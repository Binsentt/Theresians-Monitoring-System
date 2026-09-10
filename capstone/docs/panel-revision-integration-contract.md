# Panel Revision Integration Contract

Status date: 2026-09-10 (Asia/Manila)

Website repository baseline: `0238e8cad00c5f1110ebad0a0082407ad176781c` plus the reviewed panel-revision and durable-presence diff. The exact candidate revision is recorded only after local verification and commit.

Read-only Godot reference observed during this website task: `ee7dc729eec8ccec59ff1bbeaa1d5e0a554707c4`. No Godot file was changed.

Contract document version: `panel-integration-v1`. This is a documentation version; existing JSON responses do not currently include a `schema_version` property unless shown below.

## Status vocabulary

- **IMPLEMENTED** means the route exists in `backend/server.js` in the website revision named above.
- **PROPOSED** means no compatible route or persistence contract is implemented. Clients must not call it.
- All `/api` routes use JSON unless a documented lesson upload uses multipart form data.
- Website analytics and management routes use `Authorization: Bearer <website JWT>` and enforce the authenticated account's role and relationship scope on the server.
- Game write/read projections that use a playtime lease require the numeric `session_id`, opaque `session_credential`, and integer `learning_cycle_version`. The plaintext credential is never stored.

## Identity mapping

| Identity | External form | Database authority | Notes |
| --- | --- | --- | --- |
| Account ID | positive integer | `public.accounts.id` | Internal only; never substitute an external school/game ID. |
| Current Student ID | exactly 8 digits | `public.accounts.game_student_id` | Preserve leading zeroes. |
| Legacy Student ID | exactly 6 digits | `public.accounts.game_student_id` | Read/login compatibility only; preserve leading zeroes. |
| Parent ID | exactly 6 digits | `public.accounts.parent_id` | Parent and Parent/Teacher accounts only; preserve leading zeroes. |
| Parent relationship | integer row ID plus account IDs | `public.teacher_student_relationships` | `relationship_type='parent'`; one active Parent owner per Student in the current family contract. |

An Admin-created Parent plus Child is committed in one transaction. Linking an existing Student is allowed only when it has no active Parent relationship. Unlinking removes only the relationship and requires a reason; it does not delete the Student, gameplay, results, progress, or history.

## Implemented game routes

### Profile and learning cycle

- **IMPLEMENTED** `GET /api/game/profile/check/{student_id}?parent_id={parent_id}`
  - Accepts an 8-digit current or 6-digit legacy Student ID and an exact 6-digit Parent ID.
  - `200` returns `can_play: true` and the canonical linked profile.
  - `400` malformed ID, `403` wrong/inactive relationship, `404` missing account.
- **IMPLEMENTED** `GET /api/game/learning-cycle/{student_id}?parent_id={parent_id}`
  - Returns the authoritative current learning-cycle version for the linked pair.

### Playtime

- **IMPLEMENTED** `POST /api/playtime/start`
  - Input includes `student_id`, `parent_id`, and canonical profile hints. The server resolves identity and starts a lease.
  - Output includes `session_id`, `session_credential`, `learning_cycle`, `total_playtime_seconds`, `remaining_seconds`, `total_playtime_today` (whole minutes), `remaining_minutes`, `daily_limit_minutes`, `can_play`, and ISO timestamps.
- **IMPLEMENTED** `POST /api/playtime/heartbeat`
  - Input: `session_id`, `session_credential`.
  - Server time determines elapsed/remaining time. Client countdown values are not authoritative.
- **IMPLEMENTED** `POST /api/playtime/end`
  - Input: `session_id`, `session_credential`, optional terminal `status`.
  - Duplicate/non-playing ends do not add a second completed duration.
- **IMPLEMENTED** `GET /api/playtime/today/{internal_student_id}`
  - Website JWT plus authorized Student scope is required.

Time is stored and calculated in seconds. Minute fields are display/compatibility projections. `PLAYTIME_DAILY_LIMIT_MINUTES` is a positive-integer environment setting with a default of 60. For a 60-minute allowance and 240 counted seconds, the contract is 240 seconds / 4 minutes used and 3360 seconds / 56 minutes remaining.

