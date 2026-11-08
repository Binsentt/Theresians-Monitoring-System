# Database release preparation and SWR acceptance

This runbook is preparation only. It does not authorize a production connection,
role/grant change, backup, migration, deployment, Student query, or live AI call.

## Known boundary and current state

- Source reviewed for this package: GitHub `main` at
  `8a9ab3b6a3cfa3a6652538c62673c4655b03642d`.
- The recovered Railway Website was last confirmed online on application SHA
  `98f9b221656293219ea8e481647503b3c5e7164d` by read-only Railway metadata.
- Railway showed no managed database backup; no backup or restore rehearsal is
  verified.
- The owner reported migration records through 025 and no visible 026 entry.
  This is not a verified ledger/checksum result.
- `release-migration-preflight.sql` is the post-026 preflight (18 tables, 278
  columns, receipt table required). Run the new
  `release-migration-026-prerequisite-preflight.sql` before migration 026; run
  the existing official preflight only after an independently approved 026
  migration.
- The new scripts are currently local and uncommitted. Their wrappers refuse
  modified or untracked release inputs. Do not use them against production until
  they are reviewed, committed, and run from the exact approved clean commit.
- No PostgreSQL server/container is available in the Codex execution
  environment. The existing GitHub Actions backend workflow has an isolated
  Docker/PostgreSQL harness, now extended locally for pre/post-migration checks
  and synthetic archive/restore. Those exact-source CI scenarios must execute
  before this package can claim PostgreSQL runtime verification.

## 1. Role review and separate provisioning approval

The preflight identity is `tq_release_preflight_reader`. It must be a dedicated
login with `NOINHERIT`, no role memberships, and no superuser, database/schema
creation, role creation, replication, or RLS bypass attributes. Its only
application relation privilege is column-level `SELECT` on
`public.schema_migrations(version, filename, checksum)`.
Catalog visibility comes from PostgreSQL's built-in catalog access. It must
have database `CONNECT` and `public` schema `USAGE`, but no database `CREATE` or
`TEMP`, schema `CREATE`, table write/reference/trigger privileges, or sequence
privileges. It must not read `accounts`, `game_results`, `playtime_sessions`, or
any other Student/application table. It must not be able to execute
application-schema `SECURITY DEFINER` functions, which could otherwise expose
rows despite having no table SELECT grant.

First, an authorized DBA may check role metadata using a read-only query that
does not read password hashes:

```sql
BEGIN READ ONLY;
SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
       rolreplication, rolbypassrls
FROM pg_catalog.pg_roles
WHERE rolname = 'tq_release_preflight_reader';
SELECT pg_catalog.pg_get_userbyid(member) AS member_role,
       pg_catalog.pg_get_userbyid(roleid) AS granted_role
FROM pg_catalog.pg_auth_members
WHERE member = (SELECT oid FROM pg_catalog.pg_roles
                WHERE rolname = 'tq_release_preflight_reader');
ROLLBACK;
```

No row means the role is absent. Do not create or repair it in this procedure.
If absent or if any privilege check fails, stop and obtain separate written
owner/DBA approval. The approved provisioning change, if later authorized, is
limited to this shape; replace the database placeholder with the independently
confirmed database name in the DBA session:

```sql
CREATE ROLE tq_release_preflight_reader LOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE :"target_database" TO tq_release_preflight_reader;
GRANT USAGE ON SCHEMA public TO tq_release_preflight_reader;
GRANT SELECT (version, filename, checksum) ON TABLE public.schema_migrations
  TO tq_release_preflight_reader;
```

Pass the database identifier through the DBA's approved `psql` session as
`-v target_database=APPROVED_DATABASE_NAME`; psql's quoted-identifier
substitution avoids interpolating an untrusted database name as SQL syntax.
Set its password interactively in `psql` with `\password
tq_release_preflight_reader`; never put a password in SQL, a command argument,
GitHub, chat, or a file in the repository. Do not apply broad `REVOKE` commands
to fix an existing role. If inherited/public grants, membership, or any extra
effective privilege appears, stop for DBA review. After separately approved
provisioning, connect as that role and run `release-preflight-role-audit.sql`.
The audit requires exactly those three ledger columns and rejects table-wide
ledger SELECT, SELECT on extra ledger columns, application table/column reads,
or executable application-schema `SECURITY DEFINER` functions. It must pass
before either schema preflight is run.

