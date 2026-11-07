# Startup schema inventory for PR #35

## Scope and evidence

This inventory compares `database/startupSchemaReadiness.js` at PR #35 with
`Database_Table.sql`, tracked migrations 001–025, and the last checked-in
`server.js` before the startup-DDL removal. It is a source inventory only; no
production or staging database was inspected. The runtime gate requires the
presence of 17 public tables and 269 columns. Presence is not proof of the
complete SQL schema or production readiness.

| Table | Required columns | Tracked canonical `CREATE TABLE` source | Startup-contract gap / review note |
| --- | ---: | --- | --- |
| `accounts` | 32 | `Database_Table.sql` | `screen_time_reset_at`, `session_version`, `temporary_password_issued_at`, and `temporary_password_expires_at` have no tracked baseline/migration definition. Learning-cycle and archive fields are in migrations 009/010; OTP challenge fields are in 020. Migration 017 establishes `game_student_id VARCHAR(8)`; the preflight now checks its type and width because migration 024 trims this field. |
| `activity_logs` | 36 | `Database_Table.sql` | Event and telemetry fields are split across migrations 001, 009, 021, and 022. Review nullable `student_id` differences between baseline/runtime DDL and migration history before formalizing the full contract. |
| `admin_audit_logs` | 11 | **None** | Migration 018 only adds metadata columns and assumes the table exists. Base columns, types, defaults, constraints, and index are only represented by removed startup DDL/test fixtures. |
| `announcements` | 7 | `Database_Table.sql` | Baseline definition exists; old startup code also applied additional repairs. Review the baseline and repair history before asserting exact constraints. |
| `folders` | 5 | **None** | All required columns and the unique name behavior rely on old startup DDL; no canonical create migration is checked in. |
| `game_results` | 28 | migration 003 | Later fields are split across migrations 004, 007, 022, 023, and 025. `current_map` is required at runtime but has no tracked baseline/migration definition. |
| `learning_files` | 38 | **None** | Several ALTER migrations assume the table exists; there is no canonical base create. Required content, lifecycle, source, approval, file bytes, and lineage fields therefore lack one authoritative baseline. |
| `login_otp_device_skips` | 6 | **None** | Table, unique constraint, expiry index, and FK are only in removed startup DDL; no tracked create migration exists. |
| `playtime_deletion_tombstones` | 7 | migration 023 | Additive table and unique index are tracked. Its account `SET NULL` relationship must be included in migration-024 impact review. |
| `playtime_sessions` | 23 | **None** | Migration 009 alters it but assumes a pre-existing table. The required base fields, FKs, indexes, defaults, and nullability rely on removed startup DDL. Migration 019 explicitly adds the four soft-delete fields now required by live routes: `deleted_at`, `deleted_by`, `deletion_reason`, and `deletion_operation_id`. |
| `questions` | 13 | **None** | Base table, `learning_files` cascade, indexes, and unique composite index are only in removed startup DDL; no tracked base create migration exists. |
| `student_ai_insights` | 8 | **None** | No tracked migration creates it. The only definition is old startup DDL: integer IDs, JSONB insight, one row per student, account cascade/set-null FKs, and a student/stale index. Do not infer production absence from this source gap. |
| `student_game_progress` | 20 | `Database_Table.sql` | `section`, `total_quests_completed`, `total_play_time`, `current_scene`, `current_map`, and `difficulty_level` have no tracked baseline/migration definition. |
| `student_quest_milestones` | 14 | migration 021 | Migration 022 adds telemetry identifiers and indexes. Both migration definitions should be reconciled with the 14-column runtime contract. |
| `teacher_class_assignments` | 8 | migration 008 | Tracked unique/check constraints, teacher-validation trigger, and indexes exist; the readiness preflight checks that trigger is present and enabled. |
| `teacher_student_relationships` | 5 | `Database_Table.sql` | Baseline defines PK, teacher/student cascades, and uniqueness. |
| `website_sessions` | 8 | migration 018 | Tracked account cascade, unique credential hash, expiry check, and partial indexes exist. |

