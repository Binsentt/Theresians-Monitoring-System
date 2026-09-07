import {
  filterStudentProgress,
  getStudentProgressSectionOptions,
  normalizeDifficultyDisplay,
  normalizeStudentProgressRow,
  normalizeStudentProgressPayload,
  resolveDifficultyFromScene,
} from './studentProgress.utils';

describe('student progress helpers', () => {
  test('preserves explicit no-data answer metrics from the backend', () => {
    const normalized = normalizeStudentProgressRow({
      total_questions: null,
      correct_answers: null,
      incorrect_answers: null,
      performance_percentage: null,
      accuracy_rate: null,
    });

    expect(normalized.incorrect_answers).toBeNull();
    expect(normalized.performance_percentage).toBeNull();
  });

  test('does not invent incorrect answers when answer totals are absent', () => {
    expect(normalizeStudentProgressRow({ student_id: 44 }).incorrect_answers).toBeNull();
  });

  test('preserves no recorded data for each difficulty', () => {
    expect(normalizeStudentProgressRow({
      difficultyBreakdown: { easy: null, medium: { accuracy: null }, hard: null },
    }).difficultyBreakdown).toEqual({ easy: null, medium: null, hard: null });
  });

  test.each([undefined, 'res://Battle/VS_Bandit.tscn'])(
    'preserves known backend current difficulty when the scene is %s',
    (current_scene) => {
      expect(normalizeStudentProgressRow({ current_scene, difficulty_level: 'Easy' }))
        .toEqual(expect.objectContaining({ difficulty: 'Easy', difficulty_level: 'Easy' }));
    }
  );

  test('uses the shared backend metrics before legacy progress aliases', () => {
    const normalized = normalizeStudentProgressRow({
      current_quest: 'Old quest',
      current_scene: 'pinehill_village.tscn',
      difficulty_level: 'Difficult',
      correct_answers: 0,
      incorrect_answers: 0,
      accuracy_rate: 0,
      metrics: {
        currentQuest: 'Current quest', currentDifficulty: 'Easy',
        correctAnswers: 3, incorrectAnswers: 1, totalQuestions: 4, accuracy: 75,
        difficultyBreakdown: { easy: { accuracy: 75 }, medium: { accuracy: null }, hard: { accuracy: null } },
      },
    });

    expect(normalized).toEqual(expect.objectContaining({
      current_quest: 'Current quest', difficulty_level: 'Easy',
      correct_answers: 3, incorrect_answers: 1, total_questions: 4, performance_percentage: 75,
      difficultyBreakdown: { easy: 75, medium: null, hard: null },
    }));
  });

  test('keeps unavailable canonical facts unavailable despite populated legacy aliases', () => {
    const normalized = normalizeStudentProgressRow({
      current_quest: 'Old quest', current_scene: 'oak_leaf_village.tscn', difficulty_level: 'Easy',
      correct_answers: 3, incorrect_answers: 1, total_questions: 4, accuracy_rate: 75,
      metrics: { currentQuest: null, currentDifficulty: null, correctAnswers: null, incorrectAnswers: null, totalQuestions: null, accuracy: null },
    });

    expect(normalized).toEqual(expect.objectContaining({
      current_quest: null, difficulty_level: 'Unknown', correct_answers: null,
      incorrect_answers: null, total_questions: null, performance_percentage: null,
    }));
  });

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

  test('searches the canonical six-digit game Student ID without numeric coercion', () => {
    const students = [
      { student_id: 1, student_name: 'Ana Reyes', game_student_id: '001234', grade_level: 'Grade 1' },
      { student_id: 2, student_name: 'Ben Cruz', game_student_id: '101234', grade_level: 'Grade 1' },
    ];

    expect(filterStudentProgress(students, { searchQuery: '001234' }).map((student) => student.student_id)).toEqual([1]);
    expect(filterStudentProgress(students, { searchQuery: '1234' })).toEqual([]);
  });

  test('does not invent section filters when section data has not been synced', () => {
    expect(getStudentProgressSectionOptions([
      { student_id: 3, grade_level: 'Grade 2', section: null },
      { student_id: 4, grade_level: 'Grade 2', section: '' },
    ], 'Grade 2')).toEqual([]);
  });

  test('maps current Godot scene or map to the displayed difficulty instead of manual values', () => {
    expect(resolveDifficultyFromScene({ current_scene: 'res://world/oak_leaf_village.tscn', difficulty_level: 'Hard' })).toBe('Easy');
    expect(resolveDifficultyFromScene({ current_map: 'city_of_knowledge' })).toBe('Normal');
    expect(resolveDifficultyFromScene({ currentScene: 'pinehill_village.tscn' })).toBe('Difficult');
    expect(resolveDifficultyFromScene({ current_scene: 'unknown_scene.tscn' })).toBe('Unknown');
    expect(resolveDifficultyFromScene({ difficulty_level: 'Easy' })).toBe('Unknown');
  });

  test('normalizes legacy difficulty labels for historical read-only display', () => {
    expect(normalizeDifficultyDisplay('Easy')).toBe('Easy');
    expect(normalizeDifficultyDisplay('Medium')).toBe('Normal');
    expect(normalizeDifficultyDisplay('Normal')).toBe('Normal');
    expect(normalizeDifficultyDisplay('Hard')).toBe('Difficult');
    expect(normalizeDifficultyDisplay('Difficult')).toBe('Difficult');
    expect(normalizeDifficultyDisplay(null)).toBe('Unknown');
  });

  test('normalizes rows alphabetically and preserves backend difficulty with scene fallback for legacy rows', () => {
    const result = normalizeStudentProgressPayload([
      { student_id: 2, student_name: 'Noah Santos', current_scene: 'pinehill_village.tscn', difficulty_level: 'Easy' },
      { student_id: 1, student_name: 'Ava Santos', current_map: 'oak_leaf_village', difficulty_level: 'Hard' },
      { student_id: 3, student_name: 'Bella Reyes', current_scene: 'city_of_knowledge.tscn' },
    ]);

    expect(result.map((student) => student.student_name)).toEqual(['Ava Santos', 'Bella Reyes', 'Noah Santos']);
    expect(result.map((student) => student.difficulty_level)).toEqual(['Difficult', 'Normal', 'Easy']);
  });
});