The separate backup role is `tq_prod_backup_reader`. It has SELECT access to
every application table and SELECT on every sequence, so it can read Student
data. Its use and any provisioning require separate explicit approval. It must
be non-admin, non-inheriting, have no memberships or writes/DDL, and must not be
subject to row-level security or foreign tables that could make `pg_dump`
incomplete. `backup-role-preflight.sql` checks effective privileges but does
not grant them. Never reuse the schema-only preflight role or the application's
database credential for a backup.

## 2. Private tunnel and Windows libpq configuration

The owner previously established the private Railway SSH tunnel at
`127.0.0.1:55432`; keep that owner-managed tunnel open. No public PostgreSQL TCP
proxy is needed. Before using it, confirm the Railway project, production
environment, Postgres service, and tunnel destination in the Railway UI. The
local forwarded port is 55432; the expected PostgreSQL server port passed to
the SQL checks is normally 5432. `inet_server_addr()` is the address seen by
PostgreSQL and can differ from local `127.0.0.1`; obtain and compare it with the
approved Railway database endpoint. Do not guess this fingerprint.

Create the client files outside the repository, for example under
`%APPDATA%\postgresql`:

`pg_service.conf` (no password):

```ini
[tq_release_preflight]
host=127.0.0.1
port=55432
dbname=APPROVED_DATABASE_NAME
user=tq_release_preflight_reader
connect_timeout=5
application_name=tq-release-preflight
```

`pgpass.conf` (one protected local line; enter the password only in a trusted
local password manager/editor, never in CMD or PowerShell history):

```text
127.0.0.1:55432:APPROVED_DATABASE_NAME:tq_release_preflight_reader:ESCAPED_PASSWORD
```

In the pgpass line, escape a literal colon as `\:` and a literal backslash as
`\\`. Restrict the file ACL to the owner and SYSTEM, with inheritance disabled;
do not put credentials in the service file. Set `PGSERVICEFILE` and
`PGPASSFILE` only to these file paths. The wrapper refuses an inherited
`PGPASSWORD` variable and does not print credential values.

Before the preflight, verify the local forward is open without authenticating:

```powershell
Test-NetConnection 127.0.0.1 -Port 55432
& 'C:\Program Files\PostgreSQL\18\bin\pg_isready.exe' -h 127.0.0.1 -p 55432 -d APPROVED_DATABASE_NAME -U tq_release_preflight_reader
```

Then use the exact clean, reviewed release commit. The working directory is the
backend folder in that commit. The command below contains placeholders only;
never paste a connection URL or password into it:

```powershell
& '.\scripts\run-release-preflight.ps1' `
  -Stage PreMigration026 `
  -ServiceName tq_release_preflight `
  -ExpectedDatabase 'APPROVED_DATABASE_NAME' `
  -ExpectedServerAddress 'APPROVED_POSTGRES_SERVER_ADDRESS' `
  -ExpectedServerPort 5432 `
  -PassfilePath "$env:APPDATA\postgresql\pgpass.conf" `
  -ServiceFilePath "$env:APPDATA\postgresql\pg_service.conf" `
  -ExpectedSourceCommit 'APPROVED_CLEAN_SOURCE_SHA'
```

The source SHA, database name, server address, server port, role, read-only
state, and timeouts are checked before metadata inspection. The role-audit SQL
then verifies effective privileges. The pre-026 SQL reads only `pg_catalog`
and `schema_migrations`, confirms the 17-table/269-column pre-026 contract,
checks migration filenames/checksums 018–026, requires 024/025 applied and 026
pending, and stops on partial receipt objects. It does not select application
rows or apply migrations. Preserve output only in the access-restricted change
record; do not attach it to public issues or CI.

If 024 or any unexpected version is pending, a checksum/ledger differs, 026 is
already recorded, receipt objects are partial, or any identity/privilege/schema
check fails, STOP. Do not repair schema, edit the ledger, or infer the result.

