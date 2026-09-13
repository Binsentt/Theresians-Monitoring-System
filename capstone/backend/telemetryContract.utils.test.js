const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalDifficultyForMap, normalizeCanonicalTelemetry, isPlayerFacingCompletion } = require('./telemetryContract.utils');

test('telemetry normalizes canonical map difficulty and elapsed timing', () => {
  const event = normalizeCanonicalTelemetry({ map_id: 'oakleaf_village', event_type: 'task_completed', task_id: 'go-to-teachers-house', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:03Z', duration_seconds: 3 });
  assert.equal(event.telemetry_contract_version, '2.0');
  assert.equal(event.difficulty, 'Easy');
  assert.equal(event.duration_seconds, 3);
  assert.equal(isPlayerFacingCompletion(event), true);
  assert.equal(canonicalDifficultyForMap('city_of_knowledge'), 'Normal');
});

test('internal Oakleaf bandit milestones do not become player-facing completions', () => {
  const event = normalizeCanonicalTelemetry({ event_type: 'task_completed', task_id: 'oakleaf-bandits', canonical_milestone_id: 'oakleaf.bandits.bandit_1' });
  assert.equal(event.is_player_facing, false);
  assert.equal(isPlayerFacingCompletion(event), false);
});
