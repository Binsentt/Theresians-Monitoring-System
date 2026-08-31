# Backend-owned Canonical Curriculum Registry Implementation Plan

> **For the implementing engineer:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace duplicated curriculum maps with a backend-owned canonical registry, persist canonical `topic_id` for new exact-scope content, and preserve safe legacy compatibility without changing curriculum meaning.

**Architecture:** A pure backend registry module owns IDs, labels, aliases, and the complete approved membership matrix. HTTP exposes that module as a read-only versioned snapshot; backend validation, Fixed Questions, AI-generated children, and the game API resolve against the same module. The frontend derives cascading choices from the endpoint. Godot keeps only approved encounter literals and locally normalizes legacy difficulty aliases; it never downloads the registry.

**Technology Stack:** Node/Express backend and node:test, React frontend and its existing test runner, existing SQLite-style migrations, Godot/GDScript test tooling.

**Status:** Approval-gated future implementation. This plan is documentation only and must not be executed until the registry specification and additive migration proposal receive final review.

**Canonical contract:** [canonical-grade-difficulty-topic-matrix.md](../../canonical-grade-difficulty-topic-matrix.md)

## Guardrails and sequencing

- Do not begin implementation until the proposed nullable `topic_id` migration has been reviewed as a separate change. Do not apply pending migration `015_add_lesson_source_lineage.sql` as part of this work.
- Preserve existing composite labels as one `topic_id`; treat semicolon-separated matrix entries as distinct scopes.
- `basic_addition` and `subtraction` are the only currently deterministic Fixed Question topic-evidence rules. Every other Fixed Question topic requires explicit parsed per-question `topic_id`.
- Do not use OpenAI as a publication-time classifier. AI child sets inherit their human-selected canonical scope and receive structural validation, not weak topic reclassification.
- A legacy row may be read through an exact registry bridge but is never automatically rewritten. Unresolved canonical scope blocks publication.
- Keep schema and code deployment separately reviewable; no data migration, mass update, automatic reapproval, or automatic republication.

## Task 1: Create the backend registry as the sole code owner

**Files:**

- Create: `backend/curriculumScopeRegistry.js`
- Create: `backend/curriculumScopeRegistry.test.js`
- Modify: `backend/learningContentRules.utils.js`
- Modify: `backend/learningContentRules.utils.test.js`

- [ ] **Step 1: Write registry contract tests before code.**

  Cover six canonical Grades, three canonical Difficulties, all 25 stable topic IDs, each of the 18 approved matrix memberships, unique IDs, and rejection of an out-of-matrix tuple. Include normalization cases for `1`, `grade1`, `Medium`, `Average`, and `Hard`. Assert that `Basic Addition`, `Addition`, and `Basic Addition/Subtraction` are different IDs.

  ```js
  assert.deepEqual(
    normalizeScope({ grade_level: 'grade1', difficulty: 'Medium', topic_id: 'basic_addition' }),
    { grade_level: 'Grade 1', difficulty: 'Normal', topic_id: 'basic_addition' }
  );
  assert.equal(isValidScope('Grade 1', 'Easy', 'basic_addition'), true);
  assert.equal(isValidScope('Grade 1', 'Easy', 'addition'), false);
  ```

- [ ] **Step 2: Run the new test and confirm it fails because the registry does not yet exist.**

  ```powershell
  node --test backend/curriculumScopeRegistry.test.js
  ```

  Expected: a module-not-found or failing-contract result that demonstrates the test exercises the missing registry.

- [ ] **Step 3: Implement the immutable registry and small pure helpers.**

  `backend/curriculumScopeRegistry.js` must export a frozen registry snapshot plus pure helpers such as `normalizeGradeLevel`, `normalizeDifficulty`, `getTopicById`, `getTopicsForScope`, `isValidScope`, `resolveLegacyDisplayTopic`, and `getPublicRegistrySnapshot`. Keep `topic_id` as the only machine identity; labels are data owned by the same module.

  ```js
  export function isValidScope(gradeLevel, difficulty, topicId) {
    return SCOPES.some((scope) =>
      scope.grade_level === gradeLevel &&
      scope.difficulty === difficulty &&
      scope.topic_id === topicId
    );
  }
  ```

  `resolveLegacyDisplayTopic` must receive normalized Grade and Difficulty plus a display string, return one `topic_id` only for an exact in-scope registry match, and otherwise return `null`. It must not use keyword or fuzzy matching.

