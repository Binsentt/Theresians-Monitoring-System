# Theresian's Quest — Grade + Difficulty Question Pool Architecture

**Status:** Approved product decision captured as documentation only. This specification supersedes the earlier runtime use of `grade_level + difficulty + topic_id` for question upload, publication, routing, and game selection.

**Decision date:** 2026-09-01

**Authoritative active-pool key:** `grade_level + difficulty`

**Out of scope for this change:** any production mutation, deployment, migration execution, question publication, OpenAI call, Godot/APK build, or changes to student lifecycle, sections, reporting, quests, battles, saves, settings, or mobile controls.

## 1. Product decision and source evidence

Teacher/client-authored content is authoritative. A Grade/Difficulty document is allowed to cover several mathematics topics when that is how the teacher organizes the intended pool.

The supplied Grade 1 / Easy example contains Basic Addition, Subtraction, Shapes, and Place Value. The supplied Grade 1–6 curriculum corpus likewise establishes that the previous matrix must not be used to force one topic on each Grade/Difficulty document. The checked-in teacher sample files are only narrow parser fixtures; they are not a substitute for, or a restriction on, the client corpus.

Consequences:

- A mixed-topic document is valid when its selected Grade and Difficulty are valid and its questions are structurally valid.
- The system must never silently split a source document, classify it into topic pools, rewrite it, or replace it with AI output.
- Filenames, document headings, and optional topic fields are not routing or publication authority.

## 2. Final authoritative scope

Canonical Grade values remain `Grade 1` through `Grade 6`. Canonical Difficulty values remain `Easy`, `Normal`, and `Difficult`; boundary aliases `Medium` and `Average` normalize to `Normal`, and `Hard` normalizes to `Difficult`.

```text
active_pool_key = canonical_grade_level + canonical_difficulty
history_key     = canonical_grade_level + canonical_difficulty + question_set_id
```

`question_set_id` is the immutable traceability identifier for the exact set served or answered. It is not part of active-pool replacement selection.

Topic, `topic_id`, `math_topic`, and `document_topic` are optional informational fields only. They can be shown as source provenance or used in clearly labelled historical/optional analytics. They must not decide whether a set is structurally valid, reviewable, approvable, publishable, active, fetchable, or result-traceable.

## 3. Current-state audit

### Backend

| Current dependency | Current locations | Required change |
| --- | --- | --- |
| Canonical triple resolver | `backend/server.js` `resolveCanonicalQuestionScope` (~1331); `backend/curriculumScopeRegistry.js`; `backend/learningContentRules.utils.js` | Introduce/use a Grade+Difficulty resolver for all active-pool decisions. Keep topic normalization only as a best-effort metadata utility; do not use `isValidScope` as an upload or game gate. |
| Fixed-question metadata and scope assessment | `backend/fixedQuestionDocument.js`; `backend/questionScopeAssessment.utils.js`; `backend/server.js` `getQuestionSetValidationState` (~2142) | Retire `validateQuestionSetScope` from review/publication eligibility. Remove the topic-dependent metadata validation call for Fixed Questions. Preserve parsing of optional topic lines/headings only as display provenance. `MULTI_TOPIC_DOCUMENT` is absent from active code but remains in old documents; it and all equivalent topic mismatch/unverified concepts must not be publication gates. |
| Structural validation | `backend/fixedQuestionDocument.js`; existing review/publication validators | Retain readable text, exactly four non-empty distinct choices, one answer mapped to exactly one choice, valid Grade, valid Difficulty, and supported DOCX/PDF structure. Do not add semantic topic validation. |
| Upload and lesson source/generation requests | `backend/server.js` routes at ~4370, ~4430, ~4613; helper `validateLessonGenerationScope` (~4334) | Require Grade/Difficulty and the existing required source/count fields, not Topic. Persist null topic metadata for new uploads unless optional source metadata is safely available. |
| AI prompt and idempotency fingerprint | `backend/lessonQuestionGeneration.js`; `backend/server.js` generation fingerprint paths | Remove `topicId`/`mathTopic` from prompt and idempotency inputs. Prompt from clean lesson text: generate N Grade X / Difficulty Y mathematics questions using only supplied lesson material. Preserve backend-only provider use, 30-second timeout, one idempotent request, no automatic retry, structural validation, and review-required status. |
| Approval/publication | `backend/server.js` `buildQuestionSetPublicationBaseEligibility` (~2195), `publishLearningFile` (~2261) | Keep structural-validity and current human-approval fingerprint gates. Remove topic scope blocker and `CANONICAL_TOPIC_UNRESOLVED`. Lock `Grade|Difficulty`; select and replace every active set in that exact pool after explicit confirmation. |
| Active query | `backend/server.js` `getGameQuestions` (~2706) and old `buildPublishedGameQuery` helpers (~2916) | Query only one exact active Grade+Difficulty set. Do not filter by topic. Retire/delegate obsolete duplicate game query helpers so no alternate topic-routed path survives. |
| Game endpoint | `backend/server.js` `/api/game/questions` (~5402) | Require Grade and Difficulty only; ignore legacy `topic`, `math_topic`, and `topic_id` query parameters for a limited compatibility period. Return one selected `question_set_id`, Grade, and Difficulty. No topic field is authoritative in `scope`. |
| Result traceability | `backend/server.js` `resolveGameResultQuestionSet` (~1470) and `/api/game/result` (~6103) | Validate submitted `question_set_id` against the stored Grade+Difficulty only; permit active or superseded exact sets for historical results. `math_topic` remains nullable historical metadata and is not a matching condition. |
| Analytics/read models | `backend/server.js` parent/teacher result queries (~8014, ~8058, ~8510, ~8613); `backend/studentAnalyticsMetrics.utils.js`; `src/components/ParentChildProgress.js` | Preserve existing history. Where topic exists, label it as source/legacy topic metadata. Do not derive a topic, treat a missing topic as an error, or use topic to filter active pools. Grade/Difficulty and `question_set_id` are the reliable current trace. |
| Registry endpoint | `backend/server.js` `/api/curriculum/registry` (~5393); `backend/curriculumScopeRegistry.js` | Retain backend ownership of Grades, Difficulties/aliases, and optional topic catalog. Change registry contract language/data consumers so Grade/Difficulty are the pool catalog and `topics`/legacy memberships are advisory metadata only, never a hidden validity gate. |

