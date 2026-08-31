# Exact Grade, Difficulty, and Topic Dynamic Question Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one exact Grade/Difficulty/Topic scope from source upload through approval, publication, and game retrieval, while allowing a reusable Lesson PDF to generate isolated dynamic question sets.

**Architecture:** Keep `learning_files` as the question-set lifecycle record, add an additive source/child relationship for reusable Lesson PDFs, and introduce one server-side scope-assessment boundary. Fixed Questions select and validate one scope; AI children do the same after structured generation. Structural review approval remains independent from publication-only scope eligibility. The game endpoint receives all three values and selects the existing exact active set transactionally.

**Tech Stack:** Node 20, Express, PostgreSQL migrations, React 18/react-scripts, Node test runner, Godot/GDScript (separate one-time runtime release).

---

## File map and execution boundaries

| File | Responsibility |
| --- | --- |
| `capstone/backend/learningContentRules.utils.js` | Canonical Grade/Difficulty/Topic normalization and registry validation; no topic invention. |
| `capstone/backend/questionScopeAssessment.utils.js` (new) | Deterministic, non-mutating per-question topic assessment and safe diagnostic codes. |
| `capstone/backend/fixedQuestionDocument.js` | DOCX/PDF extraction, original question ordering, structural validation, and document-to-selected-scope evidence. |
| `capstone/backend/lessonQuestionGeneration.js` | Exact-scope prompt contract and parsed-generation checks; no production call during tests. |
| `capstone/backend/learningFileApproval.utils.js` | Current approval fingerprint; source/child identity where required. |
| `capstone/backend/server.js` | Schema initialization parity, source/child routes, fixed upload, validation summaries, approve/publish, and exact game query. |
| `capstone/backend/migrations/015_add_lesson_source_lineage.sql` (new) | Additive reusable-source lineage schema only. |
| `capstone/src/config/gradeTopicMap.js` | Frontend registry parity with backend. |
| `capstone/src/components/LessonQuestionManager.js` | Fixed scope controls; lesson-source selection/generation; read-only preview state refresh. |
| `capstone/src/components/LessonQuestionManager.test.js` | Manager scope, source reuse, approval/publication, role, and preview regressions. |
| `capstone/backend/*.test.js` listed below | Unit, migration, route, approval, and game contract coverage. |
| `capstone-theresians-quest/scripts/game_state.gd` and `scripts/question_provider.gd` | One-time explicit encounter topic and exact-scope game request; do not touch until the web/backend work has passed review. |

No implementation step edits a file outside these ownership boundaries without adding it to this plan and its tests. The existing user-modified `capstone/docs/teacher-fixed-question-documents/grade1-easy-basic-addition-set-a.docx` is not touched or staged.

### Task 1: Lock down the canonical scope and registry parity

**Files:**
- Modify: `capstone/backend/learningContentRules.utils.js`
- Modify: `capstone/backend/learningContentRules.utils.test.js`
- Modify: `capstone/src/config/gradeTopicMap.js`
- Modify: `capstone/src/components/lessonQuestionManager.utils.js`
- Modify: `capstone/src/components/lessonQuestionManager.utils.test.js`

- [ ] **Step 1: Write failing tuple and registry-parity tests.**

  Add a backend test that each of the audited Grade 1-6/Difficulty rows returns only its declared topics, that an invalid tuple fails, and that legacy `Medium`/`Hard` normalize to `Normal`/`Difficult`. Add a frontend test that serializes its map and compares it to a committed canonical fixture generated from the backend map. Include a test that changing Grade or Difficulty makes an invalid selected topic empty.

  ```js
  assert.equal(
    validateLearningMetadata({ grade_level: 'Grade 1', difficulty: 'Easy', math_topic: 'Basic Addition' }),
    ''
  );
  assert.notEqual(
    validateLearningMetadata({ grade_level: 'Grade 1', difficulty: 'Easy', math_topic: 'Division' }),
    ''
  );
  ```

