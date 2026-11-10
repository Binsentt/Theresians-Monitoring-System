# Game device authentication: proposed contract

Status: design plus inactive server-side primitives only. No route uses these helpers; no authentication enforcement, pairing endpoint, schema, migration, credential issuance endpoint, mobile secure-store bridge, or legacy-client cutoff is included. This PR must not be deployed as an authentication feature.

## Existing game write contract audited at PR #20

The Godot `HttpApi.request_post()` currently sends only `Content-Type: application/json`; it has no bearer-token provider. `RemoteSync` sends writes to:

| Endpoint | Current server-side protection | Identity / authorization source |
| --- | --- | --- |
| `POST /api/game/progress` | No account-auth middleware. Validates a submitted parent code and linked student; checks learning-cycle and optional playtime lease. Legacy calls can omit the lease. | Parent/student IDs and, when supplied, session lease |
| `POST /api/game/result` | No account-auth middleware. Requires an active playtime-session credential and learning-cycle metadata. | Session capability plus parent/student linkage |
| `POST /api/game/activity` | No account-auth middleware. Requires active session ID/credential and current cycle; resolves student identity from the session. | Session capability |
| `POST /api/activity-logs` | No account-auth middleware. Game public Student IDs are checked against a supplied Parent code; a legacy numeric account-ID path also exists. | Submitted identifiers; this is the weakest compatibility path and needs a separate server-side deprecation decision |
| `POST /api/playtime/start` | No account-auth middleware. Validates active Parent code and linked active Student. | Knowledge of Parent code and linked Student code |
| `POST /api/playtime/end`, `/heartbeat` | Requires an active session ID and high-entropy session credential; database stores the credential hash. | Session capability |

The six-digit Parent ID is not an authenticated Parent account session. Existing checks provide relationship and session scoping, but are not a device identity system. Website bearer authentication exists for website/admin routes and is not currently attached to these Godot writes.

PR #20's `save_commit_id` is part of the queued progress event, so a retry keeps the same ID after offline restart. The outbox contains game events and identity/cycle fields, not a proposed device token. Do not add access or refresh credentials to save files, pending queue JSON, conflict journals, logs, telemetry, or crash diagnostics.

## Proposed pairing flow

1. The game creates a one-time high-entropy device challenge and displays a short human-readable pairing code/QR. The server stores only a challenge digest, expiry, attempt count, and opaque challenge ID. Do not use a six-digit code as the only secret.
2. The parent completes a fresh authenticated session in the existing website (or a separately approved trusted parent flow), reviews the device label and exact Student, and explicitly approves pairing. The Parent ID supplied by the game is never proof of parent authority.
3. In one database transaction, the server consumes the unexpired challenge once, verifies the parent's active account and active parent/student relationship, creates a student-scoped device record, and stores only a digest of the new refresh credential. Enforce one-time challenge consumption and unique credential digests in PostgreSQL.
4. The device receives a short-lived access credential and a refresh credential once over TLS. They are saved only through platform-native secure storage. The server never returns credentials on later reads.
5. Every game write authenticates the access credential, resolves the device's Parent and Student from the database, rechecks account/relationship status, and checks the submitted cycle against the current authoritative cycle. Request-body identity fields never override the credential's scope.

Pairing endpoints must rate-limit by challenge, account and source; return non-enumerating errors; expire/consume challenges; and audit successful approvals without logging codes or tokens. A failed or expired flow leaves no credential.

## Credential and refresh rules

