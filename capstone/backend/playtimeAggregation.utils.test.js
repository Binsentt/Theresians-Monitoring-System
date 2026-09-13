const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalPlaytimeSeconds } = require('./playtimeAggregation.utils');

test('canonical playtime uses session seconds first and matches Screen Time aggregation', () => {
  const sessions = [
    { status: 'Completed', total_playtime_seconds: 95, total_playtime_minutes: 1 },
    { status: 'Completed', total_playtime_seconds: 0, total_playtime_minutes: 2 },
    { status: 'Playing', total_playtime_seconds: 45, total_playtime_minutes: 1 },
  ];
  assert.equal(canonicalPlaytimeSeconds(sessions, { includePlaying: false }), 215);
  assert.equal(canonicalPlaytimeSeconds(sessions), 260);
});
