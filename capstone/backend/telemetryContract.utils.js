const TELEMETRY_CONTRACT_VERSION = '2.0';
const QUEST_GRAPH_VERSION = 'oakleaf-city-pinehill-v1';

const MAP_DIFFICULTY = Object.freeze({
  oakleaf_village: 'Easy',
  city_of_knowledge: 'Normal',
  pinehill_village: 'Difficult',
});

const canonicalDifficultyForMap = (mapId) => {
  const key = String(mapId || '').trim().toLowerCase();
  return MAP_DIFFICULTY[key] || 'Unknown';
};

const normalizeDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const normalizeDuration = (value) => {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) return null;
  return Math.min(Math.round(duration), 86400);
};

const normalizeCanonicalTelemetry = (input = {}) => {
  const mapId = String(input.map_id || '').trim().toLowerCase() || null;
  const eventType = String(input.event_type || '').trim().toLowerCase() || null;
  const canonicalTaskId = String(input.canonical_task_id || input.task_id || '').trim() || null;
  const canonicalMilestoneId = String(input.canonical_milestone_id || '').trim() || null;
  const explicitPlayerFacing = input.is_player_facing;
  const inferredPlayerFacing = !(canonicalMilestoneId && /^oakleaf\.bandits\.bandit_[1-5]$/.test(canonicalMilestoneId));
  return {
    telemetry_contract_version: String(input.telemetry_contract_version || TELEMETRY_CONTRACT_VERSION),
    quest_graph_version: String(input.quest_graph_version || QUEST_GRAPH_VERSION),
    activity_event_id: String(input.activity_event_id || input.event_key || '').trim() || null,
    canonical_activity_id: String(input.canonical_activity_id || '').trim() || null,
    canonical_quest_id: String(input.canonical_quest_id || '').trim() || null,
    canonical_task_id: canonicalTaskId,
    canonical_milestone_id: canonicalMilestoneId,
    map_id: mapId,
    difficulty: String(input.difficulty || input.difficulty_level || canonicalDifficultyForMap(mapId)),
    event_type: eventType,
    started_at: normalizeDate(input.started_at),
    completed_at: normalizeDate(input.completed_at),
    duration_seconds: normalizeDuration(input.duration_seconds),
    is_player_facing: explicitPlayerFacing === undefined ? inferredPlayerFacing : Boolean(explicitPlayerFacing),
  };
};

const isPlayerFacingCompletion = (event = {}) => (
  (event.event_type === 'task_completed' || event.event_type === 'quest_completed')
  && event.is_player_facing !== false
  && Boolean(event.canonical_task_id || event.task_id)
);

module.exports = {
  TELEMETRY_CONTRACT_VERSION,
  QUEST_GRAPH_VERSION,
  canonicalDifficultyForMap,
  normalizeCanonicalTelemetry,
  isPlayerFacingCompletion,
};
