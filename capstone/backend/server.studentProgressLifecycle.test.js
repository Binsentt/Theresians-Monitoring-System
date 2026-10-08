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

test('server preserves the progress marker as legacy metadata and retires progress-only mutations', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

  assert.match(source, /app\.get\('\/api\/game\/learning-cycle\/:student_id'/);
  assert.match(source, /app\.get\('\/api\/student-progress\/lifecycle-summary'/);
  assert.match(source, /app\.post\('\/api\/student-progress\/bulk\/reset'/);
  assert.match(source, /app\.post\('\/api\/student-progress\/bulk\/archive', requireAnalyticsAccess, retiredStudentProgressLifecycle\)/);
  assert.match(source, /app\.get\('\/api\/student-progress\/bulk\/permanent-delete\/preview', requireAccountManagementAdmin, retiredStudentProgressLifecycle\)/);
  assert.match(source, /app\.post\('\/api\/student-progress\/bulk\/permanent-delete', requireAccountManagementAdmin, retiredStudentProgressLifecycle\)/);
  assert.match(source, /app\.post\('\/api\/student-progress\/:studentId\/archive', requireAnalyticsAccess, verifyScopedStudentAnalyticsAccess, retiredStudentProgressLifecycle\)/);
  assert.match(source, /app\.post\('\/api\/student-progress\/:studentId\/permanent-delete', requireAccountManagementAdmin, retiredStudentProgressLifecycle\)/);
  assert.equal((source.match(/app\.post\('\/api\/student-progress\/bulk\/archive'/g) || []).length, 1);
  assert.equal((source.match(/app\.post\('\/api\/student-progress\/:studentId\/archive'/g) || []).length, 1);
  assert.equal((source.match(/app\.post\('\/api\/student-progress\/bulk\/permanent-delete'/g) || []).length, 1);
  assert.equal((source.match(/app\.get\('\/api\/student-progress\/bulk\/permanent-delete\/preview'/g) || []).length, 1);
  assert.equal((source.match(/app\.post\('\/api\/student-progress\/:studentId\/permanent-delete'/g) || []).length, 1);
  assert.doesNotMatch(source, /const getArchivedProgressBulkTargets/);
  assert.doesNotMatch(source, /const resolveLearningCycleArchiveReason/);
  assert.doesNotMatch(source, /archivedProgressBulkPreviewStore/);
  assert.match(source, /current_learning_cycle_version/);
  assert.match(source, /LEARNING_CYCLE_CHANGED/);

  const lifecycleHelper = source.slice(source.indexOf('const resolveStudentProgressListingLifecycle'), source.indexOf('const getLifecycleMutationScope'));
  assert.match(lifecycleHelper, /lifecycle === 'archived'/);
  assert.match(lifecycleHelper, /status: 410/);
  assert.match(source, /Permanently delete the Student account to remove Student-owned progress/);

  const resetRoute = source.slice(
    source.indexOf("app.post('/api/student-progress/:studentId/reset'"),
    source.indexOf("app.get('/api/student-progress/lifecycle-summary'", source.indexOf("app.post('/api/student-progress/:studentId/reset'"))
  );
  assert.doesNotMatch(resetRoute, /progress_archived_at/);
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

test('Screen Time monitoring separates active and soft-archived session history', () => {
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
  assert.match(playtimeFilters, /ps\.deleted_at IS NOT NULL/);
  assert.match(playtimeFilters, /ps\.deleted_at IS NULL/);
  assert.doesNotMatch(topAchievers, /progress_archived_at/);
  assert.match(source, /Reset: New Learning Cycle Started/);
});

test('legacy progress archive markers are metadata only and do not filter active progress or Top Achievers', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const canonicalProgressBuilder = source.slice(
    source.indexOf('const buildCanonicalStudentProgressQuery'),
    source.indexOf('const normalizeTopAchieverRow')
  );
  assert.match(canonicalProgressBuilder, /a\.progress_archived_at/);
  assert.doesNotMatch(canonicalProgressBuilder, /progress_archived_at\s+IS\s+(?:NOT\s+)?NULL/i);
  assert.doesNotMatch(canonicalProgressBuilder, /getStudentProgressArchivePredicate/);
  assert.match(canonicalProgressBuilder, /a\.progress_archived_at/);
  assert.doesNotMatch(source.slice(source.indexOf('const handleTopAchieversRequest'), source.indexOf("app.get('/api/top-achievers'")), /progress_archived_at/);
});

test('permanent Student account removal remains the owned-data deletion path', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const familyLifecycle = fs.readFileSync(path.join(__dirname, 'familyLifecycle.service.js'), 'utf8');
  const routeStart = source.indexOf("app.delete('/api/accounts/:parentId/children/:studentId'");
  const routeEnd = source.indexOf("app.get('/api/accounts'", routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.ok(routeStart >= 0, 'managed Student account deletion route exists');
  assert.match(route, /permanentlyDeleteManagedStudent\(pool, req\.params\.parentId, req\.params\.studentId/);
  assert.match(familyLifecycle, /DELETE FROM public\.game_results[\s\S]*DELETE FROM public\.playtime_sessions[\s\S]*DELETE FROM public\.accounts/i);
  assert.match(source, /student_game_progress \([\s\S]*student_id INTEGER NOT NULL REFERENCES public\.accounts\(id\) ON DELETE CASCADE/i);
  assert.match(source, /student_ai_insights \([\s\S]*student_id INTEGER NOT NULL REFERENCES public\.accounts\(id\) ON DELETE CASCADE/i);
});
