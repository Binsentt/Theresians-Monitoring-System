# Question Publication Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give approved Grade/Difficulty question sets an explicit Push → Active → Remove → Delete lifecycle while blocking every server-side deletion path from deleting an active set.

**Architecture:** Reuse `learning_files.published`, `publish_status`, approval metadata, `questions.published`, soft deletion, and `admin_audit_logs`; no new state table or migration. Publishing and removing operate transactionally, the backend is authoritative for all destructive guards, and the Lesson Manager renders actions solely from response state.

**Tech Stack:** Node 20, Express, PostgreSQL (`pg`), Node test runner, React 18/Jest.

---

## File map

| File | Responsibility |
| --- | --- |
| `backend/server.js` | publish/unpublish transactions, delete guards, routes, audit writes |
| `backend/questionSetLifecycle.utils.js` | derived status for approved staged sets |
| `backend/questionSetLifecycle.utils.test.js` | status-label contract |
| `backend/server.learningGame.test.js` | lifecycle, authorization, game endpoint, audit, and delete-route contracts |
| `src/components/LessonQuestionManager.js` | state-based actions, Remove modal, response update, atomic Empty Trash call |
| `src/components/LessonQuestionManager.test.js` | Lesson Manager action-state, modal, and bulk-delete tests |

No migration is required. No Godot file changes: with `HttpApi` present, the frozen `QuestionProvider` accepts an empty remote list and does not fall back to local/unrelated questions.

### Task 1: Derive Approved / Not in Game

**Files:**
- Modify: `backend/questionSetLifecycle.utils.js`
- Test: `backend/questionSetLifecycle.utils.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('reports approved staged question sets as approved and not in game', () => {
  const lifecycle = deriveQuestionSetLifecycle({
    file_type: 'fixed_questions',
    generation_status: 'not_applicable',
    approval_status: 'approved',
    publish_status: 'staged',
    published: false,
  });
  assert.equal(lifecycle.code, 'approved_inactive');
  assert.equal(lifecycle.label, 'Approved');
  assert.equal(lifecycle.publishLabel, 'Not in Game');
  assert.equal(lifecycle.tone, 'approved');
});
```

- [ ] **Step 2: Verify the test fails**

Run: `node --test backend/questionSetLifecycle.utils.test.js`

Expected: FAIL because current staged rows render as Pending.

- [ ] **Step 3: Implement the minimal derived branch**

Insert this branch after active/superseded checks and before ready-for-review/staged fallbacks:

```js
if (normalizedPublishStatus === 'staged' && row.approval_status === 'approved') {
  return {
    code: 'approved_inactive',
    label: 'Approved',
    tone: 'approved',
    generationStatus,
    publishStatus: normalizedPublishStatus,
    publishLabel: 'Not in Game',
  };
}
```

Do not persist another status enum or relabel `review_required` rows.

- [ ] **Step 4: Verify and commit**

```powershell
node --test backend/questionSetLifecycle.utils.test.js
git add backend/questionSetLifecycle.utils.js backend/questionSetLifecycle.utils.test.js
git commit -m "feat: label approved inactive question sets"
```

Expected: PASS.

### Task 2: Make Remove from Game transactional and audited

**Files:**
- Modify: `backend/server.js`
- Test: `backend/server.learningGame.test.js`

- [ ] **Step 1: Write failing successful-removal and inactive-removal tests**

Use the current mock `pool`, `setQueryHandler`, and `requestJson` helpers. The successful test for `POST /api/questions/unpublish/77` must assert:

```js
assert.equal(response.status, 200);
assert.equal(response.body.learningFile.publish_status, 'staged');
assert.equal(response.body.learningFile.published, false);
assert.equal(response.body.learningFile.approval_status, 'approved');
assert.deepEqual(unpublishedQuestions.params, [77]);
assert.match(unpublishSelectSql, /for update/i);
assert.doesNotMatch(unpublishFileSql, /approval_status\s*=\s*'review_required'/i);
assert.equal(unpublishAudit.operation_type, 'question_set_unpublished');
```

For a staged/deleted target, assert HTTP 409 with `QUESTION_SET_NOT_ACTIVE` (or 404 for missing), no question update, and no audit insert.

- [ ] **Step 2: Verify failure**

Run: `node --test backend/server.learningGame.test.js`

Expected: FAIL because current unpublish is nontransactional, resets approval, returns no changed row, and does not audit.

- [ ] **Step 3: Replace `unpublishLearningFile` with a transaction**

Implement this exact behavior:

