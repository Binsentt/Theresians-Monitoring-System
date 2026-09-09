# Admin Parent Creation and Automatic Grounded Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Admin the sole authority for atomic Parent-plus-children creation and automatically provide one shared, fingerprint-cached grounded insight for every authorized role once valid gameplay evidence exists.

**Architecture:** Extend the existing Admin account endpoint with validated child operations and one PostgreSQL transaction, deprecate the Parent mutation route, and preserve all Parent reads. Extract automatic insight resolution into a backend service that reuses canonical metrics, existing claim validation, `student_ai_insights`, and a transaction-scoped advisory lock; render its single payload through one shared React component.

**Tech Stack:** Node.js 20, Express, PostgreSQL/pg, React 18, Jest, Node test runner.

---

### Task 1: Establish failing Admin Parent-creation contracts

**Files:**
- Create: `capstone/backend/server.adminParentCreation.test.js`
- Modify: `capstone/backend/server.parentChildCreation.test.js`

- [ ] **Step 1: Write failing route tests**

Add HTTP-level tests that submit `POST /api/accounts` as Admin with one and multiple `children` entries. Assert one `BEGIN`/`COMMIT`, Parent and Student inserts, Parent relationships, eight-digit create validation, six/eight-digit link lookup, duplicate request-ID rejection, rejection of an already-parented Student, rollback after a later child failure, and child rows returned for ID Directory visibility. Update the old Parent mutation test to require authenticated Parent and Parent/Teacher calls to return `403` with no writes while the existing Parent GET remains readable.

```js
assert.equal(response.status, 201);
assert.deepEqual(response.body.children.map((child) => child.game_student_id), ['00123456', '00123457']);
assert.deepEqual(transactionEvents, ['begin', 'commit']);
assert.equal(parentMutation.status, 403);
assert.equal(writesAfterParentMutation, 0);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test backend/server.adminParentCreation.test.js backend/server.parentChildCreation.test.js
```

Expected: new Admin composite-creation assertions fail because `/api/accounts` ignores `children`, and old Parent mutation assertions fail because the route still creates children.

### Task 2: Implement atomic Admin Parent creation and Parent mutation denial

**Files:**
- Modify: `capstone/backend/server.js`

- [ ] **Step 1: Add request normalization without writes**

Reuse `resolveParentChildProfile`, `normalizeNewStudentCode`, `normalizeExistingStudentCode`, and `resolveCanonicalSection`. Normalize every child to `{ operation, studentId, profile }`, require at least one child for Parent-access roles, and reject duplicate IDs before obtaining a database client.

```js
const operation = String(child.operation || 'create').trim().toLowerCase();
const studentId = normalizeExistingStudentCode(child.student_id ?? child.studentId);
if (!studentId) return { error: 'Student ID must be either 6 or 8 digits.' };
if (seen.has(studentId)) return { error: `Duplicate Student ID: ${studentId}.` };
```

- [ ] **Step 2: Move Parent and child database writes into one transaction**

Acquire one client, begin a transaction, insert the Parent, then process each child. Create mode requires `normalizeNewStudentCode`, inserts a Student with the existing game-child password/email behavior, and adds a Parent relationship. Link mode selects an active Student `FOR UPDATE`, rejects any active Parent relation, leaves the Student unchanged, and adds only the relationship. Commit once all rows succeed and roll back on any failure.

```js
await client.query('BEGIN');
const parent = (await client.query(parentInsertSql, parentParams)).rows[0];
for (const child of normalizedChildren) {
  const student = child.operation === 'create'
    ? await createChildAccount(client, parent.id, child)
    : await resolveUnparentedStudent(client, child.studentId);
  await ensureParentStudentRelationship(client, { teacherId: parent.id, studentId: student.id, relationshipType: 'parent' });
}
await client.query('COMMIT');
```

- [ ] **Step 3: Deny the obsolete Parent mutation and preserve reads**

Keep the authenticated Parent middleware on `POST /api/parent/children`, but return `403` without opening a transaction. Expand the read-only Section registry middleware to include Admin so the Manage Users form can use the same backend registry.

```js
app.post('/api/parent/children', requireParentAnalyticsAccess, (_req, res) => {
  res.status(403).json({ error: 'Only an administrator can create or link children.' });
});
```

- [ ] **Step 4: Run focused backend tests and verify GREEN**

Run the Task 1 command. Expected: all Admin transaction and Parent-denial subtests pass with no network or production database access.

### Task 3: Establish failing automatic-insight contracts

**Files:**
- Create: `capstone/backend/studentAiInsight.service.test.js`
- Modify: `capstone/backend/server.studentMetricsParity.test.js`
- Modify: `capstone/backend/studentAnalyticsInsight.utils.test.js`

