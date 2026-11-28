# Theresians Website production recovery runbook

**Status: NO-GO.** This document coordinates separately approved operations; it
does not authorize a production connection, credential change, backup, restore,
migration, restart, deployment, or merge. Never place credentials, application
rows, backup bytes, or routine definitions in GitHub, CI artifacts, chat, or
ordinary logs.

## Verified status as of 2026-11-26

- Production Website service `efe9f84c-7d05-4698-be00-452c22b47ec7` in
  `overflowing-insight/production` is **CRASHED** at deployment
  `ae7e87d7-74ff-48ad-948d-6c6c77b9ae3c`, source
  `12783185b083ed1b370143d912ddcb70d53e6839`. Railway metadata reported zero
  running replicas. Its public domain includes `theresiansquest.com`.
- PostgreSQL service `14626d99-748f-455c-ab2c-e5a66c00329a` is **ONLINE** at
  deployment `49d9afe7-65a3-4b82-bfa3-2cf36a2fcb6d`, PostgreSQL 18, one replica,
  with a 5 GB volume. Metadata did not disclose database contents or size.
- The last known startup failure reports that read-only schema validation
  cannot find `game_progress_save_commits` and its required constraints. This
  is startup-log evidence, not a current production catalog query. The live
  migration ledger, checksums, partial-object state, and exact pending list
  remain **unverified**.
- PR #46 is open, Draft, and unmerged. Its verified HEAD is
  `7c7e8f5b3934c54a8527d15d1b47558c23bdb3e9`; backend and frontend workflows
  passed at that HEAD. That validation does not establish production
  authentication or schema state.
- The owner verified the local CA, protected connection files, and exactly one
  reader passfile tuple. A production connection using
  `tq_release_preflight_reader` previously reached PostgreSQL and failed SCRAM
  password authentication. No successful reader authentication or metadata
  preflight has occurred. The password mismatch remains unresolved.
- The owner independently confirmed the C: volume is NTFS, fully encrypted,
  BitLocker protection is On, and encryption is 100%. Current free space could
  not be read in the managed shell. The earlier free-space estimate is stale.
- A prior Railway Backups screenshot showed “No Backups”; it is not a current
  backup inventory. Railway MCP does not expose backup/PITR status. A read-only
  CLI PITR-status query was attempted but blocked by DNS/network failure.
  Therefore managed backup and PITR availability are **unknown**. Do not enable
  PITR or change Railway settings under this runbook.

The failed reader authentication must not be retried automatically. The PR #46
change after the failure fixed local passfile matching guidance and added
synthetic tests; it did not change the production password or prove that the
server secret matches the passfile. Local `CONNECTION_FILES=PASS` and
`EXACT_MATCHING_TUPLES=1` validate file shape and selection, not credential
equality.

## 1. Authentication and metadata-preflight gate

The supported tested synchronization mechanism is `psql`'s `\\password` fed
through standard input, rather than browser-console clipboard paste. The
disposable PostgreSQL 18 CI scenario verifies that this sets a SCRAM verifier,
does not echo the synthetic password, and that the exact synthetic passfile
entry authenticates. This proves the client mechanism in a disposable
environment only; it does not prove a production administrative path or
credential match.

No production password reset or authentication retry is authorized by this
runbook. Before considering one, the owner must separately approve both the
exact password-only operation and the single subsequent reader authentication
and metadata-preflight attempt. The password source must be the already
protected reader passfile; do not generate or display another secret. A secure
administrative connection must first be established independently with
`sslmode=verify-full`, the pinned CA, the intended hostname, and independently
verified production identity. An administrator login is not the reader and
must never be used as fallback for the preflight.

The available `\\password` stdin method can avoid the previous browser-paste
ambiguity only if that authenticated, certificate-verified administrative
session is available and its credential is already protected. No such complete
admin TCP profile/passfile and independently trusted host path has been
verified. The previously validated TCP proxy mapping, loopback relay, pinned
CA, and `localhost` certificate identity are a candidate TCP route and do not
depend on SSH host-key trust. However, no protected administrator TCP
service/passfile has been verified. SSH is a separate fallback and remains
blocked by host-key trust. Do not substitute an unverified SSH connection or
weaken TLS. If the protected administrator TCP credential is unavailable,
stop and obtain a separately reviewed secure administrator route; do not
retry production authentication.

