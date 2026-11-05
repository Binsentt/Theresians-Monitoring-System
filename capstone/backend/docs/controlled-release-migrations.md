# Controlled release migrations

This procedure separates ordinary Railway application deployments from database migrations. It does not itself authorize a production migration or deployment.

## Startup schema safety and the Railway deployment incident

The production-linked Railway services both started a deployment for commit
`9f4075ff` at `2026-11-04T07:37:35.152Z`, about two seconds after PR #32 merged to
`main`. The primary deployment succeeded and serves the production domains; the
secondary service crashed. Both deployment records report `reason=deploy` and
source branch `main`. The only tracked GitHub workflow is isolated backend CI,
not a deploy workflow. Railway's read API does not expose the Auto Deploy toggle.
The owner has confirmed Auto Deploy is disabled on both services, but that could
not be independently verified through the API.

The secondary logs repeatedly report schema initialization failure and legacy
cleanup skipped, with the error detail blank. The primary logs show the server
listening. Available metadata does not identify whether the deployment was
started by Railway's Git integration, a manual dashboard action, CLI/API action,
or a queued/redeploy operation. Treat the trigger as unresolved. Before another
`main` merge, an operator must inspect Railway's deployment/audit timeline at
the timestamps above, confirm the source/repository/branch and Auto Deploy state
for both services in the dashboard, and verify no deployments are queued or
running. If that evidence does not explain the event, keep `main` unchanged and
have the Railway owner choose an approved deployment-control change. No Railway
configuration was changed during this work.

On `main` before this remediation, importing `server.js` called `ensureSchema()`
and then ran `permanentlyDeleteLegacySixDigitStudents()` after schema readiness.
PR #34 removes that deletion path. This startup-safety change is based on PR #34
and removes the remaining schema writes. The replacement startup check performs
one parameterized `SELECT` against `pg_catalog` to confirm the required tables
and columns exist. It does not create or repair schema. Missing requirements
cause readiness to fail, the listener is not started, and the database pool is
closed.

The compatibility check proves table/column presence only. It does not prove
every SQL type, default, index, trigger, or foreign-key definition; compare those
to the migration ledger and catalog in the existing read-only preflight before
deployment. This PR must not be deployed until that preflight confirms the live
schema is compatible or separately reviewed migrations cover every missing
prerequisite.

### Removed startup database writes

The previous `ensureSchema()` had 177 direct `pool.query` call sites. One is a
loop over announcement-repair statements, so the actual query count could be
higher depending on that statement list. Its SQL contains 15 `CREATE TABLE IF
NOT EXISTS` statements, 39 index statements (31 ordinary and 8 unique), 115
`ALTER TABLE` statements (including statements inside 2 guarded `DO` blocks),
and 8 fixed `UPDATE` statements. It also awaited a Parent-code backfill that ran
one `SELECT` and one `UPDATE` per missing Parent ID. The fixed updates normalized
nullable account flags and cycle versions, cleared malformed Parent IDs,
copied legacy trash timestamps, and populated learning-file
generation/publish/deletion state. None of these repairs/backfills now run at
startup, and they have not been silently converted into a production migration:
the live schema/data state is unknown, so any replacement migration set must
follow the authorized preflight and isolated restore rehearsal.

`ensureSchema()` itself did not contain `DELETE` or `TRUNCATE`. The separate
six-digit Student cleanup was startup-triggered on `main` and is removed by PR
#34. Migration 024 remains destructive: it deletes qualifying legacy Student
accounts and directly related `game_results` and `playtime_sessions`; foreign-key
cascades can extend the impact. Keep its existing approval, count, cascade-review,
and write-quiescence gates.

Ordinary authenticated route writes remain route-scoped, not startup work.
Lesson-generation jobs are scheduled in response to requests; `server.js` has no
process-start timer. Startup still creates/checks the uploads directory on the
filesystem, which does not alter the database.

### Startup-safety test isolation

The synthetic schema helper requires `NODE_ENV=test`, `CI=true`, a loopback
allow-listed `tq_*_test_ci` database, and a run-specific database comment marker.
CI creates and stamps the database inside its disposable PostgreSQL 16 container,
which has no external network. The new startup integration test seeds only
synthetic records, starts the app as a `SELECT`-only role with read-only
transactions, checks readiness for a complete schema and rejection for an empty
schema, and verifies the sentinel records did not change. It does not contact
Railway or school data.

The compatibility refactor intentionally blocks service startup on an
incomplete schema. Do not merge/deploy this change until the operator has
verified that the currently deployed database already has the required shape
and historical backfills, or separately approved migration work has been
prepared and rehearsed against an isolated restore.

## Release controls