The seven bolded missing base definitions are `admin_audit_logs`, `folders`,
`learning_files`, `login_otp_device_skips`, `playtime_sessions`, `questions`,
and `student_ai_insights`. Tracked ALTER migrations that reference a missing
base table do not supply a reproducible initial definition for a fresh database.

`Database_Table.sql` is not safe as a production migration: it includes sample
INSERTs and has an `ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS` statement that
is not portable PostgreSQL syntax. Do not execute the file as a production
repair script. Extract and review additive DDL separately.

## What the readiness/preflight code validates

The application startup gate is read-only and checks only required table and
column existence. It does not issue DDL, DML, cleanup, or backfill SQL. The
operator preflight adds: expected database/role/address/port matching; a
non-admin SELECT-only role check; migration-ledger shape and checksums 018–025;
required table/column presence; selected core column types; full visible column
metadata output; constraint/index/trigger inventory; and an enabled check for
`teacher_class_assignments_validate_teacher`.

It does **not** assert exact nullability/defaults/types for every one of the 269
columns, every primary/unique/FK/check constraint, all indexes, or all
application-required trigger behavior. The catalog report is evidence for an
operator review, not an automatically approved schema contract. Those
assertions cannot be made authoritative for seven base tables until a reviewed
canonical baseline exists. The known column gaps above also require owner-
approved additive migrations before a future fresh install can satisfy all
runtime assumptions.

The only tracked application trigger found in migrations 001–025 is the
teacher-class-assignment validation trigger from migration 008. It validates
active teacher roles and updates `updated_at`. No additional runtime trigger is
required by the checked-in source. A production trigger inventory that differs
from this source must be investigated before release.

## Migration 024 impact

Migration 024 directly deletes six-digit legacy Student accounts, matching
`game_results` rows by `resolved_student_id`, and matching `playtime_sessions`
rows by `student_id`. The operator SQL reports direct counts, every actual
inbound FK into those three deleted relations with its delete action, and the
recursive CASCADE graph. It exits nonzero whenever migration 024 is pending.
The operator must additionally count each cascade descendant and every
SET NULL/SET DEFAULT effect, account for rows that would be deleted by more than
one edge without double-counting totals, and inspect RESTRICT/NO ACTION edges.
The guarded runner only rechecks the three direct counts. If complete impact
cannot be proven, keep 024 blocked; no merge or application rollback restores
deleted rows.

Require, before any separate migration-024 execution approval:

1. A verified database backup and successful isolated restore rehearsal.
2. Full count-only cascade and update impact reviewed by the data owner.
3. Owner-approved write quiescence covering every route that can create or
   change affected rows; a boolean attestation alone does not stop writes.
4. A reviewed recovery plan and explicit approval for the exact pending list.

## Later migration 026 contract

PR #35 intentionally excludes PR #31 migration 026. That additive migration
creates `game_progress_save_commits` with nine required columns, so the future
combined startup contract will be 18 tables / 278 columns only after PR #31 is
integrated and migration 026 is separately approved and applied. Do not add
the table to this pre-migration readiness gate. Reconcile its PK
`(student_id, learning_cycle_version, save_commit_id_hash)`, unique
`(student_id, activity_event_key)`, checks, FK cascade to accounts, and
response-receipt fields against the merged source before activating the
combined contract. The receipt data is student-linked and account deletion
cascades to it; retention/deletion policy remains an owner decision.

## Safe schema migration strategy

Do not edit historical applied migrations or restore application-startup DDL.
After the source gaps and live schema are reviewed, prepare separately reviewed
additive migration(s) that define missing base tables and columns with explicit
types, nullability, defaults, keys, FKs, checks, and indexes. Reconcile each
definition against existing production objects before execution; `IF NOT EXISTS`
does not repair an incompatible object. Run the candidates only against a
disposable restored database first, then use the explicit release migration
approval gate. Migration 026 must remain a separate later prerequisite until
its own approval and application are complete.