After a separately authorized attempt, the exact reviewed source at the
approved SHA must run the seven-setting service profile validator and then the
metadata-only preflight as the restricted reader. The profile contract is
exactly `host=localhost`, `hostaddr=127.0.0.1`, the approved local tunnel port,
database, reader role, `sslmode=verify-full`, and the verified CA path. The
passfile lookup is keyed by `localhost`, not `127.0.0.1`. The checks must bind
the expected database, server address, server port, TLS identity, current role,
read-only transaction, source commit, and exact reader privileges. Do not
print passfile contents or connection URLs.

The accepted restricted-reader service profile is exactly:

`pg_service.conf`:

```ini
[tq_release_preflight]
host=localhost
hostaddr=127.0.0.1
port=55432
dbname=APPROVED_DATABASE_NAME
user=tq_release_preflight_reader
sslmode=verify-full
sslrootcert=ABSOLUTE_PATH_TO_VERIFIED_PRODUCTION_ROOT_CA
```

The matching passfile key is
`localhost:55432:APPROVED_DATABASE_NAME:tq_release_preflight_reader:ESCAPED_PASSWORD`.
Keep the credential only in the existing protected passfile; do not substitute
the local route address `127.0.0.1` as the passfile host key.

Only the approved pre-026 SQL may then inspect database identity, PostgreSQL
version, migration metadata, catalogs, and receipt prerequisites. It must
require valid migration history through 025, migration 024 already applied,
026 the sole pending migration, and no partial migration-026 objects. It reads
no Student or Parent rows and changes no state. A failure or unexpected result
stops the sequence; never edit ledger rows or infer the result from startup
logs.

## 2. Backup-role routine review evidence

The backup role `tq_prod_backup_reader` is broader than the metadata reader: it
can read application tables, sequences, and Student data. Do not provision or
use it without separate owner/DBA approval. The existing
`backup-role-preflight.sql` checks effective read coverage, role membership,
large-object access, writes, grant options, RLS, foreign tables, and dangerous
function classes. It intentionally reports
`OVERALL_BACKUP_ROLE_NONWRITING=UNVERIFIED` until a human has reviewed the
actual user-routine bodies.

`backup-role-routine-review-export.sql` supplies that missing review material.
It runs in an explicit repeatable-read, read-only transaction with statement
and lock timeouts; requires the exact backup role and independently supplied
database/server identity; and exports routine definitions, owner, language,
security, volatility, configuration, ACL, and effective EXECUTE status. Its
inventory fingerprint is computed with the same ordered fields as the backup
role audit. The export must match the audit's
`BACKUP_ROLE_ROUTINE_INVENTORY_SHA256` exactly. The PowerShell backup tool pins
this SQL as a reviewed source input. The SQL does not read application table
rows or alter the database.

The fingerprint and export also bind each routine's `probin`/`prosrc` values
and its extension membership, extension version, extension schema, and
extension owner. Treat an extension-owned routine as requiring review of the
matching extension source package and deployed shared-library implementation;
catalog metadata and `pg_get_functiondef()` do not prove what native code
does. For every routine, follow executable call paths and dependencies,
including dynamic SQL and nested routines. Inspect `SECURITY DEFINER`
ownership, `search_path` configuration, effective `EXECUTE` grants, language
trust, writes to tables/sequences/large objects, role or configuration changes,
and filesystem, network, process, or global-state effects. Volatility labels
and a read-only caller transaction are not proof that an arbitrary routine is
side-effect free.

Routine bodies may contain sensitive literals. Store the protected routine definition export only in a new file in the approved encrypted, restricted evidence directory; never let the JSON package reach console, CI log, or public artifact storage. The export
is not itself approval. A qualified independent reviewer must compare every
definition and effective EXECUTE path with the exact application/tool source,
identify possible writes, dynamic SQL, external calls and extension effects,
and sign the existing 16-line evidence format. It binds reviewer ID, decision
`APPROVED`, scope `nonwriting-side-effects-and-source-integrity`, database,
backup role, server address/port, tool and application source SHAs, routine
inventory SHA, issue/expiry times (no more than seven days), reviewer public
key SHA-256, the public key, and the RSA/SHA-256 signature. The public-key
fingerprint must be approved and pinned separately; the evidence cannot
authorize its own key. The review module requires a current signature and the
separately pinned fingerprint. No review signature or reviewer approval
currently exists; do not fabricate one or use the export as a substitute.

