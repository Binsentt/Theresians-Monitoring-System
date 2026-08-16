import {
  filterStudentProgress,
  getStudentProgressSectionOptions,
  normalizeStudentProgressPayload,
  resolveDifficultyFromScene,
} from './studentProgress.utils';

describe('student progress helpers', () => {
  test('supports legacy array payloads and normalizes student progress rows', () => {
    const result = normalizeStudentProgressPayload([
      {
        student_id: 7,
        grade_level: 'Grade 4',
        correct_answers: 8,
        total_questions: 10,
        accuracy_rate: 80,
      }
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        student_id: 7,
        section: null,
        incorrect_answers: 2,
        performance_percentage: 80,
      })
    ]);
  });

  test('supports wrapped payloads and safely falls back to an empty list', () => {
    expect(normalizeStudentProgressPayload({ data: [{ student_id: 2, total_questions: 0, correct_answers: 0 }] })).toHaveLength(1);
    expect(normalizeStudentProgressPayload({ error: 'Forbidden' })).toEqual([]);
    expect(normalizeStudentProgressPayload(null)).toEqual([]);
  });

  test('filters student progress safely even when names are missing', () => {
    const students = [
      { student_id: 1, student_name: null, grade_level: 'Grade 3', section: 'Section A' },
      { student_id: 2, student_name: 'Maria Santos', grade_level: 'Grade 3', section: 'Section B' },
    ];

    expect(() =>
      filterStudentProgress(students, {
        searchQuery: 'maria',
        selectedGrade: 'Grade 3',
        selectedSection: 'Section B',
      })
    ).not.toThrow();

    expect(
      filterStudentProgress(students, {
        searchQuery: 'maria',
        selectedGrade: 'Grade 3',
        selectedSection: 'Section B',
      }).map((student) => student.student_id)
    ).toEqual([2]);
  });

  test('does not invent section filters when section data has not been synced', () => {
    expect(getStudentProgressSectionOptions([
      { student_id: 3, grade_level: 'Grade 2', section: null },
      { student_id: 4, grade_level: 'Grade 2', section: '' },
    ], 'Grade 2')).toEqual([]);
  });

  test('maps current Godot scene or map to the displayed difficulty instead of manual values', () => {
    expect(resolveDifficultyFromScene({ current_scene: 'res://world/oak_leaf_village.tscn', difficulty_level: 'Hard' })).toBe('Easy');
    expect(resolveDifficultyFromScene({ current_map: 'city_of_knowledge' })).toBe('Medium');
    expect(resolveDifficultyFromScene({ currentScene: 'pinehill_village.tscn' })).toBe('Hard');
    expect(resolveDifficultyFromScene({ current_scene: 'unknown_scene.tscn' })).toBe('Unknown');
    expect(resolveDifficultyFromScene({ difficulty_level: 'Easy' })).toBe('Unknown');
  });

  test('normalizes student progress rows alphabetically and derives difficulty from scene data', () => {
    const result = normalizeStudentProgressPayload([
      { student_id: 2, student_name: 'Noah Santos', current_scene: 'pinehill_village.tscn', difficulty_level: 'Easy' },
      { student_id: 1, student_name: 'Ava Santos', current_map: 'oak_leaf_village', difficulty_level: 'Hard' },
      { student_id: 3, student_name: 'Bella Reyes', current_scene: 'city_of_knowledge.tscn' },
    ]);

    expect(result.map((student) => student.student_name)).toEqual(['Ava Santos', 'Bella Reyes', 'Noah Santos']);
    expect(result.map((student) => student.difficulty_level)).toEqual(['Easy', 'Medium', 'Hard']);
  });
});
