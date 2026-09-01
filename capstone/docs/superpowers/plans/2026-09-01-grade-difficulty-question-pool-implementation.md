# Grade + Difficulty Question Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Topic-routed question pools with one active Grade+Difficulty question set while retaining Topic only as optional historical/source metadata.

**Architecture:** The backend normalizes Grade and Difficulty as the only active-pool scope, locks/replaces exact Grade+Difficulty sets transactionally, and returns one exact set to Godot. The frontend submits and displays Grade/Difficulty workflows without Topic gates. Godot requests and histories use Grade+Difficulty+question-set ID. Existing nullable topic fields and history are retained but never decide routing or eligibility.

**Tech Stack:** Node 20/Express/PostgreSQL, React/Jest, Godot/GDScript, existing DOCX/PDF/PPTX extraction and backend OpenAI integration.

---

**Implementation boundary:** This is a plan only. Do not execute it without a new explicit implementation authorization. No migration is required for this cutover, no production writes are authorized, and a replacement signed APK is required only after the planned Godot change passes its clean-worktree regression.

## Preflight and shared contracts

- [ ] **1. Establish the Grade+Difficulty scope contract before touching routes**

  **Files:** `backend/curriculumScopeRegistry.js`, `backend/learningContentRules.utils.js`, `backend/curriculumScopeRegistry.test.js`, `backend/learningContentRules.utils.test.js`, `backend/server.js`

  Replace active-scope callers of the triple resolver with a Grade+Difficulty resolver that returns only canonical values:

  ```js
  const resolveQuestionPoolScope = ({ grade_level, grade, difficulty } = {}) => {
    const canonicalGrade = normalizeGradeLevel(grade_level || grade);
    const canonicalDifficulty = normalizeDifficulty(difficulty);
    return canonicalGrade && canonicalDifficulty
      ? { grade_level: canonicalGrade, difficulty: canonicalDifficulty }
      : null;
  };
  ```

  Keep topic lookup/alias utilities for optional metadata and legacy display only. Remove active callers' dependency on `isValidScope`, `resolveLegacyDisplayTopic`, or selected `topic_id`. Preserve the registry endpoint's backend ownership, ETag, and authorization.

  **Tests:** canonical Grade/Difficulty accepts the approved aliases; no test treats topic membership as required for a pool; topic display lookup remains non-authoritative.

- [ ] **2. Remove topic publication gates while retaining structural gates**

  **Files:** `backend/fixedQuestionDocument.js`, `backend/questionScopeAssessment.utils.js`, `backend/questionScopeAssessment.utils.test.js`, `backend/learningContentRules.utils.js`, `backend/learningContentRules.utils.test.js`, `backend/server.js`

  Stop calling `validateQuestionSetScope` and topic-required `validateLearningMetadata` for Fixed Question review/publication. Delete or retire the active `QUESTION_SCOPE_INVALID`, `QUESTION_TOPIC_MISMATCH`, `QUESTION_TOPIC_UNVERIFIED`, and `QUESTION_TOPIC_METADATA_REQUIRED` publication path. Do not introduce a replacement semantic classifier.

  Keep the source parser's optional `Topic ID:` and heading extraction as display provenance without requiring it. Ensure the actual Fixed Question validator fails only for unreadable/unsupported DOCX/PDF, invalid Grade/Difficulty, missing question text, not-exactly-four choices, duplicate choices, or an answer that cannot map uniquely to a choice.

  **Tests:** a Grade 1/Easy document containing addition, subtraction, shapes, and place value passes with null per-question `topic_id`; malformed question structures fail with precise structural errors; a filename or heading cannot alter scope.

## Backend lifecycle and API work

- [ ] **3. Make approval and Push operate on Grade+Difficulty**

  **Files:** `backend/server.js`, `backend/learningFileApproval.test.js`, `backend/server.learningGame.test.js`

  In `getQuestionSetValidationState`, produce structural validity plus Grade/Difficulty metadata validity; omit topic-scope validation. In `buildQuestionSetPublicationBaseEligibility`, retain structural and reviewed-fingerprint gates but remove any topic blocker and `CANONICAL_TOPIC_UNRESOLVED` path.

  In `publishLearningFile`, replace:

  ```js
  const scopeKey = `${grade}|${difficulty}|${topicId}`;
  ```

  with:

  ```js
  const scopeKey = `${grade}|${difficulty}`;
  ```

  Select all active rows in the exact Grade/Difficulty pool, return all affected rows for explicit confirmation, then supersede/unpublish all of them and activate exactly the new set in the same transaction. Preserve role checks, approval fingerprint checks, audit fields, and all unrelated pools.

  **Tests:** first publish; confirmation-required replacement; confirmed replacement of more than one legacy active row; unrelated Grade/Difficulty remains active; publication rolls back atomically on an injected query failure.

