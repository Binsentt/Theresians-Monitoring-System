# Final Question Review and AI Lesson Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Fixed Question uploads faithful to their source and selected exact scope, add a real last-question review gate, and accept clean PDF/PPTX lesson text for safe AI child-set generation.

**Architecture:** Keep `learning_files` as the durable set/source lifecycle owner. Move lesson extraction into a focused backend module, keep Fixed Question parsing separate, and use the existing canonical registry plus server validation summaries as the sole scope/eligibility authority. The React review gate is local session UI state; server approval continues to enforce authorization, review status, structural validation, and fingerprints.

**Tech Stack:** Node 20, Express, PostgreSQL, React 18, `pdf-parse`, Mammoth, `yauzl`, `fast-xml-parser`, Node test runner, React/Jest.

---

## Scope and file map

| File | Responsibility |
| --- | --- |
| `capstone/backend/fixedQuestionDocument.js` | Parse and structurally validate source-faithful Fixed Question records. |
| `capstone/backend/questionScopeAssessment.utils.js` | Report only proved addition/subtraction conflicts; never require ordinary per-question metadata. |
| `capstone/backend/lessonTextExtraction.js` | Validate/extract/clean PDF and PPTX readable lesson text without provider access. |
| `capstone/backend/lessonQuestionGeneration.js` | Build exact-scope provider input and reject malformed output without title fallback/truncation. |
| `capstone/backend/server.js` | Route validation, source/child lifecycle, server approval/publish eligibility, and safe errors. |
| `capstone/backend/*test.js` | Unit and route/lifecycle coverage with stubbed provider only. |
| `capstone/src/components/LessonQuestionManager.js` | PDF/PPTX UX, Preview sentinel gate, response refresh, exact blockers. |
| `capstone/src/components/lessonQuestionManager.utils.js` | Teacher-facing accepted file formats and Preview helpers. |
| `capstone/src/components/*test.js` | Modal, selector, review-gate, and eligibility UI behavior. |
| `capstone/backend/package.json`, `capstone/backend/package-lock.json` | Direct production dependencies only. |

No database migration is part of this plan. Existing 015/016 schema fields are sufficient.

### Task 1: Lock source fidelity and declared Fixed Question scope in tests

**Files:**

- Modify: `capstone/backend/fixedQuestionDocument.test.js`
- Modify: `capstone/backend/questionScopeAssessment.utils.test.js`
- Modify: `capstone/backend/learningFileApproval.test.js`

- [ ] **Step 1: Add source-to-parsed-record assertions.**

  Add a DOCX/PDF extractor-stub test with one source record containing line breaks, `A.` through `D.`, and `Answer: B`. Assert the output is exactly the same question text after whitespace normalization, exactly the four source choices in order, and the B choice as `correct_answer`.

  ```js
  assert.deepEqual(result.questions[0], {
    source_index: 1,
    question: 'What is 2 + 3?',
    options: ['4', '5', '6', '7'],
    correct_answer: '5',
    validation_errors: [],
    is_valid: true,
  });
  ```

- [ ] **Step 2: Add final-scope regression cases.**

  Assert a structurally valid Shapes document with no `topic_id` line is eligible when its selected canonical scope is Shapes. Assert a valid document heading containing `Basic Addition, Subtraction, Shapes, and Place Value` neither creates `MULTI_TOPIC_DOCUMENT` nor blocks a selected valid scope. Assert malformed optional `topic_id` does not become a hidden required-metadata blocker.

- [ ] **Step 3: Prove the current code is red.**

  Run:

  ```powershell
  C:\Users\vince\AppData\Local\npm-cache\_npx\ebaba8b9e55fd0a9\node_modules\node\bin\node.exe --test backend/fixedQuestionDocument.test.js backend/questionScopeAssessment.utils.test.js backend/learningFileApproval.test.js
  ```

  Expected: the non-arithmetic test fails with `QUESTION_TOPIC_METADATA_REQUIRED` and the mixed-heading test fails with `MULTI_TOPIC_DOCUMENT`.

- [ ] **Step 4: Make the minimal Fixed Question validator change.**

  In `fixedQuestionDocument.js`, keep format detection, extraction, parsing, field validation, and normalizations. Remove document-heading topic validity from the publication decision. Require the set's supplied canonical `topic_id`/scope instead of a per-record topic label. Preserve `document_topic` only as read-only metadata.

  ```js
  const validateQuestionSetForPublication = ({ questions, grade_level, difficulty, topic_id, math_topic, scope_validation } = {}) => {
    const review = validateQuestionSetForReview({ questions, grade_level, difficulty, topic_id, math_topic });
    const scopeError = scope_validation?.isValid === false ? scope_validation.message : '';
    return {
      isValid: review.isValid && !scopeError,
      document_errors: [...review.document_errors, ...(scopeError ? [scopeError] : [])],
      questions: review.questions,
      scope_validation,
    };
  };
  ```

