# Lesson Manager Content Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Lesson & Question Manager publication, preview, and mutation flows safe and in-place while presenting Easy/Normal/Difficult consistently without changing production data or Godot gameplay.

**Architecture:** Keep uploaded files, questions, lifecycle, and publication state in the backend database. The browser requests the existing authenticated manager/read endpoints; publishing adds an explicit server-confirmed replacement handshake within the existing transaction. The backend accepts legacy Medium/Hard inputs but normalizes API/UI values to Normal/Difficult; database values are not migrated in this change.

**Tech Stack:** Node.js/Express/PostgreSQL SQL, React 18, Jest/react-scripts, Node test runner.

---

### Task 1: Establish canonical display and matching terminology

**Files:**
- Modify: `capstone/backend/learningContentRules.utils.js`
- Modify: `capstone/backend/server.js`
- Modify: `capstone/backend/progressScene.utils.js`
- Modify: `capstone/backend/fixedQuestionDocument.js`
- Modify: `capstone/backend/learningContentRules.utils.test.js`
- Modify: `capstone/backend/server.learningGame.test.js`
- Modify: `capstone/src/config/gradeTopicMap.js`
- Modify: `capstone/src/components/lessonQuestionManager.utils.js`
- Modify: `capstone/src/components/lessonQuestionManager.utils.test.js`
- Modify: `capstone/src/components/studentProgress.utils.js`
- Modify: `capstone/src/components/studentProgress.utils.test.js`
- Modify: `capstone/src/components/StudentAnalytics.js`
- Modify: `capstone/src/components/StudentAnalytics.test.js`

- [ ] **Step 1: Write failing normalization tests.**

  Add assertions that backend and manager helpers return `Easy`, `Normal`, and `Difficult` for `Easy`, `Medium`/`Normal`, and `Hard`/`Difficult`, respectively. Add endpoint assertions that a request using legacy `Medium` selects a set stored as `Normal`, a request using `Hard` selects a set stored as `Difficult`, and response values display `Normal`/`Difficult` while the test fixture's stored source values remain unchanged.

- [ ] **Step 2: Run the targeted tests and observe RED.**

  Run: `node --test backend/learningContentRules.utils.test.js backend/server.learningGame.test.js` from `capstone` and `npm test -- --watchAll=false --runInBand --runTestsByPath src/components/lessonQuestionManager.utils.test.js src/components/studentProgress.utils.test.js src/components/StudentAnalytics.test.js`.

  Expected: assertions expecting `Normal` and `Difficult` fail because the current canonical values are `Medium` and `Hard`.

- [ ] **Step 3: Implement one compatibility normalization.**

  Change the allowed/display difficulty levels and grade-topic map keys to `Easy`, `Normal`, and `Difficult`. Normalize all legacy spellings to those canonical values. Update `canonicalDifficultySql` to map both legacy and new database values to the same values, so publication scope and `/api/game/questions` matching remain one scope. Keep the analytics object keys `medium` and `hard` unchanged because they are internal metric buckets; change only their rendered labels to `Normal` and `Difficult`.

- [ ] **Step 4: Preserve compatibility at content boundaries.**

  Normalize difficulty comparison in fixed-question validation so a legacy document marker is equivalent to the selected canonical value. Update scene-derived dashboard display labels to Normal/Difficult only; do not alter scene routing, battle strength, question selection, result identity, or stored historical rows.

- [ ] **Step 5: Run the targeted tests and observe GREEN.**

  Re-run the commands from Step 2. Expected: all targeted tests pass, including legacy request matching and historical response normalization.

### Task 2: Require explicit replacement confirmation inside the existing transaction

**Files:**
- Modify: `capstone/backend/server.js`
- Modify: `capstone/backend/server.learningGame.test.js`

- [ ] **Step 1: Write failing publication-route tests.**

  Add four endpoint cases: (a) no same-scope active set publishes normally, (b) an active same-scope set without `confirm_replacement: true` returns HTTP 409 with code `ACTIVE_SET_REPLACEMENT_CONFIRMATION_REQUIRED` and safe current/new summaries, (c) a confirmed request supersedes the old set and activates the new set in the same transaction, and (d) a failing activation rolls back, leaving the existing active state untouched. Include legacy `Medium`/`Normal` and `Hard`/`Difficult` same-scope pairs.

- [ ] **Step 2: Run the focused backend test and observe RED.**

  Run: `node --test backend/server.learningGame.test.js`.

  Expected: confirmation-required assertions fail because the existing route supersedes immediately.

- [ ] **Step 3: Implement transaction-bound confirmation.**

  Extend `publishLearningFile(fileId, publisherId, { confirmReplacement })`. After the existing advisory lock and before any update, query the current Active same-scope learning file using the normalized SQL expression. If a different active set exists and confirmation is absent, throw an HTTP 409 error carrying only its id, title, grade, normalized difficulty, topic, and question count. The route must forward `req.body.confirm_replacement === true` and serialize that summary. With confirmation present, retain the existing supersede, question unpublish, new activation, and commit sequence unchanged.

- [ ] **Step 4: Run the focused backend test and observe GREEN.**

  Run: `node --test backend/server.learningGame.test.js`.

  Expected: normal publication remains available without an active competitor; replacement cannot mutate anything without confirmation; a transaction failure rolls back.