- [ ] **Step 2: Run the focused tests and observe RED.**

  Run from `C:\Users\vince\Documents\Capstone-Project\Theresian's Quest- Web\capstone`:

  ```powershell
  node --test backend/learningContentRules.utils.test.js
  npm test -- --watchAll=false --runInBand --runTestsByPath src/components/lessonQuestionManager.utils.test.js
  ```

  Expected: the new parity and reset cases fail before the common fixture/normalization wiring exists.

- [ ] **Step 3: Implement one canonical scope helper and parity fixture.**

  Add `normalizeQuestionScope` and `validateQuestionScope` beside the existing metadata helpers. They return canonical `{ grade_level, difficulty, math_topic }` only when all three values are valid and otherwise return the existing safe validation message. Export one JSON-safe registry fixture consumed by the frontend test; keep the existing UI map as data only until the repository layout supports a genuinely shared module. Do not alter the audited map, split slash/`and` labels, or add aliases for topic names.

- [ ] **Step 4: Re-run the focused tests and commit the isolated scope contract.**

  Run the commands from Step 2; expected result is PASS. Then stage only Task 1 files and commit:

  ```powershell
  git add capstone/backend/learningContentRules.utils.js capstone/backend/learningContentRules.utils.test.js capstone/src/config/gradeTopicMap.js capstone/src/components/lessonQuestionManager.utils.js capstone/src/components/lessonQuestionManager.utils.test.js
  git commit -m "feat: define canonical question scope"
  ```

### Task 2: Add deterministic question-scope assessment before using it in a route

**Files:**
- Create: `capstone/backend/questionScopeAssessment.utils.js`
- Create: `capstone/backend/questionScopeAssessment.utils.test.js`
- Modify: `capstone/backend/fixedQuestionDocument.js`
- Modify: `capstone/backend/fixedQuestionDocument.test.js`

- [ ] **Step 1: Write the failing scope-assessment cases.**

  Test the public pure function with a Grade 1/Easy/Basic Addition question, a subtraction question, and an ambiguous/unimplemented-topic question. Assert the return shape is exact, preserves `source_index`, and never assigns a topic from the selected scope merely because the question lacks evidence.

  ```js
  assert.deepEqual(
    assessQuestionScope({ source_index: 3, question: 'What is 9 - 2?' }, BASIC_ADDITION_SCOPE),
    { status: 'mismatch', detected_topic: 'Subtraction', code: 'QUESTION_TOPIC_MISMATCH', source_index: 3 }
  );
  assert.equal(
    assessQuestionScope({ source_index: 4, question: 'Solve this.' }, BASIC_ADDITION_SCOPE).status,
    'unverified'
  );
  ```

- [ ] **Step 2: Run scope/parser tests and observe RED.**

  ```powershell
  node --test backend/questionScopeAssessment.utils.test.js backend/fixedQuestionDocument.test.js
  ```

  Expected: `questionScopeAssessment.utils.js` does not exist and fixed-document validation has no per-question scope diagnostics.

- [ ] **Step 3: Implement the pure, conservative matcher.**

  Create `assessQuestionScope(question, scope)` with only explicit topic rules reviewed for each newly publishable canonical topic. Return one of:

  ```js
  { status: 'match', source_index }
  { status: 'mismatch', detected_topic: 'Subtraction', code: 'QUESTION_TOPIC_MISMATCH', source_index }
  { status: 'unverified', code: 'QUESTION_TOPIC_UNVERIFIED', source_index }
  ```

  A rule may identify a topic only from deterministic content evidence. Missing a rule, conflicting evidence, or an unsupported topic returns `unverified`; it never returns `match` by default. Extend `fixedQuestionDocument.js` with `validateQuestionSetScope({ questions, selected_scope, document_topic })` that compares the header to the selected tuple and accumulates safe `Question N` diagnostics. Keep `validateQuestionSetForReview` structural-only except for existing actual question Grade/Difficulty metadata inconsistencies.

- [ ] **Step 4: Add the audited mixed-document regression and run GREEN.**

  Add the 15-question Addition/Subtraction fixture (questions 1, 2, 4, 6, 8, 10, 11, 13, 15 addition; 3, 5, 7, 9, 12, 14 subtraction) as structurally valid, review-eligible, and publication-blocked. Run the command from Step 2; expected result is PASS.