- [ ] **Step 5: Replace the scope policy with conflict-only evidence.**

  In `questionScopeAssessment.utils.js`, keep selected canonical scope resolution. For selected `basic_addition`/`subtraction`, emit a mismatch only for exclusive proved arithmetic evidence; return `match`/no-conflict for no evidence. For every other topic, do not require or guess per-question metadata. Delete `MISSING_DOCUMENT_TOPIC`, `MULTI_TOPIC_DOCUMENT`, `DOCUMENT_TOPIC_MISMATCH`, `QUESTION_TOPIC_METADATA_REQUIRED`, and `QUESTION_TOPIC_UNVERIFIED` as final-workflow blockers.

  ```js
  if (selectedScope.topic_id === 'basic_addition' || selectedScope.topic_id === 'subtraction') {
    const detected = detectArithmeticTopicId(question.question);
    if (detected && detected !== selectedScope.topic_id) return mismatch(question, detected, selectedScope);
  }
  return match(question);
  ```

- [ ] **Step 6: Run the focused tests green and commit.**

  Run the Step 3 command. Expected: all tests pass; no network request occurs.

  ```powershell
  git add capstone/backend/fixedQuestionDocument.js capstone/backend/fixedQuestionDocument.test.js capstone/backend/questionScopeAssessment.utils.js capstone/backend/questionScopeAssessment.utils.test.js capstone/backend/learningFileApproval.test.js
  git commit -m "fix: honor declared fixed question scope"
  ```

### Task 2: Apply the final Fixed Question lifecycle contract at server boundaries

**Files:**

- Modify: `capstone/backend/server.js`
- Modify: `capstone/backend/server.learningAuthorization.test.js`
- Modify: `capstone/backend/server.learningGame.test.js`
- Create: `capstone/backend/server.fixedQuestionLifecycle.test.js`

- [ ] **Step 1: Add lifecycle tests with a stubbed database.**

  Cover a selected Grade 1/Easy/Shapes upload without source metadata; a Basic Addition set containing `8 - 3 = ?`; a multi-topic-looking header; `approval_status = approved`; and a Push response whose blocker is exact and actionable. Assert Fixed Question rows inherit the selected scope and are inserted in parsed order.

  ```js
  assert.equal(savedFile.topic_id, 'shapes');
  assert.deepEqual(savedQuestions.map(({ topic_id }) => topic_id), ['shapes', 'shapes']);
  assert.match(conflictResponse.body.error, /Question 2 conflicts with selected Topic: Basic Addition/i);
  ```

- [ ] **Step 2: Run the new route test red.**

  Run:

  ```powershell
  C:\Users\vince\AppData\Local\npm-cache\_npx\ebaba8b9e55fd0a9\node_modules\node\bin\node.exe --test backend/server.fixedQuestionLifecycle.test.js backend/server.learningAuthorization.test.js backend/server.learningGame.test.js
  ```

  Expected: the route still stores nullable per-question topic metadata and the current publication summary still reports header/metadata blockers.

- [ ] **Step 3: Stamp selected scope and simplify eligibility.**

  In the Fixed Question upload transaction, persist the selected `topic_id` on the `learning_files` row and every question row; retain source content fields unchanged. In `getQuestionSetValidationState` and `buildQuestionSetPublicationBaseEligibility`, use structural validity, canonical scope, conflict-only scope validation, and current approval. Do not inspect `document_topic` as an eligibility precondition.

  ```js
  await saveQuestionsForFile(learningFile.id, fixedQuestions.map((question) => ({
    ...question,
    grade_level: learningFile.grade_level,
    difficulty: learningFile.difficulty,
    math_topic: learningFile.math_topic,
    topic_id: learningFile.topic_id,
    source: 'fixed',
  })), client);
  ```

- [ ] **Step 4: Make Approve status-authoritative.**

  Before approval update, require `approval_status === 'review_required'`; retain backend authorization and structural validation. Return 409 for an already approved or otherwise non-review-required candidate. Do not transmit or persist browser scroll evidence.

  ```js
  if (String(learningFile.approval_status || 'review_required') !== 'review_required') {
    throw createLifecycleHttpError('This question set is not awaiting review approval.', 409);
  }
  ```

