# Migration 026 recovery runbook

**Current status: production NO-GO. Every gate below is PENDING.** This runbook describes a later, separately authorized operation. It does not authorize connecting to production, taking/restoring a backup, running SQL, or applying a migration now.

## Gates

| Gate | Required evidence | Status |
| --- | --- | --- |
| A — CA trust | Protected local PEM-only root CA; exact approved SHA-256 pin; `verify-full` semantics for the Railway tunnel at `localhost`. | PENDING |
| B — Reader | Independently authenticated `tq_release_preflight_reader`; exact TLS and target identity; role audit confirms read-only metadata access. Never substitute the application URL or owner account. | PENDING |
| C — Read-only preflight | Separately approved exact-source preflight; database identity; ledger 018–025 filenames/checksums; 024 and 025 applied; 026 sole pending; pre-026 17-table/269-column schema; no partial 026 objects; matching report and SQL hashes. | PENDING |
| D — Recovery copy | Separately approved PostgreSQL 18 logical backup, verified archive, protected destination, and successful restore into a fresh isolated loopback-only PostgreSQL 18 database with reviewed aggregate-only checks. | PENDING |
| E — Migration 026 | Separate written authorization naming the exact source SHA, artifact digest, target identity, preflight/backup/restore evidence, runtime permission plan, and migration 026 only. | PENDING |
| F — Post-migration | Read-only schema/startup-contract and ledger verification; exact 026 filename/checksum; runtime role has only the required `SELECT`, `INSERT`, and `UPDATE` access to the receipt table. | PENDING |
| G — Website recovery | Separate approval for a Railway restart/deployment, followed by non-destructive public health, Student Progress, and Game save-idempotency acceptance checks. | PENDING |

## Controlled runner contract (for a later approved window only)

Migration checksum calculation normalizes CRLF and lone CR to LF, preserving the canonical LF SHA-256 values in the preflight manifests. This does not repair or accept historical ledger rows whose stored checksum was calculated from noncanonical content; any mismatch remains fail-closed and requires a separately authorized read-only ledger audit. Never rewrite ledger entries to make them match.

The recovery command prints only the current source SHA, recovery artifact SHA-256, and preflight SQL SHA-256 before gating. Those values are identifiers, not approvals. The command refuses to run unless it sees all required attestation flags/references and hashes, exact `RECOVERY_026_EXPECTED_PENDING_MIGRATIONS=26`, an exact Git HEAD match, and a clean tree for every release-critical artifact. It rejects any pending list containing 024 or another version. The normal runner for 018–026 is not invoked.

Set only the non-secret target and approval values in a protected local PowerShell session. The required names are `RECOVERY_026_APPROVED`, `RECOVERY_026_APPROVAL_REFERENCE`, `RECOVERY_026_PREFLIGHT_OK`, `RECOVERY_026_PREFLIGHT_REFERENCE`, `RECOVERY_026_PREFLIGHT_SHA256`, `RECOVERY_026_PREFLIGHT_REPORT_SHA256`, `RECOVERY_026_BACKUP_VERIFIED`, `RECOVERY_026_BACKUP_REFERENCE`, `RECOVERY_026_BACKUP_SHA256`, `RECOVERY_026_RESTORE_VERIFIED`, `RECOVERY_026_RESTORE_REFERENCE`, `RECOVERY_026_RESTORE_REPORT_SHA256`, `RECOVERY_026_RUNTIME_PERMISSION_REVIEWED`, `RECOVERY_026_PERMISSION_REFERENCE`, `RECOVERY_026_EXPECTED_PENDING_MIGRATIONS`, `RECOVERY_026_EXPECTED_SOURCE_SHA`, `RECOVERY_026_EXPECTED_ARTIFACT_SHA256`, `RECOVERY_026_RUNTIME_ROLE`, `RELEASE_EXPECTED_DATABASE`, `RELEASE_EXPECTED_DB_USER`, `RELEASE_EXPECTED_SERVER_ADDRESS`, `RELEASE_EXPECTED_SERVER_PORT`, `PGHOST=127.0.0.1`, `PGPORT`, `PGUSER`, `PGDATABASE`, `RELEASE_DB_CA_FILE`, and `RELEASE_DB_TLS_SERVER_NAME=localhost`.

Do not set `PGPASSWORD`, `DATABASE_URL`, or any `PGSSL*` override. The command requires an interactive hidden password prompt and a separate visible confirmation phrase. Do not place the password in a command, file, environment variable, log, or chat.

Only after Gates A–E have been independently approved and documented may the operator run this command from the exact reviewed commit in the backend directory:

```powershell
node .\scripts\run-approved-recovery-migration-026.js
```

The runner acquires the release advisory lock, validates the database and role, verifies the 018–025 ledger and absence of partial receipt objects, and repeats those checks inside one serializable transaction. It executes only migration 026, grants the reviewed runtime role only `SELECT`, `INSERT`, and `UPDATE` on the new receipt table, inserts the matching ledger row, checks the existing startup-schema contract and effective runtime permissions, then commits once. A lost commit response is reported as **outcome unknown**; do not retry. Inspect the ledger/schema through a newly authorized read-only procedure first. A migration or verification error rolls back; rollback/unlock/close errors are reported without replacing the primary failure.

This tool has not been run against production. No gate is currently satisfied by this local preparation.