Active Playing sessions are included using the bounded effective end (`NOW`, expiry, and last heartbeat). Paused/background clients remain counted only while they continue valid heartbeats. A stale heartbeat finalizes the lease. A new start interrupts a still-live prior lease for the same Student rather than double counting it.

Website playtime lists return `summary.total_records`, `summary.total_playtime_seconds`, and `summary.playing_count` for the complete authorized filtered dataset, not only the displayed page. Legacy completed rows whose seconds field is still zero fall back to their preserved minute value.

The school-day boundary currently uses PostgreSQL `CURRENT_DATE`/`date_trunc('day', NOW())` in the database session timezone. No application-level timezone override is implemented; production must keep the database timezone configuration documented and stable.

### Activity

- **IMPLEMENTED** `POST /api/game/activity`
  - Input: lease fields above plus `event_type`, `event_key`, and `task_id`.
  - Supported boundary types are canonical task start/completion variants normalized by the backend.
  - Identity, grade, and section come from the active lease, not caller display values.
  - Uniqueness is `(student_id, event_key)` for non-null keys. A retry returns `200` with `duplicate: true`; the first insert returns `201`.
  - The event key must include the learning cycle and stable task boundary. It is not a title/time-bucket deduplication key.
- **IMPLEMENTED LEGACY/COMPATIBILITY** `POST /api/activity-logs`
  - Retained for non-boundary session/status entries. It is not the canonical idempotent quest-boundary route.

Difficulty is derived from event-time `current_scene`/`current_map`: Oakleaf and its recognized tutorial/interior aliases map to `Easy`, City to `Normal`, and Pinehill to `Difficult`. Unknown historical duration remains semantically unavailable; an explicit duration of zero may represent a genuine instantaneous event.

### Questions and recorded outcomes

- **IMPLEMENTED** `GET /api/game/questions?grade={grade}&difficulty={difficulty}&topic={optional_topic}`
  - Returns only the active, approved exact-scope question set.
  - Every valid question has four distinct nonempty choices and one correct answer mapped to one of those choices.
  - Exhausted/undersized availability is returned truthfully; no static fallback is presented as AI.
- **IMPLEMENTED** `POST /api/game/result`
  - Requires the active lease and learning-cycle fields. Records canonical outcomes that feed progress aggregates and grounded analytics.
- **IMPLEMENTED** `POST /api/game/progress`
  - Requires current learning-cycle lease state once a cycle is established. Server-side monotonic rules prevent stale-cycle regression.

### Leaderboard

- **IMPLEMENTED WEBSITE** `GET /api/top-achievers` and `GET /api/leaderboard/top-achievers`
  - JWT required. Admin sees all eligible Students; Teacher and Parent scopes are derived from authenticated relationships. Caller-supplied scope IDs are ignored.
- **IMPLEMENTED GAME PROJECTION** `POST /api/game/leaderboard`
  - Valid current playtime lease required. Returns only `rank`, pseudonymous `display_name`, progress, accuracy, correct/total answers, and quests completed; it does not expose Student IDs, names, email, Parent data, or Admin-only fields.

Both projections reuse the canonical stable order: progress descending, accuracy descending, correct answers descending, quests completed descending, then internal Student ID ascending. Each Student contributes only its highest current-cycle row. Archived accounts, archived progress, and rows before the current-cycle boundary are ineligible. Website Teacher/Parent relationship scope may intentionally be narrower than the lease-authorized global pseudonymous game projection.

## Implemented website analytics and lesson routes

- **IMPLEMENTED** `GET /api/students/progress`, `GET /api/student-progress/{internal_student_id}`, and `POST /api/student-progress/{internal_student_id}/ai-insight` with role/relationship scope.
- **IMPLEMENTED** grounded insight fingerprint/cache: unchanged evidence reuses the cached result; concurrent work is coalesced; stale insight is labeled; unavailable AI never replaces deterministic recorded metrics.
- **IMPLEMENTED** `PUT /api/learning-files/{file_id}/questions/{question_id}` for staged question edits. Active sets and sets referenced by historical game results are immutable. A permitted edit invalidates approval and recomputes structural validation/fingerprint.
- **IMPLEMENTED** deletion-reason contracts for individual questions, staged question-set trash, permanent question-set delete, and atomic bulk Trash delete. Direct API calls require a nonblank reason of at most 1000 characters. Actor, action, target, reason, timestamp, and relevant before/after JSON are written to `public.admin_audit_logs` in the same database transaction.

