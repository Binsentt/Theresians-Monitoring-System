# Production recovery review handoff

Prepared 2026-11-28. **Production remains NO-GO.** This is a review package and
proposed authorization scope, not permission to connect, reset a password,
export metadata, read application rows, freeze writers, create or restore a
backup, migrate, restart, deploy, or incur a Railway charge. No independent
routine approval, production export, production recovery copy, restore result,
or live acceptance result is asserted here.

Use this alongside the existing
[operator runbook](database-release-preparation-operator-runbook.md) and
[migration 026 runbook](../scripts/recovery-migration-026-runbook.md). Preserve
their stops. Their historical service observations do not establish current
production identity, authentication, schema, writer activity, or backup/PITR
availability. Keep actual service IDs, database/address pins, private paths,
reviewer identity, approval references, credentials, routine definitions, and
recovery artifacts in the restricted operator record, outside the repository.

## Source and target bindings

These are separate approvals. A newer commit, a matching filename, a passing
synthetic test, or a successful signature check cannot replace one of them.

| Operation | Required immutable binding |
| --- | --- |
| Password-only synchronization | Separately reviewed new operator source and artifact digest; named administrator route and identity; the existing protected reader passfile as the password source; only the approved reader role. This does not change the preflight source pin. |
| Restricted metadata preflight | **Exactly `57908cba66e39a187caa290b2bd1eb0a776f7d26`**, clean reviewed inputs, `run-release-preflight.ps1 -Stage PreMigration026`, service `tq_release_preflight`, role `tq_release_preflight_reader`. Do not substitute the integration branch, current HEAD, or the synchronization operator's source. |
| Proposed routine catalog audit/export | Exact source `9c5ce4e4f1f9c3252d28ae29e77a874493eec971`, paths `capstone/backend/scripts/backup-role-preflight.sql` and `capstone/backend/scripts/backup-role-routine-review-export.sql`. A changed export requires new review and authorization. |
| Later backup/restore tool | Separately approved exact 40-character tool commit, clean release-critical inputs, and exact production application commit independently verified from deployed-source evidence. Neither is automatically the export-source or preflight commit. |
| Signed routine review | Exact database, role `tq_prod_backup_reader`, literal server address and server port, tool commit, production application commit, routine inventory digest, reviewer/key pin, issue time and expiry. |
| Migration/deployment | Separately approved migration executor commit and artifact/checksum pins, then one exact deployable application commit with passing CI at that commit. No blanket approval of a branch. |

The owner/DBA must independently anchor the target to the intended Railway
project, production environment, PostgreSQL service, database, literal
server-side address/port, verified TLS identity and CA fingerprint. Record the
local loopback route/tunnel port separately: it is not the server-side address
or port signed in the review. A profile must retain `host=localhost`,
`hostaddr=127.0.0.1`, the approved tunnel port, `sslmode=verify-full`, and the
verified CA. Do not learn the expected target from the export itself or weaken
TLS to make an identity check pass.

## Proposed production metadata export authorization — not executed

The following scope is ready for owner/DBA review after the restricted-reader
preflight passes. All private bindings must be completed in the restricted
record before authorization; an incomplete record means stop.

> Authorize the named operator, during the recorded UTC window, to perform one
> catalog-only backup-role audit and one routine-definition export using the
> two SQL files at `9c5ce4e4f1f9c3252d28ae29e77a874493eec971`, PostgreSQL 18
> `psql`, the independently pinned production endpoint, and only
> `tq_prod_backup_reader` through the reviewed `tq_prod_backup` TLS service.
> Authorize local protected output creation for these results only. The
> approval ends after those attempts or at the window's expiry, whichever is
> first. It does not authorize a password reset, role provisioning, grant
> change, arbitrary SQL, user-routine invocation, application-row query, dump,
> snapshot, restore, maintenance action, migration, deployment, or Railway
> configuration change. An authentication failure, timeout, identity mismatch,
> SQL failure, or unexpected output stops the attempt; no automatic retry or
> administrator fallback is permitted.

The approval record must include:

1. The exact source above, local SQL byte digests, reviewed client version and
   output-capture artifact digest, operator, change reference and UTC window.
   Source verification and local validation precede any connection.
2. The independently established database, literal server address/port,
   Railway resource identity, local route, CA fingerprint and TLS name.
3. Separate authorization for use of the broader backup role. If it is absent
   or lacks required privileges, stop; this proposal does not authorize its
   creation or repair. The metadata reader must never be replaced by this role
   for the earlier restricted preflight.
4. A verified encrypted local NTFS destination outside every checkout, with
   restricted owner/DBA-approved ACLs, no reparse traversal, sufficient current
   free capacity, and a stable protected evidence directory. An approved
   capture wrapper must create new output files exclusively (`CreateNew`),
   stream stdout directly to protected storage, keep diagnostics protected,
   check process exit status and never echo JSON. Review that wrapper before
   production use; this document supplies no execution authorization.
