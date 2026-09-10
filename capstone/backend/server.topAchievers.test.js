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
  assert.match(handler, /COALESCE\(a\.is_archived, false\) = false/);
  assert.doesNotMatch(handler, /LIMIT 50/);
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