Question generation remains backend-only. PDF/PPTX extraction, requested-count validation, idempotency, provider call, structural validation, persistence, and editable preview are separate stages. Provider `429 insufficient_quota`/`credit_balance_exhausted` is a generation failure, not a parsing failure. The source remains retryable. No browser key, mock/static fallback, or provider substitution is part of this contract.

## Implemented website authentication and presence

- **IMPLEMENTED** `POST /api/session/heartbeat`
  - Requires a valid website JWT containing a server-issued 256-bit random session credential.
  - Only the SHA-256 credential hash is stored in `public.website_sessions`; the raw credential remains inside the signed bearer token and is never logged.
  - The server updates `last_seen_at` from server time. The browser sends a heartbeat every 25 seconds only while visible and sends one immediately after focus/visibility recovery.
- **IMPLEMENTED** `POST /api/logout-status`
  - Ignores caller-supplied account identity and revokes only the authenticated token's session.
  - A second browser session remains valid and keeps the same account online. Reuse of the revoked token is rejected by shared authentication middleware.
- **IMPLEMENTED** `GET /api/admin/presence`
  - Admin-only. Returns distinct enabled website accounts with at least one non-revoked, unexpired session seen within the 75-second freshness window.
  - The dashboard refreshes every 30 seconds while visible. Network loss or browser termination ages presence out; unload is not treated as proof of logout.
  - `parent_teacher` contributes once to `online_now.total`, once to the Teacher facet, and once to the Parent facet. The overlapping facets must not be summed to calculate the unique total.

The session's absolute authentication lifetime remains 30 days and is independent of the 75-second presence freshness window. Account archive, role change, temporary-credential issuance, and password change/reset increment the account session version and revoke all durable website sessions. Permanent account deletion removes sessions through the account foreign key. New sessions are issued only after trusted-device authentication or OTP verification succeeds.

Tokens issued before this contract have no durable session credential. They remain bounded by their previously signed 30-day JWT expiry and account session version, are never counted online, and receive `WEBSITE_SESSION_REAUTHENTICATION_REQUIRED` from the heartbeat route so the browser performs an explicit sign-in transition.

Registered/enabled account counts continue to come from active account records. They are not aliases for Online Now and `accounts.status` is not used as presence evidence.

## Migration order and recovery

Apply migrations in numeric order through `018_website_sessions_and_audit_metadata.sql`. Migration 018 is additive and transactional: it adds nullable `admin_audit_logs.before_metadata` and `after_metadata` JSONB columns, then creates `website_sessions` and its active-presence/expiry indexes. Startup compatibility performs the same idempotent additions before API readiness; schema failure aborts server startup instead of allowing a false-ready process.

The disposable PostgreSQL 18 verification covers the prior-schema upgrade, repeated migration, preservation of existing audit rows, JSONB availability, concurrent sessions for one account, transaction rollback, and persistence through a new connection. Application rollback may stop issuing session-aware tokens, but must not delete audit history. The additive session table may remain during an application rollback; dropping it is a separate reviewed database change.

Production environment target (read-only verified 2026-09-10): Railway project `overflowing-insight` / service `Theresians-Monitoring-System` / environment `production`, source `Binsentt/Theresians-Monitoring-System:main`, root `/capstone`, config `/capstone/railway.toml`, domain `theresiansquest.com`. The currently observed deployment remains `42f22587-7de1-4213-8da0-c65f02b3c359` at source `cdaa88993723bf10b61236bf95da6eeafc480863`; the local candidate is not deployed by this document.

## Errors

Common status meanings:

- `400`: malformed identity, invalid structure, missing reason, or invalid lease payload.
- `401`: missing/expired website authentication.
- `403`: authenticated but unauthorized role/relationship, wrong Parent pair, or invalid lease credential.
- `404`: missing account, relationship target, content, or session.
- `409`: stale learning cycle, stale heartbeat, active-content safeguard, historical-reference safeguard, ownership conflict, or replacement confirmation required.
- `422`: question-set structural/review validation failure.
- `429`: provider rate/quota response after classification.
- `5xx`: unavailable dependency or unexpected server failure; clients must not convert this to fabricated success.

