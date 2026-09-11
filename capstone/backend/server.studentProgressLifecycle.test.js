const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('migration 010 adds only the lifecycle and archive controls required for canonical student progress', () => {
  const migrationPath = path.join(__dirname, 'migrations', '010_add_student_progress_lifecycle_controls.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /ADD COLUMN IF NOT EXISTS current_learning_cycle_version INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS progress_archived_at TIMESTAMPTZ/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS progress_archived_by INTEGER/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS progress_archive_reason VARCHAR\(1000\)/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS learning_cycle_version INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /idx_accounts_student_progress_archive/i);
  assert.match(sql, /idx_playtime_sessions_student_cycle/i);
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
});

test('server exposes scoped archive, bulk lifecycle, permanent delete, and canonical cycle contracts', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

  assert.match(source, /app\.get\('\/api\/game\/learning-cycle\/:student_id'/);
  assert.match(source, /app\.get\('\/api\/student-progress\/lifecycle-summary'/);
  assert.match(source, /app\.post\('\/api\/student-progress\/bulk\/reset'/);
  assert.match(source, /app\.post\('\/api\/student-progress\/bulk\/archive'/);
  assert.match(source, /app\.post\('\/api\/student-progress\/:studentId\/archive'/);
  assert.match(source, /app\.post\('\/api\/student-progress\/:studentId\/permanent-delete'/);
  assert.match(source, /current_learning_cycle_version/);
  assert.match(source, /LEARNING_CYCLE_CHANGED/);

  const permanentDeleteRoute = source.slice(
    source.indexOf("app.post('/api/student-progress/:studentId/permanent-delete'"),
    source.indexOf("app.get('/api/student-progress/:studentId/ai-insight'", source.indexOf("app.post('/api/student-progress/:studentId/permanent-delete'"))
  );
  assert.match(permanentDeleteRoute, /progress_archived_at IS NOT NULL/);
  assert.doesNotMatch(permanentDeleteRoute, /progress_archived_at IS NULL/);
  assert.doesNotMatch(permanentDeleteRoute, /DELETE FROM public\.accounts/i);
  assert.doesNotMatch(permanentDeleteRoute, /DELETE FROM public\.teacher_student_relationships/i);
  assert.match(permanentDeleteRoute, /accounts, and relationships remain preserved/i);

  const resetRoute = source.slice(
    source.indexOf("app.post('/api/student-progress/:studentId/reset'"),
    source.indexOf("app.get('/api/student-progress/lifecycle-summary'", source.indexOf("app.post('/api/student-progress/:studentId/reset'"))
  );
  assert.match(resetRoute, /progress_archived_at IS NULL/);
  assert.match(resetRoute, /startFreshLearningCycle\(client, studentId\)/);
});

test('bulk reset is registered before the single-student route so it never treats bulk as a Student ID', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const bulkResetIndex = source.indexOf("app.post('/api/student-progress/bulk/reset'");
  const singleResetIndex = source.indexOf("app.post('/api/student-progress/:studentId/reset'");
  const confirmationHelper = source.slice(
    source.indexOf('const resolveBulkLifecycleConfirmation'),
    source.indexOf('const getScopedLifecycleStudents')
  );

  assert.ok(bulkResetIndex >= 0, 'bulk reset route is registered');
  assert.ok(singleResetIndex >= 0, 'single-student reset route is registered');
  assert.ok(bulkResetIndex < singleResetIndex, 'bulk reset route precedes /:studentId/reset');
  assert.match(confirmationHelper, /expected_count/);
  assert.doesNotMatch(confirmationHelper, /student_id|parent_id/i);
});

test('active monitoring excludes only soft-archived students while archive history remains queryable', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const playtimeFilters = source.slice(
    source.indexOf('const applyPlaytimeFilters'),
    source.indexOf('const handlePlaytimeListRequest')
  );
  const topAchievers = source.slice(
    source.indexOf('const handleTopAchieversRequest'),
    source.indexOf("app.get('/api/top-achievers'")
  );

  assert.match(playtimeFilters, /lifecycle === 'archived'/);
  assert.match(playtimeFilters, /archived_student\.progress_archived_at IS NOT NULL/);
  assert.match(playtimeFilters, /NOT EXISTS/);
  assert.match(topAchievers, /a\.progress_archived_at IS NULL/);
  assert.match(source, /Archive: Progress Archived/);
  assert.match(source, /Reset: New Learning Cycle Started/);
});

test('archived bulk permanent delete exposes an admin-only preview-token contract bound to exact targets', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const previewIndex = source.indexOf("app.get('/api/student-progress/bulk/permanent-delete/preview'");
  const deleteIndex = source.indexOf("app.post('/api/student-progress/bulk/permanent-delete'");
  const singleIndex = source.indexOf("app.post('/api/student-progress/:studentId/permanent-delete'");
  assert.ok(previewIndex >= 0, 'archived bulk preview route is registered');
  assert.ok(deleteIndex >= 0, 'archived bulk delete route is registered');
  assert.ok(previewIndex < singleIndex, 'bulk preview precedes the single-student route');
  assert.ok(deleteIndex < singleIndex, 'bulk delete precedes the single-student route');
  const previewRoute = source.slice(previewIndex, deleteIndex);
  const deleteRoute = source.slice(deleteIndex, singleIndex);
  const targetResolver = source.slice(source.indexOf('const getArchivedProgressBulkTargets'), previewIndex);
  assert.match(previewRoute, /requireAccountManagementAdmin/);
  assert.match(targetResolver, /buildCanonicalStudentProgressQuery\('archived'\)/);
  assert.match(targetResolver, /progress_archived_at IS NOT NULL/);
  assert.match(previewRoute, /preview_token/);
  assert.match(previewRoute, /targets/);
  assert.match(previewRoute, /student_game_progress|game_results|student_ai_insights/);
  assert.match(deleteRoute, /requireAccountManagementAdmin/);
  assert.match(deleteRoute, /jwt\.verify|verifyRememberToken/);
  assert.match(deleteRoute, /target_ids|targetIds/);
  assert.match(deleteRoute, /forUpdate:\s*true/);
  assert.match(deleteRoute, /ROLLBACK/);
  assert.match(deleteRoute, /confirmation.*DELETE|DELETE.*confirmation/);
  assert.match(deleteRoute, /DELETE FROM public\.student_game_progress|startFreshLearningCycle/);
  assert.match(deleteRoute, /DELETE FROM public\.game_results/);
  assert.match(deleteRoute, /DELETE FROM public\.student_ai_insights/);
  assert.doesNotMatch(deleteRoute, /DELETE FROM public\.accounts/i);
  assert.doesNotMatch(deleteRoute, /DELETE FROM public\.teacher_student_relationships/i);
  assert.doesNotMatch(deleteRoute, /DELETE FROM public\.playtime_sessions/i);
  assert.match(deleteRoute, /writeAdminAuditLog|writeStudentLifecycleAudit/);
});

test('archived bulk permanent delete binds actor, target fingerprint, expiry, and replay protection', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const helperStart = source.indexOf('const getArchivedProgressBulkTargets');
  const routeStart = source.indexOf("app.post('/api/student-progress/bulk/permanent-delete'");
  const relevant = source.slice(helperStart, routeStart);
  assert.ok(helperStart >= 0, 'archived target resolver exists');
  assert.match(relevant, /createHash\(['"]sha256/);
  assert.match(relevant, /actor_id|actorId/);
  assert.match(relevant, /expires|expires_at|expiresIn/);
  assert.match(relevant, /preview_token/);
  assert.match(relevant, /target_fingerprint|fingerprint/);
  assert.match(relevant, /used|replay|operation/);
  assert.match(relevant, /search/);
});