- Keep Railway Auto Deploy disabled for both production-linked services: overflowing-insight and natural-imagination. Do not re-enable it.
- Ordinary application deployments must not invoke migrate:release. The Railway config in this change removes its pre-deploy migration command.
- The supported migration entry point remains npm run migrate:release, but it now requires explicit approval, a change reference, an exact target fingerprint, and the exact pending-version list.
- If version 024 is pending, execution additionally requires an explicit migration-024 approval, owner-reviewed cascade counts, a write-quiescence attestation, and direct count values that still match immediately before execution.
- Do not put DATABASE_URL or other credentials in command history, repository files, GitHub Actions, logs, or chat. Load them only from an approved operator secret store into the process environment.

The Railway dashboard’s Auto Deploy toggle is not exposed by the read-only service API. An owner/operator must confirm it remains disabled in the UI before a release.

## Exact read-only operator preflight

Use a dedicated non-admin PostgreSQL login role with SELECT-only access, no role memberships, no schema/database CREATE privilege, no table write privileges, and no sequence USAGE/UPDATE privilege. The SQL package performs read-only inspection and returns aggregate counts/schema metadata only. It never returns Student IDs, names, or other row values.

From capstone/backend in a trusted clean checkout of the exact release source:

    PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000' \
      psql 'service=APPROVED_READ_ONLY_SERVICE' -X -q -P pager=off \
      -v ON_ERROR_STOP=1 \
      -v expected_database='APPROVED_DATABASE_NAME' \
      -v expected_role='APPROVED_READ_ONLY_ROLE' \
      -v expected_server_address='APPROVED_SERVER_ADDRESS' \
      -v expected_server_port='5432' \
      -f scripts/release-migration-preflight.sql

The service alias must be configured through the approved secure operator mechanism. Do not substitute a password-bearing URI on the command line. The SQL begins `BEGIN READ ONLY`, verifies the expected database, role, TCP server address and port, and fails with nonzero status on a missing/malformed ledger, required startup object, core type mismatch, migration filename/checksum mismatch, or newer ledger version. Confirm the returned target fingerprint and PostgreSQL version against the approved change record. The script emits metadata and aggregate counts only; store output only in the restricted operations record.

The script lists versions 018–025 in this PR #35 source tree, filenames, ledger checksums, and pending state. Migration 026 from PR #31 is intentionally excluded. Compare applied checksums to the exact source file bytes in the same clean checkout:

It also compares the startup compatibility contract (17 tables and 269 required
columns) to `pg_catalog`, returning counts and missing schema-object names only.
Any missing table or column is a stop condition. Core runtime types are checked
explicitly; the script emits all visible column types, nullability, defaults,
constraints, indexes, and triggers for review. It does not claim that every
table's complete canonical shape has been validated. See
`startup-schema-inventory.md` for source gaps and required follow-up.

    sha256sum \
      migrations/018_website_sessions_and_audit_metadata.sql \
      migrations/019_playtime_history_removal.sql \
      migrations/020_add_auth_otp_challenge_security.sql \
      migrations/021_canonical_milestones_and_activity_contract.sql \
      migrations/022_game_telemetry_contract.sql \
      migrations/023_quest_evidence_and_playtime_tombstones.sql \
      migrations/024_remove_legacy_six_digit_students.sql \
      migrations/025_add_game_result_question_traceability.sql

A missing schema_migrations ledger is a stop condition; do not infer all versions are pending and do not let the release runner create the ledger. A ledger filename/checksum mismatch, unknown version newer than this checkout, or incomplete migration output is a stop condition.

### Migration 024 impact

If version 024 is pending, the preflight emits count-only results for:
- candidate Student accounts with a trimmed six-digit game_student_id;
- game_results rows matched by resolved_student_id;
- playtime_sessions rows matched by student_id;
- each actual direct foreign-key edge into accounts, game_results, and playtime_sessions, including its ON DELETE action;
- the full recursive CASCADE edge graph.

Migration 024 physically deletes candidate accounts and the direct game_results/playtime_sessions rows. The SQL deliberately exits with status 4 whenever 024 is pending, after printing the counts and graph. This is not a successful deployment preflight: the operator must count every recursively affected row and each SET NULL/SET DEFAULT effect, inspect RESTRICT/NO ACTION edges, and document the complete impact before a separate deletion approval. The guarded migration runner only rechecks the three direct deletion counts, so it is not a substitute for full impact review. Stop if any edge or descendant cannot be fully counted or if concurrent writes are possible.

The exact-count guard in the migration command compares the three direct counts again immediately before applying the migrations. The required write-quiescence value is an operator attestation; it does not itself block application writes. Because an application write can race a count check, do not run 024 while matching save writes remain possible. Use an owner-approved maintenance/write-quiescence procedure, or keep 024 blocked until the migration is redesigned with an atomic impact guard.

### Later migration 026 integration

PR #35 does not contain migration 026 and its current startup gate is 17 tables / 269 required columns. When PR #31 is rebased and reviewed against this source, the combined startup contract must be updated to 18 tables / 278 columns only as part of that approved integration. It must not be activated before migration 026 is separately approved and applied. Migration 026 adds the student/cycle/save-ID receipt table and cascades receipt deletion with account deletion; the owner must separately approve receipt retention and account-deletion behavior.

