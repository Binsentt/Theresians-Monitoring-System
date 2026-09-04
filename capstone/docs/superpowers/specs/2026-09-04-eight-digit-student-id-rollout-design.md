# Eight-Digit Student ID Rollout with Legacy Compatibility

## Decision

New Student IDs are exactly eight ASCII digits. Existing six-digit Student IDs remain unchanged and remain valid only where an existing account is being located. Parent IDs remain exactly six ASCII digits. Student-ID editing is not added.

## Production evidence

- Nine existing Student IDs have exactly six digits.
- No existing Student ID has eight digits; one Student ID is blank.
- `public.accounts.game_student_id` is nullable `VARCHAR(6)` with a unique non-null index.
- Parent/Student links, progress, activity, AI insight, and monitoring records use integer `accounts.id` relationships. They do not duplicate the public Student ID as their relationship key.
- The local schema/migration audit found no other public Student-ID text column. `parent_id` is a distinct six-character Parent identifier and remains unchanged; `student_id` columns in the related tables are integer account foreign keys.

This evidence rules out an eight-digit-only runtime change and rules out a backfill. It requires a width-only migration plus separate creation and lookup validation.

## Data migration

Create one migration, `backend/migrations/017_widen_game_student_id_to_eight.sql`, whose only database object change is:

```sql
ALTER TABLE public.accounts
  ALTER COLUMN game_student_id TYPE VARCHAR(8);
```

The migration does not update rows, generate IDs, pad IDs, or modify another table. PostgreSQL widening from `VARCHAR(6)` to `VARCHAR(8)` preserves existing values, nullability, and the existing unique index. A disposable-database migration test must prove those properties before the migration is committed. The application bootstrap declaration changes to `VARCHAR(8)` only for a newly created column; it must not issue an automatic `ALTER` against an existing deployment.

## Validation boundary

Two backend concepts prevent legacy values from leaking into creation paths:

| Concept | Accepted values | Callers |
| --- | --- | --- |
| `normalizeNewStudentCode` | exactly `[0-9]{8}` | Parent Add Child creation, game registration fallbacks, any future Student creation request |
| `normalizeExistingStudentCode` | exactly `[0-9]{6}` or `[0-9]{8}` | profile check, Parent Add Child lookup, learning cycle, Save/Load, RemoteSync, activity/progress/result lookup, monitoring filters |
| `normalizeParentCode` | exactly `[0-9]{6}` | unchanged Parent validation |

The legacy-compatible helper never authorizes a new Student insert. The new-ID helper never normalizes, pads, or rewrites input.

## Runtime path matrix

| Surface | Current role | Post-rollout rule |
| --- | --- | --- |
| Manage Users Admin Add / Edit | website-account only; does not create or edit Student IDs | preserve behavior; do not add Student-ID editing |
| Parent Add Child | finds a Student by code, otherwise creates and links a child | lookup accepts 6/8; create accepts only 8 |
| `POST /api/playtime/start` | finds a linked Student, otherwise creates registration | lookup accepts 6/8; fallback create accepts only 8 |
| `POST /api/game/progress` | resolves a Student; legacy code path can create if absent | lookup accepts 6/8; fallback create accepts only 8 |
| profile check and learning cycle | lookup | accepts 6/8 |
| result, activity, progress, playtime | public-code lookup then internal account-ID persistence | accepts 6/8; keeps persisted relationships untouched |
| web reports, activity, progress, analytics | display/search | no format mutation; permit both code lengths in server-side lookup filters |
| Godot New Game | profile lookup | local 6-or-8 validation, Parent remains 6 |
| Godot Save/Load and RemoteSync | existing account compatibility | local 6-or-8 validation; forward full string unchanged |

## Creation, lookup, change, and display audit

| Classification | Confirmed paths | Rollout action |
| --- | --- | --- |
| Create | Parent Add Child; missing-account fallbacks in game-progress and playtime-start | each must perform a 6/8 existing lookup first and call `normalizeNewStudentCode` immediately before an insert |
| Lookup | Parent Add Child pre-insert check; game profile check; learning-cycle; game-progress; game-result; activity ingestion; playtime-start; monitoring filter | use only `normalizeExistingStudentCode` for public-code handling |
| Change | no Admin Add Account, Edit User, Student profile, or import path currently writes `game_student_id` | do not add Student-ID editing; unrelated edits continue to preserve existing values byte-for-byte |
| Display/search | Manage Users, Student Progress, Activity, Analytics, Teacher/Parent monitoring | retain current display/search behavior and never coerce, pad, or truncate a stored code |

## Web behavior

Parent Add Child is a mixed lookup-or-create flow, not a separate Student-ID editor. Its Student-ID field accepts ASCII digits only, has `maxLength={8}`, and accepts a six- or eight-digit value so a Parent can link an already-existing legacy Student. The endpoint always looks up first: a six-digit value can only link an existing Student, while a missing value can create a Student only when it is exactly eight digits. The UI must communicate that distinction rather than guessing whether a value is new. Existing reports and search fields remain display/search-only and must not reject or truncate legacy values.

## Godot behavior and freeze

Only these frozen-product files may change: `scenes/new_game_scene.tscn`, `scenes/texture_rect_2.gd`, `scripts/game_state.gd`, and `scripts/remote_sync.gd`, plus focused `tools/` tests.

The Student `LineEdit` gains only `max_length = 8`. Its local validator accepts exactly six or exactly eight ASCII digits; malformed input makes no HTTP request and shows `Student ID must be either 6 or 8 digits.` Parent validation and field length remain six digits. Debug retains `http://localhost:5000`; release retains `https://theresiansquest.com`. A transport failure still says that connection failed, and a backend response still surfaces its truthful server message.

Settings, Teacher House, triggers, dialogue, battle, quests, controls, NPCs, maps, TileSets, question routing, randomization, and movement speed are out of scope.

## Verification and release boundary

Tests cover migration preservation, creation rejection of six/seven/nine/non-numeric codes, six/eight lookup success, Parent linking, unchanged legacy compatibility, Parent six-digit validation, Godot request suppression for malformed values, New Game profile requests, Save/Load, and RemoteSync.

All work remains local. The resulting commits are not pushed; migration 017 is not applied; no production account, question, activity, result, APK, deployment, or OpenAI action is permitted.