5. `psql -X -q -w`, pager off and `ON_ERROR_STOP=1`, using the reviewed protected
   service/passfile rather than a URL, inline password or administrator role.
   Pass `expected_database`, `expected_server_address`, `expected_server_port`
   and, for the audit, `expected_role=tq_prod_backup_reader`. Clear/reject
   ambient connection overrides through the reviewed connection checks.

The audit uses an explicit read-only transaction with 10-second statement and
2-second lock timeouts. The export uses repeatable-read/read-only, 30-second
statement and 2-second lock timeouts, `pg_catalog` search path, exact
`current_user=session_user=tq_prod_backup_reader` and target identity checks,
then rolls back. They inspect catalogs rather than Student/Parent table rows.
Routine bodies can nevertheless contain secret literals; treat the JSON as
sensitive. Do not attach it to chat, a PR, GitHub, CI, ordinary logs, or a
public artifact.

Preserve exit status, timestamps, source/file digests and the audit markers.
Require exactly one `CATALOG_PRIVILEGE_CHECKS=PASS`, the audit's
`OVERALL_BACKUP_ROLE_NONWRITING=UNVERIFIED` marker, and exactly one
`BACKUP_ROLE_ROUTINE_INVENTORY_SHA256`. The JSON's
`routine_inventory_sha256` must match that digest exactly. Record the export
file SHA-256 separately. A catalog pass is not a nonwriting semantic approval.

## Work for the qualified independent reviewer

The reviewer must be able to assess PostgreSQL privileges, procedural code,
native extensions, dynamic execution and the exact application/backup source.
They must be independent of the operator's implementation and control their
own private signing key and approval decision. Codex, the operator, an
automated test, or an owner assertion cannot stand in for this review.

Provide the reviewer the protected JSON and audit result, export file digest,
independently anchored target record, exact application and tool source,
extension package/build provenance and deployed native implementations, and
the proposed backup command and execution context. The inventory includes
non-system-schema routines with identity arguments, owner, language, kind,
security, volatility, leakproof flag, configuration, ACL, `probin`, `prosrc`,
extension name/version/schema/owner, definition digest and effective EXECUTE.
This inventory is the starting point, not a complete transitive call graph.

For every routine and every reachable execution path, the reviewer must:

- Match definitions and inventory to the audit; trace nested routines,
  aggregates and their support routines, dynamic SQL, overloaded resolution,
  casts/operators, triggers or other executable dependencies reachable from
  the exact tool's queries and dump/restore work. Catalog dependency lists
  alone do not resolve dynamic execution.
- Inspect effective EXECUTE through PUBLIC or other grants, `SECURITY DEFINER`
  owner authority, schema/search-path resolution, language trust, and mutable
  implementation/configuration inputs. Explain even an apparently uncallable
  routine's disposition and all paths into callable dependencies.
- Review the matching extension source package and deployed shared library
  for extension/native routines, including `probin`/`prosrc` and version/build
  identity. `pg_get_functiondef()`, extension membership and volatility labels
  cannot establish native-code behavior. Missing source/binary provenance or
  an unexplained dependency means **REJECT / UNVERIFIED**.
- Explicitly assess writes to tables, sequences and large objects; role,
  configuration or privilege changes; and filesystem, network, process and
  global/external effects. A read-only caller transaction or later rollback
  cannot prove the absence of such effects.

Record the per-routine/dependency findings privately. Approve only when the
review establishes both nonwriting side effects and source integrity for the
exact scope. Any uncertainty blocks approval; do not generate a provisional
`APPROVED` signature.

### Signature and independent key trust

Use the existing functions in
[`backupRoleReview.validation.psm1`](../scripts/backupRoleReview.validation.psm1).
The evidence has exactly 16 ordered lines: `TQ_BACKUP_ROLE_REVIEW_V1`, then
`reviewer_id`, `decision`, `scope`, `database`, `role`, `server_address`,
`server_port`, `tool_source_sha`, `application_source_sha`,
`routine_inventory_sha256`, `issued_utc`, `expires_utc`,
`reviewer_key_sha256`, `public_key_xml_base64`,
`signature_sha256_rsa_base64`, each field written as `name=value`.

The reviewer signs the canonical payload returned by
`New-TqBackupRoleReviewPayload`: the header and first 13 fields encoded as
UTF-8 with LF separators and a trailing LF. The decision is exactly
`APPROVED`, scope exactly `nonwriting-side-effects-and-source-integrity`, role
exactly `tq_prod_backup_reader`. Use an RSA/SHA-256 signature and a supported
canonical RSA public key of at least 2048 bits; no private key enters the
operator package. `reviewer_key_sha256` is the fingerprint produced by
`Get-TqBackupRoleReviewPublicKeyFingerprint`, not a generic hash of the XML
file. The last two fields carry canonical base64 public-key XML and signature.