For production backup, each canonical signed-payload SHA-256 may be claimed
once. The validator reconstructs the exact UTF-8/LF payload that was signed;
accepted CRLF and optional final-newline representations therefore share one
claim identity. The raw evidence-file SHA-256 remains separately recorded for
artifact provenance. Immediately before backup work, the tool atomically
creates a `CreateNew` use receipt keyed by the canonical payload digest in the
same protected directory as the signed evidence and verifies the receipt ACL.
A pre-existing receipt rejects replay. The receipt is durable and
intentionally not removed after a later backup failure; obtain a fresh
independent review and attestation for another attempt. Keep the evidence
directory stable and protected, on the verified encrypted local volume, and
retain its receipts. The use receipt prevents accidental reuse within that
directory; it is local operator evidence, not a defense against an
administrator who can replace or relocate the entire evidence directory.
Receipt creation or verification failure stops before the backup
snapshot/archive operation.
Before using the canonical-payload receipt scheme, inspect any legacy
`.tq-backup-role-review-<evidence-sha256>.used` receipts in the evidence
directory and reconcile their prior claims. The validator refuses to create a
canonical claim while any legacy-format receipt remains; do not delete a
receipt to bypass that stop.

### Independent reviewer handoff checklist

The owner/operator prepares the exact reviewed tool and application commit
SHAs, independently anchored target database/address/port, the catalog audit
result, and the protected JSON produced by
`backup-role-routine-review-export.sql`. The qualified independent reviewer
must then:

1. Confirm the export's `routine_inventory_sha256` equals the read-only audit
   marker and record the export file SHA-256 without publishing routine
   definitions.
2. Review every exported routine and every effective execution path. Inspect
   the actual source for trusted procedural languages; inspect the deployed
   package/shared library for `language=c` routines; follow extension name,
   version, schema, owner, `probin`, and `prosrc`; and trace nested calls,
   dynamic SQL, security-definer ownership and `search_path`.
3. Explicitly assess table, sequence, large-object, role, configuration,
   filesystem, network, process, and other global side effects. Any missing
   source/binary, unexplained dependency, inventory mismatch, or unknown
   behavior means **REJECT / UNVERIFIED**, not an inferred pass.
4. Independently control the signing key. Supply its public-key SHA-256 via an
   owner/DBA-approved out-of-band channel, then sign the exact bounded-lifetime
   evidence payload only after a documented approval. The reviewer must not
   use a key generated or selected by the operator for this attestation.
5. Return the signed evidence through the protected evidence directory. The
   operator validates it against the separately approved key fingerprint and
   exact target/source/inventory pins. This signature does not itself approve
   the backup, writer freeze, restore, migration, or deployment.

The human reviewer—not the owner or Codex—must attest to routine semantics and
transitive implementation behavior that catalog metadata cannot establish,
and must own the private signing key and approval decision.

## 3. Sequence-state write quiescence

The production backup script retains an unconditional hard-stop for
`CreateProductionBackup`. MVCC snapshots do not include sequence state. Do not
remove this stop until a separate implementation and operational review prove
an externally enforced writer freeze and before/after sequence evidence.

The Website being crashed does not prove writes have stopped. Known potential
writers in the checked-in application include:

- Website account/session/OTP, parent-child, teacher assignment, content,
  question/lesson lifecycle, announcement, activity-log, and Screen Time API
  paths.
- Mobile game API requests for `/api/game/progress`, `/api/game/result`,
  `/api/game/activity`, playtime sessions, and deletion tombstones.
- A GET to `/api/student-progress/:studentId` can save a regenerated AI
  insight. Polling `/api/learning-files/:id/generation-status` can restart a
  queued generation job. In-process question-generation work can update files
  and insert questions. Those jobs and their pollers must be drained/stopped.
- Manual deployment/migration/admin tools and direct administrator sessions.

The current Railway metadata snapshot lists only the Website API replicas and
PostgreSQL services and no scheduled job service. That does not rule out
external clients and writers, integrations, additional credentials,
database triggers, extensions, or out-of-band jobs. The full live writer
inventory is unknown.

Before any future approved production dump, the owner/DBA must document and
enforce a maintenance window in this order:

The sequence-state fingerprint must match exactly before and after the dump.

1. Stop ingress and all Website API replicas, prevent autoscaling/restart,
   disable automatic deploy for the window, and drain active requests. Stop
   mobile traffic by taking the API out of service; do not rely on client
   inactivity.
2. Stop and drain in-process lesson/question generation and related status
   polling. Inventory and pause external scheduled jobs, integrations, direct
   clients, administrative sessions, and any other writer. Check the actual production
   catalog for sequence inventory, triggers and non-application writers.
3. Keep only the separately approved backup reader connection. Block new
   writer-capable connections, terminate existing writer sessions under DBA
   authority, and verify no write-capable session or in-flight write
   transaction remains. Do not use the backup reader to terminate sessions.