Important machine codes include `LEARNING_CYCLE_CHANGED`, `PLAYTIME_HEARTBEAT_STALE`, `ACTIVE_QUESTION_SET_CANNOT_BE_DELETED`, `QUESTION_SET_HISTORY_PREVENTS_PERMANENT_DELETE`, `QUESTION_SET_REVIEW_VALIDATION_FAILED`, and classified question-generation failure codes returned by the generation endpoint.

## External verification boundaries

- Automated OpenAI tests inject mocked providers and prove validation, grounding, cache fingerprints, retry behavior, and absence of static fallback. They are not a live-provider PASS.
- Railway exposes the `OPENAI_API_KEY` variable name but not proof of value validity, quota, or spending authorization. The bounded live smoke remains exactly two calls: one small PPTX requesting five questions and one synthetic-evidence insight. It requires explicit authorization for disposable fixture writes and provider spending before execution.
- Railway reports staged patch `7f468f6c-1d69-481a-80f6-c12ef9cc78d3`, with 11 named service-variable changes and an unreconciled environment-level count. It must not be accepted, discarded, or bundled with a source release until its exact contents are independently reviewed.
- Leaderboard, activity idempotency, Easy/Oakleaf mapping, and screen-time summaries are backend-contract verified. No website-only test claims current Godot/device end-to-end verification.

## AI runtime pause and non-AI QA boundary

- **IMPLEMENTED** `GET /api/learning-files/ai-status` exposes the server runtime state without exposing provider credentials.
- When `AI_GENERATION_ENABLED` is not explicitly `true`, lesson generation and grounded insight provider calls are stopped before key lookup or outbound fetch. The stable machine code is `AI_PAUSED` and the user-facing message is: `AI generation is temporarily paused. Recorded data and available questions remain accessible.`
- A paused lesson source may still be persisted as `source_ready`/`not_generated` for later review. It must not create generated questions, an approval record, an empty approved set, or fabricated AI output.
- Genuine cached insight remains visible with its evidence fingerprint and timestamp. Current evidence is labeled current; changed evidence is labeled stale. No retry control bypasses the pause.
- The local manual browser checklist is [non-ai-manual-qa.md](non-ai-manual-qa.md). It uses only synthetic accounts and a disposable local database. It is not production verification and does not authorize Railway deployment or a live OpenAI request.

## Acceptance fixtures

All automated fixtures are disposable/mocked; they are not production IDs.

1. Current identity: Student `00001234`, Parent `123456`; correct pair `200 can_play=true`, wrong Parent `403`, missing Parent `404`.
2. Legacy identity: Student `001234`, Parent `123456`; leading zeroes remain strings.
3. Activity retry: same Student, cycle, task boundary, and `event_key` twice; one row, responses `201 duplicate=false` then `200 duplicate=true`.
4. Playtime: configured 60 minutes, 240 counted seconds; 4 minutes used and 56 minutes remaining.
5. Ranking tie: identical progress/accuracy/correct/quests; lower internal Student ID ranks first. Game output remains pseudonymous.
6. Question edit: staged five-question set, exactly four distinct choices each; edit resets approval and preserves correct-answer membership before a later explicit approval/publish.
7. Insight: one or more valid recorded results creates evidence; fewer than five is labeled preliminary; unchanged evidence reuses its fingerprint/cache.

## Game handoff checklist

- Send exact string IDs without numeric coercion.
- Treat the playtime lease and learning-cycle version as one credential set for every game write.
- Use `/api/game/activity`, not the legacy activity route, for quest/task boundaries.
- Persist and retry the exact stable `event_key` until acknowledged.
- Send event-time scene/map metadata so difficulty is derived correctly.
- Do not consume private website leaderboard routes from the game.
- Do not assume a 60-minute allowance; render returned limit/remaining fields.
- Do not claim website Online Now support until the proposed persistent-session contract is implemented.
