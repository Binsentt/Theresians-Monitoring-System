# Lesson Lifecycle and Deterministic Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-backed question-set lifecycle visibility, factual analytics metrics, and cacheable user-triggered AI insights without changing the current dashboard design or weakening authorization.

**Architecture:** `learning_files` remains the question-set record and receives additive generation/publish metadata. A pure backend metrics module computes factual values from progress, results, and playtime, while an authenticated endpoint stores only validated AI interpretation keyed by a metrics fingerprint. React renders the authoritative API states and never fabricates percentages.

**Tech Stack:** Express, PostgreSQL, React, Node test runner, React Testing Library, existing direct OpenAI Responses client, Railway.

---

### Task 1: Persist question-set lifecycle state

**Files:**
- Modify: `backend/server.js:ensureSchema`, lifecycle helpers, upload/list/publish routes
- Modify: `backend/server.learningGame.test.js`
- Create: `backend/questionSetLifecycle.utils.js`
- Create: `backend/questionSetLifecycle.utils.test.js`

- [ ] **Step 1: Write failing lifecycle tests**

```js
assert.deepEqual(deriveQuestionSetLifecycle({ generation_status: 'ready_for_review', publish_status: 'staged' }), {
  code: 'ready_for_review', label: 'Ready for Review',
});
assert.equal(deriveQuestionSetLifecycle({ generation_status: 'failed', publish_status: 'staged' }).label, 'Failed');
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `node --test backend/questionSetLifecycle.utils.test.js`

- [ ] **Step 3: Add the lifecycle helper and additive schema columns**

```js
await pool.query("ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS generation_status VARCHAR(32) NOT NULL DEFAULT 'not_applicable'");
await pool.query("ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS publish_status VARCHAR(32) NOT NULL DEFAULT 'staged'");
await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ');
await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS published_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL');
```

Backfill legacy `published=true` records as `active` and the remainder as `staged`; normalize each response through the helper.

- [ ] **Step 4: Add lifecycle route tests**

Test a Lesson PDF’s `generating → ready_for_review/staged` transition, a failed generation with no question insert, a fixed upload staying `not_applicable/staged`, and same-scope `active → superseded` replacement.

- [ ] **Step 5: Run focused lifecycle tests**

Run: `node --test backend/questionSetLifecycle.utils.test.js backend/server.learningGame.test.js`

### Task 2: Publish exactly one active set per canonical scope

**Files:**
- Modify: `backend/server.js:publishLearningFile`, game question/file queries
- Test: `backend/server.learningGame.test.js`

- [ ] **Step 1: Write the failing replacement test**

```js
assert.equal(previous.publish_status, 'superseded');
assert.equal(next.publish_status, 'active');
assert.equal(next.published, true);
assert.ok(next.published_at);
```

- [ ] **Step 2: Implement an advisory transaction lock and ordered updates**

Use the canonical grade/difficulty/topic key with `pg_advisory_xact_lock(hashtext($1))`; validate target questions, supersede all current active rows in that scope, then activate the target with `published_at` and `published_by` from `req.authenticatedUser.id`.

- [ ] **Step 3: Return authoritative state and preserve game compatibility**

Keep `published` in sync for older readers, return active lifecycle data from `GET /api/game/questions`, and leave the game endpoint public.

- [ ] **Step 4: Run focused tests**

Run: `node --test backend/server.learningGame.test.js`

### Task 3: Centralize deterministic analytics metrics

**Files:**
- Create: `backend/studentAnalyticsMetrics.utils.js`
- Create: `backend/studentAnalyticsMetrics.utils.test.js`
- Modify: `backend/parentIdGame.utils.js`
- Modify: `backend/server.js:analytics and student-progress routes`
- Modify: `backend/server.gameProgress.test.js`

- [ ] **Step 1: Write pure failing metric tests**

```js
assert.equal(metrics.correctAnswers, 3);
assert.equal(metrics.incorrectAnswers, 2);
assert.equal(metrics.accuracy, 60);
assert.equal(metrics.difficulty.medium.accuracy, 50);
assert.equal(metrics.questCompletionPercentage, null);
```

Include zero results, result-history precedence, canonical difficulty mapping, topic aggregation, missing playtime, and the absence of a quest denominator.

- [ ] **Step 2: Implement pure calculations**

Use aggregate game-result numerators/denominators; return explicit `null` and availability metadata when values do not exist. Prefer explicit Godot `progress_percentage` in `resolveProgressPercentage`, retain lesson/quest values separately, and never infer a quest denominator.

- [ ] **Step 3: Adapt scoped routes**

Return `metrics` from `/api/student-progress/:studentId`; fetch only data already authorized by the existing scope middleware. Update list/overview queries to use factual result aggregates where available without exposing cross-scope rows.

- [ ] **Step 4: Run backend metric and authorization regression tests**

Run: `node --test backend/studentAnalyticsMetrics.utils.test.js backend/server.gameProgress.test.js backend/server.analyticsAuthorization.test.js backend/server.parentGameResults.test.js`

### Task 4: Add cacheable user-triggered AI insight endpoint

**Files:**
- Create: `backend/studentInsightGeneration.js`
- Create: `backend/studentInsightGeneration.test.js`
- Modify: `backend/server.js:ensureSchema`, game writes, student-progress routes
- Test: `backend/server.analyticsAuthorization.test.js`

- [ ] **Step 1: Write failing AI cache and validation tests**

```js
assert.equal(canGenerateInsight({ validResultCount: 4 }).ready, false);
assert.equal(canGenerateInsight({ validResultCount: 5 }).ready, true);
assert.equal(validateInsightPayload({ performance_insight: '...', strengths: [], weaknesses: [], recommendations: [] }).valid, true);
```

- [ ] **Step 2: Add additive insight storage and staleness writes**

Create `student_ai_insights` with `student_id`, `input_fingerprint`, JSON insight, `generated_by`, `generated_at`, and `stale_at`. Mark the row stale after a valid `game_results` insert or a meaningful progress snapshot change.

- [ ] **Step 3: Implement the authorized request endpoint**

Use `requireAnalyticsAccess` plus `verifyScopedStudentAnalyticsAccess`. Return an insufficient-data state below five valid results, a non-stale matching cache without provider access, or a sanitized unavailable response on missing configuration, provider error, timeout, or invalid JSON. Send only computed metrics to the existing server-side OpenAI client.

- [ ] **Step 4: Run focused AI tests**

Run: `node --test backend/studentInsightGeneration.test.js backend/server.analyticsAuthorization.test.js`

### Task 5: Render lifecycle and factual no-data states without redesign

**Files:**
- Modify: `src/components/LessonQuestionManager.js`
- Modify: `src/styles/lessonQuestionManager.css`
- Modify: `src/components/StudentAnalytics.js`
- Modify: `src/components/ParentChildProgress.js`
- Modify: `src/components/StudentProgress.js`
- Modify: `src/components/TeacherStudentProgress.js`
- Test: `src/components/LessonQuestionManager.test.js`
- Test: `src/components/StudentAnalytics.test.js`
- Test: `src/components/ParentChildProgress.test.js`

- [ ] **Step 1: Write failing UI regressions**

Assert lifecycle labels come from the API, a long filename has a title/ellipsis class, fixed questions hide AI/generation language, no data shows `Not available`, quest completion does not use a synthetic percentage, and the Generate/Refresh control respects cached, stale, unavailable, and insufficient states.

- [ ] **Step 2: Render the server response**

Add compact lifecycle badges and source/generated-set metadata. Keep Preview and Push to Game. Replace numerical fallback rendering with availability text; use `metrics` in Student Analytics and Parent Child Progress.

- [ ] **Step 3: Apply isolated table CSS**

Give `.drive-table` a desktop min-width and `table-layout: fixed`; set Name to a generous width, `white-space: nowrap`, `overflow: hidden`, and `text-overflow: ellipsis`; preserve only wrapper-level horizontal scrolling below the desktop breakpoint; keep actions visible without root overflow.

- [ ] **Step 4: Run focused React tests**

Run: `npm test -- --watch=false --runInBand --runTestsByPath src/components/LessonQuestionManager.test.js src/components/StudentAnalytics.test.js src/components/ParentChildProgress.test.js`

### Task 6: Full verification and existing-service deployment

**Files:**
- Modify: only files proven necessary by Tasks 1–5

- [ ] **Step 1: Run full relevant verification**

Run backend tests serially, focused frontend tests, `npm run build`, and `git diff --check`.

- [ ] **Step 2: Commit only the verified website/backend files**

Run: `git add <verified paths> && git commit -m "Add lifecycle and grounded analytics"`

- [ ] **Step 3: Push and monitor the existing Railway production service**

Run: `git push origin main`; monitor `Theresians-Monitoring-System` until the deployment reports `SUCCESS`.

- [ ] **Step 4: Run safe live checks**

Confirm root `200`, private analytics remain `401` without a token, lifecycle APIs retain authorization, and no existing production data is modified solely for testing. Verify live Lesson PDF generation only if the configured provider has available quota; otherwise report the sanitized external block.
