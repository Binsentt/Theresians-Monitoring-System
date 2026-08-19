# Official School Dataset Import Readiness

The official school dataset is **PENDING_CLIENT_DATA**. This document is a mapping guide only; it does not approve an import, generate identifiers, or introduce a second identity system.

| Official field when supplied | Existing authoritative destination | Import rule |
| --- | --- | --- |
| Student ID Number | `public.accounts.game_student_id` | Preserve the supplied six-digit value as a string, including leading zeroes. Do not generate a replacement ID. |
| Student name | `public.accounts.name` and, where the supplied data is split, `first_name`, `last_name`, `middle_initial` | Validate and retain only the school-provided value. |
| Grade Level | `public.accounts.grade_level` | Use an existing Grade 1–6 value. |
| Section | `public.accounts.section` | Import only a supplied section; leave unknown values empty rather than inventing one. |
| Teacher ID / Employee ID | `public.accounts.employee_id` | The current system accepts required numeric values up to ten digits for teacher-capable accounts. Institutional format/range is **PENDING_CLIENT_DATA**. |
| Teacher/student or teacher/section assignment | `public.teacher_student_relationships` | Create only school-provided assignments using the existing relationship type and unique relationship constraint. |
| Parent/student relationship, if supplied and authorised | `public.teacher_student_relationships` with the existing canonical parent relationship type | Resolve both existing account records first; never permit a source row to take over an already unrelated linked Student ID. |

## Preconditions for a future import

1. Receive the approved client data dictionary and authoritative Teacher/Employee ID rules.
2. Validate all external Student IDs as strings before any conversion or lookup.
3. Dry-run against an isolated transaction/report first: new records, existing matches, duplicate IDs, missing mandatory fields, and relationship conflicts.
4. Obtain approval for the exact import report before writing production rows.

## Current no-data behaviour

Student, monitoring, activity, and leaderboard views must show their existing empty states when no authorised real records exist. Deterministic analytics and AI insight must remain unavailable when there is insufficient real gameplay data; no demo metrics or recommendations are created by the import process.