- [ ] **Step 5: Commit the assessment boundary.**

  ```powershell
  git add capstone/backend/questionScopeAssessment.utils.js capstone/backend/questionScopeAssessment.utils.test.js capstone/backend/fixedQuestionDocument.js capstone/backend/fixedQuestionDocument.test.js
  git commit -m "feat: assess exact question topic scope"
  ```

### Task 3: Add reusable Lesson-PDF source lineage additively

**Files:**
- Create: `capstone/backend/migrations/015_add_lesson_source_lineage.sql`
- Modify: `capstone/backend/server.js`
- Modify: `capstone/backend/fixedQuestionDocumentTopic.migration.test.js`
- Modify: `capstone/backend/server.schema.test.js`
- Modify: `capstone/backend/lessonQuestionGeneration.test.js`

- [ ] **Step 1: Write migration and source-lineage tests before changing the schema.**

  Assert migration 015 adds only:

  ```sql
  ALTER TABLE public.learning_files
    ADD COLUMN IF NOT EXISTS content_role VARCHAR(32) NOT NULL DEFAULT 'question_set',
    ADD COLUMN IF NOT EXISTS source_learning_file_id INTEGER REFERENCES public.learning_files(id) ON DELETE RESTRICT;
  ```

  Assert it adds a check accepting only `lesson_source` and `question_set`, adds an index on `source_learning_file_id`, does not update questions, and does not delete, truncate, or rewrite historical files. Add schema tests that source rows cannot be approved/published and child rows retain exact scope.

- [ ] **Step 2: Run migration/schema tests and observe RED.**

  ```powershell
  node --test backend/fixedQuestionDocumentTopic.migration.test.js backend/server.schema.test.js backend/lessonQuestionGeneration.test.js
  ```

  Expected: migration 015 and the source/child schema behavior are absent.

- [ ] **Step 3: Implement additive source/child schema support.**

  Add migration 015 and matching `ensureSchema()` clauses. Existing records stay `content_role = 'question_set'` with a null parent. A new reusable Lesson PDF record is `content_role = 'lesson_source'`, has no questions, and is excluded from validation/approval/publish candidates. Every new generated child is `content_role = 'question_set'`, has non-null `source_learning_file_id`, preserves its own Grade/Difficulty/Topic/count/fingerprint, and copies only necessary source storage references. Do not add a new fixed-document format, mutate historic lessons, or alter existing approval history.

- [ ] **Step 4: Make generation identity source-and-scope specific.**

  Update the existing request-fingerprint construction and duplicate lookup so the key includes the durable source id/content fingerprint, actor, canonical Grade/Difficulty/Topic, and requested count. Same source plus different scopes or counts yields independent children; an identical retry returns the same child and does not call the provider twice. Keep provider tests mocked; do not call OpenAI.

- [ ] **Step 5: Run GREEN and commit.**

  Run the command from Step 2; expected result is PASS. Then:

  ```powershell
  git add capstone/backend/migrations/015_add_lesson_source_lineage.sql capstone/backend/server.js capstone/backend/fixedQuestionDocumentTopic.migration.test.js capstone/backend/server.schema.test.js capstone/backend/lessonQuestionGeneration.test.js
  git commit -m "feat: support reusable lesson question sources"
  ```

### Task 4: Make Fixed uploads and AI children validate exact scope without conflating review and publication

**Files:**
- Modify: `capstone/backend/server.js`
- Modify: `capstone/backend/fixedQuestionDocument.js`
- Modify: `capstone/backend/lessonQuestionGeneration.js`
- Modify: `capstone/backend/server.learningGame.test.js`
- Modify: `capstone/backend/learningFileApproval.test.js`
- Modify: `capstone/backend/lessonQuestionGeneration.test.js`

