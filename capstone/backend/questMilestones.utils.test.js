const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyMilestoneWeight,
  countUniqueCompletedMilestones,
  calculateWeightedCompletion,
} = require('./questMilestones.utils');

test('counts canonical completed milestones once even when activity repeats', () => {
  assert.equal(countUniqueCompletedMilestones([
    { milestone_id: 'tutorial' },
    { milestone_id: 'tutorial' },
    { milestone_id: 'teacher-house' },
  ]), 2);
});

test('no completed task produces a zero count', () => {
  assert.equal(countUniqueCompletedMilestones([]), 0);
});

test('tutorial and later canonical tasks increment independently', () => {
  assert.equal(countUniqueCompletedMilestones([
    { milestone_id: 'tutorial' },
    { milestone_id: 'teacher-house' },
    { milestone_id: 'bandit-1' },
  ]), 3);
});

test('battle counts only after a canonical completion milestone is persisted', () => {
  assert.equal(countUniqueCompletedMilestones([
    { milestone_id: 'tutorial' },
    { milestone_id: 'teacher-house' },
  ]), 2);
  assert.equal(countUniqueCompletedMilestones([
    { milestone_id: 'tutorial' },
    { milestone_id: 'teacher-house' },
    { milestone_id: 'bandit-1' },
    { milestone_id: 'bandit-1' },
  ]), 3);
});

test('cycle reset reads only the new cycle when callers scope persisted rows', () => {
  const activeCycleRows = [
    { milestone_id: 'tutorial', learning_cycle_version: 2 },
    { milestone_id: 'teacher-house', learning_cycle_version: 2 },
  ];
  assert.equal(countUniqueCompletedMilestones(activeCycleRows), 2);
  assert.equal(countUniqueCompletedMilestones(activeCycleRows.filter((row) => row.learning_cycle_version === 3)), 0);
});

test('uses centralized significance weights for navigation, battles, and bosses', () => {
  assert.equal(classifyMilestoneWeight('teacher-house'), 1);
  assert.equal(classifyMilestoneWeight('bandit-battle'), 3);
  assert.equal(classifyMilestoneWeight('boss-bandit-battle'), 4);
});

test('normalizes weighted completion from the canonical graph', () => {
  assert.equal(calculateWeightedCompletion({
    completed: [{ milestone_id: 'tutorial', weight: 1 }, { milestone_id: 'bandit-battle', weight: 3 }],
    required: [{ milestone_id: 'tutorial', weight: 1 }, { milestone_id: 'bandit-battle', weight: 3 }, { milestone_id: 'boss-battle', weight: 4 }],
  }), 50);
});
