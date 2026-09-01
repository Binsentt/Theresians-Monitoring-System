# Question Publication Lifecycle Design

**Status:** Documentation-only design. No runtime, schema, production-content, deployment, or Godot change is authorized by this document.

## Goal

Make an approved question set move through an explicit, safe lifecycle:

```text
Approved / Not in Game --Push to Game--> Active in Game
Active in Game --Remove from Game--> Approved / Not in Game
Approved / Not in Game --Delete--> Trash / existing permanent-delete rules
```

An Active in Game set is never deletable. Removing it from Game and deleting it are two separate human actions.

## Audit of the Current Model

`learning_files` already supplies the authoritative persisted model:

| Concern | Existing field or behavior |
| --- | --- |
| Publication membership | `published` compatibility boolean plus `publish_status` (`staged`, `active`, `superseded`) |
| Review approval | `approval_status` (`review_required`, `approved`, `legacy_active`) plus approval fingerprint and actor/time fields |
| Soft deletion | `deleted_at`; `DELETE /api/learning-files/:id` moves a row to Trash |
| Permanent deletion | `DELETE /api/learning-files/:id/permanent`, only for a trashed row without historical results |
| Historical provenance | `game_results.question_set_id`, `questions.learning_file_id`, source rows, and `admin_audit_logs` |
| Active set selection | one Mathematics set for exact canonical `Grade + Difficulty`; Topic is descriptive metadata only |

`backend/questionSetLifecycle.utils.js` already derives **Active in Game** for `publish_status = active` and **Replaced** for `superseded`. The missing read-model state is an approved staged set: it currently renders as Pending even when `approval_status = approved`.

### Existing endpoints

- `POST /api/questions/publish/:id` calls a transaction-scoped `publishLearningFile`. It checks structural validity and review approval, obtains a Grade/Difficulty advisory lock, requires replacement confirmation when an exact active pool exists, supersedes every active same-pool set, unpublishes their questions, then activates the chosen set and publishes its questions.
- `POST /api/questions/unpublish/:id` currently calls `unpublishLearningFile`. It merely updates by ID, unpublishes questions, **resets approval to `review_required`**, has no transaction/active-state guard, and writes no publication audit event. This does not meet the requested Remove from Game contract.
- `DELETE /api/learning-files/:id` already blocks rows whose `published` is true or `publish_status` is exactly `active`, then soft-deletes the set and unpublishes questions.
- `DELETE /api/learning-files/:id/permanent` checks the same active condition and blocks permanent deletion when `game_results.question_set_id` references the set.
- Folder trash and folder permanent-delete routes also query for active question sets before proceeding. Empty Trash invokes the existing per-file permanent endpoint, so it inherits that endpoint only after the active check is made robust and consistent.
- `GET /api/game/questions` resolves one active exact Grade/Difficulty pool. With no active set it returns HTTP 200 and `availability.code = QUESTION_POOL_EXHAUSTED`, an empty `questions` array, and `scope.question_set_id = null`.

### Authorization

All current publication and deletion routes use `requireLessonQuestionManagerAccess`: Admin and Teacher are allowed; Parent/Teacher is allowed only with `?scope=teacher`; Parent/Teacher Parent scope, Parent, and Student are denied. Remove from Game must keep this exact middleware and scope rule.

### Grade 1 / Difficult read-only audit

The requested production lookup was attempted without mutation. It could not be completed: the currently selected browser session had expired, and Railway's registered public audit key has no corresponding local private key for the SSH tunnel; a local PostgreSQL client is also unavailable. Therefore **the row is unverified, not absent**. No learning-file ID, state, count, approval, publication, or action visibility is asserted from incomplete evidence. The implementation must be validated against this record only after a human signs in or supplies the existing private read-only audit key; no lifecycle action is authorized as part of that lookup.

## Chosen Design

### State derivation and actions

Persisted fields remain the source of truth; no parallel lifecycle field is introduced.

| Persisted condition | Lesson Manager status | Primary action | Delete |
| --- | --- | --- | --- |
| valid, `approval_status = review_required`, staged | Ready for Review or Pending | Approve through the existing preview gate | Existing lifecycle |
| valid, `approval_status = approved`, staged | Approved / Not in Game | Push to Game | Existing lifecycle |
| `published = true` or `publish_status = active` | Active in Game | Remove from Game | Disabled with “Remove from Game before deleting this question set.” |
| `publish_status = superseded` | Superseded / Not in Game | Push to Game only if the existing review/structural eligibility still passes | Existing lifecycle and historical-result protection |
| generating, failed, invalid, or deleted | Existing status | No Push | Existing lifecycle |

The active predicate is deliberately compatibility-safe:

```js
const isActiveQuestionSet = (file) => Boolean(
  file?.published || String(file?.publish_status || '').trim().toLowerCase() === 'active'
);
```

Every server-side delete, Trash, permanent-delete, and folder-delete check uses an equivalent database predicate. A direct attempt to remove an active question set from storage responds with HTTP 409 and the stable code `ACTIVE_QUESTION_SET_CANNOT_BE_DELETED`; UI state is never the authority.

### Push to Game

Push stays on the existing `POST /api/questions/publish/:id` route. It remains allowed only for a nondeleted, structurally valid, review-approved question set with a canonical Grade/Difficulty. The existing transaction and advisory lock remain the replacement mechanism:

1. lock only `Grade|Difficulty`;
2. enumerate and lock active Mathematics sets in that exact pool;
3. require explicit replacement confirmation if any exist;
4. change those predecessors to `published = false`, `publish_status = superseded`, and unpublish their questions;
5. change the selected set to `published = true`, `publish_status = active`, and publish its questions;
6. commit atomically.