### Task 3: Keep Lesson Manager mounted and make structured preview the authoritative preview

**Files:**
- Modify: `capstone/src/components/LessonQuestionManager.js`
- Modify: `capstone/src/components/LessonQuestionManager.test.js`
- Modify: `capstone/src/styles/lessonQuestionManager.css`
- Modify: `capstone/backend/server.js`
- Modify: `capstone/backend/server.learningGame.test.js`

- [ ] **Step 1: Write failing manager tests.**

  Add Jest cases proving that filename and row Preview both request only `/api/learning-files/:id/questions`; a DOCX/PDF/Active/Superseded/invalid/AI row shows a read-only structured question modal; a 409 replacement response opens `Replace Active Question Set?`; Cancel makes no second request; Confirm sends `{ "confirm_replacement": true }`; and Delete, Trash, Restore, Empty Trash, and Publish retain the manager root and selected view while their refresh occurs.

- [ ] **Step 2: Run the focused manager test and observe RED.**

  Run: `npm test -- --watchAll=false --runInBand --runTestsByPath src/components/LessonQuestionManager.test.js`.

  Expected: the filename route opens the raw preview, confirmed publication has no modal, and a mutation switches to `DashboardLoadingShell`.

- [ ] **Step 3: Make refresh non-blocking after initial data load.**

  Split the initial `loading` state from an in-place manager refresh. Initial mount may show `DashboardLoadingShell`; every post-mutation refresh must update files, trash, and storage without setting that global loading flag or changing `managerView`, filters, pagination, selected folder, or scroll position. Do not add any browser reload or scroll restoration code.

- [ ] **Step 4: Make structured questions the one primary preview.**

  Route filename and Preview actions to one `openQuestionSetPreview` function using the authenticated manager questions endpoint. Extend that endpoint's read-only response with normalized file lifecycle, requested versus actual count, generation state/error, validation summary, and question validation errors. Do not call `/api/game/questions`; do not update `last_fetched_at`, publication status, or question records. Keep raw source downloading separate from question review.

- [ ] **Step 5: Add a confirmation modal and safe action states.**

  Keep an Active set’s normal Delete/Trash action disabled with an explanatory title. On a confirmation-required response, store the server summaries, show current/new metadata, and only issue the confirmation POST when the user chooses Replace & Push to Game. Active rows remain previewable and read-only.

- [ ] **Step 6: Replace the left card with a toolbar without changing table ownership.**

  Change the workspace layout to a single full-width manager surface with a horizontal `[ + New ] [ My Files ] [ Trash Bin ] [ Storage ]` toolbar. Maintain a wrapping toolbar on small widths and retain the existing table wrapper as the only horizontal scrolling region. Do not add viewport-level horizontal overflow.

- [ ] **Step 7: Run focused frontend/backend tests and observe GREEN.**

  Run: `npm test -- --watchAll=false --runInBand --runTestsByPath src/components/LessonQuestionManager.test.js` and `node --test backend/server.learningGame.test.js`.

  Expected: all new behavior passes and no test invokes the game question endpoint for preview.

### Task 4: Verify no static runtime data and complete the release checks

**Files:**
- Modify: `capstone/src/components/LessonQuestionManager.test.js`
- Create: `capstone/docs/lesson-manager-question-source-of-truth.md`

- [ ] **Step 1: Write a failing empty-data test.**

  Render Lesson Manager with `/api/learning-files` returning `[]`; assert `No question files available yet.` appears and no fixture title or static row appears.

- [ ] **Step 2: Run the focused test and observe RED.**

  Run: `npm test -- --watchAll=false --runInBand --runTestsByPath src/components/LessonQuestionManager.test.js`.

  Expected: the assertion is absent before the explicit regression coverage is added.

- [ ] **Step 3: Add the source-of-truth audit document.**

  Document the verified path `Teacher upload -> backend upload/parser or generation -> learning_files/questions -> explicit Push -> Active -> /api/game/questions -> Godot QuestionProvider`, `res://Data/questions.json` as fallback-only, unreferenced developer `Questions/` files as legacy/unused, and PPTX as deferred because no picker/MIME/parser/security support exists. State that no difficulty database migration runs in this release.

- [ ] **Step 4: Run full verification.**

  Run the full frontend suite, relevant backend test suite, production frontend build, `git diff --check`, and an audit command showing only intended website files. Record the actual Node version if the local host is not Node 20.

- [ ] **Step 5: Create one local commit.**

  Stage only the listed manager, normalization, test, CSS, and audit-document files. Commit with `fix: improve lesson manager content workflow`. Do not push, deploy, import, publish, call OpenAI, or change Godot.

## Scope review

- Replacement confirmation is server-enforced and stays inside the existing transaction.
- Preview reads only the manager endpoint; game-fetch metadata is untouched.
- Legacy `Medium`/`Hard` records and requests are accepted but displayed/matched as `Normal`/`Difficult`; no production migration is included.
- Godot code is not changed: the backend accepts its current legacy request labels, preserving the encounter contract.
- PPTX is deliberately deferred, with no parser, ZIP/XML dependency, or file picker change.