- [ ] **4. Redesign game selection and result verification**

  **Files:** `backend/server.js`, `backend/server.learningGame.test.js`, `backend/server.parentGameResults.test.js`

  Refactor `getGameQuestions` and remove/delegate any duplicate topic-based helper path (`buildPublishedGameQuery`, `getGameQuestionsByQuery`, `getGameLearningFilesByQuery`) so only one active set is selected by canonical Grade/Difficulty. Query that single active `learning_files.id`, then fetch its published questions. Do not union all active legacy sets.

  `GET /api/game/questions` must require only Grade and Difficulty. During the compatibility window, accept `topic`, `math_topic`, and `topic_id` but ignore them. Return `scope.grade_level`, `scope.difficulty`, and `scope.question_set_id`; topic fields are optional descriptive payload fields only.

  Update `resolveGameResultQuestionSet` to compare the submitted set's Grade/Difficulty with the result Grade/Difficulty. Permit active and superseded set IDs for historical traceability. Never compare Topic. Continue storing nullable existing `math_topic` only when supplied; do not infer it.

  **Tests:** no-Topic request succeeds; legacy topic request returns the same pool; invalid Grade/Difficulty fails; multiple active legacy sets produce the documented fail-closed code; result accepts an active/superseded matching set and rejects a mismatched Grade/Difficulty set without considering Topic.

- [ ] **5. Remove Topic from AI generation input without weakening safety**

  **Files:** `backend/lessonQuestionGeneration.js`, `backend/lessonQuestionGeneration.test.js`, `backend/lessonTextExtraction.test.js`, `backend/server.js`, `backend/server.learningGame.test.js`

  Change generation inputs and fingerprints to `{ lessonText, title, gradeLevel, difficulty, questionCount }`. Replace prompt Topic lines with an explicit lesson-grounding instruction:

  ```text
  Generate exactly N Grade X / Difficulty Y mathematics questions using only the provided lesson material.
  The lesson can cover multiple topics. Do not introduce unrelated material.
  ```

  Keep PDF/PPTX extraction, clean PPTX text behavior, unsupported `.ppt`, server-only OpenAI use, 30-second timeout, idempotency/in-progress handling, no automatic retry, structural validation, and review-required status. Persist null topic fields for generated children unless optional source metadata is explicitly present; do not classify generated questions.

  **Tests:** PDF and PPTX mixed-topic fixtures; clean text excludes OOXML/XML/binary tokens; prompt has no Topic instruction; generated output still needs four distinct choices and mapped answers; mocked provider only, never live OpenAI.

- [ ] **6. Preserve schema/history and avoid an unreviewed migration**

  **Files:** `backend/server.js` schema initialization assertions, `backend/server.schema.test.js`, `backend/migrations/` (no new file)

  Do not remove or backfill `topic_id`, `math_topic`, or `document_topic`. Do not add a unique active-pool index in this change because legacy topic pools can legitimately leave multiple currently-active rows until a human-approved replacement converges them. Keep nullable fields/read models intact.

  Verify that existing Grade/Difficulty indexes remain usable for the exact predicates. If a future performance index is needed, write a separate reviewed migration proposal after production preflight; do not create/apply it here.

  **Tests:** schema test confirms all existing nullable topic/history columns remain supported and no runtime migration has been added.

## Frontend work

- [ ] **7. Remove Topic from upload/generation UX and requests**

  **Files:** `src/components/LessonQuestionManager.js`, `src/components/lessonQuestionManager.utils.js`, `src/curriculumRegistry.js`, `src/components/LessonQuestionManager.test.js`, `src/components/lessonQuestionManager.utils.test.js`, `src/curriculumRegistry.test.js`

  Remove required topic state, dropdowns, validation, payload fields, `getMathTopicsForGradeDifficulty` gating, Topic wording, and Topic contribution to local idempotency keys. Keep read-only registry loading for Grades/Difficulties and preserve existing auth/scope behavior.

  The final Fixed flow displays Grade, Difficulty, File Type, and DOCX/PDF file. The Lesson flow displays Grade, Difficulty, Question Count, and a PDF/PPTX source. The reusable source message says Grade, Difficulty, and Question Count only.

  **Tests:** selectors are absent; form sends no topic keys; Grade/Difficulty is required; fixed DOCX/PDF and lesson PDF/PPTX supported-file behavior remains; no duplicate frontend topic map appears.