```js
const unpublishLearningFile = async (fileId, actor) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT * FROM public.learning_files WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [fileId]
    );
    const learningFile = locked.rows[0];
    if (!learningFile) throw createLifecycleHttpError('Uploaded file not found', 404);
    if (!(learningFile.published || String(learningFile.publish_status || '').trim().toLowerCase() === 'active')) {
      const error = createLifecycleHttpError('This question set is not Active in Game.', 409);
      error.code = 'QUESTION_SET_NOT_ACTIVE';
      throw error;
    }
    const updated = await client.query(
      `UPDATE public.learning_files
       SET published = false, publish_status = 'staged'
       WHERE id = $1 RETURNING *`,
      [fileId]
    );
    await client.query('UPDATE public.questions SET published = false WHERE learning_file_id = $1', [fileId]);
    await writeQuestionSetPublicationAudit(client, actor, updated.rows[0], 'question_set_unpublished');
    await client.query('COMMIT');
    return normalizeLearningFileRow(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};
```

`writeQuestionSetPublicationAudit` writes only to existing `admin_audit_logs`, records `question_set_unpublished`, and uses safe set/Grade/Difficulty text. Do not clear approval fields, source data, questions, `published_at`, `published_by`, results, or analytics.

- [ ] **Step 4: Return the normalized row from the route**

Make the route pass `req.authenticatedUser`, serialize lifecycle errors as Publish does, and return:

```js
res.json({ success: true, message: 'Content removed from game.', learningFile });
```

- [ ] **Step 5: Verify and commit**

```powershell
node --test backend/server.learningGame.test.js
git add backend/server.js backend/server.learningGame.test.js
git commit -m "feat: add audited question set removal"
```

Expected: PASS.

### Task 3: Enforce the active delete lock on every route

**Files:**
- Modify: `backend/server.js`
- Test: `backend/server.learningGame.test.js`

- [ ] **Step 1: Add failing direct, folder, and Empty Trash contract tests**

Test `DELETE /api/learning-files/:id`, `DELETE /api/learning-files/:id/permanent`, `DELETE /api/folders/:id`, `DELETE /api/folders/:id/permanent`, and the new `DELETE /api/learning-files/trash` against active fixtures. Each must return:

```js
assert.equal(response.status, 409);
assert.equal(response.body.code, 'ACTIVE_QUESTION_SET_CANNOT_BE_DELETED');
assert.match(response.body.error, /Remove from Game before deleting/i);
```

For Empty Trash, assert that one active trashed fixture produces no question/file deletes for any row and returns only safe blocked IDs. Also assert that a trashed historical-result fixture blocks the whole operation before any deletion.

- [ ] **Step 2: Verify failure**

Run: `node --test backend/server.learningGame.test.js`

Expected: FAIL because current endpoints use inconsistent generic conflict responses.

- [ ] **Step 3: Add and apply one error constructor**

Near `createLifecycleHttpError`, add:

```js
const createActiveQuestionSetDeleteError = () => {
  const error = createLifecycleHttpError(
    'Remove from Game before deleting this question set.',
    409
  );
  error.code = 'ACTIVE_QUESTION_SET_CANNOT_BE_DELETED';
  return error;
};
```

Use equivalent active predicates in all four existing routes. Before `app.delete('/api/learning-files/:id')`, add `DELETE /api/learning-files/trash`: begin a transaction, select all target trashed rows `FOR UPDATE`, reject the entire set if any is active or referenced by `game_results`, otherwise delete their questions and learning-file rows, commit, then remove the returned local source paths. Return `{ success: true, deleted_file_ids }`. Preserve current permanent-delete protection for any `game_results.question_set_id` reference; do not unpublish as a delete side effect.

- [ ] **Step 4: Verify and commit**

```powershell
node --test backend/server.learningGame.test.js
git add backend/server.js backend/server.learningGame.test.js
git commit -m "fix: block active question set deletion"
```

Expected: PASS.

### Task 4: Audit Push and preserve exact Grade/Difficulty replacement

**Files:**
- Modify: `backend/server.js`
- Test: `backend/server.learningGame.test.js`

- [ ] **Step 1: Extend the existing publish test**

For Grade 1/Easy replacement, assert:

```js
assert.equal(publishAudit.operation_type, 'question_set_published');
assert.deepEqual(unpublishedLearningFiles.params, ['Grade 1', 'Easy', setB.id]);
assert.doesNotMatch(unpublishedLearningFiles.sql, /topic_id|math_topic/i);
assert.equal(unrelatedPoolMutationAttempted, false);
```

Run the same fixture once as Fixed Questions and once as an approved AI child (`source = 'lesson'`).

- [ ] **Step 2: Verify failure**

Run: `node --test backend/server.learningGame.test.js`

Expected: FAIL because Push currently creates no publication audit event.

- [ ] **Step 3: Pass the authenticated actor through Publish and write the audit in its transaction**

Change `publishLearningFile(fileId, publisherId, options)` to accept `actor`, derive `const publisherId = Number(actor?.id) || null` inside the helper, and pass `req.authenticatedUser` from `POST /api/questions/publish/:id`. After marking the selected file/questions active and before `COMMIT`, call `writeQuestionSetPublicationAudit(client, actor, publishedFile, 'question_set_published')`. Do not change the advisory lock, review/validation gates, replacement confirmation, or Topic-optional Grade/Difficulty scope.