No other Grade/Difficulty pool is read or changed. Fixed and AI-generated reviewed child sets use this same route and transaction.

### Remove from Game

`POST /api/questions/unpublish/:id` becomes the explicit Remove from Game operation. Its backend implementation runs in one transaction, locks the nondeleted row, and only proceeds when the target is currently active. It changes only publication membership:

```text
learning_files.published       true  -> false
learning_files.publish_status  active -> staged
questions.published            true  -> false
```

It preserves `approval_status`, `approved_at`, `approved_by`, `approved_content_fingerprint`, source bytes/URL, questions, `published_at`/`published_by` historical publication provenance, IDs, results, and analytics. A set that had been approved therefore becomes **Approved / Not in Game**. Removing a nonactive or deleted set returns a safe conflict/not-found response and does not rewrite it.

The backend response returns the normalized changed `learningFile`, allowing the frontend to update that one row immediately before its ordinary narrow refresh. The UI uses the existing modal style and explicitly says that source, questions, and historical results are not deleted. It does not require typed DELETE confirmation.

### Audit trail

Use the existing `admin_audit_logs` table; do not add a second audit system. Add deterministic publication operations:

- `question_set_published` when Push commits;
- `question_set_unpublished` when Remove commits.

Each log records the authorized actor, set ID as the existing target-account field, a safe set title, action text, and Grade/Difficulty reason text. The unpublish audit insert occurs in the same transaction as the state change so neither can commit alone.

### Delete, Trash, and bulk protection

The single-file Trash and permanent-delete endpoints retain their existing historical-result policy. Their active checks are normalized and return the new stable conflict code. Folder Trash and folder permanent delete retain whole-operation blocking when a folder contains an active set. Empty Trash changes from browser-side `Promise.all` calls to one authenticated `DELETE /api/learning-files/trash` transaction. It locks all requested trashed rows before any permanent deletion, blocks the entire operation with `ACTIVE_QUESTION_SET_CANNOT_BE_DELETED` and a safe active-file ID list if any are active, and likewise blocks the entire operation when any row has historical results. No endpoint may unpublish as a side effect of deletion.

For superseded sets, deletion remains governed by the current two-step Trash then permanent-delete policy. A superseded set with `game_results.question_set_id` references cannot be permanently deleted; its soft-deleted source and questions remain available for traceability. A superseded set without results may follow the existing deletion lifecycle. This preserves `question_set_id` and `learning_file_id` truthfulness.

### No active pool and game behavior

Removing the only active set is valid. The exact Grade/Difficulty then has no active pool; the game endpoint returns no questions and `QUESTION_POOL_EXHAUSTED`, never broadens Grade/Difficulty, never serves superseded content, and never calls AI. The frozen Godot candidate already treats a successful response with zero remote questions as empty and returns without falling back to local/unrelated questions while `HttpApi` is present. No Godot modification is required.

## Error Contract

| Case | HTTP | Code |
| --- | --- | --- |
| Active set sent to Trash or permanent delete | 409 | `ACTIVE_QUESTION_SET_CANNOT_BE_DELETED` |
| Active folder contains an active set | 409 | `ACTIVE_QUESTION_SET_CANNOT_BE_DELETED` with safe affected-file summary |
| Empty Trash contains an active set | 409 | `ACTIVE_QUESTION_SET_CANNOT_BE_DELETED` with safe active-file IDs; no rows are deleted |
| Empty Trash contains historical results | 409 | existing historical-result protection code/message; no rows are deleted |
| Remove requested for an inactive set | 409 | `QUESTION_SET_NOT_ACTIVE` |
| Remove requested for deleted/missing set | 404 | existing not-found convention |
| Push requires same-pool replacement confirmation | 409 | `ACTIVE_SET_REPLACEMENT_CONFIRMATION_REQUIRED` |
| No active game pool | 200 | `availability.code = QUESTION_POOL_EXHAUSTED` |

## Regression Matrix

The implementation must cover all of the following for both Fixed Question and approved AI-generated child sets where applicable:

1. approved inactive renders Push;
2. Push makes the exact set Active in Game;
3. active renders Remove, never Push;
4. active Delete is disabled with the required explanation;
5. direct active Trash and permanent-delete requests return 409 with the stable code;
6. Remove confirms, unpublishes questions, preserves approval/source/questions/results, and returns the staged approved row;
7. Delete becomes available only after Remove;
8. replacement supersedes only the same Grade/Difficulty predecessor set(s);
9. unrelated Grade/Difficulty pools remain unchanged;
10. no-active pool returns `QUESTION_POOL_EXHAUSTED` with no questions;
11. bulk Trash/permanent delete cannot bypass the active lock;
12. Admin, Teacher, and Parent/Teacher Teacher scope are allowed; Parent/Teacher Parent scope, Parent, and Student are denied;
13. publish/unpublish audit events are persisted;
14. preview, review-complete, approval, Grade/Difficulty routing, randomization, retry, exhaustion, PDF/PPTX ingestion, Student Progress archive, section registry, and Godot regressions remain intact.

## Migration and Rollback

**Migration required: no.** The needed lifecycle, review, traceability, and audit columns already exist. This is an application-only change.

Rollback is application-only: deploy the previous verified web build if necessary. Do not delete sources, questions, results, audit rows, or active-pool history. A set removed while the new code was live remains an approved staged set; a forward correction may republish it only with normal human authorization and replacement confirmation.
