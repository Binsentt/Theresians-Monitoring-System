# Final Testing Defects: Website and Backend Implementation Plan

This plan implements only the website/backend portion of the reviewed Final Testing Defect Patch Specification.

## Baseline and isolation

- Worktree branch: codex/final-testing-defects-web-spec-plan.
- Base: 17fe091bf4f97d28ffcb5c0ef7ecb8cb89297305.
- Preserve the dirty Grade 1 Set A DOCX in main; it is not present or changed in this isolated worktree.
- Do not deploy, push, apply a migration, mutate production, publish questions, or call OpenAI.

## Expected files

Implementation should be limited to the following unless an audit finds a direct dependency:

- capstone/backend/migrations/014_add_learning_file_approval.sql
- capstone/backend/server.js
- capstone/backend/server.accountCreation.test.js
- capstone/backend/server.lessonManager.test.js or the existing focused lesson-manager test file
- capstone/backend/fixedQuestionDocument.test.js only if a verified parser defect is reproduced
- capstone/src/components/ManageUsers.js
- capstone/src/components/ManageUsers.test.js
- capstone/src/styles/manageusers.css only for clear archive/permanent states, not a redesign
- capstone/src/components/LessonQuestionManager.js
- capstone/src/components/LessonQuestionManager.test.js
- capstone/src/components/lessonQuestionManager.utils.js and its test only if lifecycle label normalization requires it
- capstone/src/styles/lessonquestionmanager.css only for the compact existing Preview action area

## Step 1: account tests before code

Add focused tests that currently fail for:

1. Active account action text is Archive Account, never ambiguous Delete.
2. Archive request does not include permanent=true and requires a reason.
3. Archived-account permanent action requires typed DELETE and a reason.
4. A permanent request made without typed DELETE receives a client error.
5. A permanent request for an active account receives a conflict error.
6. Teacher, Parent, Parent/Teacher, and Student requests receive authorization denial.
7. Repeated UI confirmation is disabled while pending; a repeated backend request after removal is harmlessly rejected as not found.
8. Successful archive/permanent completion clears deletion state before the success modal is visible.

Use local HTTP/database fixtures only. Do not invoke a real account deletion.

## Step 2: account implementation

### Frontend

- Rename the active-list action to Archive Account.
- Keep it out of the archived list.
- Rename the archived-list destructive action to Permanent Delete.
- Retain the existing reason input and normal archive confirmation.
- For permanent deletion, add an exact typed DELETE field and an irreversible warning. The final action is disabled until reason and typed confirmation are valid and remains disabled while pending.
- Split cancellation and success cleanup: a guarded user-close helper protects an in-flight request; an unguarded successful-completion reset clears deletingUser, deleteOperation, reason, reason errors, typed confirmation, and intermediate confirmation state before showing Success.
- Await data refresh after state cleanup without returning the delete modal to the tree.

### Backend

- Keep requireAccountManagementAdmin as the authority.
- Treat permanent=true as valid only when the body includes permanent_confirmation exactly DELETE and the target has is_archived true.
- Preserve self-delete and last-admin protections.
- Keep archive behavior non-destructive and its existing audit semantics.
- Keep permanent delete's existing account lifecycle semantics; do not add broader cascades or alter unrelated relationship/history behavior in this patch.
- Ensure the endpoint writes the existing reason/audit operation type only after all validation gates pass.

## Step 3: approval migration

Prepare additive migration 014_add_learning_file_approval.sql:

- Add approval_status with a non-null review_required default and constrained values review_required, approved, legacy_active.
- Add approved_at, approved_by referencing accounts, and approved_content_fingerprint.
- Backfill already Active/published rows as legacy_active without changing published, publish_status, questions, or history.
- Leave all non-active rows review_required.
- Add only supporting indexes needed by the new status queries.
- Make every statement idempotent and non-destructive.

Do not modify or rerun migrations 012 or 013. Do not apply migration 014 in this work.

## Step 4: approval tests before code

Create failing local tests for:

1. Valid new Fixed Questions begin review_required and cannot publish.
2. Valid AI-generated reviewable questions begin review_required and cannot publish.
3. Admin and Teacher can approve.
4. Parent/Teacher teacher scope can approve.
5. Parent/Teacher parent scope, Parent, and Student cannot approve.
6. Mixed-topic, malformed, invalid-choice, invalid-answer, invalid Grade/Difficulty/Topic inputs cannot approve.
7. Approval records actor, time, status, fingerprint, and audit event.
8. Publish with missing approval is rejected.
9. Publish with a stale fingerprint is rejected.
10. Metadata or question mutation clears approval and requires re-review.
11. Existing Active legacy content remains active without an approval backfill that changes game content.
12. Existing replacement confirmation and atomic rollback remain unchanged after approval passes.

## Step 5: approval backend

- Add a small, testable helper that builds the canonical approval fingerprint.
- Add an approval endpoint adjacent to the protected learning-file routes, using the existing Lesson Manager access middleware and Parent/Teacher teacher-scope query convention.
- Lock learning_files and questions, reuse existing publication validation and eligibility helpers, and reject ineligible approval without state changes.
- Add the approval check to publishLearningFile before scope advisory locks/replacement work.
- Clear approval through a narrowly named helper in every existing learning-file metadata/content mutation path. The fingerprint check remains mandatory at Publish.
- Return normalized approval state in the existing learning-file API response so the UI does not infer eligibility.

## Step 6: Preview approval UI

- Preserve the current header, internal preview body, fixed footer, Download Source, Close, question cards, validation rendering, and viewport-aware Question 1 behavior.
- Add a compact reviewed marker for each loaded question card in Preview state only.
- Add Approve near Download Source and Close; it appears only when server-side role/scope data permits Lesson Manager access.
- Keep Approve disabled until every locally loaded question is marked reviewed and the server-reported eligibility is valid.
- After approval succeeds, replace only the affected file row in state or perform the existing narrow refresh; do not remount the manager or automatically Push to Game.
- Push to Game remains separately visible only when the file reports valid, single-topic, approved eligibility.

## Step 7: Set A classifier boundary

Do not change fixedQuestionDocument.js merely to suppress a message. The local document parses as Basic Addition. A parser test is added only if an authenticated read-only production record or a supplied exact source reproduces a false multi-topic classification. Otherwise the existing mixed-topic blocker remains an explicit regression case.

## Step 8: verification

Run, using Node 20:

- focused Manage Users frontend tests;
- focused Lesson Manager frontend tests;
- focused account lifecycle backend tests;
- focused publication/approval/fixed-document backend tests;
- full backend suite;
- full frontend suite;
- production frontend build;
- git diff --check.

Then rerun frozen neighboring tests for Lesson Manager preview, replacement/rollback, Active delete protection, role authorization, Parent/Teacher scope isolation, Student Progress, Screen Time, Activity Log, Top Achievers, Analytics, print reporting, and AI request authorization/idempotency.

## Commit and rollback

Commit website/backend source, migration, and tests as one focused patch only after all gates pass. No unrelated DOCX is staged.

If a required frozen test fails, revert the focused uncommitted hunk before continuing. Before deployment, normal Git rollback is one focused commit revert. After deployment, roll back application code; preserve additive approval data and audit history.
