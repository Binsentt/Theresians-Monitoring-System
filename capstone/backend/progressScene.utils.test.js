const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePlaytimeStatus,
  resolveDifficultyFromScene,
  resolveCurrentDifficulty,
  sortRowsByStudentName,
} = require('./progressScene.utils');

test('resolves difficulty from Godot scene and map fields only', () => {
  assert.equal(resolveDifficultyFromScene({ current_scene: 'res://world/oak_leaf_village.tscn', difficulty_level: 'Hard' }), 'Easy');
  assert.equal(resolveDifficultyFromScene({ current_map: 'city_of_knowledge' }), 'Normal');
  assert.equal(resolveDifficultyFromScene({ currentScene: 'pinehill_village.tscn' }), 'Difficult');
  assert.equal(resolveDifficultyFromScene({ scene: 'unknown_scene.tscn', difficulty_level: 'Easy' }), 'Unknown');
  assert.equal(resolveDifficultyFromScene({ difficulty_level: 'Easy' }), 'Unknown');
});

test('current difficulty uses verified playable context before validated saved battle scope', () => {
  for (const scene of ['res://interiors/player_house.tscn', 'res://interiors/players_house.tscn', 'res://interiors/teacher_house.tscn', 'res://world/player_house_outside_door.tscn', 'res://world/teacher_house_outside_door.tscn', 'res://world/npc_house_outside_door.tscn']) {
    assert.equal(resolveCurrentDifficulty({ current_scene: scene, difficulty_level: 'Difficult' }), 'Easy');
  }
  assert.equal(resolveCurrentDifficulty({ current_map: 'res://scenes/2nd Village/Pinehill Village.tscn', difficulty_level: 'Easy' }), 'Difficult');
  assert.equal(resolveCurrentDifficulty({ current_scene: 'res://Battle-Enemy/battle.tscn', difficulty_level: 'Normal' }), 'Normal');
  assert.equal(resolveCurrentDifficulty({ current_scene: 'unknown.tscn', difficulty_level: 'nonsense' }), 'Unknown');
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