- Use opaque, cryptographically random credentials with at least 256 bits of entropy. Store only SHA-256 digests for random bearer values; compare digests in constant time.
- Access/refresh TTLs, maximum device count, and whether a Parent session must be reauthenticated are owner-approved policy values; this PR deliberately defines no default durations.
- Refresh rotation must be transactional and compare-and-swap the current refresh digest. A client-generated stable rotation request ID and next refresh secret are needed to recover an ambiguous response without accepting a different successor. Exact retries return the already-recorded rotation result; reuse with a different successor revokes the family and is audited. Concurrent rotations must serialize on the credential-family row.
- Revocation immediately blocks access and refresh; support revoking one device, all devices for one Student, and all devices for a Parent. Account deactivation, relationship removal and Student archival must deny writes on the next request even if a token has not expired.
- Device credentials are Student-scoped. Changing Student requires an explicit parent-authorized pairing; never relabel queued events or silently reuse another Student's token.
- Credentials are not bound permanently to a learning-cycle version. On each write, compare the queued event's cycle with the current cycle. A stale event is held/quarantined for explicit recovery and never replayed into the new cycle. The Parent may re-pair/reauthorize but the old event's `save_commit_id` and ownership are not rewritten.

## Godot secure-storage integration

Introduce a small Godot `CredentialStore` interface only when both native providers are ready. It must expose store/read/delete/availability and distinguish locked, missing, revoked and unsupported states. Unsupported devices fail closed; never fall back to `user://`, project settings, save JSON, outbox or conflict journal.

- **iOS:** implement a Godot iOS native plugin backed by Apple Keychain (`Security.framework`), app-specific service/account names, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, no iCloud synchronization, and no shared access group unless separately approved. Delete all device credentials on explicit unlink/logout/account switch. Test reinstall/restore behavior on physical iPhone.
- **Android:** implement a Godot Android plugin using a non-exportable Android Keystore AES-GCM key to protect app-private credential material; exclude ciphertext and key aliases from Android backup/device transfer. Handle key invalidation by requiring re-pairing, never by writing plaintext. Confirm minimum API and plugin packaging against the actual Android export.
- Keep access credentials in memory where feasible; pass them through an HTTP authorization-header provider. Never log headers or attach credentials to analytics. Local QA must retain its current network boundary and cannot opt into production writes through auth fallback.

These platform bridges, lifecycle UX and native build tests are not implemented here. Existing Android/iOS runtime tests do not establish secure-store behavior.

## Offline queue behavior with authentication

- Keep PR #20's event bytes, `save_commit_id`, event key and original Student/cycle ownership stable across restart and retry.
- On access expiry, pause protected sync and attempt one serialized refresh. If refresh is temporarily unavailable, retain events unchanged. Never resend via an unauthenticated legacy endpoint.
- On refresh revocation or permanent authorization failure, keep the queue encrypted only if an approved local-data design exists; otherwise preserve the existing queue file without adding token material, stop sync and show a re-pair action. Do not discard the event or move it to a different Student.
- On `LEARNING_CYCLE_CHANGED`, preserve the original event and ID, stop that Student's stale writes, and require an explicit product decision for export/discard/recovery. Do not retry under the new cycle.
- Conflict journal continues to preserve the exact original event and `save_commit_id` before acknowledging a `SAVE_COMMIT_ID_REUSED` conflict. Journal failures keep the event queued. Device tokens must never enter the journal.

## Required owner decisions before route/client integration

1. Is pairing approved through the existing authenticated Parent website, or must the game have a separate Parent sign-in? Which authenticated website session/role is authoritative?
2. May one device access multiple linked Students, and may one Student be paired to multiple devices? What is the maximum and how is a shared household device switched safely?
3. What are approved access and refresh lifetimes, inactivity timeout, device revocation controls, and reauthentication rules?
4. What is the Android migration policy for the existing identifier-only client: date/version cutoff, staged enforcement, and handling for devices that cannot update? No unauthenticated fallback or cutoff is assumed here.
5. What is the account recovery and lost-device process? Which Parent/admin actions revoke credentials?
6. What should happen to unsynced events when a Parent revokes a device, changes the linked Student, or a learning cycle advances?
7. What native plugin/API minimums and physical-device test ownership are approved for iOS and Android?
8. What retention/deletion period applies to device records, pairing audit records and revocation evidence?

Until these are approved, PR #36 and PR #20 remain independent and production routes stay unchanged. Before enabling enforcement, land the schema and server endpoints first, then native client storage and Authorization header support, then a staged client rollout and explicit legacy cutoff.
