const QUEST_GRAPH_VERSION = 'oakleaf-city-pinehill-v1';

const PLAYER_FACING_TASKS = Object.freeze([
  'go-to-teachers-house', 'talk-to-the-teacher', 'first-bandit-math-challenge',
  'oakleaf-bandits', 'oakleaf-boss-bandit', 'oakleaf-return-to-teacher',
  'go-to-city-of-knowledge', 'go-to-school', 'talk-to-city-school-teacher',
  'go-to-pinehill-village', 'deep-forest-bandits', 'pinehill-arrival',
  'talk-to-old-man', 'pinehill-bandits', 'defeat-the-wizard',
  'return-to-city-of-knowledge', 'return-to-city-school', 'final-teacher',
]);

const CANONICAL_TASK_LABELS = Object.freeze({
  tutorial: 'Tutorial',
  'go-to-teachers-house': "Go to the Teacher's House",
  'talk-to-the-teacher': 'Talk to the Teacher',
  'first-bandit-math-challenge': 'First Bandit Math Challenge',
  'oakleaf-bandits': 'Oakleaf Bandits',
  'oakleaf-boss-bandit': 'Oakleaf Boss Bandit',
  'oakleaf-return-to-teacher': 'Return to the Teacher',
  'go-to-city-of-knowledge': 'Go to the City of Knowledge',
  'go-to-school': 'Go to School',
  'talk-to-city-school-teacher': 'Talk to the City School Teacher',
  'go-to-pinehill-village': 'Go to Pinehill Village',
  'deep-forest-bandits': 'Deep Forest Bandits',
  'pinehill-arrival': 'Pinehill Arrival',
  'talk-to-old-man': 'Talk to the Old Lady',
  'pinehill-bandits': 'Pinehill Bandits',
  'defeat-the-wizard': 'Defeat the Wizard',
  'return-to-city-of-knowledge': 'Return to the City of Knowledge',
  'return-to-city-school': 'Return to the City School',
  'final-teacher': 'Final Teacher',
});

const MAP_TASKS = Object.freeze({
  oakleaf: Object.freeze([
    'go-to-teachers-house', 'talk-to-the-teacher', 'first-bandit-math-challenge',
    'oakleaf-bandits', 'oakleaf-boss-bandit', 'oakleaf-return-to-teacher',
  ]),
  city: Object.freeze([
    'go-to-city-of-knowledge', 'go-to-school', 'talk-to-city-school-teacher',
    'return-to-city-of-knowledge', 'return-to-city-school', 'final-teacher',
  ]),
  pinehill: Object.freeze([
    'go-to-pinehill-village', 'deep-forest-bandits', 'pinehill-arrival',
    'talk-to-old-man', 'pinehill-bandits', 'defeat-the-wizard',
  ]),
});

const MILESTONE_WEIGHTS = Object.freeze({ tutorial: 1, navigation: 1, interaction: 1, graded_battle: 3, boss: 4, map_transition: 1 });

const taskWeightType = (taskId) => {
  if (taskId === 'first-bandit-math-challenge' || taskId === 'oakleaf-bandits' || taskId === 'deep-forest-bandits' || taskId === 'pinehill-bandits') return 'graded_battle';
  if (taskId === 'oakleaf-boss-bandit' || taskId === 'defeat-the-wizard' || taskId === 'final-teacher') return 'boss';
  if (taskId.includes('go-to-') || taskId.includes('arrival') || taskId.includes('return-to-')) return 'navigation';
  return 'interaction';
};

const canonicalTaskRequiresGradedEvidence = (taskId) => {
  const normalized = normalizeCanonicalTaskId(taskId);
  if (!PLAYER_FACING_TASKS.includes(normalized)) return false;
  const type = taskWeightType(normalized);
  return type === 'graded_battle' || type === 'boss';
};

const canonicalTaskWeight = (taskId) => MILESTONE_WEIGHTS[taskWeightType(taskId)] || 1;