### Frontend

| Current dependency | Current locations | Required change |
| --- | --- | --- |
| Required Topic form state and selector | `src/components/LessonQuestionManager.js` initial form (~38), submission checks (~613), modal (~1461) | Delete required `topic_id`/`math_topic` form state, dependent dropdown, client validation, form payload fields, and topic-specific error text for Fixed Question and Lesson generation. Keep registry-derived Grade/Difficulty choices. |
| Lesson reuse and idempotency | `LessonQuestionManager.js` storage keys (~74, ~86), source generation (~559) | Key a child generation by source identity/content, Grade, Difficulty, and question count only. Update user copy to say Grade, Difficulty, and Question Count. |
| Preview and Push presentation | `LessonQuestionManager.js` preview/eligibility helpers and tests | Show optional source topic only when it already exists, labelled as metadata. Remove topic conflict/error cards and topic-based replacement copy. Preserve initial Question 1 preview, final-question viewing gate, Approve, then Push to Game. |
| Folders, table, filters | `LessonQuestionManager.js`; `src/components/lessonQuestionManager.utils.js` | Keep physical/view organization as Grade/Difficulty. Remove Topic as a required folder or active-pool filter; a non-authoritative optional metadata filter may be retained only if it cannot affect publication or game routing. |
| Registry client | `src/curriculumRegistry.js`, `src/curriculumRegistry.test.js` | Continue consuming the read-only backend registry. Stop using topic memberships to gate forms or construct requests. Do not restore a duplicate frontend topic map. |
| Regression coverage | `src/components/LessonQuestionManager.test.js`, utility/registry tests | Replace Topic-required, mismatch, and Topic-based replacement expectations with Grade/Difficulty pool cases while retaining role/scope authorization and existing non-question workflows. |

### Godot

