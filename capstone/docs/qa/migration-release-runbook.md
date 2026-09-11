# Migration 018–020 release runbook

The application startup schema repair is not a migration runner. It creates the equivalent website-session and audit objects from migration 018, but it does not execute the ordered SQL files for migrations 019 or 020.

## Required release entrypoint

Before starting the application revision that uses these columns, an authorized release step must run the checked-in runner once, in order, against the intended database:

```text
RELEASE_MIGRATIONS_APPROVED=true DATABASE_URL="$DATABASE_URL" npm --prefix backend run migrate:release
```

The runner acquires PostgreSQL advisory lock `4819020`, sets a 15-second statement bound, creates the additive `public.schema_migrations` ledger, and applies exactly 018 → 019 → 020. It records each file's SHA-256 checksum after successful application and refuses a changed file at an already-recorded version. Migration 018 is internally transactional; migrations 019 and 020 use additive `IF NOT EXISTS` operations and repeat safely. The application must not serve the new revision until the command exits successfully. If a command fails, the runner releases the advisory lock, leaves that file unrecorded, and the release must stop for diagnosis.

## Compatibility and recovery

The changes are additive: existing accounts, relationships, histories, audit rows, and website sessions remain. Migration 020 adds purpose-bound OTP challenge fields and a partial unique challenge index; incompatible or outstanding legacy challenges are rejected or cleared by the existing server verification paths. A failed startup rejects readiness through `schemaReady` and exits non-zero.

The disposable QA upgrade test verifies fresh baseline objects, ordered 018→019→020 application, repeat application, preserved records and indexes, and normal recovery/login behavior. Unit coverage verifies checksum mismatch rejection and lock release after a failed file. Production migration execution is a separate approved release action and was not performed during QA.