Before accepting the package, the owner/DBA must authenticate the reviewer and
approve that fingerprint through an independent protected channel. Pin it as
`ExpectedBackupRoleReviewerKeySha256`; a key embedded in evidence cannot
authorize itself, and an operator-generated key is not an independent signer.
Use strict UTF-8 without a BOM, no extra/reordered/duplicate fields, and at
most 16 KiB. Times use `yyyy-MM-ddTHH:mm:ssZ`; expiry must be after issue,
still current, and no later than seven days after issue. The validator permits
at most five minutes of future issue-time skew; this is not an approval-window
extension. Revalidate exact target/source/inventory/key pins immediately
before and after the archive operation. An export, signature, or valid key
does not approve the backup or any later production action.

### Canonical replay receipts and legacy claims

Record both raw evidence-file SHA-256 (artifact provenance) and canonical
signed-payload SHA-256 (one-use identity). Accepted newline representations,
including CRLF and an optional final newline, reconstruct the same signed
UTF-8/LF payload and therefore the same claim. Reformatting a file cannot
create another approval.

Before a later production backup, the tool must atomically create and durably
flush `.tq-backup-role-review-payload-<payload-sha256>.used` with `CreateNew`
in the evidence file's protected directory, then verify its restricted ACL.
A prior or interrupted claim, creation failure or ACL failure stops before
snapshot/archive work. Keep the receipt after any later failure; another
attempt needs a fresh independent review and signed payload. Never relocate
the directory, delete receipts, or change formatting to bypass this stop.
This is local operator evidence, not protection against an administrator who
can replace the entire directory.

Inventory legacy `.tq-backup-role-review-<raw-evidence-sha256>.used` receipts
first. Any legacy receipt blocks canonical claims. Preserve it and reconcile
its evidence, prior operation and canonical payload under owner/DBA review;
unknown legacy claims remain a stop. Do not silently delete or rename legacy
receipts to make the new scheme pass.

## Railway-native recovery options — inspect only

Current production backup/PITR configuration remains unknown. The following
describes official Railway documentation checked on 2026-11-28, not observed
configuration or permission to create a paid resource.

In the authenticated dashboard, independently select the intended project,
production environment and PostgreSQL service, then open **Backups**. Record
a sanitized UTC inventory of existing backup dates/status, schedules and
expiry, plus PITR enabled/off state and the available restore range/archiver
health if shown. Do not expose variables or credentials. If unavailable,
record **UNKNOWN**. Do not click create, restore, schedule, enable/disable,
resize, or Deploy during inspection.