- [ ] **Step 4: Replace backend duplicate-map imports rather than copying registry constants.**

  Adapt `learningContentRules.utils.js` to call registry helpers and return canonical values/labels from the registry. Keep response compatibility fields only as derived labels. Remove its independent Grade/Difficulty/topic map after all consumer tests are adapted.

- [ ] **Step 5: Re-run focused tests.**

  ```powershell
  node --test backend/curriculumScopeRegistry.test.js backend/learningContentRules.utils.test.js
  ```

  Expected: both suites pass with the full approved matrix represented once in backend source.

## Task 2: Expose the immutable registry and normalize exact-scope API input

**Files:**

- Modify: `backend/server.js`
- Modify: `backend/server.learningGame.test.js`
- Create: `backend/server.curriculumRegistry.test.js`
- Modify: `backend/server.schema.test.js` if its route/schema assertions enumerate endpoints

- [ ] **Step 1: Write endpoint and request-adapter tests first.**

  Assert `GET /api/curriculum/registry` returns the registry version, labels, aliases, and scope memberships without authentication-sensitive or question content. Assert no write route exists. For game-content selection, test `topic_id=basic_addition` succeeds only for `Grade 1`/`Easy`, while `topic=Basic Addition` is a temporary exact-label compatibility adapter. Test invalid/missing/out-of-membership/ambiguous values return a safe scope error without pool widening.

- [ ] **Step 2: Run only the new/affected server tests to establish the failure.**

  ```powershell
  node --test backend/server.curriculumRegistry.test.js backend/server.learningGame.test.js
  ```

- [ ] **Step 3: Add one read-only endpoint and one shared scope adapter.**

  Add:

  ```http
  GET /api/curriculum/registry
  ```

  The handler returns `getPublicRegistrySnapshot()` and supports ETag/version cache behavior. The game and manager adapters should prefer `topic_id`, normalize Grade/Difficulty aliases, and invoke `resolveLegacyDisplayTopic` only if a canonical ID is absent. They must reject, rather than broaden, an unresolvable scope.

- [ ] **Step 4: Remove server-local duplicate Grade/Difficulty arrays and topic validation.**

  Make server code consume the registry module; keep existing error shape where required by tests, but do not perpetuate a second curriculum owner.

- [ ] **Step 5: Re-run focused endpoint tests.**

  ```powershell
  node --test backend/server.curriculumRegistry.test.js backend/server.learningGame.test.js backend/server.schema.test.js
  ```

  Expected: the registry response and every exact-scope API path agree on canonical IDs.

## Task 3: Review the additive `topic_id` schema change before creating it

**Files:**

- Review/update only after approval: `backend/migrations/<next>_add_canonical_topic_id.sql`
- Modify after approval: persistence/query code that writes or reads question-set and question `topic_id`
- Create after approval: focused migration and persistence tests using the project's existing database-test convention

- [ ] **Step 1: Build a read-only schema and data inventory.**

  Identify the actual question-set and per-question tables/columns used by `learning_files`, generated child sets, Fixed Question parsing, active-pool selection, and game-history joins. Record existing index names and row counts without writing production data.

- [ ] **Step 2: Submit the proposed migration for review; do not create or apply it before approval.**

  The reviewed migration must be additive and nullable:

  ```sql
  ALTER TABLE learning_files ADD COLUMN topic_id TEXT NULL;
  ALTER TABLE questions ADD COLUMN topic_id TEXT NULL;
  CREATE INDEX idx_learning_files_scope_topic_id
    ON learning_files (grade_level, difficulty, topic_id);
  CREATE INDEX idx_questions_topic_id ON questions (topic_id);
  ```

  Substitute verified physical names only during review. Do not add an unreviewed foreign key to a dynamic code registry and do not make existing rows non-null.

- [ ] **Step 3: Write migration tests before migration creation/application.**

  The test must prove a pre-existing row survives with `NULL topic_id`, a new row can store a valid topic ID, the proposed indexes are present, and old code paths still read a nullable record. The test fixture must not silently backfill legacy data.

