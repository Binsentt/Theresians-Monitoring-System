const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TELEMETRY_CONTRACT_VERSION,
  QUEST_GRAPH_VERSION,
  canonicalDifficultyForMap,
  normalizeCanonicalTelemetry,
  isPlayerFacingCompletion,
} = require('./telemetryContract.utils');

test('normalizes a canonical task completion with stable identity and timing', () => {
  const event = normalizeCanonicalTelemetry({
    telemetry_contract_version: TELEMETRY_CONTRACT_VERSION,
    quest_graph_version: QUEST_GRAPH_VERSION,
    activity_event_id: 'cycle:4:activity:tutorial:complete',
    canonical_activity_id: 'tutorial',
    canonical_quest_id: 'main',
    canonical_task_id: 'tutorial',
    canonical_milestone_id: 'tutorial.complete',
    map_id: 'oakleaf_village',
    event_type: 'task_completed',
    started_at: '2026-09-13T01:00:00.000Z',
    completed_at: '2026-09-13T01:00:12.000Z',
    duration_seconds: 12,
  });

  assert.equal(event.activity_event_id, 'cycle:4:activity:tutorial:complete');
  assert.equal(event.duration_seconds, 12);
  assert.equal(event.difficulty, 'Easy');
  assert.equal(isPlayerFacingCompletion(event), true);
});

test('map difficulty is authoritative and internal bandit defeats are not player-facing quests', () => {
  assert.equal(canonicalDifficultyForMap('oakleaf_village'), 'Easy');
  assert.equal(canonicalDifficultyForMap('city_of_knowledge'), 'Normal');
  assert.equal(canonicalDifficultyForMap('pinehill_village'), 'Difficult');
  assert.equal(isPlayerFacingCompletion({
    event_type: 'task_completed',
    canonical_task_id: 'oakleaf.bandits',
    canonical_milestone_id: 'oakleaf.bandits.bandit_1',
    is_player_facing: false,
  }), false);
});
