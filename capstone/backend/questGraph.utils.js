const QUEST_GRAPH_VERSION = 'oakleaf-city-pinehill-v1';

const PLAYER_FACING_TASKS = Object.freeze([
  'go-to-teachers-house',
  'talk-to-the-teacher',
  'first-bandit-math-challenge',
  'oakleaf-bandits',
  'oakleaf-boss-bandit',
  'oakleaf-return-to-teacher',
  'go-to-city-of-knowledge',
  'go-to-school',
  'talk-to-city-school-teacher',
  'go-to-pinehill-village',
  'deep-forest-bandits',
  'pinehill-arrival',
  'talk-to-old-man',
  'pinehill-bandits',
  'defeat-the-wizard',
  'return-to-city-of-knowledge',
  'return-to-city-school',
  'final-teacher',
]);

const MILESTONE_WEIGHTS = Object.freeze({
  tutorial: 1,
  navigation: 1,
  interaction: 1,
  graded_battle: 3,
  boss: 4,
  map_transition: 1,
});

const taskWeightType = (taskId) => {
  if (taskId === 'first-bandit-math-challenge' || taskId === 'oakleaf-bandits' || taskId === 'deep-forest-bandits' || taskId === 'pinehill-bandits') return 'graded_battle';
  if (taskId === 'oakleaf-boss-bandit' || taskId === 'defeat-the-wizard' || taskId === 'final-teacher') return 'boss';
  if (taskId.includes('go-to-') || taskId.includes('arrival') || taskId.includes('return-to-')) return 'navigation';
  return 'interaction';
};

const canonicalTaskWeight = (taskId) => MILESTONE_WEIGHTS[taskWeightType(taskId)] || 1;

const calculateWeightedCompletion = (completedTaskIds = []) => {
  const completed = new Set((Array.isArray(completedTaskIds) ? completedTaskIds : []).filter((id) => id === 'tutorial' || PLAYER_FACING_TASKS.includes(id)));
  const total = PLAYER_FACING_TASKS.reduce((sum, taskId) => sum + canonicalTaskWeight(taskId), 0) + MILESTONE_WEIGHTS.tutorial;
  const completedWeight = (completed.has('tutorial') ? MILESTONE_WEIGHTS.tutorial : 0)
    + [...completed].reduce((sum, taskId) => sum + canonicalTaskWeight(taskId), 0);
  return total > 0 ? Number(((completedWeight / total) * 100).toFixed(2)) : 0;
};

module.exports = {
  QUEST_GRAPH_VERSION,
  PLAYER_FACING_TASKS,
  MILESTONE_WEIGHTS,
  canonicalTaskWeight,
  calculateWeightedCompletion,
};
