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
  assert.match(handler, /ORDER BY progress_percentage DESC, accuracy_rate DESC, correct_answers DESC, quests_completed DESC/);
  assert.match(handler, /COALESCE\(NULLIF\(TRIM\(a\.grade_level\), ''\), p\.grade_level\) AS grade_level/);
  assert.match(handler, /COALESCE\(NULLIF\(TRIM\(a\.section\), ''\), p\.section\) AS section/);
  assert.doesNotMatch(handler, /LIMIT 50/);
});

test('authenticated Teachers can read the authoritative Section registry', () => {
  assert.match(
    serverSource,
    /app\.get\('\/api\/sections\/registry', requireAuthenticatedRoles\(\[[^\]]*'teacher'[^\]]*\]\)/
  );
});
