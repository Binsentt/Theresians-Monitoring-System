const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('Top Achievers keeps the approved ranking order without truncating the authorized cohort', () => {
  const handler = serverSource.slice(
    serverSource.indexOf('const handleTopAchieversRequest'),
    serverSource.indexOf("app.get('/api/top-achievers'")
  );
  assert.match(handler, /ORDER BY \$\{CANONICAL_TOP_ACHIEVER_ORDER_SQL\}/);
  assert.match(handler, /COALESCE\(NULLIF\(TRIM\(a\.grade_level\), ''\), p\.grade_level\) AS grade_level/);
  assert.match(handler, /COALESCE\(NULLIF\(TRIM\(a\.section\), ''\), p\.section\) AS section/);
  assert.match(handler, /canonical_results\.game_score AS game_score/);
  assert.match(handler, /COALESCE\(a\.is_archived, false\) = false/);
  assert.doesNotMatch(handler, /LIMIT 50/);
});

test('Top Achievers exposes the canonical integer Game Score while retaining accuracy as analytics data', () => {
  const handler = serverSource.slice(
    serverSource.indexOf('const handleTopAchieversRequest'),
    serverSource.indexOf("app.get('/api/top-achievers'")
  );
  assert.match(handler, /SUM\(gr\.score\).*AS game_score/s);
  assert.match(handler, /gr\.score BETWEEN 0 AND gr\.total_items/);
  assert.match(handler, /gr\.played_at >= a\.current_learning_cycle_started_at/);
  assert.match(serverSource, /game_score: Number\.isFinite\(gameScore\)/);
});

test('Top Achievers uses the same Screen Time reset boundary and preserves archived history accounting', () => {
  const handler = serverSource.slice(
    serverSource.indexOf('const handleTopAchieversRequest'),
    serverSource.indexOf("app.get('/api/top-achievers'")
  );
  assert.match(handler, /screen_time_reset_at/);
  assert.match(handler, /COALESCE\(ps\.server_started_at, ps\.start_time\) >= COALESCE\(a\.screen_time_reset_at/);
  assert.doesNotMatch(handler, /ps\.deleted_at IS NULL/);
});

test('Top Achievers and game leaderboard use only deduplicated current-cycle canonical milestones', () => {
  assert.match(serverSource, /LOWER\(BTRIM\(COALESCE\(sqm\.canonical_task_id, sqm\.milestone_id\)\)\) IN \(\$\{CANONICAL_CAMPAIGN_TASK_SQL\}\)/);
  assert.match(serverSource, /GROUP BY LOWER\(BTRIM\(COALESCE\(sqm\.canonical_task_id, sqm\.milestone_id\)\)\)/);
  assert.doesNotMatch(serverSource, /ELSE COALESCE\(p\.total_quests_completed, 0\) END AS total_quests_completed/);
  assert.doesNotMatch(serverSource, /ELSE COALESCE\(p\.total_quests_completed, 0\) END AS quests_completed/);
});

test('website and lease-authorized game projection reuse one stable canonical ranking order', () => {
  assert.match(
    serverSource,
    /const CANONICAL_TOP_ACHIEVER_ORDER_SQL = `progress_percentage DESC NULLS LAST,[\s\S]*student_id ASC`;/
  );
  assert.equal((serverSource.match(/\$\{CANONICAL_TOP_ACHIEVER_ORDER_SQL\}/g) || []).length, 2);
});

test('authenticated Teachers can read the authoritative Section registry', () => {
  assert.match(
    serverSource,
    /app\.get\('\/api\/sections\/registry', requireAuthenticatedRoles\(\[[^\]]*'teacher'[^\]]*\]\)/
  );
});