- [ ] **Step 1: Write failing route and validation-state tests.**

  Cover: Fixed upload rejects missing/invalid selected Topic before persistence; header mismatch is a publication-only blocker; Basic Addition with one subtraction has `QUESTION_TOPIC_MISMATCH` naming Question 3; unknown evidence has `QUESTION_TOPIC_UNVERIFIED`; four choices/distinct/mapped answer/actual Grade-Difficulty mismatch remain structural; and the 15-question mixed fixture remains structurally valid/approval-eligible yet `MULTI_TOPIC_DOCUMENT` blocked.

  Add AI cases with mocked structured output: an exact-scope result is ready for review, while an out-of-scope or unverified result records a safe failed validation state and creates no publishable child.

- [ ] **Step 2: Run focused backend tests and observe RED.**

  ```powershell
  node --test backend/fixedQuestionDocument.test.js backend/questionScopeAssessment.utils.test.js backend/lessonQuestionGeneration.test.js backend/learningFileApproval.test.js backend/server.learningGame.test.js
  ```

  Expected: current upload derives a topic from the header, does not scope-assess each question, and generation trusts prompt output.

- [ ] **Step 3: Change fixed upload to require and use the selected scope.**

  In `POST /api/learning-files/upload`, parse and validate `grade_level`, `difficulty`, and `math_topic` for both source types. For `fixed_questions`, pass the selected tuple into `resolveFixedQuestionDocumentMetadata`, `validateQuestionSetForReview`, and `validateQuestionSetScope`; do not replace selected `math_topic` with `metadata.math_topic`. Persist the selected canonical tuple to the file and question rows, retain `document_topic` only as audited source evidence, and return precise publication validation diagnostics.

- [ ] **Step 4: Apply the same post-generation gates to an AI child.**

  Expand `buildGenerationInput` to state the selected exact tuple as a hard scope constraint. After `parseGeneratedQuestions`, pass output through structural validation and `validateQuestionSetScope` before `saveQuestionsForFile`. A failed scope assessment leaves the child non-publishable with a safe generation error; it does not auto-retry, auto-correct, or promote a topic.

- [ ] **Step 5: Preserve the review/publication split and fingerprint invalidation.**

  Keep `getQuestionSetValidationState`, `buildQuestionSetReviewEligibility`, `buildQuestionSetPublicationBaseEligibility`, `buildQuestionSetPublicationEligibility`, and `approveLearningFile` structurally driven. Make the publication builder inspect the new scope diagnostics and select the truthful code before `REVIEW_APPROVAL_REQUIRED`. Ensure `buildLearningFileApprovalFingerprint` still includes all scope fields and question content; source lineage may be included only as identity, never as a way to preserve approval after a scope/question edit.

- [ ] **Step 6: Run GREEN and commit.**

  Run the command from Step 2; expected result is PASS. Then:

  ```powershell
  git add capstone/backend/server.js capstone/backend/fixedQuestionDocument.js capstone/backend/lessonQuestionGeneration.js capstone/backend/server.learningGame.test.js capstone/backend/learningFileApproval.test.js capstone/backend/lessonQuestionGeneration.test.js
  git commit -m "feat: separate exact scope publication from review"
  ```

### Task 5: Update Lesson Manager inputs and preserve the existing preview contract

**Files:**
- Modify: `capstone/src/components/LessonQuestionManager.js`
- Modify: `capstone/src/components/LessonQuestionManager.test.js`
- Modify: `capstone/src/components/lessonQuestionManager.utils.js`
- Modify: `capstone/src/components/lessonQuestionManager.utils.test.js`
- Modify: `capstone/src/config/gradeTopicMap.js`

- [ ] **Step 1: Write failing manager tests.**

  Verify Fixed Questions renders and requires the dependent Grade -> Difficulty -> Topic controls, includes `math_topic` in its `FormData`, and resets topic when its prerequisites change. Verify Lesson PDF can select an existing reusable source and create two independent child rows for different scopes/counts. Verify no filename, Set A/B label, or file id is used to choose a topic.

  Retain exact preview regressions: no Reviewed checkbox; Question 1 first-visible; inner scroll and wheel behavior; viewport anchoring; background lock; close/reopen and file-switch reset; no header X; and footer order `Download Source | Approve | Close`.

- [ ] **Step 2: Run manager tests and observe RED.**

  ```powershell
  npm test -- --watchAll=false --runInBand --runTestsByPath src/components/LessonQuestionManager.test.js src/components/lessonQuestionManager.utils.test.js
  ```

  Expected: Fixed Questions lacks a Topic selector and the reusable-source generation controls do not exist.