- [ ] **Step 5: Return a content-derived review snapshot key.**

  Include a nonpersistent `review_fingerprint` in the questions-preview response, computed from the same set/question content already used for approval fingerprinting. This is only the frontend reset key; it is not an assertion that a human scrolled.

  ```js
  res.json({
    file: normalizedFile,
    validation: summary,
    review_fingerprint: buildLearningFileApprovalFingerprint(file, validation.structural.questions),
    questions: validation.structural.questions,
  });
  ```

- [ ] **Step 6: Run focused tests green and commit.**

  Run the Step 2 command plus:

  ```powershell
  C:\Users\vince\AppData\Local\npm-cache\_npx\ebaba8b9e55fd0a9\node_modules\node\bin\node.exe --test backend/learningFileApproval.test.js backend/questionSetLifecycle.utils.test.js
  ```

  Expected: all tests pass and the exact active-scope replacement/game-selection tests remain unchanged.

  ```powershell
  git add capstone/backend/server.js capstone/backend/server.fixedQuestionLifecycle.test.js capstone/backend/server.learningAuthorization.test.js capstone/backend/server.learningGame.test.js capstone/backend/learningFileApproval.test.js capstone/backend/questionSetLifecycle.utils.test.js
  git commit -m "fix: make fixed question review eligibility explicit"
  ```

### Task 3: Add bounded clean PDF/PPTX lesson extraction

**Files:**

- Create: `capstone/backend/lessonTextExtraction.js`
- Create: `capstone/backend/lessonTextExtraction.test.js`
- Modify: `capstone/backend/package.json`
- Modify: `capstone/backend/package-lock.json`

- [ ] **Step 1: Add direct parser dependencies.**

  Add only these direct production dependencies under `backend` and regenerate the backend lockfile with Node 20:

  ```json
  {
    "dependencies": {
      "fast-xml-parser": "^5.2.5",
      "yauzl": "^3.2.0"
    }
  }
  ```

  Do not use a frontend/transitive `jszip`, add OCR, or accept `.ppt`.

- [ ] **Step 2: Write red extraction tests.**

  Build fixture/mocked ZIP-entry tests for: a readable three-slide deck; out-of-order ZIP entries whose `presentation.xml` relationship order must win; XML/theme/relationship garbage that must not be returned; image-only deck; missing OOXML presentation members; ZIP path traversal; and oversized expanded entry. Test PDF through the same public extractor with a stubbed `pdf-parse` implementation.

  ```js
  assert.equal(result.text, 'Slide 1\nBasic Addition\n\nSlide 2\nAdding combines numbers.\n\nSlide 3\n3 + 2 = 5');
  assert.equal(result.format, 'pptx');
  await assert.rejects(() => extractLessonText(imageOnlyPptx), /No readable lesson text was found/i);
  assert.doesNotMatch(result.text, /<a:t>|rId\d+|theme\d+|shapeId/i);
  ```

- [ ] **Step 3: Run extractor tests red.**

  Run:

  ```powershell
  C:\Users\vince\AppData\Local\npm-cache\_npx\ebaba8b9e55fd0a9\node_modules\node\bin\node.exe --test backend/lessonTextExtraction.test.js
  ```

  Expected: module/dependency does not yet exist.

- [ ] **Step 4: Implement the single extraction boundary.**

  Export `validateLessonSourceFile(file)`, `extractLessonText(filePath, fileMetadata, dependencies)`, and `cleanLessonText(text)`. Accept PDF only with the existing MIME/signature rule. For PPTX require the exact OOXML MIME, `.pptx`, ZIP signature, `[Content_Types].xml`, `ppt/presentation.xml`, and presentation relationships. Use `yauzl` lazy entry access with explicit entry count, individual expanded bytes, total expanded bytes, and path bounds.

  ```js
  const cleanLessonText = (value) => String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  ```

  Resolve only presentation-listed `ppt/slides/slide*.xml` targets. Parse with `preserveOrder: true`, collect visible `a:t` run content in paragraph order, prepend `Slide N`, and never read notes, masters, layouts, themes, media, charts, relationships beyond the presentation list, or other package parts.