const normalizeCanonicalTaskId = (value) => String(value || '').trim().toLowerCase();

const canonicalTaskDisplayLabel = (taskId) => {
  const normalized = normalizeCanonicalTaskId(taskId);
  if (CANONICAL_TASK_LABELS[normalized]) return CANONICAL_TASK_LABELS[normalized];
  return null;
};

// Student Progress and Top Achievers share the canonical journey position.
// A current/reached canonical task advances the visible journey through
// that graph position; completed milestones remain included. Only the complete
// canonical task set (plus the tutorial marker) can report 100%.
const calculateJourneyProgress = ({ completedTaskIds = [], reachedTaskIds = [], currentTaskId = null } = {}) => {
  const validTasks = new Set(['tutorial', ...PLAYER_FACING_TASKS]);
  const completed = new Set((Array.isArray(completedTaskIds) ? completedTaskIds : [])
    .map(normalizeCanonicalTaskId)
    .filter((taskId) => validTasks.has(taskId)));
  const reached = new Set((Array.isArray(reachedTaskIds) ? reachedTaskIds : [])
    .map(normalizeCanonicalTaskId)
    .filter((taskId) => validTasks.has(taskId)));
  const current = normalizeCanonicalTaskId(currentTaskId);
  if (validTasks.has(current)) reached.add(current);
  completed.forEach((taskId) => reached.add(taskId));
  if (reached.size === 0) return null;

  const tutorialWeight = MILESTONE_WEIGHTS.tutorial;
  const totalWeight = tutorialWeight
    + PLAYER_FACING_TASKS.reduce((sum, taskId) => sum + canonicalTaskWeight(taskId), 0);
  const completedWeight = (completed.has('tutorial') ? tutorialWeight : 0)
    + PLAYER_FACING_TASKS.filter((taskId) => completed.has(taskId))
      .reduce((sum, taskId) => sum + canonicalTaskWeight(taskId), 0);
  const furthestTaskIndex = PLAYER_FACING_TASKS.reduce((furthest, taskId, index) => (
    reached.has(taskId) ? Math.max(furthest, index) : furthest
  ), -1);
  const reachedWeight = (reached.has('tutorial') ? tutorialWeight : 0)
    + PLAYER_FACING_TASKS.slice(0, furthestTaskIndex + 1)
      .reduce((sum, taskId) => sum + canonicalTaskWeight(taskId), 0);
  const allCampaignTasksCompleted = completed.has('tutorial')
    && PLAYER_FACING_TASKS.every((taskId) => completed.has(taskId));
  if (allCampaignTasksCompleted) return 100;

  const percentage = Number((Math.max(completedWeight, reachedWeight) / totalWeight * 100).toFixed(2));
  return Math.min(99, Math.max(0, percentage));
};

const calculateWeightedCompletion = (completedTaskIds = []) => {
  const completed = new Set((Array.isArray(completedTaskIds) ? completedTaskIds : [])
    .filter((id) => id === 'tutorial' || PLAYER_FACING_TASKS.includes(id)));
  const total = PLAYER_FACING_TASKS.reduce((sum, taskId) => sum + canonicalTaskWeight(taskId), 0) + MILESTONE_WEIGHTS.tutorial;
  const completedWeight = (completed.has('tutorial') ? MILESTONE_WEIGHTS.tutorial : 0)
    + [...completed]
      .filter((taskId) => taskId !== 'tutorial')
      .reduce((sum, taskId) => sum + canonicalTaskWeight(taskId), 0);
  return total > 0 ? Number(((completedWeight / total) * 100).toFixed(2)) : 0;
};

module.exports = {
  QUEST_GRAPH_VERSION,
  PLAYER_FACING_TASKS,
  MAP_TASKS,
  MILESTONE_WEIGHTS,
  CANONICAL_TASK_LABELS,
  canonicalTaskWeight,
  canonicalTaskRequiresGradedEvidence,
  canonicalTaskDisplayLabel,
  calculateJourneyProgress,
  calculateWeightedCompletion,
};
