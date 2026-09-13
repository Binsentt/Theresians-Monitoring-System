const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalPlaytimeSeconds } = require('./playtimeAggregation.utils');

test('Top Achievers and Screen Time share canonical session seconds', () => {
  assert.equal(canonicalPlaytimeSeconds([
    { total_playtime_seconds: 125, total_playtime_minutes: 1, status: 'Offline' },
    { total_playtime_minutes: 2, status: 'Offline' },
    { total_playtime_seconds: 999, status: 'Playing' },
  ], { includePlaying: false }), 245);
});