- [ ] **Step 1: Write service-level failing tests with an injected provider**

Cover no-data/no-call, limited one-to-four result generation, sufficient five-result generation, current-fingerprint reuse, advisory-lock recheck, changed-fingerprint refresh, provider failure with no cache, and provider failure retaining stale cache. The provider is a local function counter and never performs HTTP.

```js
const state = await resolveStudentAiInsight({ studentId: 44, gradeLevel: 'Grade 1', metrics, actorId: 1, pool, generateInsight });
assert.equal(state.data_level, 'limited_data');
assert.equal(state.preliminary, true);
assert.equal(generateInsight.mock.calls.length, 1);
```

- [ ] **Step 2: Write failing HTTP parity tests**

Use the existing canonical fixture with four Easy Oakleaf results `[1, 1, 1, 0]`. Assert 75% accuracy, current difficulty Easy, automatic insight on the first Admin detail GET, identical cached insight for Teacher and Parent GETs, only one provider call, a new call after evidence changes, and no provider call after unchanged save/progress data.

- [ ] **Step 3: Run focused AI tests and verify RED**

Run:

```powershell
node --test backend/studentAiInsight.service.test.js backend/server.studentMetricsParity.test.js backend/studentAnalyticsInsight.utils.test.js backend/studentAnalyticsMetrics.utils.test.js
```

Expected: service import/status assertions and automatic GET generation fail because the current threshold is five and generation is manual.

### Task 4: Implement automatic, locked, cached grounded insights

**Files:**
- Create: `capstone/backend/studentAiInsight.service.js`
- Modify: `capstone/backend/server.js`

- [ ] **Step 1: Implement deterministic data levels and cache state**

Export `resolveInsightDataLevel`, `buildAiInsightState`, and `resolveStudentAiInsight`. Use `no_data` for zero valid results, `limited_data` for one through four, and `sufficient_data` for five or more. Return `preliminary: true` only for limited data.

```js
const resolveInsightDataLevel = (count) => count < 1 ? 'no_data' : count < 5 ? 'limited_data' : 'sufficient_data';
```

- [ ] **Step 2: Implement one-generation-per-fingerprint locking**

For missing/stale state, begin a client transaction, call `SELECT pg_advisory_xact_lock($1)`, re-read `student_ai_insights`, and return immediately if another request stored the current fingerprint. Otherwise invoke the injected grounded provider, upsert the validated insight, and commit. On provider failure, roll back and return truthful unavailable state with the previous cached insight, if any.

```js
await client.query('BEGIN');
await client.query('SELECT pg_advisory_xact_lock($1)', [studentId]);
const lockedCache = await readCachedInsight(client, studentId);
if (lockedCache?.input_fingerprint === fingerprint && !lockedCache.stale_at) return commitCached(client, lockedCache);
```

- [ ] **Step 3: Route GET and manual recovery POST through the service**

The canonical student-detail GET awaits `resolveStudentAiInsight` after metrics are built. The existing POST uses the same service. Both use the same fingerprint and persisted row for Admin, Teacher, and Parent; authorization remains in existing middleware.

- [ ] **Step 4: Run focused backend tests and verify GREEN**

Run the Task 3 command. Expected: all automatic, parity, cache, fallback, metric, and grounding tests pass without a live provider.

### Task 5: Establish failing Admin and Parent UI contracts

**Files:**
- Modify: `capstone/src/components/ManageUsers.test.js`
- Modify: `capstone/src/components/ParentDashboard.test.js`

- [ ] **Step 1: Add failing Manage Users tests**

Assert the Parent role displays one Children row, uses `/api/sections/registry`, supports Add Another Child and unsaved-row removal, switches between Create New Child and Link Existing Student, submits normalized `children`, and blocks invalid/duplicate child IDs before calling `/api/accounts`.

```js
expect(container.textContent).toContain('Children');
expect(container.textContent).toContain('Add Another Child');
expect(JSON.parse(accountRequest[1].body).children).toHaveLength(2);
```

- [ ] **Step 2: Replace Parent Dashboard Add Child expectations**

Assert neither Parent nor Parent/Teacher renders Add Child controls or the old modal, while linked children, View Child Progress, and the existing Parent read requests remain present.

- [ ] **Step 3: Run focused frontend tests and verify RED**

Run:

```powershell
npm test -- --runTestsByPath src/components/ManageUsers.test.js src/components/ParentDashboard.test.js
```

Expected: Children workflow assertions fail and old Parent Add Child controls are still rendered.

### Task 6: Implement Admin Children form and remove Parent mutation UI