4. Capture sequence state before the shared snapshot as an aggregate-only
   fingerprint of all sequence names, ownership, and
   `last_value`/`is_called` values. Maintain the external write barrier
   while the exported repeatable-read snapshot is opened, the manifest and
   `pg_dump` consume that same snapshot, and the archive/TOC/digest checks
   complete. Capture the same sequence fingerprint after the dump and require
   an exact before/after digest match.
5. Release the snapshot and remove the write barrier only after the approved
   operator confirms archive integrity and records the before/after evidence.
   If the writer inventory is incomplete, sessions cannot be blocked, the
   digests differ, or the barrier is interrupted, stop and reject the backup.

This is a proposed operational gate, not an implemented or tested production
freeze mechanism. Sequence quiescence remains unsatisfied, so the existing
script hard-stop remains necessary.

## 4. Backup storage, size and integrity

The owner has verified C: encryption and the local protected backup parent.
Current free capacity and destination reparse/ACL state were not independently
readable in this managed shell. Production database size is unknown because
the metadata query has not run. The backup script requires available space of
at least `2 × pg_database_size(current_database()) + 1 GiB` for archive and
restore-related artifacts. Do not use the old free-space estimate.

After the separately authorized restricted-reader connection and target
identity gate, the operator may collect only the current database byte size
and server version in a read-only transaction:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
WITH measured AS (
  SELECT pg_catalog.pg_database_size(current_database())::bigint AS bytes
)
SELECT current_database() AS database_name,
       current_setting('server_version_num') AS server_version_num,
       measured.bytes AS database_bytes,
       pg_catalog.pg_size_pretty(measured.bytes) AS database_size
