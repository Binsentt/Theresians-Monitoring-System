const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PLAYER_FACING_TASKS, MAP_TASKS, calculateWeightedCompletion, calculateJourneyProgress,
  canonicalTaskDisplayLabel, canonicalTaskWeight, canonicalTaskEvidenceType, canonicalMapDisplayLabel,
  compareCanonicalTaskIdsByProgression,
} = require('./questGraph.utils');

test('canonical task ordering follows campaign progression and sorts unknown IDs deterministically last', () => {
  const unordered = [
    'pinehill-bandits', 'unknown-z-task', 'deep-forest-bandits', 'tutorial',
    'oakleaf-bandits', 'unknown-a-task', 'go-to-school',
  ];

  assert.deepEqual(unordered.sort(compareCanonicalTaskIdsByProgression), [
    'tutorial', 'oakleaf-bandits', 'go-to-school', 'deep-forest-bandits',
    'pinehill-bandits', 'unknown-a-task', 'unknown-z-task',
  ]);
  assert.equal(compareCanonicalTaskIdsByProgression('OAKLEAF-BANDITS', 'oakleaf-bandits'), 0);
});

test('quest graph separates Oakleaf, City, and Pinehill tasks', () => {
  assert.equal(PLAYER_FACING_TASKS.length, 18);
  assert.equal(MAP_TASKS.oakleaf.length, 6);
  assert.equal(MAP_TASKS.city.length, 6);
  assert.equal(MAP_TASKS.pinehill.length, 6);
  assert.equal(canonicalTaskWeight('oakleaf-bandits'), 3);
  assert.equal(canonicalTaskWeight('oakleaf-boss-bandit'), 4);
});

test('canonical quest evidence types distinguish exploration, navigation, interactions, battles, bosses, and map transitions', () => {
  assert.equal(canonicalTaskEvidenceType('go-to-teachers-house'), 'exploration');
  assert.equal(canonicalTaskEvidenceType('go-to-school'), 'navigation');
  assert.equal(canonicalTaskEvidenceType('talk-to-old-man'), 'npc_interaction');
  assert.equal(canonicalTaskEvidenceType('pinehill-bandits'), 'mathematics_battle');
  assert.equal(canonicalTaskEvidenceType('defeat-the-wizard'), 'boss_battle');
  assert.equal(canonicalTaskEvidenceType('return-to-city-of-knowledge'), 'map_transition');
  assert.equal(canonicalTaskEvidenceType('not-a-canonical-task'), null);
  assert.equal(canonicalMapDisplayLabel('deep-forest-bandits', 'city_of_knowledge'), 'City of Knowledge — Forest Area');
  assert.equal(canonicalMapDisplayLabel('pinehill-bandits', 'pinehill_village'), 'Pinehill Village');
});

test('weighted progress distinguishes first Bandit progress from completion', () => {
  const initial = calculateWeightedCompletion([]);
  const tutorial = calculateWeightedCompletion(['tutorial']);
  const firstTasks = calculateWeightedCompletion(['tutorial', 'go-to-teachers-house']);
  const allOakleaf = calculateWeightedCompletion(['tutorial', ...MAP_TASKS.oakleaf]);
  assert.equal(initial, 0);
  assert(tutorial > initial);
  assert(firstTasks > tutorial);
  assert(allOakleaf > firstTasks);
});

test('weighted progress counts tutorial once and caps a complete campaign at 100 percent', () => {
  const totalWeight = PLAYER_FACING_TASKS.reduce((sum, taskId) => sum + canonicalTaskWeight(taskId), 0) + 1;
  assert.equal(calculateWeightedCompletion(['tutorial']), Number(((1 / totalWeight) * 100).toFixed(2)));
  assert.equal(calculateWeightedCompletion(['tutorial', 'tutorial']), Number(((1 / totalWeight) * 100).toFixed(2)));
  assert.equal(calculateWeightedCompletion(['tutorial', ...PLAYER_FACING_TASKS]), 100);
});

test('Student Progress uses the furthest canonical journey position, while Top Achievers completion stays milestone-based', () => {
  const reached = (taskId) => calculateJourneyProgress({ reachedTaskIds: [taskId] });
  const oakleaf = reached('go-to-teachers-house');
  const oakleafBandits = reached('oakleaf-bandits');
  const citySchool = reached('go-to-school');
  const deepestForest = reached('deep-forest-bandits');
  const pinehill = reached('pinehill-bandits');
  const finalTeacher = reached('final-teacher');
  const complete = calculateJourneyProgress({ completedTaskIds: ['tutorial', ...PLAYER_FACING_TASKS] });

  assert.ok(oakleaf > 0 && oakleaf < oakleafBandits);
  assert.ok(oakleafBandits < citySchool);
  assert.ok(citySchool < deepestForest);
  assert.ok(deepestForest < pinehill);
  assert.ok(pinehill < finalTeacher);
  assert.ok(finalTeacher < 100);
  assert.equal(complete, 100);
  assert.ok(calculateJourneyProgress({ completedTaskIds: PLAYER_FACING_TASKS }) < 100);
  assert.equal(calculateJourneyProgress({ reachedTaskIds: ['not-a-canonical-task'] }), null);
  assert.equal(canonicalTaskDisplayLabel('oakleaf-bandits'), 'Oakleaf Bandits');
});