- [ ] **Step 3: Implement the smallest UI changes at existing boundaries.**

  Use `getMathTopicsForGradeDifficulty` for both source types. In Fixed mode, always render Topic and send it with Grade/Difficulty. In Lesson mode, separate “upload/select lesson source” from “generate question set,” require the exact tuple plus count only for the child request, and render source rows as non-publishable. Keep the existing modal structure and footer; only consume the existing/extended validation summary to distinguish `Needs Correction` from a publication blocker.

- [ ] **Step 4: Refresh child/file state after approval without auto-publishing.**

  On a successful existing approve endpoint response, replace the preview record and matching table row by id, recompute eligibility from the returned validation summary, and retain the current preview scroll/reset behavior. Enable Push only when `publication_eligibility.eligible` is true; otherwise render that endpoint's safe blocker.

- [ ] **Step 5: Add role/scope cases and run GREEN.**

  Add Admin, Teacher, Parent-Teacher Teacher-scope visibility cases and Parent-Teacher Parent-scope, Parent, and Student denial cases for Fixed scope controls, source selection, approve, and Push. Run the command from Step 2; expected result is PASS.

- [ ] **Step 6: Commit the manager change.**

  ```powershell
  git add capstone/src/components/LessonQuestionManager.js capstone/src/components/LessonQuestionManager.test.js capstone/src/components/lessonQuestionManager.utils.js capstone/src/components/lessonQuestionManager.utils.test.js capstone/src/config/gradeTopicMap.js
  git commit -m "feat: choose exact question scope in lesson manager"
  ```

### Task 6: Require exact dynamic scope at the game API boundary

**Files:**
- Modify: `capstone/backend/server.js`
- Modify: `capstone/backend/server.learningGame.test.js`
- Modify: `capstone/backend/questionSetLifecycle.utils.test.js`

- [ ] **Step 1: Write failing game-query tests.**

  Assert `GET /api/game/questions` rejects missing grade, difficulty, or topic with safe `QUESTION_SCOPE_REQUIRED`; rejects a tuple absent from the registry; retrieves only the active exact tuple; never retrieves by filename/id; and changes its candidate set only when that exact scope is replaced. Assert repeated randomization maintains its current no-repeat-until-exhausted behavior per exact active set.

- [ ] **Step 2: Run the game tests and observe RED.**

  ```powershell
  node --test backend/server.learningGame.test.js backend/questionSetLifecycle.utils.test.js
  ```

  Expected: the current endpoint still accepts a partial scope and can query a broad pool.

- [ ] **Step 3: Implement exact-scope-only retrieval.**

  Replace partial query branching in `getGameQuestionsByQuery`, `getGameQuestions`, and `getGameFiles` with a canonical scope guard. Keep legacy difficulty alias normalization at the request edge, require all three fields after normalization, select only `publish_status = 'active'`/published records for that tuple, and return a safe error code without marking a file fetched on invalid input. Preserve transaction-bound same-scope replacement and question-result tracing.

- [ ] **Step 4: Run GREEN and commit.**

  Run the command from Step 2; expected result is PASS. Then:

  ```powershell
  git add capstone/backend/server.js capstone/backend/server.learningGame.test.js capstone/backend/questionSetLifecycle.utils.test.js
  git commit -m "feat: require exact game question scope"
  ```

### Task 7: Make the one-time Godot scope release after backend/API review

**Files:**
- Modify: `C:\Users\vince\Documents\Capstone-Project\capstone-theresians-quest\scripts\game_state.gd`
- Modify: `C:\Users\vince\Documents\Capstone-Project\capstone-theresians-quest\scripts\question_provider.gd`
- Modify/Create: existing Godot battle lifecycle tests under `C:\Users\vince\Documents\Capstone-Project\capstone-theresians-quest\tools`

- [ ] **Step 1: Write failing scope propagation tests.**

  For each configured battle task, assert `question_scope` normalizes to a nonempty Grade, Difficulty, and Topic. Assert `QuestionProvider` sends `grade`, `difficulty`, and `topic` together and keys its no-repeat history by exact scope plus active question-set identity.