FROM measured;
ROLLBACK;
```

`pg_database_size` reports bytes for the database and requires CONNECT on that
database (or `pg_read_all_stats`); do not grant additional privileges just to
run it. If it is denied, stop and leave capacity **unknown**. The owner can
read local free bytes without administrator elevation using:

```powershell
$volume = Get-Volume -DriveLetter C -ErrorAction Stop
if ($volume.FileSystem -ne 'NTFS') { throw 'STOP: backup volume is not NTFS.' }
[pscustomobject]@{
  FileSystem = $volume.FileSystem
  AvailableBytes = [int64]$volume.SizeRemaining
  TotalBytes = [int64]$volume.Size
}
```

Compare only those byte counts with the script's threshold. Do not include
database contents or connection information in the capacity record.

After the authorized restricted metadata connection succeeds, collect only
the current database size and identity metadata needed to calculate capacity;
do not query application rows. On the owner machine, read current volume
capacity and validate the exact encrypted destination's NTFS, ACL, reparse
status, and path outside the repository before any backup authorization. Stop
if capacity is below the script threshold or any storage check is unavailable.

The eventual backup requires PostgreSQL 18 client tools, the dedicated
reviewed backup role, verified service/TLS identity, a separately approved
recovery point and change, enforced writer quiescence, custom-format
`pg_dump` using the shared exported snapshot, archive SHA-256 and TOC
verification, and a protected evidence record. No production backup has been
created or verified. Do not put the archive, routine export, sidecars, or logs
in the repository or GitHub.

Restore into a new, isolated PostgreSQL 18 instance bound to loopback with no
route to production. It must be a separate empty `tq_restore_*` database,
non-admin local restore role, and distinct connection service. Verify archive
SHA and TOC before restore; use `pg_restore --single-transaction
--exit-on-error --no-owner --no-privileges`, never `--clean` or `--create`.
The rehearsal must validate restored schema/ledger/checksums, aggregate-only
table consistency, sequence states, large objects, routine/catalog
fingerprints, and all source-vs-restore checks without emitting row data.
Keep the target isolated until independently reviewed. Synthetic PostgreSQL
16/18 CI and PostgreSQL 18 synthetic archive-integrity tests are not a restore
of production data. No production archive or isolated production restore
exists yet.

## 5. Migration 026 and post-migration verification

Migration 026 is the additive receipt-table migration for game-progress save
idempotency. Do not execute it until all of these are separately authorized and
verified:

1. Exact clean reviewed source, passing exact-head backend/frontend CI, and
   secure restricted-reader preflight.
2. Ledger versions, filenames and canonical checksums through 025 match
   source; 024 and 025 are applied; 026 is the only pending migration; the
   receipt table/constraints are wholly absent, not partial.
3. Approved production backup archive passes SHA/TOC checks and a separate
   isolated PostgreSQL 18 restore rehearsal passes.
4. Backup-role routine review is signed and verified against the exact
   inventory fingerprint. Writer freeze and before/after sequence state pass.
5. Runtime role privileges for the exact migration and route are reviewed;
   no production test writes are used.
6. Owner separately approves migration 026 alone, target identity, exact
   checksum/source, change reference, monitoring window, operator and
   rollback owner.

Use the reviewed recovery-specific executor
`capstone/backend/scripts/recoveryMigration026.js`, not a generic runner that
could apply other pending migrations. It must assert the exact pending list is
`[26]`, verify prior checksums, take its advisory lock, apply only migration
026 transactionally, and preserve `OUTCOME UNKNOWN` if a COMMIT response is
lost. Migration 024 remains prohibited. After a separately authorized run,
verify the complete receipt-table/constraint/index contract and effective
runtime permissions read-only before considering a deployment.

The reviewed recovery executor's PostgreSQL client configuration requires an
explicit loopback host, the `localhost` TLS server name, the pinned CA, and
`rejectUnauthorized: true`. The general controlled release migration config
also verifies the pinned self-signed CA before enabling TLS verification.
Never replace these checks with `rejectUnauthorized: false`, or treat
PostgreSQL `sslmode=verify-full` as equivalent to an unverified Node TLS
connection.

## 6. Website and mobile restoration

The fastest safe route is still blocked by unresolved reader authentication,
no verified production backup/restore, no signed backup-role review, and no
sequence-quiescence implementation. A deployment rollback is not yet a
verified alternative: a previously removed deployment is not proof that its
startup schema contract matches the live database, and older code may not
preserve save-idempotency semantics. Do not redeploy an older image merely to
see whether it starts.

After migration and post-migration verification, separately approve one exact
source deployment with Auto Deploy confirmed off and no other deployment
queued. Check startup logs, configured health endpoint and replica health.
Never disable startup schema validation. Keep the receipt table on code
rollback; a database restore is a separate disaster-recovery operation.

Using only synthetic/test accounts and mocked AI where applicable, acceptance
must cover:

- Website account creation, login/session/OTP, and role authorization.
- Mobile authentication and API compatibility for the deployed game client.
- Save creation with a unique commit ID; exact retry returns the same receipt;
  altered payload under the same ID is rejected; progress and activity persist
  exactly once.
- Game-result, activity, playtime-session and tombstone flows, including
  persistence across API restart.
- Admin/Teacher Student Progress authorization, linked Parent read-only access,
  and denial of unrelated Students.
- Current-cycle evidence, AI Strengths/Weaknesses/Recommendations grounded in
  synthetic results, generation availability/cache failure states, and upload
  processing. No real Student record or live AI call.

Record exact deployed SHA, test fixture identifier, sanitized results, and
redacted evidence in the restricted release record. Production acceptance has
not occurred.

## 7. Railway backup/PITR and next gates

Read-only service metadata currently confirms PostgreSQL online and Website
crashed. It does not establish Railway backup/PITR configuration. The
documented `railway postgres pitr status` command is read-only, but the last
Codex CLI attempt could not reach Railway because of DNS/network failure. The
owner may inspect the current Backups/PITR status in Railway dashboard or run
the documented status command from their authenticated normal shell; do not
enable PITR or change settings. Preserve sanitized status and timestamps only.

The next smallest safe actions are:

1. Owner/DBA resolves the secure administrative connection prerequisite and,
   under fresh explicit authorization, performs at most one password-only
   synchronization followed by one restricted-reader authentication and
   metadata-preflight attempt. The tested stdin `\\password` method avoids
   browser clipboard ambiguity but requires a verified administrative
   TLS-verified route and its already protected credential. No such route is
   currently verified; no retry/reset is authorized now.
2. If preflight passes, produce the exact metadata-only database-size and
   migration/schema results. Have the owner verify current encrypted disk
   capacity and the backup destination checks.
3. Obtain separate DBA approval for backup-role use, perform the routine
   export only to protected encrypted storage, and obtain the independent
   signed review. Implement/review/enforce the sequence freeze without
   removing the backup hard-stop prematurely.
4. Separately authorize production backup, then isolated restore rehearsal;
   only after both pass consider separately authorizing migration 026, its
   post-checks, deployment, and synthetic website/mobile acceptance.

No production credential reset, authentication retry, SQL, backup, restore,
migration, role/grant change, restart, deployment, merge, Student-row access,
or Railway configuration change has been performed by this preparation.