- [ ] **Step 4: Lock the no-active game response with a test**

Stub no active set and assert:

```js
assert.equal(response.status, 200);
assert.deepEqual(response.body.questions, []);
assert.equal(response.body.availability.code, 'QUESTION_POOL_EXHAUSTED');
assert.equal(response.body.scope.question_set_id, null);
```

Do not change `/api/game/questions`; this test protects its fail-closed behavior.

- [ ] **Step 5: Verify and commit**

```powershell
node --test backend/server.learningGame.test.js
git add backend/server.js backend/server.learningGame.test.js
git commit -m "feat: audit question publication lifecycle"
```

Expected: PASS.

### Task 5: Render the authoritative Lesson Manager lifecycle

**Files:**
- Modify: `src/components/LessonQuestionManager.js`
- Test: `src/components/LessonQuestionManager.test.js`

- [ ] **Step 1: Write failing action-state and confirmation tests**

Assert these UI states:

```js
expect(screen.getByText('Approved')).toBeTruthy();
expect(screen.getByRole('button', { name: 'Push to Game' })).toBeTruthy();
expect(screen.getByText('Active in Game')).toBeTruthy();
expect(screen.getByRole('button', { name: 'Remove from Game' })).toBeTruthy();
expect(screen.queryByRole('button', { name: 'Push to Game' })).toBeNull();
expect(screen.getByRole('button', { name: 'Delete' }).disabled).toBe(true);
```

Confirming Remove must show the requested preservation statement, call `POST /api/questions/unpublish/:id`, replace the row from `data.learningFile` immediately, and enable Delete only after the response is inactive.

- [ ] **Step 2: Verify failure**

```powershell
$env:CI = 'true'
npm test -- --runInBand src/components/LessonQuestionManager.test.js
```

Expected: FAIL because active rows currently render Push and lack Remove.

- [ ] **Step 3: Implement state-based actions**

Add one UI predicate:

```js
const isActiveQuestionSet = (file = {}) => Boolean(
  file.published || String(file.publish_status || '').trim().toLowerCase() === 'active'
);
```

Render Remove instead of Push for active rows. Keep Delete disabled with title `Remove from Game before deleting this question set.`. Implement `requestRemoveFromGame` plus a modal using current manager modal styles. `removeFileFromGame` calls the existing unpublish endpoint, replaces that single response row in `files`, closes the modal, and then calls the existing narrow refresh. Preserve `?scope=teacher` through `lessonManagerApiUrl`.

- [ ] **Step 4: Add failure and role-scope UI coverage**

Replace Empty Trash's `Promise.all` loop with one `DELETE /api/learning-files/trash` request. Assert a 409 delete-lock error leaves all trash rows unchanged and reports the backend message. Assert Parent/Teacher Teacher-scope requests include `?scope=teacher`; backend authorization tests remain the authority for denied Parent/Teacher Parent scope, Parent, and Student roles.

- [ ] **Step 5: Verify and commit**

```powershell
$env:CI = 'true'
npm test -- --runInBand src/components/LessonQuestionManager.test.js
git add src/components/LessonQuestionManager.js src/components/LessonQuestionManager.test.js
git commit -m "feat: manage active question set removal"
```

Expected: PASS.

### Task 6: Run complete local regressions

**Files:**
- Modify: none unless a test exposes a true requirement gap

- [ ] **Step 1: Run backend contracts under Node 20**

```powershell
node --version
node --test backend/questionSetLifecycle.utils.test.js backend/server.learningGame.test.js backend/server.learningAuthorization.test.js backend/fixedQuestionDocument.test.js backend/lessonQuestionGeneration.test.js
```

Expected: PASS, including Admin/Teacher/Parent-Teacher Teacher-scope authorization and all denied roles.

- [ ] **Step 2: Run frontend contracts**

```powershell
$env:CI = 'true'
npm test -- --runInBand src/components/LessonQuestionManager.test.js src/components/lessonQuestionManager.utils.test.js src/components/StudentProgressLifecycleActions.test.js
```

Expected: PASS; review gate, mixed-topic Fixed Questions, PDF/PPTX ingestion, and Student Progress Archive remain unchanged.

- [ ] **Step 3: Run final local release gates**

```powershell
node --test backend/*.test.js
$env:CI = 'true'
npm test -- --runInBand
npm run build
git diff --check
```

Expected: all tests/builds pass with no whitespace errors.

- [ ] **Step 4: Verify delivery constraints before any later release decision**

```powershell
git status --short
git log --oneline -6
```

Expected: only intended commits. Do not push, deploy, publish a set, call OpenAI, migrate, modify Godot, build an APK, or alter protected worktrees.

## Rollback

This is an application-only change. If a later release regresses, route traffic back to the prior verified web build or make a forward fix. Never delete source rows, questions, results, audit rows, or pool history; never use destructive SQL, automatic unpublish, mass deletion, or `git reset --hard`.