- [ ] **Step 4: After separate approval, create and apply the migration once in controlled environments.**

  This is intentionally not an action of the current documentation task. Run the project’s established migration command only after explicit approval, then run the focused migration tests.

- [ ] **Step 5: Implement the legacy bridge without rewriting history.**

  New writes use canonical `topic_id`; legacy `math_topic`/display text is retained for readability. During transitional reads, resolve only the exact safe tuple-and-label cases in memory. Missing/unknown/ambiguous rows remain `NULL` and are not publication eligible.

## Task 4: Make Fixed Question publication evidence fail closed by topic ID

**Files:**

- Modify: `backend/questionScopeAssessment.utils.js`
- Modify: `backend/questionScopeAssessment.utils.test.js`
- Modify: `backend/fixedQuestionDocument.js`
- Modify: `backend/fixedQuestionDocument.test.js`
- Modify: `backend/fixedQuestionDocumentTopic.migration.test.js`
- Modify: `backend/learningFileApproval.test.js`

- [ ] **Step 1: Write failure-first evidence tests.**

  Retain existing passing/mismatching/unverified arithmetic cases for `basic_addition` and `subtraction`. For a representative non-deterministic topic, test missing metadata, unsupported metadata, a different metadata ID, an invalid registry ID, and a metadata ID valid globally but invalid for the selected Grade/Difficulty. Add an explicit composite test proving `basic_addition_subtraction` cannot be inferred from individual arithmetic detection.

  ```js
  assert.deepEqual(
    assessQuestionScope(questionWithoutTopicId, selectedShapesScope),
    { status: 'unverified', code: 'QUESTION_TOPIC_METADATA_REQUIRED' }
  );
  ```

- [ ] **Step 2: Run the focused tests and capture the expected pre-change failures.**

  ```powershell
  node --test backend/questionScopeAssessment.utils.test.js backend/fixedQuestionDocument.test.js backend/fixedQuestionDocumentTopic.migration.test.js backend/learningFileApproval.test.js
  ```

- [ ] **Step 3: Implement registry-aware per-question assessment.**

  The function accepts a canonical selected scope. It uses the existing proven addition/subtraction rules only for their IDs. Every other ID reads an explicitly parsed `question.topic_id`, checks registry existence and exact equality, and returns the precise safe blocker. It must never fall through to word matching, filename analysis, a document title, or an OpenAI call.

- [ ] **Step 4: Persist/parse metadata without inventing it.**

  Extend only the controlled Fixed Question schema/parser to capture explicit `topic_id` metadata. Do not synthesize metadata from a selected dropdown or legacy content. Keep structural validation distinct from publication eligibility as the existing exact-scope lifecycle requires.

- [ ] **Step 5: Re-run the Fixed Question regression group.**

  ```powershell
  node --test backend/questionScopeAssessment.utils.test.js backend/fixedQuestionDocument.test.js backend/fixedQuestionDocumentTopic.migration.test.js backend/learningFileApproval.test.js
  ```

  Expected: only the two approved deterministic topics can publish without explicit per-question metadata; all other unsupported evidence fails closed.

## Task 5: Store inherited canonical scope for AI-generated children

**Files:**

- Modify: `backend/lessonQuestionGeneration.js`
- Modify: `backend/lessonQuestionGeneration.test.js`
- Modify: `backend/server.js`
- Modify: `backend/server.schema.test.js`
- Modify: generated-child persistence tests identified in Task 3

- [ ] **Step 1: Write tests that assert scope inheritance, not classification.**

  Submit a valid canonical `topic_id`; assert the child set and each child question persist the normalized tuple and registry-derived label. Assert generated text that lacks topic keywords can still pass topic policy when structure is valid because it inherits the selected scope. Assert an invalid or out-of-matrix requested topic is rejected before generation.

- [ ] **Step 2: Run the focused generation tests and confirm their pre-change failure.**

  ```powershell
  node --test backend/lessonQuestionGeneration.test.js backend/server.schema.test.js
  ```

- [ ] **Step 3: Use the registry to construct the prompt and persist the child scope.**

  The request sends `topic_id`; backend resolves the label once. Store canonical `topic_id` on the generated child set/questions. Retain prompt controls and structural validation, but remove any generated-output topic keyword reclassification from the publication decision.