**Files:**
- Create: `capstone/src/components/AdminParentChildren.jsx`
- Create: `capstone/src/components/AdminParentChildren.test.jsx`
- Create: `capstone/src/components/adminParentChildren.utils.js`
- Create: `capstone/src/components/adminParentChildren.utils.test.js`
- Modify: `capstone/src/components/ManageUsers.js`
- Modify: `capstone/src/components/ParentDashboard.js`
- Modify: `capstone/src/styles/manageusers.css`
- Modify: `capstone/src/styles/parentdashboard.css`
- Delete: `capstone/src/components/ParentAddChildModal.js`
- Delete: `capstone/src/components/ParentAddChildModal.test.js`

- [ ] **Step 1: Implement tested child-row normalization and validation**

Create blank rows with stable client IDs and create/link operation. Validate create rows using the existing Grade options, exact eight-digit new IDs, required canonical Section choice, and name fields. Validate link rows as six or eight digits. Reject duplicates across both modes.

- [ ] **Step 2: Implement the controlled Children section**

Render existing form controls and registry-derived Sections. Add/remove operations update only unsaved state. The last row cannot be removed because Parent creation requires at least one child.

- [ ] **Step 3: Integrate with Manage Users submission**

Load the Section registry with the existing authenticated headers, render Children for Parent-access roles, merge child errors with Parent errors, and include the normalized array in the single `/api/accounts` request. Reset child state only after success.

- [ ] **Step 4: Remove Parent Add Child UI**

Remove the import, modal state, handlers, button, modal rendering, and create/link empty-state wording from Parent Dashboard. Delete the now-unreferenced modal and its test. Preserve every Parent read request and navigation action.

- [ ] **Step 5: Run focused frontend tests and verify GREEN**

Run the Task 5 command plus the two new component/utility tests. Expected: all Parent creation and monitoring-only UI tests pass.

### Task 7: Establish failing shared AI presentation contracts

**Files:**
- Create: `capstone/src/components/GroundedAiAnalysis.test.jsx`
- Modify: `capstone/src/components/StudentAnalytics.test.js`
- Modify: `capstone/src/components/ParentChildProgress.test.js`

- [ ] **Step 1: Write failing shared presentation tests**

Assert Performance Insight, Strengths, Weaknesses, Recommendations, limited-data preliminary label, stale-unavailable warning with retained content, no-data state, and optional Refresh Insight action.

- [ ] **Step 2: Write failing role-view parity tests**

Feed the same `aiInsight.insight` object to Student Analytics and Parent Child Progress and assert both render all four sections and identical text without requiring a POST click.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
npm test -- --runTestsByPath src/components/GroundedAiAnalysis.test.jsx src/components/StudentAnalytics.test.js src/components/ParentChildProgress.test.js
```

Expected: the new component is missing and Parent currently renders recommendations only.

### Task 8: Implement the shared AI presentation

**Files:**
- Create: `capstone/src/components/GroundedAiAnalysis.jsx`
- Modify: `capstone/src/components/StudentAnalytics.js`
- Modify: `capstone/src/components/ParentChildProgress.js`
- Modify: `capstone/src/styles/studentprogress.css`

- [ ] **Step 1: Implement one shared renderer**

Render the four persisted insight fields, evidence-level notice, temporary-unavailable warning, and optional refresh button. Do not calculate metrics or create recommendations in React.

- [ ] **Step 2: Replace both role-specific AI blocks**

Pass the exact backend `aiInsight` object from both views into `GroundedAiAnalysis`. Keep each page’s existing fetch, role authorization, layout, child selection, stale-request guard, and refresh handler.

- [ ] **Step 3: Run focused frontend tests and verify GREEN**

Run the Task 7 command. Expected: both role views render identical persisted AI content automatically.

### Task 9: Full verification, scope audit, and focused commit

**Files:**
- Modify only files listed above plus this plan.

- [ ] **Step 1: Run all focused acceptance tests**

Run the focused backend and frontend commands from Tasks 2, 4, 6, and 8. Count test files/tests and record failures.

- [ ] **Step 2: Run full backend suite**

```powershell
node --test backend/*.test.js backend/migrations/*.test.js
```

Expected: zero failures and no live database/OpenAI access.

- [ ] **Step 3: Run full frontend suite**

```powershell
npm test -- --runInBand
```

Expected: zero failures.

- [ ] **Step 4: Run production build and whitespace verification**

```powershell
npm run build
git diff --check
```

Expected: both exit zero.

- [ ] **Step 5: Audit repository boundaries**

Compare final web status/diff against starting commit `9ac5472`, and compare the Godot repository HEAD/status against its captured baseline. Verify no Railway operation, production database call, live OpenAI call, push, or deployment occurred.

- [ ] **Step 6: Commit only focused files**

Stage the exact implementation, tests, styles, and this plan. Inspect the staged diff, commit with a focused message, and verify the resulting HEAD and clean/expected worktree state. Do not push or deploy.
