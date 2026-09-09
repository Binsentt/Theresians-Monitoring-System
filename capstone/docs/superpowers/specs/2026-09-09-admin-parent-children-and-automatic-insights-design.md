# Admin Parent Creation and Automatic Grounded Insights Design

## Scope

Revise only the canonical monitoring website. Admin becomes the sole authority for creating or linking children while creating a Parent account. Parent and Parent/Teacher parent-mode access remains read-only. Existing analytics calculations stay canonical and gain automatic, fingerprint-cached grounded insight generation for any student with valid gameplay evidence.

The Godot repository, Railway configuration, deployed services, production data, question publication, and existing Parent-to-Student relationships remain unchanged.

## Account creation architecture

The existing Admin-only `POST /api/accounts` endpoint accepts an optional `children` array only when the new account role has Parent access. Parent validation remains unchanged. Every child is validated with the existing child-name, Student-ID, Grade, Section, and canonical section-registry rules before the first database write.

Each child entry explicitly selects one operation:

- `create`: requires a new, unique eight-digit Student ID and creates a Student account using the existing approved game-child credential behavior.
- `link`: resolves an existing six- or eight-digit Student ID and reuses that Student account without changing its profile or credentials.

Duplicate Student IDs within one request are rejected. A linked Student must be active and must have no active Parent relationship. If an active Parent relationship exists, the request fails with `This Student is already linked to a Parent account.` Existing relationships are never replaced, transferred, or duplicated. Multiple-Parent support is out of scope.

After validation, one database transaction creates the Parent, creates any new Student accounts, and inserts all Parent relationships. Any failure rolls back the complete database operation. The existing Parent temporary-password and credential-email response behavior is preserved; email delivery and the Admin audit record occur after the database transaction commits, matching the current non-fatal email-delivery contract.

The Admin ID Directory remains a read-only query over `accounts` and `teacher_student_relationships`, so newly committed Student accounts appear without synchronization work.

## Parent authorization and UI

The existing Parent `POST /api/parent/children` mutation becomes forbidden for Parent and Parent/Teacher callers with an authenticated `403` response. Parent read endpoints remain unchanged. Existing Admin-only relationship management remains available and continues to preserve existing relationships.

The Parent Dashboard removes its Add Child button, modal state, modal rendering, and create/link wording. Child selection, Child Progress, Screen Time, Activity, Announcements, and all other monitoring behavior remain intact.

The existing Manage Users Add Parent form adds a Children section. It starts with one child row and supports adding and removing unsaved rows. Each row offers Create New Child or Link Existing Student. Create mode collects Student Name, eight-digit Student ID, Grade, and canonical Section. Link mode accepts a six- or eight-digit Student ID and relies on authoritative backend lookup; it does not duplicate or rewrite the existing Student.

## Canonical analytics and automatic AI

`loadStudentAnalyticsEvidence` and `buildStudentAnalyticsMetrics` remain the single source of deterministic student metrics for Admin, Teacher, and Parent. Role middleware continues to control access before the same student-detail calculation runs. Accuracy remains correct answers divided by valid total question results. Total Progress remains unavailable because no authoritative complete denominator exists.

The student-detail read automatically resolves grounded AI state:

- No data: zero valid per-question gameplay results; no provider call and no fabricated insight.
- Limited data: one through four valid results; provider generation is allowed and the response is marked preliminary.
- Sufficient data: five or more valid results; normal grounded analysis.

The existing grounded claim catalog, provider validation, `student_ai_insights` table, and evidence fingerprint remain authoritative. A cached current fingerprint is returned without a provider call. For a missing or stale fingerprint, a PostgreSQL transaction-scoped advisory lock keyed to the Student prevents concurrent authorized reads from generating the same fingerprint more than once. After taking the lock, the backend re-reads the cache before invoking the provider and persists the validated result with the existing upsert.

If generation fails, deterministic metrics still return. The last valid persisted insight is not deleted; when present it is returned as stale and clearly marked temporarily unavailable. No fallback AI text, static Grade recommendation, random content, or invented topic/mastery/trend is generated.

Admin/Teacher Student Analytics and Parent Child Progress render the same persisted insight fields through a shared presentation component: Performance Insight, Strengths, Weaknesses, and Recommendations. Limited evidence is visibly labeled preliminary. Manual Refresh remains only as an optional recovery action.

## Error handling

All request validation occurs before database writes. Database uniqueness violations and ownership conflicts produce truthful `400` or `409` responses. Transaction failures roll back Parent, new Students, and relationships together. Authentication and role failures occur before mutation. Provider errors are isolated from metrics and do not erase cached insight data.

No credential, token, API key, or temporary password is logged or added to analytics input.

## Verification

Tests are written and observed failing before production edits. Focused backend coverage verifies Admin Parent creation with one and multiple children, new and legacy Student-ID rules, duplicate rejection, transaction rollback, relationship creation, ID Directory visibility, Parent mutation denial, existing relationship preservation, zero/limited/sufficient AI state, 3/4 accuracy, Easy difficulty, cross-role metrics and AI parity, cache reuse, changed-evidence refresh, provider-failure fallback, and no live provider access.

Focused frontend coverage verifies the Manage Users Children workflow, unsaved-row removal, Parent Add Child removal, preserved Parent monitoring reads, and shared AI presentation. Existing full backend/frontend suites, production build, and `git diff --check` provide regression gates. The final scope check confirms zero Godot changes and no Railway or production mutation.