- [ ] **Step 4: Verify source/child isolation.**

  One reusable lesson source generates independent children for two valid tuples. Approval/publication of one child cannot alter the other child, and only an exact tuple can replace an exact active pool.

- [ ] **Step 5: Re-run focused generation and lifecycle tests.**

  ```powershell
  node --test backend/lessonQuestionGeneration.test.js backend/questionSetLifecycle.utils.test.js backend/learningFileApproval.test.js
  ```

## Task 6: Migrate the frontend from the independent map to the endpoint

**Files:**

- Create: `src/api/curriculumRegistry.js`
- Modify: `src/components/LessonQuestionManager.jsx`
- Modify: `src/components/lessonQuestionManager.utils.js`
- Modify: `src/components/LessonQuestionManager.test.js`
- Modify: `src/components/lessonQuestionManager.utils.test.js`
- Delete after all consumers migrate: `src/config/gradeTopicMap.js`
- Modify/delete its direct tests/imports as required

- [ ] **Step 1: Write UI tests against a mocked registry response.**

  Verify `Grade 1` -> `Easy` presents exactly Basic Addition, Subtraction, Shapes, Place Value; `Grade 2` -> `Easy` preserves the one composite Basic Addition/Subtraction option; a changed Grade/Difficulty clears invalid Topic selection; submitted create/generate payloads use `topic_id`, not a label; a registry error/loading state disables scope-dependent actions.

- [ ] **Step 2: Run the focused UI tests and confirm missing-client failure.**

  ```powershell
  npm test -- --watchAll=false --runInBand --runTestsByPath src/components/LessonQuestionManager.test.js src/components/lessonQuestionManager.utils.test.js
  ```

- [ ] **Step 3: Add a thin read-only client.**

  `src/api/curriculumRegistry.js` fetches `/api/curriculum/registry`, checks response shape/version, and exposes a derived selector helper. It owns no topic map. Keep its cache local to the client/session and invalidate naturally on refresh/version change.

- [ ] **Step 4: Replace map consumers and remove the duplicate owner.**

  Update all Lesson Manager/Fixed Question/AI selectors to consume registry scopes. Replace display-label payloads with `topic_id` while rendering labels from the endpoint response. Remove `gradeTopicMap.js` only after `rg "gradeTopicMap|GRADE_TOPIC_MAP" src` shows no runtime consumer.

- [ ] **Step 5: Re-run focused UI tests.**

  ```powershell
  npm test -- --watchAll=false --runInBand --runTestsByPath src/components/LessonQuestionManager.test.js src/components/lessonQuestionManager.utils.test.js
  ```

## Task 7: Keep Godot local, canonical, and limited to approved encounter literals

**Files:**

- Modify after explicit gameplay approval: `scripts/game_state.gd`
- Modify/add focused Godot scope normalization regression under the existing Godot test harness
- Do not modify: QuestionProvider history/randomization unless its current exact key needs the canonical `topic_id` field

- [ ] **Step 1: Add focused failing coverage for difficulty normalization and First Bandit scope.**

  Test `Medium`/`Average` normalize to `Normal`, `Hard` to `Difficult`, canonical output never emits `Medium` or `Hard`, and the proven First Bandit scope is precisely `Grade 1`/`Easy`/`basic_addition` (with a derived display label only if the transitional HTTP contract needs it).

- [ ] **Step 2: Implement only the normalizer and explicit approved literal.**

  Do not fetch the web registry, add a complete local topic map, or assign topics to City/Pinehill/other encounters. Leave all unapproved encounter mappings unresolved.

- [ ] **Step 3: Run the established targeted Godot parser/RemoteSync/QuestionProvider regression commands.**

  Expected: no script error, existing scoped history/non-repeat behavior remains unchanged, and no request can form a `Medium` or `Hard` pool.

## Task 8: Conduct the legacy/backfill review gate

**Files:**

- Create after explicit data-change approval: a dated read-only audit report outside runtime source
- Create after review, if required: a narrowly scoped one-time backfill script and its test/report artifacts

- [ ] **Step 1: Run a read-only candidate-resolution report.**

  Use only normalized Grade, normalized Difficulty, exact display label, and registry membership. Report candidate rows, safely resolvable rows, and unresolved reasons. Do not update any row.