- [ ] **Step 2: Run the focused Godot regression harness and observe RED.**

  Run the repository's documented headless Godot test command from `C:\Users\vince\Documents\Capstone-Project\capstone-theresians-quest`. Expected: at least one existing encounter normalizes without a topic.

- [ ] **Step 3: Add encounter-topic configuration without file identities.**

  Add the canonical topic to every battle task's existing `question_scope`; do not include a filename, set label, or learning-file id. Make `_normalize_question_scope` reject/flag incomplete dynamic scope and make `question_provider.gd` transmit the three values as query parameters. Preserve quest sequencing, combat strength, modal flow, retry handling, fallback behavior, and no-repeat behavior. Do not hardcode Set A/Set B or a specific teacher upload.

- [ ] **Step 4: Run the full Godot regression and produce a separately reviewed APK.**

  Only after the backend/frontend change is reviewed and deployed, run the focused harness and the existing full Godot test/build flow. This is the one initial APK release required for exact dynamic topics. It is not an APK build requirement for later exact-scope content replacements.

- [ ] **Step 5: Commit in the Godot repository only after explicit approval.**

  ```powershell
  git -C "C:\Users\vince\Documents\Capstone-Project\capstone-theresians-quest" add scripts/game_state.gd scripts/question_provider.gd tools
  git -C "C:\Users\vince\Documents\Capstone-Project\capstone-theresians-quest" commit -m "feat: request questions by exact encounter scope"
  ```

  This task is intentionally out of scope for the current planning-only request and must not be started without new authorization.

### Task 8: Run the Node 20 release gate and prepare rollback artifacts

**Files:**
- Modify only test/implementation files from Tasks 1-6; no production data files

- [ ] **Step 1: Verify Node 20 and install state without changing dependencies.**

  ```powershell
  node --version
  npm --version
  ```

  Expected: Node reports `v20.x`. If it does not, stop before interpreting test results and use the approved Node 20 runtime; do not change lockfiles to compensate.

- [ ] **Step 2: Run all focused regression groups.**

  ```powershell
  node --test backend/learningContentRules.utils.test.js backend/questionScopeAssessment.utils.test.js backend/fixedQuestionDocument.test.js backend/fixedQuestionDocumentTopic.migration.test.js backend/lessonQuestionGeneration.test.js backend/learningFileApproval.test.js backend/server.schema.test.js backend/server.learningGame.test.js backend/questionSetLifecycle.utils.test.js
  npm test -- --watchAll=false --runInBand --runTestsByPath src/components/LessonQuestionManager.test.js src/components/lessonQuestionManager.utils.test.js
  ```

  Expected: all pass, including DOCX and PDF fixtures, source reuse/isolation, review/publication separation, role/scope denial, and preview regressions.

- [ ] **Step 3: Run full backend, frontend, build, and diff gates.**

  ```powershell
  node --test backend/*.test.js backend/database/*.test.js
  npm test -- --watchAll=false --runInBand
  npm run build
  git diff --check
  git status --short
  ```

  Expected: all suites/build pass, no whitespace errors, and status shows only intended files plus any pre-existing user change that was neither edited nor staged.

- [ ] **Step 4: Record rollback readiness, but do not deploy.**

  Verify migration 015 is additive and that prior application code tolerates its unused columns. Preserve the pre-release commit SHA, migration SQL, and post-migration schema query. A rollback first routes traffic to the prior app release; it does not delete child/source rows. If a code rollback is insufficient, disable new source-generation UI/routes while retaining raw records for a forward fix. Do not use `git reset --hard`, destructive SQL, mass unpublish, deletion, or an automatic production rollback.

## Requirement-to-task review