- [ ] **Step 5: Run extraction tests green and commit.**

  Run the Step 3 command. Expected: all PDF/PPTX, empty, order, junk, and bounds tests pass.

  ```powershell
  git add capstone/backend/package.json capstone/backend/package-lock.json capstone/backend/lessonTextExtraction.js capstone/backend/lessonTextExtraction.test.js
  git commit -m "feat: extract clean PPTX lesson text"
  ```

### Task 4: Route PDF/PPTX lesson generation through clean text and validate child output

**Files:**

- Modify: `capstone/backend/server.js`
- Modify: `capstone/backend/lessonQuestionGeneration.js`
- Modify: `capstone/backend/lessonQuestionGeneration.test.js`
- Modify: `capstone/backend/server.learningAuthorization.test.js`
- Create: `capstone/backend/server.lessonIngestion.test.js`

- [ ] **Step 1: Add red route/generation tests.**

  Stub the extractor and provider. Assert PPTX source save accepts only its valid format, empty/PPTX failure calls no provider, clean text enters the provider input without internal XML, title alone cannot substitute for text, the prompt carries selected Grade/Difficulty/ID/display label/count, malformed output saves no questions, and valid output creates a `ready_for_review` child whose questions inherit the exact selected tuple.

  ```js
  assert.equal(providerCalls, 0);
  assert.match(JSON.stringify(providerRequest.input), /Topic ID: basic_addition/);
  assert.deepEqual(savedQuestions.map((row) => row.topic_id), ['basic_addition', 'basic_addition']);
  assert.equal(savedQuestionRows.length, 0);
  ```

- [ ] **Step 2: Run the focused tests red.**

  Run:

  ```powershell
  C:\Users\vince\AppData\Local\npm-cache\_npx\ebaba8b9e55fd0a9\node_modules\node\bin\node.exe --test backend/lessonQuestionGeneration.test.js backend/server.lessonIngestion.test.js backend/server.learningAuthorization.test.js
  ```

  Expected: PPTX is rejected and generation can still use title/partially truncated content behavior.

- [ ] **Step 3: Use clean extraction before provider work.**

  Replace PDF-only `generateQuestionTextFromLesson` with the extraction module. Validate readable text and the maximum text budget before calling `generateLessonQuestions`; never slice and continue. Reuse this function for direct and reusable-source generation so both share format, cleaning, empty, and provider-call behavior.

  ```js
  const lesson = await extractLessonText(sourceFilePath, lessonSource);
  if (lesson.text.length > MAX_LESSON_TEXT_CHARS) {
    throw new QuestionGenerationError('QUESTION_AI_LESSON_TOO_LONG', 'The lesson text is too long for safe question generation.');
  }
  const questions = await generateLessonQuestions({ lessonText: lesson.text, /* exact scope */ });
  ```

- [ ] **Step 4: Tighten generator input/output boundaries.**

  In `lessonQuestionGeneration.js`, require nonempty `lessonText` even when a title exists. Keep the 30-second abort, no retry, JSON schema, and safe diagnostics. Validate exact count and all structural fields before `saveQuestionsForFile`; stamp canonical scope only in the trusted server path and do not run weak topic classification.

  ```js
  if (!lesson) {
    throw new QuestionGenerationError('QUESTION_AI_EMPTY_LESSON', 'No readable lesson text was found in this lesson source.');
  }
  if (lesson.length > MAX_LESSON_TEXT_CHARS) {
    throw new QuestionGenerationError('QUESTION_AI_LESSON_TOO_LONG', 'The lesson text is too long for safe question generation.');
  }
  ```

- [ ] **Step 5: Preserve source reuse and safe failure.**

  Keep source rows non-reviewable/non-publishable, child `source_learning_file_id`, idempotency keys, and safe failure status. On extraction/provider/output failure, write no question rows and keep the candidate non-publishable. Do not call OpenAI in any test.

- [ ] **Step 6: Run focused tests green and commit.**

  Run the Step 2 command. Expected: all tests pass with zero real network/provider calls.

  ```powershell
  git add capstone/backend/server.js capstone/backend/lessonQuestionGeneration.js capstone/backend/lessonQuestionGeneration.test.js capstone/backend/server.lessonIngestion.test.js capstone/backend/server.learningAuthorization.test.js
  git commit -m "feat: ingest clean lesson sources before generation"
  ```

### Task 5: Add the real final-question Preview gate and PDF/PPTX UI copy

**Files:**

- Modify: `capstone/src/components/LessonQuestionManager.js`
- Modify: `capstone/src/components/lessonQuestionManager.utils.js`
- Modify: `capstone/src/components/LessonQuestionManager.test.js`
- Modify: `capstone/src/components/lessonQuestionManager.utils.test.js`
- Modify: `capstone/src/styles/lessonQuestionManager.css`
- Modify: `capstone/src/styles/lessonQuestionManager.viewport.test.js`