## 3. Backup and isolated restore gate

No production backup or restore has been verified. Before migration 026, the
owner must approve the backup operation, recovery point, operator, and encrypted
storage destination. A volume existing in Railway is not evidence of a usable
backup. A backup without a successful isolated restore rehearsal is not release
readiness.

Use only PostgreSQL 18 client tools and the dedicated backup role. The backup
destination must be a non-temporary, non-CI directory on encrypted storage with
restricted ACLs. The script refuses overwrite, requires a change reference and
explicit switches, checks `tq_prod_backup_reader` against all relations and
sequences, creates a custom-format archive, lists its TOC, and writes a SHA-256
sidecar. Keep the archive, TOC, digest, and logs out of Git, GitHub artifacts,
chat, and ordinary project folders. The backup role reads Student records.

After separate approval, from a clean reviewed commit with the approved
backup/restore role and external service/pass files configured, the operator
would use the `CreateProductionBackup` action with
`-ExecuteApprovedProductionBackup -EncryptedStorageConfirmed`, the approved
change reference, and the external encrypted directory. No such command is
authorized by this preparation task.

Restore only into a separately created, disposable PostgreSQL 18 target reachable
through `tq_restore_local` at a loopback address. The database must have a
`tq_restore_*` name, be empty, and use a local non-admin, `NOINHERIT` restore
role with CREATE on the disposable `public` schema only. Do not configure the
restore alias to Railway or any production host. The script rechecks the archive
SHA-256 and TOC before using `pg_restore --single-transaction --exit-on-error
--no-owner --no-privileges`; it refuses `--clean` or `--create`, verifies the
restored migration ledger/receipt table read-only, and never drops or creates a
database. A restore failure leaves the disposable target for operator
inspection; do not repoint it at production. A full post-restore source preflight
and checksum review is required before treating the rehearsal as complete.

Docker/Podman and a local PostgreSQL server are unavailable in the Codex
environment, so the PowerShell dump/restore utility has static/parser tests
only. The owner must provide an approved disposable PostgreSQL 18 restore host
with no external route, or install/enable an approved local container runtime
and use a no-network container. Do not install or download one as part of this
task.

## 4. Migration 026: separate approval and controlled procedure

Migration 026 is additive: it creates `public.game_progress_save_commits` with
the columns, unique keys, foreign key, and checks used by `/api/game/progress`
save idempotency. It does not update/delete existing Student, Game result,
progress, session, or activity rows. Its account foreign key cascades deletion
of receipt rows if an account is later deleted. Application startup does not
run this migration or repair schema.

Migration 026 is not approved here. It may be considered only after all these
gates are separately approved and evidenced:

1. Exact clean release commit and passing Node 20 backend/frontend CI.
2. Pre-026 preflight passes from the dedicated metadata-only role; 024 and 025
   checksums match and 026 is the only expected pending version.
3. The receipt table and all named receipt objects are absent (not partial).
4. A production backup archive passes SHA/TOC verification and restores into
   the isolated PostgreSQL 18 target; schema and ledger/checksums are reviewed.
5. Runtime role effective privileges can use the receipt table without startup
   DDL. Confirm required `SELECT`, `INSERT`, `UPDATE` and any conflict handling
   privileges from the exact route SQL; do not issue production test writes.
6. Owner approves migration 026 alone, the exact database fingerprint, source
   checksum, approval reference, maintenance/monitoring window, and rollback
   owner.

After approval only, the controlled `npm run migrate:release` runner must be
used from the approved source, with transient values read from the secure
operator store: `RELEASE_MIGRATIONS_APPROVED=true`, approval reference, exact
database/user/server/port fingerprint, and
`RELEASE_EXPECTED_PENDING_MIGRATIONS=26`. Do not set migration-024 flags or run
024. The runner takes its advisory lock, verifies existing migration checksums,
compares the actual pending list exactly to `[26]`, and applies only that list.
Do not run it with the production application's DATABASE_URL or administrator
credentials. On any mismatch, stop and inspect metadata; never edit
`schema_migrations` manually.