| Requirement | Plan task(s) |
| --- | --- |
| Exact Grade -> Difficulty -> Topic -> set hierarchy and full audited mapping | 1, 5, 6 |
| Fixed explicit scope; DOCX/PDF; no filename routing/splitting/fabrication | 2, 4, 5 |
| Per-question mismatch with Question N and mixed 15-question truth | 2, 4 |
| Structural approval separate from publication eligibility | 4, 5 |
| Reusable multi-topic Lesson PDF and isolated AI children | 3, 4, 5 |
| Existing approval fingerprint invalidation | 4 |
| Existing exact-scope replacement and randomization | 6, 7 |
| Strict game request without filename/id | 6, 7 |
| Admin/Teacher/Parent-Teacher Teacher-scope only | 5 |
| Preview, modal, scroll, footer, and no-X regressions | 5 |
| Node 20 focused/full test, build, diff gate | 8 |
| No Godot change in current task; planned initial release only | 7 |

## Self-review

- **Scope coverage:** Every requested item maps to at least one task above. The one material runtime finding—current encounters can omit topic—is explicitly planned as a separate, approval-gated Godot task, so no claim is made that web changes alone complete exact game scope.
- **Structural/publication separation:** Tasks 2 and 4 keep malformed question structure and actual Grade/Difficulty record inconsistency structural, while mixed/uncontrolled/missing/unverified topic scope is publication-only unless the approved structural rules say otherwise.
- **No metadata guessing:** Task 2's matcher fails closed as `unverified`; Tasks 4 and 5 do not write a topic inferred from filename, UI selection alone, or an AI prompt.
- **Terminology consistency:** `source_learning_file_id`, `content_role`, `question_set`, `lesson_source`, `QUESTION_TOPIC_MISMATCH`, and `QUESTION_TOPIC_UNVERIFIED` use the same names in migration, route, tests, and UI tasks.
- **Placeholder scan:** This plan contains no unassigned implementation work. Topic-matcher rule coverage is an intentionally fail-closed requirement: a topic is not newly publishable until its deterministic rule and test are committed.

## Rollback strategy

The eventual schema migration is additive and keeps legacy rows as self-contained `question_set` records. The previous application release ignores the new columns, so a code rollback is non-destructive. There is no migration that rewrites questions, remaps topics, re-approves, republishes, or deletes source/child records. If a post-release problem appears, stop new source generation, restore the previously verified application artifact, retain audit data, and ship a forward corrective migration only after review. Production content, approvals, game state, accounts, and progress are never reset as a rollback mechanism.

## Approved canonical-registry successor — 2026-08-31

The current approved curriculum decision replaces the duplicate-map and broad deterministic-classifier aspects of this earlier implementation plan. Follow [the backend-owned canonical curriculum registry implementation plan](2026-08-31-backend-owned-canonical-curriculum-registry.md) for every future registry, schema, Fixed Question, AI-child, frontend, game API, and Godot change.

The successor plan is binding for the following decisions:

- backend is the sole canonical owner of topic IDs, display labels, aliases, and valid Grade/Difficulty/Topic memberships;
- canonical scope identity uses `grade_level + difficulty + topic_id`, with `Grade 1` through `Grade 6` and `Easy`/`Normal`/`Difficult`;
- `Medium`/`Average` normalize to `Normal`, and `Hard` to `Difficult`, without creating another active pool;
- frontend consumes `GET /api/curriculum/registry` and ultimately retires the independent `gradeTopicMap.js` map;
- composites remain single canonical topics and semicolon-delimited labels remain separate scopes;
- only `basic_addition` and `subtraction` retain deterministic Fixed Question evidence; every other topic requires explicit parsed per-question `topic_id` and fails closed if absent or unsupported;
- AI-generated children inherit and persist the human-selected canonical `topic_id`, then receive structural—not weak topic-classification—validation;
- legacy rows remain unchanged/readable, with only exact safe in-memory resolution and publication blocking when canonical ID cannot be resolved; and
- nullable additive `topic_id` migration/backfill work is approval-gated and has not been created or applied.

This amendment does not authorize implementation, migration creation/application, backfill, deployment, push, APK build, question publication, or production data access. The full 25-topic registry, 18-cell matrix, endpoint contract, migration proposal, expected files, and complete regression matrix are in [canonical-grade-difficulty-topic-matrix.md](../../canonical-grade-difficulty-topic-matrix.md) and the successor plan above.
