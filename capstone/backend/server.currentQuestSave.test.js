const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('a later canonical completion cannot overwrite the latest manually saved Current Quest', () => {
  const helper = serverSource.slice(
    serverSource.indexOf('const ensureCurrentLearningProgressRow'),
    serverSource.indexOf("app.post('/api/game/result'")
  );
  assert.match(helper, /SET current_quest = COALESCE\(NULLIF\(BTRIM\(current_quest\), ''\), \$2\)/);
  assert.match(helper, /current_learning_cycle_started_at/);
});
