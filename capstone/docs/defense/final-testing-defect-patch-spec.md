# Final Testing Defect Patch Specification

Status: reviewed for implementation planning only.
Website/backend baseline: 17fe091bf4f97d28ffcb5c0ef7ecb8cb89297305.
Godot baseline: f7811c688876dc52f316a9322603275b323d8102.

## Scope and release boundary

This is a narrow patch release. It may change only:

1. Manage Users archive and permanent-account-delete clarity and safety.
2. Lesson and Question Manager review approval before publication.
3. Godot exploration-player speed, visible application title, and one opt-in decorative NPC wanderer.

The existing signed APK remains a verified previous artifact. A new source freeze and new signed APK are required only after the Godot patch has been reviewed and verified. No production data, question publication, migration application, deployment, APK build, or OpenAI call is part of this phase.

## Account lifecycle contract

### Active account

The only destructive-looking account action for an active account is Archive Account.

- Archive is non-destructive.
- It requires a non-empty reason and the existing normal confirmation step.
- It marks the account archived/inactive using the existing lifecycle fields and preserves historical data according to the current account lifecycle.
- Archive is reversible through Restore.
- Permanent Delete is never shown in the active-account action list.

### Archived account

The archived-account list may offer Restore and Permanent Delete.

- Permanent Delete is Admin-only, enforced by the server.
- The target must already be archived.
- It requires a non-empty reason and a typed confirmation exactly equal to DELETE.
- The confirmation request is one-shot: the confirmation control becomes disabled while the request is in flight, and the endpoint must reject a second request after the account is gone.
- The UI uses explicit, irreversible wording. It must not imply that archive is permanent deletion.

The current implementation already routes an active-list Delete request to archive semantics. The patch corrects the visible label and confirmation wording instead of changing archive behavior.

### Modal lifecycle and flicker

The reported flicker is caused by success handling calling the normal close function while its deleting guard refuses to close the delete modal. The success modal can therefore be rendered while the delete modal is still selected.

The patch will use a dedicated successful-completion reset routine that clears the deletion target and confirmation state before the success modal is shown. User-cancel protection remains intact while a request is pending. No timer, animation suppression, or polling workaround is permitted.

## Lesson approval before publication

### Final gate

A question set may be pushed to game only when all of the following are true:

VALID
AND SINGLE CANONICAL TOPIC
AND REVIEWED AND APPROVED
AND AUTHORIZED

Approval never overrides parsing, exactly-four-choice, correct-answer, Grade, Difficulty, Topic, or mixed-topic validation. It is separate from Push to Game and cannot publish content by itself.

### Approval state

An additive learning_files approval record will contain:

- approval_status: review_required, approved, or legacy_active.
- approved_at.
- approved_by.
- approved_content_fingerprint.

New reviewable Fixed Question and AI-generated question sets begin in review_required. Existing Active sets remain active and are not un-published by the migration; they receive legacy_active. Existing non-active sets require a new review before a future publication.

Approve is server-side transactional:

1. Lock the learning file and its question rows.
2. Recompute all publication validation and controlled-topic eligibility.
3. Calculate a canonical content fingerprint from Grade, canonical Difficulty, controlled Topic, document Topic, question text, choices, and correct answers.
4. Persist approved state, reviewer, time, and fingerprint.
5. Write an audit event with the safe action label Question Set Approved for Publication Review.

Publish recomputes the same validation and fingerprint while holding the file lock. It rejects a missing, stale, or invalid approval before it considers replacement publication.

Any changed Grade, Difficulty, Topic, document topic, question text, option, or correct answer invalidates approval. Metadata update paths clear approval immediately; the publication fingerprint check is a second server-side defense for every content mutation path.

### Review-completion contract

Preview remains read-only. It is not itself approval.

The Preview modal records a local review checklist for every displayed question card. The Approve action is available only after all cards are marked reviewed, a clear confirmation is accepted, and the server reports the set structurally eligible for review approval. Server validation remains the authority.

The Approve control is visible only to:

- Admin.
- Teacher.
- Parent/Teacher while its request scope is teacher.

Parent, Student, and Parent/Teacher parent scope remain denied by the existing server-side Lesson Manager scope middleware. Parent/Teacher teacher scope continues to be checked by the backend rather than trusted from the UI.

## Set A investigation boundary

The current local Set A document is a Grade 1 / Easy / Basic Addition document with five valid Basic Addition questions. Its parsed document topic is Basic Addition, so it does not reproduce the reported multiple-topics message.

The production Set A record has not been diagnosed: Railway service status is available, but the configured read-only SSH key was not accepted for the PostgreSQL query. No classifier change, topic relabeling, upload, or publication is allowed without an authenticated, read-only production record inspection. The implementation must preserve the current controlled-topic blocker.

## Frozen-system protection

The patch must not alter:

- quest order, Tutorial, Teacher House, Bandit progression, task IDs, activity ordering, Current Quest, Task Trigger/Complete semantics, or GameState advancement;
- DialoguePanel behavior, one-press-one-line input, held-input suppression, Teacher/Bandit continuation, or dialogue wording;
- battle mechanics, QuestionProvider, QuizManager, first-Bandit Grade 1 / Easy / Basic Addition scope, four-choice contract, result traceability, or life persistence;
- Save/Load, learning-cycle validation, previous-cycle behavior, manual save deletion, scene/position/quest restoration;
- playtime lease, heartbeat, presence, RemoteSync retry/activity/result contracts, Screen Time, leaderboard, or activity-log contracts except the new approval audit entry;
- Settings, pause, mobile controls, D-pad/Interact layout and hitboxes, existing HUD positions, or existing responsive UI;
- website authentication, authorization, IDOR protections, Parent/Teacher isolation, Student Progress lifecycle, printing, analytics, or AI architecture;
- migrations 012 and 013.

## Deployment and rollback

The future website/backend deployment applies the new additive migration once before the approval-gated code serves traffic. If validation fails before deployment, do not push. If the deployed approval path fails, disable the new patch by rolling back the application to the previously verified commit; do not delete approval audit rows or alter historical question/publication records.

The Godot patch is separately reviewed. If it fails a frozen-system regression, revert only the focused commit before creating any new APK. The prior signed f7811c6 artifact is preserved unchanged.
