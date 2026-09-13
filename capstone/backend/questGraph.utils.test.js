const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QUEST_GRAPH_VERSION,
  PLAYER_FACING_TASKS,
  calculateWeightedCompletion,
} = require('./questGraph.utils');

test('canonical player-facing graph keeps Oakleaf sub-milestones out of quest count', () => {
  assert.equal(QUEST_GRAPH_VERSION, 'oakleaf-city-pinehill-v1');
  assert.equal(PLAYER_FACING_TASKS.length, 18);
  assert.equal(calculateWeightedCompletion(['tutorial', 'go-to-teachers-house']), calculateWeightedCompletion(['go-to-teachers-house', 'tutorial']));
  assert.equal(calculateWeightedCompletion(['oakleaf.bandits.bandit_1']), 0);
});

test('weighted completion is distinct from accuracy and increases for partial bandit progress only through canonical task evidence', () => {
  const tutorial = calculateWeightedCompletion(['tutorial']);
  const teacher = calculateWeightedCompletion(['tutorial', 'go-to-teachers-house']);
  const fullBanditTask = calculateWeightedCompletion(['tutorial', 'go-to-teachers-house', 'oakleaf-bandits']);
  assert.ok(tutorial > 0);
  assert.ok(teacher > tutorial);
  assert.ok(fullBanditTask > teacher);
});