## Explicit migration command gate

Run the command only from a controlled operator environment using the exact source commit that contains the approved migrations. The code takes the release advisory lock, verifies the ledger and checksums, compares the live database identity to the supplied target fingerprint, and requires the actual pending versions to exactly match the separately approved list. It applies only that pending list. Any mismatch stops before migration SQL executes.

Set the following transient environment values from the approved change record and read-only preflight; do not save them to the repository or GitHub:

    RELEASE_MIGRATIONS_APPROVED=true
    RELEASE_APPROVAL_REFERENCE=CHG-APPROVAL-ID
    RELEASE_EXPECTED_DATABASE=APPROVED_DATABASE_NAME
    RELEASE_EXPECTED_DB_USER=APPROVED_MIGRATION_ROLE
    RELEASE_EXPECTED_SERVER_ADDRESS=APPROVED_SERVER_ADDRESS
    RELEASE_EXPECTED_SERVER_PORT=5432
    RELEASE_EXPECTED_PENDING_MIGRATIONS=18,24,25

The example values above are placeholders, not production values. Use the actual full pending version list from the preflight, in ascending order, or use none when there is nothing pending. Never copy the example list as approval.

When version 024 is pending, also require all of these transient values:

    RELEASE_MIGRATION_024_APPROVED=true
    RELEASE_MIGRATION_024_CASCADE_REVIEWED=true
    RELEASE_MIGRATION_024_WRITES_QUIESCED=true
    RELEASE_EXPECTED_024_ACCOUNT_COUNT=COUNT_FROM_APPROVED_PREFLIGHT
    RELEASE_EXPECTED_024_GAME_RESULTS_COUNT=COUNT_FROM_APPROVED_PREFLIGHT
    RELEASE_EXPECTED_024_PLAYTIME_SESSIONS_COUNT=COUNT_FROM_APPROVED_PREFLIGHT

Those values require separate human approval. The cascade-reviewed and writes-quiesced flags are attestations, not machine-enforced policies. The command refuses to apply 024 if any are missing or if direct counts changed. If 024 is pending and the owner has not approved a reliable write-quiescence procedure, stop.

After loading DATABASE_URL and the transient approval values from the authorized secret store, run:

    npm run migrate:release

Do not pass credentials as command-line arguments. The runner does not print the database identity, DATABASE_URL, or raw SQL results. It reports only the approved migration versions completed. On any failure, inspect the ledger and schema before considering a retry; do not edit schema_migrations manually.

## Backup and isolated restore rehearsal

Before any writable operation:

1. The database owner selects the backup point-in-time and approved backup operator.
2. Take a provider-native or logical backup under the organization’s data-handling rules. Keep it out of the repository and CI artifacts.
3. Verify completion and integrity; record the backup digest and target identity in a restricted operations record.
4. Restore it to a separately isolated disposable database.
5. Run read-only preflight there, then rehearse the exact approved migration set on the disposable restore under a separately authorized test operation.
6. Compare schema, ledger checksums, and count-only deletion impact before and after. Confirm that restoration to the selected point-in-time works.
7. Keep the backup until post-deployment verification and the owner’s recovery window have passed.

Migration 024 deletion is not undone by application rollback. Migration 026 is additive and should remain after code rollback. An older backend that does not enforce save_commit_id can reintroduce duplicate writes for newer game clients, so backend rollback requires a coordinated compatibility plan.

## Controlled rollout order

1. Review this release-gating PR and its isolated CI.
2. With the owner’s approval, merge the gate PR while Auto Deploy remains disabled. A merge must not deploy the service.
3. Separately approve a manual rollout of this gate-only main commit to the primary service. This deployment activates the Railway config without a migration command; monitor the existing website/API health throughout. Do not manually deploy the second service without owner approval.
4. Run and review the read-only database preflight. Stop on any mismatch, unknown migration, or unapproved migration-024 impact.
5. Complete the verified backup and isolated restore rehearsal.
6. Recheck PR #31 head, mergeability, and checks. Separately approve and merge it; keep Auto Deploy disabled.
7. Re-run read-only preflight against the exact production target. Approve the exact pending migration list and any 024 impact independently.
8. Execute npm run migrate:release from the approved merged source commit using the explicit target and approval inputs. Verify ledger/checksums and the receipt table.
9. Separately approve a manual Railway deploy of the PR #31 backend code. The activated config must have no migration pre-deploy command. Verify health and a synthetic save/retry path before client rollout.
10. Recheck and separately approve game PR #20. Its merge creates the Android Internal Testing APK artifact. Verify the artifact before any distribution.

## Verification boundary

The backend CI and isolated PostgreSQL idempotency tests are evidence for code behavior, not production database readiness. No migration, deployment, or production database access is part of this document.