Immediately afterward, run the role audit and existing post-migration
`release-migration-preflight.sql` from the same reviewed source. Confirm all
receipt table columns/constraints and 18 tables/278 columns. This is still not a
deployment authorization.

## 5. Deployment and recovery gates

Railway's read-only metadata last showed the recovered Website service online
on the prior source SHA. Its deployed config is `main`; Auto Deploy was
owner-reported disabled but is not exposed by the read API. Before any merge or
manual deployment, the owner must verify the Website and Postgres services'
source repo/branch, Auto Deploy OFF, no queued/running deployments, and the
exact current and proposed deployment SHAs in the Railway dashboard. Preserve
the currently online deployment until migration and the deployment are
separately approved.

Before deployment, confirm production runtime permissions against exact current
route SQL and perform a synthetic save/retry integration in disposable
PostgreSQL. Deploy only the approved SHA manually after the migration and
post-migration preflight gates. Check `/api/health` (or the configured Railway
health path), startup readiness, logs for schema compatibility, and a
non-production synthetic account path. Do not use a real Student account to
test saves.

Application rollback does not roll back migration 026 or remove the receipt
table. Keep it in place. Rolling back to older backend code may stop enforcing
`save_commit_id`, so coordinate with the Game client version and preserve
backend idempotency protection. Database restore is a separate disaster
recovery operation and must never overwrite production without its own explicit
approval.

## 6. Student Progress and Parent browser acceptance

Only after a separately approved deployment and designated synthetic/test
Student data are available:

1. Sign in as Admin and Teacher; confirm each sees only authorized Student
Progress records.
2. Use a test Student with five or more validated Mathematics attempts on a
canonical topic and at least 80% accuracy. Confirm the topic strength cites
only that evidence. Use a separate synthetic Student below the threshold and
confirm no topic strength is shown.
3. Submit known incorrect answers with valid canonical question, set, Grade,
   Difficulty, and Topic metadata. Confirm weaknesses cite the incorrect
   evidence, and each recommendation addresses a confirmed weakness.
4. Include results without valid topic metadata; confirm they can contribute
   only to supported general metrics and display an explicit topic evidence
   gap, never an inferred topic.
5. Refresh AI Insight. Confirm current-cycle evidence is reloaded, another
   Student's insight cannot appear, stale evidence is not presented as current,
   and AI paused/provider failure is labeled accurately while deterministic
   grounded evidence remains available.
6. Confirm Performance by Map, Latest Activity, Score Over Time, and Per-Quest
   Evidence use accepted saves/current cycle; exploration tasks show completion
   without invented quiz scores.
7. Sign in as a Parent linked to the test Student. Confirm only the linked
   child's progress is visible and every Parent control remains view-only;
   verify an unrelated child is denied.
8. Confirm a zero-result Student sees a truthful insufficient-evidence state.
9. Record the deployed source SHA, test account/data fixture, screenshots with
   personal identifiers redacted, and results in the restricted release record.

Never create, edit, reset, or backfill real Student records for acceptance.
This plan has not been run against production or live AI.

## 7. Remaining owner approvals and shortest order

1. Approve review/publication of the local preparation files to a clean release
   branch/PR so the exact scripts and new CI scenarios are immutable and
   testable. No commit/push is authorized by this run.
2. If needed, separately authorize the DBA to provision/repair the
   metadata-only preflight role. Verify it by connecting as that role; stop on
   extra privileges.
3. Separately approve creating the broad read-only backup role, production
   logical backup, and encrypted destination. Separately approve the isolated
   restore rehearsal. These actions handle production Student data.
4. Review the exact-source isolated CI result, including the pre-026 synthetic
   PostgreSQL cases, then approve only migration 026 if every gate passes.
5. Run post-migration read-only schema verification.
6. Separately approve manual Railway deployment of one exact commit with
   Auto Deploy confirmed off.
7. Perform Student/Teacher/Parent browser acceptance with designated test
   accounts and separately approve any live AI-provider call.

Until the production preflight, backup, and restore gates pass, migration and
deployment are not release-safe. The recovered Website should remain online on
its existing deployment.