- [ ] **Step 1: Write UI tests with a controlled `IntersectionObserver`.**

  Mock an observer that records `root` and manually reports the final target visible. Test one, two, five, fifteen, and invalid-question sets; close/reopen; file switch; changed `review_fingerprint`; and successful approval response refresh. Assert no reviewed-checkbox controls exist.

  ```js
  expect(approveButton).toBeDisabled();
  expect(observerOptions.root).toBe(previewScrollContainer);
  act(() => observerCallback([{ isIntersecting: true, target: finalQuestionSentinel }]));
  expect(approveButton).toBeEnabled();
  fireEvent.click(closeButton);
  reopenPreview();
  expect(approveButton).toBeDisabled();
  ```

- [ ] **Step 2: Run frontend tests red.**

  Run:

  ```powershell
  npm test -- --watchAll=false --runInBand --runTestsByPath src/components/LessonQuestionManager.test.js src/components/lessonQuestionManager.utils.test.js src/styles/lessonQuestionManager.viewport.test.js
  ```

  Expected: current Approve is enabled immediately after structural eligibility and lesson utilities accept only PDF.

- [ ] **Step 3: Implement session-local sentinel state.**

  Introduce `reviewComplete`, `reviewSnapshotKey`, and a final-question sentinel ref. Reset them when the modal closes/opens, selected file changes, questions begin loading, or API response key changes. Observe the sentinel with `root: previewBodyRef.current`; render it in the final question card so visibility proves the reviewer reached the final question in the inner scroll container.

  ```js
  const previewCanApprove = previewCanShowApprove
    && previewReviewEligibility.eligible
    && reviewComplete
    && !approvingPreview;
  ```

  The observer supports the small-set case by checking once after questions render. It must clean up on every state change and never persist a scroll value.

- [ ] **Step 4: Update labels and upload acceptance.**

  Make Lesson chooser, file input, source save, errors, table source labels, and help text say `PDF or PPTX`. Add `.pptx` and standard PPTX MIME to the lesson accept list and `isSupportedLearningUpload`; do not add `.ppt`. Keep Fixed Question teacher copy DOCX/PDF-only and retain the existing backend-only JSON/CSV compatibility behavior.

  ```js
  if (normalizedType === 'lesson') return /\.(pdf|pptx)$/.test(normalizedName);
  ```

- [ ] **Step 5: Refresh from approval response and surface exact blockers.**

  After Approve, replace the Preview record from the response, refresh the matching list/file state, and recompute eligibility from returned `validation_summary`. Render `publication_eligibility.message` for every disabled Push action; do not substitute an opaque generic message.

- [ ] **Step 6: Run frontend tests green and commit.**

  Run the Step 2 command. Expected: all cases pass; the modal still starts at Question 1, retains background lock and footer order, and has no per-question checklist.

  ```powershell
  git add capstone/src/components/LessonQuestionManager.js capstone/src/components/lessonQuestionManager.utils.js capstone/src/components/LessonQuestionManager.test.js capstone/src/components/lessonQuestionManager.utils.test.js capstone/src/styles/lessonQuestionManager.css capstone/src/styles/lessonQuestionManager.viewport.test.js
  git commit -m "feat: require final question review before approval"
  ```

### Task 6: Preserve authorization, game contract, and non-regression behavior

**Files:**

- Modify: `capstone/backend/server.learningAuthorization.test.js`
- Modify: `capstone/backend/server.learningGame.test.js`
- Modify: `capstone/backend/questionSetLifecycle.utils.test.js`
- Modify: `capstone/src/components/LessonQuestionManager.test.js`

- [ ] **Step 1: Add role/scope and lifecycle cases.**

  Assert Admin, Teacher, and Parent/Teacher Teacher-scope may create/review/generate/push; Parent/Teacher Parent-scope, Parent, Student, and anonymous actors are denied. Assert reusable source children remain independent and exact active pool replacement leaves randomization, unused-before-repeat, same-Bandit retry, and no-scope-switch behavior unchanged.