| Current dependency | Current locations | Required change |
| --- | --- | --- |
| Encounter scope normalization | `scripts/game_state.gd` `_normalize_question_scope` and `_normalize_difficulty` (~860) and persisted encounter context | Normalize and retain only Grade and Difficulty for remote question requests. Convert legacy `Medium`/`Average` to `Normal` and `Hard` to `Difficult` at this boundary; the current function emits `Medium`/`Hard` and must be corrected. Legacy saved `topic`/`math_topic` keys may be ignored; do not rewrite existing save files. Keep encounter ID, retry count, checkpoints, scene/position, quest flow, and battle state unchanged. |
| Remote request and local filter/history | `scripts/question_provider.gd` `_get_encounter_question_params` (~104), `_filter_questions` (~171), `_pool_key` (~197) | Send Grade/Difficulty only. Remove topic from remote selection and from the history key/filter. Use Grade+Difficulty+`question_set_id` for served remote questions; preserve unused-before-repeat, random selection, retry using another unused question, and explicit reset/exhaustion behavior. |
| Result payload | `scripts/remote_sync.gd` (~349) | Always send Grade, Difficulty, and an available `question_set_id`. Do not require or manufacture `topic_id`/`math_topic`; optional existing metadata may be sent only as non-authoritative history text. |
| Product-context checks | `tools/production_question_api_smoke_test.gd`, `tools/question_provider_normalization_test.gd`, `tools/question_set_traceability_test.gd`, `tools/battle_lifecycle_test.gd` | Change endpoint fixture/expectations to Grade+Difficulty. Remove expected topic assertions. Retain answer normalization, question-set traceability, one-time final Godot compatibility, Bandit retry, no-repeat, exhaustion, and lifecycle checks. |

The minimal Godot scope change does not alter quests, battle mechanics, lives, dialogue, Save/Load format, Settings, or mobile controls. A replacement signed APK is required after this one-time code change; it must be built only from the subsequently approved clean Godot commit, never a dirty Android worktree.

## 4. Final workflows

### Fixed Questions

```text
Select Grade -> Select Difficulty -> Upload DOCX/PDF -> Parse and structurally validate
-> Preview starts at Question 1 -> reviewer reaches final question -> Approve -> Push to Game
```

The preview renders the exact parsed teacher/client source. A structural mistake is corrected in the source and uploaded again. The system does not modify question wording, choices, answers, topic placement, or content ownership.

Approve begins disabled and becomes enabled only after every parsed question is structurally valid and the reviewer has reached the final question. Approval changes review state only. Push is enabled only after successful approval and activates the Grade+Difficulty pool.

### AI Lesson Question Sets

```text
Select Grade -> Select Difficulty -> Select count -> choose/upload PDF or PPTX lesson source
-> clean readable extraction -> backend generation -> structurally validate -> Preview
-> reviewer reaches final question -> Approve -> Push to Game
```

The prompt is grounded strictly in the extracted lesson text and may cover all topics present in it. PDF extraction and clean PPTX slide-text extraction remain; legacy `.ppt` remains unsupported. Generation stays backend-only, uses the existing 30-second timeout/idempotency/no-auto-retry controls, and never auto-publishes. It may not be used as a publication-time topic classifier.

## 5. Exact replacement and legacy policy

1. On Push, canonicalize Grade and Difficulty first and acquire a transaction-scoped advisory lock for `Grade|Difficulty`.
2. Validate the target set structurally and verify current human review approval/fingerprint.
3. Read all active non-deleted Mathematics question sets in that Grade+Difficulty pool with row locks.
4. If one or more exist, return a confirmation response listing every set that will be replaced. No action occurs without explicit confirmation.
5. On confirmed Push, mark all those active sets `superseded`, unpublish their questions, activate/publish only the new set and its questions, and commit atomically.
6. Do not affect any other Grade/Difficulty pool.

Historical topic fields and `topic_id` values remain intact. New rows can store null topic values. No automatic backfill, splitting, deletion, relabeling, or source rewrite is permitted.

During cutover, legacy active topic-scoped sets need a deterministic guard. If a Grade+Difficulty pool has more than one legacy active set before a new Grade+Difficulty publication, `/api/game/questions` must fail closed with a dedicated ambiguous-legacy-pool response rather than blend multiple old sets. A single legacy active set can be served as an explicitly marked compatibility pool until a teacher publishes its Grade+Difficulty replacement. Publishing the replacement is the human-controlled convergence action and supersedes every old active set in that pool.

## 6. API contract

### `GET /api/game/questions`

Request:

```text
/api/game/questions?grade_level=Grade%201&difficulty=Easy
```

`grade` remains an accepted Grade alias. `topic`, `math_topic`, and `topic_id` may be accepted temporarily for wire compatibility but are ignored for selection and never validated as a game scope.

Success response shape:

```json
{
  "scope": {
    "grade_level": "Grade 1",
    "difficulty": "Easy",
    "question_set_id": 123
  },
  "learning_files": [{ "id": 123, "grade_level": "Grade 1", "difficulty": "Easy" }],
  "questions": [
    {
      "id": 456,
      "learning_file_id": 123,
      "question_set_id": 123,
      "question": "…",
      "options": ["…", "…", "…", "…"],
      "correct_answer": "…",
      "grade_level": "Grade 1",
      "difficulty": "Easy",
      "topic_id": null,
      "math_topic": null
    }
  ],
  "availability": { "available": true, "code": "QUESTION_POOL_READY" }
}
```

Optional topic fields in a response are descriptive only. The endpoint selects one active set, never a union of topic sets. Invalid/missing Grade or Difficulty returns a scope-validation error. A multi-active legacy pool returns a deterministic fail-closed compatibility error. The existing undersized/exhausted availability behavior remains Grade/Difficulty scoped.

### `POST /api/game/result`

The gameplay contract is Grade, Difficulty, and optional positive-integer `question_set_id`. When `question_set_id` is supplied, the backend validates the stored set's canonical Grade and Difficulty and accepts active or superseded provenance. It does not compare a submitted or stored Topic. Existing `math_topic` is nullable historical/optional metadata only.

## 7. Schema and migration decision

**Migration required for this cutover: NO.** `learning_files` and `questions` already have Grade and Difficulty; topic columns are already nullable. `game_results.question_set_id` already supplies traceability. The existing Grade/Difficulty indexes have the required left-prefix for exact Grade/Difficulty predicates, so no migration is needed for correctness or initial performance.

No existing topic data is removed. The existing topic indexes may remain until a separately reviewed cleanup/performance migration. A future proposal may add an expression-aware Grade/Difficulty active-pool index after production preflight, but it must not create a uniqueness constraint or rewrite active legacy rows without a reviewed human-controlled convergence plan. That future proposal is explicitly outside this change.

## 8. Regression acceptance matrix

| # | Area | Acceptance case |
| --- | --- | --- |
| 1 | Fixed | Grade 1 / Easy mixed-topic source is accepted. |
| 2 | Fixed | Structurally invalid question is blocked. |
| 3 | Fixed | No Topic selector is present. |
| 4 | Fixed | No `topic_id` is required. |
| 5 | Fixed | Preview preserves exact parsed source fidelity. |
| 6 | Fixed | Review requires reaching the final question. |
| 7 | Fixed | Structural validity plus review enables approval. |
| 8 | Fixed | Successful approval enables Push. |
| 9 | Fixed | Publish activates the exact Grade/Difficulty pool. |
| 10 | Fixed | Same Grade/Difficulty publish replaces that pool after confirmation. |
| 11 | Fixed | Other Grade/Difficulty pools remain untouched. |
| 12 | Fixed | Filename does not decide scope or topic. |
| 13 | Fixed | DOCX path works. |
| 14 | Fixed | PDF path works. |
| 15 | AI | No Topic selector is present. |
| 16 | AI | Generation uses Grade/Difficulty. |
| 17 | AI | Mixed-topic lesson PDF works. |
| 18 | AI | Mixed-topic lesson PPTX works. |
| 19 | AI | PPTX extraction contains clean readable slide text only. |
| 20 | AI | Generated questions are grounded in lesson material. |
| 21 | AI | Four distinct choices and mapped answer are required. |
| 22 | AI | Review gate remains enforced. |
| 23 | AI | Approval remains required. |
| 24 | AI | Push activates only after approval. |
| 25 | AI | Tests make no live provider call. |
| 26 | Game | Endpoint accepts Grade/Difficulty without Topic. |
| 27 | Game | Godot requires no Topic. |
| 28 | Game | Randomization remains. |
| 29 | Game | Same-Bandit retry uses another unused question when available. |
| 30 | Game | Exhaustion/reset is isolated to Grade/Difficulty/question-set history. |
| 31 | Game | Grade, Difficulty, and `question_set_id` traceability remains. |

## 9. Rollback

Release the backend/frontend and Godot scope changes as one reviewed compatibility set. The backend temporarily ignores legacy Topic request parameters so the immediately previous APK is not broken during rollout. If a release must be rolled back, restore the previous web/backend artifact and keep all historical rows untouched; no data rollback is required because this design creates no schema/data migration. Do not roll back by changing question content or statuses outside the normal audited publication lifecycle.
