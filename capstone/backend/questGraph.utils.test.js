const test = require('node:test');
const assert = require('node:assert/strict');
const { PLAYER_FACING_TASKS, MAP_TASKS, calculateWeightedCompletion, canonicalTaskWeight } = require('./questGraph.utils');

test('quest graph separates Oakleaf, City, and Pinehill tasks', () => {
  assert.equal(PLAYER_FACING_TASKS.length, 18);
  assert.equal(MAP_TASKS.oakleaf.length, 6);
  assert.equal(MAP_TASKS.city.length, 6);
  assert.equal(MAP_TASKS.pinehill.length, 6);
  assert.equal(canonicalTaskWeight('oakleaf-bandits'), 3);
  assert.equal(canonicalTaskWeight('oakleaf-boss-bandit'), 4);
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