- [ ] **8. Keep review/preview while changing presentation to optional metadata**

  **Files:** `src/components/LessonQuestionManager.js`, `src/components/LessonQuestionManager.test.js`, `src/styles/lessonQuestionManager.css` only if markup requires it

  Preserve Question 1 opening, `IntersectionObserver` final-question gate, structural validation cards, human approval, Push availability, replacement confirmation, role authorization, and source fidelity. Remove topic mismatch/not-a-single-topic errors and Topic-based replacement language. If an old row has a topic label, show it only as `Source topic metadata` and never as a pool scope.

  Keep Grade/Difficulty folders and scope-independent search/status filtering. Retain an optional source-topic metadata filter only if it cannot shape the active pool or Push result; otherwise remove it.

  **Tests:** mixed-topic preview has no error; approval stays disabled until final question; after approval Push is enabled; confirmation lists Grade/Difficulty and affected sets; existing archive/section/reporting components are untouched.

## Godot compatibility and release work

- [ ] **9. Make the minimal Grade+Difficulty-only Godot scope update in a clean Godot integration worktree**

  **Files:** `scripts/game_state.gd`, `scripts/question_provider.gd`, `scripts/remote_sync.gd`, `tools/production_question_api_smoke_test.gd`, `tools/question_provider_normalization_test.gd`, `tools/question_set_traceability_test.gd`, and only directly related product-context tests.

  In `game_state.gd`, ignore legacy topic keys while normalizing encounter request scope and change its existing `Medium`/`Hard` outputs to canonical `Normal`/`Difficult`. In `question_provider.gd`, request Grade/Difficulty only; remove topic filtering and construct pool history from canonical Grade, canonical Difficulty, and `question_set_id`. Continue accepting optional topic passthrough metadata without using it for selection. In `remote_sync.gd`, send Grade/Difficulty and `question_set_id`; do not require/make up topic metadata.

  Do not change `World/QuestUI.gd` encounter control flow, Bandit scene mechanics, lives, dialogue, save/load semantics, settings, or mobile controls.

  **Tests:** endpoint smoke request has no Topic; normalization preserves `question_set_id`; unanswered candidates are randomized; repeated same-Bandit attempt selects a different unused question when possible; history resets after exhaustion and remains isolated across question-set changes; result traceability is Grade/Difficulty/set ID.

- [ ] **10. Execute release verification and prepare—but do not distribute—the replacement APK**

  **Files:** no source changes beyond Task 9; clean integration worktree only.

  Run Godot import, script checks, all relevant headless product-context regressions, then build a signed APK from the approved clean Godot commit using the existing signing identity. Do not build from the dirty Android worktree. The APK is a new required replacement artifact because the prior APK sends Topic-required remote question requests.

  **Verification:** record commit, signing identity verification result without exposing secrets, APK hash/path, and clean worktree status. Do not deploy or distribute without separate authorization.

## Full verification and rollout

- [ ] **11. Run the complete regression matrix under Node 20 and verify a production build**

  **Files:** all focused test files above plus existing suites.

  Run focused backend Node tests, frontend Jest tests, then the full backend/frontend suites with the repository's pinned Node 20 executable. Build the frontend production artifact and run `git diff --check`. Verify no live provider call is made by tests. Re-run protected non-question suites covering student archive, section registry, manage users, screen time/activity, reporting/printing, leaderboard, and authorization.

  **Commands (adapt only to existing package scripts):**

  ```powershell
  & $node20 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' test -- --runInBand
  & $node20 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' run build
  git diff --check
  ```

  **Acceptance:** all 31 cases in `2026-09-01-grade-difficulty-question-pool-design.md` pass, clean worktrees have only intentional changes, and no protected worktree changes.

- [ ] **12. Release and rollback controls**

  **Files:** release notes only; no data migration.

  Deploy the backward-compatible backend/frontend before or together with the new Godot APK, so older clients' Topic query parameters are ignored rather than rejected. Before enabling content publication, inspect active counts grouped by canonical Grade/Difficulty and identify ambiguous legacy pools. Require a teacher-approved Grade/Difficulty replacement to converge each ambiguous pool; never auto-merge/split data.

  If deployment must be rolled back, redeploy the prior web/backend commit and keep all topic and result history unchanged. Because no migration/backfill occurs, no database rollback is needed. Do not use reset, destructive stash, content rewrite, or automatic publication as a rollback mechanism.