- [ ] **Step 2: Obtain explicit approval for the report’s exact write set.**

  The report must distinguish each safe mapping from rows that are missing, ambiguous, out-of-matrix, or use a historical display label with no configured alias.

- [ ] **Step 3: If approved, execute a transactional, idempotent, narrowly scoped backfill.**

  Write only `topic_id` where the audited exact tuple resolves uniquely. Preserve every legacy display value and history field. Never alter questions, labels, approvals, publication state, or active selection except through separately authorized workflows.

- [ ] **Step 4: Verify post-backfill results and keep unresolved rows blocked.**

  Compare pre/post counts, prove every modified row has a valid registry membership, and prove `NULL` unresolved rows are rejected for publication.

## Task 9: Full release regression and rollout gate

**Files:**

- Modify only the files from Tasks 1-8; no production data files

- [ ] **Step 1: Run the full focused regression group.**

  ```powershell
  node --test backend/curriculumScopeRegistry.test.js backend/learningContentRules.utils.test.js backend/questionScopeAssessment.utils.test.js backend/fixedQuestionDocument.test.js backend/fixedQuestionDocumentTopic.migration.test.js backend/lessonQuestionGeneration.test.js backend/learningFileApproval.test.js backend/server.curriculumRegistry.test.js backend/server.schema.test.js backend/server.learningGame.test.js backend/questionSetLifecycle.utils.test.js
  npm test -- --watchAll=false --runInBand --runTestsByPath src/components/LessonQuestionManager.test.js src/components/lessonQuestionManager.utils.test.js
  ```

- [ ] **Step 2: Run full backend/frontend/build/diff gates.**

  ```powershell
  node --test backend/*.test.js backend/database/*.test.js
  npm test -- --watchAll=false --runInBand
  npm run build
  git diff --check
  git status --short
  ```

- [ ] **Step 3: Separate code rollout from data migration/backfill.**

  Before any deployment, record the reviewed migration status, code commit SHA, registry version, empty production-write count, and rollback path. Deploy neither code nor schema as part of documentation approval. A code rollback must not delete `topic_id`, historical values, child sets, approval records, or game history.

## Requirement-to-task traceability

| Requirement | Task(s) |
| --- | --- |
| Backend owns IDs, labels, aliases, memberships | 1, 2 |
| Full approved Grade 1-6 matrix | 1, 2, 6 |
| Frontend consumes read-only endpoint; no duplicate map | 2, 6 |
| New scope key uses `topic_id` | 1-5 |
| Fixed Questions deterministic only for addition/subtraction | 4 |
| Other Fixed Question topics require explicit per-question metadata | 4 |
| AI children inherit human-selected scope, structural checks only | 5 |
| Legacy preserved and unresolved publication blocked | 3, 8 |
| Future nullable additive migration, no immediate apply | 3 |
| Godot local normalizer/no registry fetch/no invented topics | 7 |
| Exact-pool/randomization/non-regression | 2, 5, 7, 9 |

## Self-review

- **One authority:** The registry module is the sole curriculum-map owner; endpoint, validation, frontend, AI, and game adapters consume it.
- **Scope integrity:** `topic_id`, not display text, is the persisted machine key; labels and aliases cannot create duplicate pools.
- **Fail-closed evidence:** Fixed Questions receive no invented classifier coverage. Only two existing deterministic rules remain; every other topic requires exact explicit metadata.
- **Composite preservation:** Composite labels have their own IDs and are never split by a fallback detector or backfill.
- **Legacy safety:** Schema is nullable/additive, compatibility is in-memory/exact, data rewrites are separately reviewed, and unresolved content cannot publish.
- **Godot restraint:** The plan specifies only the proven First Bandit topic and alias normalization; it intentionally leaves unapproved encounters untouched.
- **Verification:** Each implementation change begins with a focused failing test and ends with focused/full regression commands.

## Rollback strategy

The schema proposal is additive and nullable, so a previous application release can ignore the added columns. A code rollback disables new registry-dependent writes while preserving `topic_id`, legacy display labels, content, approval history, active-set state, and game results. Backfill is never the rollback mechanism: it is separate, audited, and only adds an ID where exact evidence permits. Do not use destructive SQL, automatic unpublish, mass delete, or `git reset --hard` as a rollback.
