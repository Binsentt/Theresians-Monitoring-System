const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePlaytimeStatus,
  resolveDifficultyFromScene,
  sortRowsByStudentName,
} = require('./progressScene.utils');

test('resolves difficulty from Godot scene and map fields only', () => {
  assert.equal(resolveDifficultyFromScene({ current_scene: 'res://world/oak_leaf_village.tscn', difficulty_level: 'Hard' }), 'Easy');
  assert.equal(resolveDifficultyFromScene({ current_map: 'city_of_knowledge' }), 'Medium');
  assert.equal(resolveDifficultyFromScene({ currentScene: 'pinehill_village.tscn' }), 'Hard');
  assert.equal(resolveDifficultyFromScene({ scene: 'unknown_scene.tscn', difficulty_level: 'Easy' }), 'Unknown');
  assert.equal(resolveDifficultyFromScene({ difficulty_level: 'Easy' }), 'Unknown');
});

test('normalizes screen-time statuses without exposing Auto Save labels', () => {
  assert.equal(normalizePlaytimeStatus('Active'), 'Active');
  assert.equal(normalizePlaytimeStatus('Auto Save'), 'Completed');
  assert.equal(normalizePlaytimeStatus('Auto Saved'), 'Completed');
  assert.equal(normalizePlaytimeStatus('Limit Reached'), 'Completed');
  assert.equal(normalizePlaytimeStatus('Logged Out'), 'Offline');
  assert.equal(normalizePlaytimeStatus('Unexpected'), 'Offline');
});

test('sorts student rows alphabetically by student display name', () => {
  const rows = sortRowsByStudentName([
    { student_name: 'Noah Santos' },
    { child_name: 'ava santos' },
    { name: 'Bella Reyes' },
  ]);

  assert.deepEqual(rows.map((row) => row.student_name || row.child_name || row.name), [
    'ava santos',
    'Bella Reyes',
    'Noah Santos',
  ]);
});