- [ ] **Step 2: Run the regression group.**

  Run:

  ```powershell
  C:\Users\vince\AppData\Local\npm-cache\_npx\ebaba8b9e55fd0a9\node_modules\node\bin\node.exe --test backend/server.learningAuthorization.test.js backend/server.learningGame.test.js backend/questionSetLifecycle.utils.test.js
  npm test -- --watchAll=false --runInBand --runTestsByPath src/components/LessonQuestionManager.test.js
  ```

  Expected: all pass with no test using live provider credentials or a real provider call.

- [ ] **Step 3: Commit regression coverage.**

  ```powershell
  git add capstone/backend/server.learningAuthorization.test.js capstone/backend/server.learningGame.test.js capstone/backend/questionSetLifecycle.utils.test.js capstone/src/components/LessonQuestionManager.test.js
  git commit -m "test: preserve lesson manager scope and game regressions"
  ```

### Task 7: Run release verification and prepare non-destructive rollback evidence

**Files:**

- Modify: no production source beyond Tasks 1-6

- [ ] **Step 1: Verify Node 20.**

  Run:

  ```powershell
  C:\Users\vince\AppData\Local\npm-cache\_npx\ebaba8b9e55fd0a9\node_modules\node\bin\node.exe --version
  ```

  Expected: `v20.x`. Stop if a different Node runtime is used for test/build interpretation.

- [ ] **Step 2: Run all focused backend and frontend tests.**

  Run:

  ```powershell
  C:\Users\vince\AppData\Local\npm-cache\_npx\ebaba8b9e55fd0a9\node_modules\node\bin\node.exe --test backend/fixedQuestionDocument.test.js backend/questionScopeAssessment.utils.test.js backend/learningFileApproval.test.js backend/lessonTextExtraction.test.js backend/lessonQuestionGeneration.test.js backend/server.fixedQuestionLifecycle.test.js backend/server.lessonIngestion.test.js backend/server.learningAuthorization.test.js backend/server.learningGame.test.js backend/questionSetLifecycle.utils.test.js
  npm test -- --watchAll=false --runInBand --runTestsByPath src/components/LessonQuestionManager.test.js src/components/lessonQuestionManager.utils.test.js src/styles/lessonQuestionManager.viewport.test.js
  ```

  Expected: all pass and zero real OpenAI calls.

- [ ] **Step 3: Run full Node 20/backend/frontend/build/diff gates.**

  Run:

  ```powershell
  C:\Users\vince\AppData\Local\npm-cache\_npx\ebaba8b9e55fd0a9\node_modules\node\bin\node.exe --test backend/*.test.js backend/database/*.test.js
  npm test -- --watchAll=false --runInBand
  npm run build
  git diff --check
  git status --short
  ```

  Expected: passing suites/build, no whitespace errors, and only intended files in the clean implementation worktree.

- [ ] **Step 4: Record rollback posture without a production mutation.**

  The release rollback is application-only: route traffic/deploy artifact back to the previous verified web commit, leaving source rows, child rows, approval audit, and active pools intact. Because this plan adds no migration, no destructive data rollback exists or is needed. If ingestion is faulty, disable the new PDF/PPTX UI/route path in a forward corrective release; never delete sources, mass-unpublish, reset history, or rebuild the APK as rollback.

## Requirement-to-task matrix

| Requirement | Tasks |
| --- | --- |
| Fixed content fidelity and structural truth | 1, 2 |
| Exact selected canonical scope; no hidden metadata/header gate | 1, 2 |
| Addition/subtraction proved conflict only | 1, 2 |
| Scroll-to-last, resettable approval gate | 2, 5 |
| Explicit approved/push lifecycle and blockers | 2, 5 |
| PDF/PPTX clean readable lesson ingestion | 3, 4, 5 |
| PPTX order/junk/empty/image-only protections | 3, 4 |
| Exact-scope AI generation/output validation | 4 |
| Source reuse, idempotency, timeout, no auto-publish | 4, 6 |
| Role/scope and game/randomization regressions | 6 |
| Node 20 tests/build/diff and rollback | 7 |

## Plan self-review

- **Coverage:** Every requested Fixed, AI, PPTX, review, security, role, game, and no-regression requirement is assigned to an implementation task and focused regression.
- **Migration:** None is proposed; the plan uses only deployed 015/016 columns and nonpersistent local review state.
- **Dependencies:** `yauzl` and `fast-xml-parser` are direct backend dependencies; OCR, `.ppt`, and reliance on transitive frontend packages are excluded.
- **No placeholders:** All task steps name exact files, concrete assertions, commands, and expected results.
- **Safety:** No task authorizes production writes, question publication, live provider testing, Godot changes, APK work, destructive cleanup, or automatic correction.