| Option | Recovery boundary and remaining limitation |
| --- | --- |
| Reviewed logical archive | A portable PostgreSQL 18 custom-format archive plus shared-snapshot integrity evidence, before/after sequence evidence and a tested isolated restore. It proves the selected archive's recoverability only after validation. The current production backup hard-stop remains in place. |
| Railway volume backup | Volume contents at an existing backup point; restoration is confined to the same project/environment. Manual backup size is limited to 50% of volume capacity. Incremental storage is billed; displayed incremental size can lag. Restoring stages a replacement volume and requires Deploy/redeployment. This is not the isolated logical restore rehearsal. [Railway Backups](https://docs.railway.com/volumes/backups) |
| Railway PostgreSQL PITR | Restores an archived timestamp into a new sibling service; cutover is separate. Coverage starts at the first base backup after enablement, never retroactively. Enabling creates a bucket/configuration and redeploys. Storage and upload egress are billed; a restored service also consumes resources. Archive health/range must be verified; a truncated archive can narrow recovery. This is not proof of logical archive/restore integrity. [Railway PITR](https://docs.railway.com/volumes/point-in-time-recovery) |

For a **future separately approved** native volume restore, identify the
existing backup by timestamp in Backups, choose Restore, inspect Details and
the staged volume swap, then seek the specific restore/deploy approval before
Deploy. For PITR, the later approved operator selects a timestamp within the
verified range and the correct cluster history; creation of the sibling and
any cutover require explicit approval. No such action is part of this handoff.
Existing native recovery points may add protection but do not waive the
logical backup, sequence-freeze or isolated-restore gates. See
[Railway's volume restore procedure](https://docs.railway.com/volumes/backups#how-to-restore-a-backup)
and [PITR procedure](https://docs.railway.com/volumes/point-in-time-recovery#restoring-to-a-point-in-time).

## Consolidated recovery order and human gates

Every row requires a named operator, owner/DBA decision, exact scope and
evidence in the protected release record. A failed or ambiguous row stops
later rows. Do not apply migration 024, edit ledger checksums, disable startup
validation, grant broader privileges, or retry a lost COMMIT response.

| Order | Gate and evidence required before proceeding |
| --- | --- |
| 1. Production password synchronization | Independently review the new password-only operator and its disposable PostgreSQL 18 evidence. Verify the administrator route, protected credential, CA and target independently; approve one synchronization sourced from the existing protected reader passfile. No new password, plaintext output, browser paste, grant change, or unverified administrator/SSH fallback. A successful synthetic test is not production authentication. |
| 2. Restricted preflight | Separately approve the bounded reader attempt at **exact source `57908cba66e39a187caa290b2bd1eb0a776f7d26`**. Require profile/passfile validation, verified TLS/target/role, ledger filenames and canonical checksums through 025, 024/025 applied, 026 the sole pending migration, expected pre-026 schema and no partial 026 objects. Preserve the report/SQL hashes. Any mismatch is NO-GO. |
| 3. Routine review and storage | Approve the bounded catalog export above; obtain the qualified independent review with separately authenticated signer/key and exact source/target/inventory pins. Verify current database size, encrypted destination, restricted ACLs, no reparse traversal and free bytes of at least `2 x database_bytes + 1 GiB`. Keep all outputs private. |
| 4. Enforced writer freeze | Independently review/implement a complete production writer inventory and external barrier before removing any backup hard-stop. Stop API ingress/replicas, mobile writers, autoscaling/restarts/autodeploy, in-process generation and status pollers, external jobs/integrations/direct clients and administrator writers; drain transactions, block new writer sessions and verify quiescence. A crashed Website does not establish this. Include GET-triggered insight/generation writes, triggers and extensions. Capture all sequence names/ownership/`last_value`/`is_called` as aggregate-only fingerprints before and after the dump; any mismatch or barrier break rejects it. |
| 5. Logical backup | Only after the freeze implementation and operation have separate approval may the production hard-stop be replaced in a newly reviewed source. Separately approve one recovery point/backup attempt; validate the unexpired independent review and canonical one-use claim before snapshot/archive. Use PostgreSQL 18 custom-format `pg_dump` and one exported repeatable-read snapshot shared with manifest/integrity queries; keep the barrier until matching sequence digests and archive SHA/TOC checks pass. Preserve a failed claim and partial-artifact outcome. |
| 6. Isolated restore | Separately authorize a fresh empty `tq_restore_*` PostgreSQL 18 target bound to loopback, isolated from production, with a non-admin restore role/service. Verify archive digest/TOC; use `--single-transaction --exit-on-error --no-owner --no-privileges`, never `--clean` or `--create`. Require source-vs-restore schema, ledger/checksum, aggregate data, sequence, large-object and routine/catalog evidence. Synthetic CI is not a restore of production. |
| 7. Migration 026 only | Separately approve the exact recovery executor/artifact/checksum, target, preflight/backup/restore evidence, runtime permission plan, monitoring window and rollback owner. Require pending list `[26]`, advisory lock, transactional execution and read-only post-checks of ledger, receipt table/constraints/indexes and effective runtime SELECT/INSERT/UPDATE. An unknown COMMIT outcome requires a newly authorized read-only investigation, not a rerun. |
| 8. Exact deployment | Separately approve one reviewed application SHA with passing backend/frontend CI at that SHA, Auto Deploy off and no competing queued deployment. Observe terminal successful deployment, startup/schema validation, configured health endpoint and healthy replicas. A queued deployment is not recovery. Retain the additive receipt table on a code rollback. |
| 9. Live acceptance and stability | Separately authorize designated synthetic/test fixtures and mocked AI; no real Student record or live AI call. Verify Website auth/session/OTP/role access; mobile auth/API compatibility; unique save, exact retry with same receipt, changed-payload conflict, once-only progress/activity; game result/playtime/tombstone persistence; Student Progress authorization and linked Parent read-only/foreign-Student denial; AI evidence and generation/upload failure states. Verify persistence across one separately approved restart. Record deployed SHA and sanitized results. Name the observation window, owner, error/latency/replica/restart thresholds and rollback triggers before release. Require health and bounded logs/metrics throughout the full window; elapsed time alone is not stability evidence. |

Before asking for the next production approval, provide the completed private
bindings, exact artifacts and digests, observed prior-gate evidence, proposed
bounded action and stop conditions. The outstanding human decisions are the
secure administrator route and password-only operation; exact pinned reader
preflight; broader backup-role use/export and independent semantic signer;
writer freeze implementation/operation; backup and isolated restore;
migration 026; exact deployment; synthetic live acceptance and the stability
window. None is satisfied by preparing this document.
