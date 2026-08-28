import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import StudentAnalytics from './StudentAnalytics';
import { clearPreparedReport } from './PrintReportPortal';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/admin/student-progress/44' }),
  useNavigate: () => mockNavigate,
  useParams: () => ({ studentId: '44' }),
}));

jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

const jsonResponse = (body) => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => body,
});

describe('StudentAnalytics defensive rendering', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin', name: 'Admin' }));
    localStorage.setItem('token', 'student-detail-token');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    clearPreparedReport();
    jest.useRealTimers();
    delete global.fetch;
    console.error.mockRestore();
  });

  test('renders defaults instead of crashing on malformed progress detail values', async () => {
    global.fetch = jest.fn(() => jsonResponse({
      progress: {
        student_id: 44,
        student_name: { bad: 'name' },
        grade_level: null,
        section: undefined,
        accuracy_rate: '87.5',
        progress_percentage: 'bad-number',
        score: { bad: true },
      },
      analysis: {
        strengths: [{ message: 'Strong effort.' }],
        weaknesses: [null],
        recommendations: [{ message: 'Practice fractions.' }],
        difficultyBreakdown: { easy: '60', medium: null, hard: 'not-a-number' },
      },
      metrics: {
        totalProgress: 'bad-number',
        accuracy: '87.5',
        correctAnswers: null,
        incorrectAnswers: null,
        difficultyBreakdown: { easy: { accuracy: '60' }, medium: { accuracy: null }, hard: { accuracy: 'not-a-number' } },
      },
      aiInsight: { status: 'insufficient_data', message: 'Not enough gameplay data yet to generate a reliable analysis.' },
    }));

    await act(async () => {
      root.render(<StudentAnalytics />);
    });

    expect(container.textContent).toContain('Student analytics');
    expect(container.textContent).toContain('88%');
    expect(container.textContent).toContain('Not enough gameplay data yet to generate a reliable analysis.');
    expect(container.textContent).not.toContain('Practice fractions.');
    expect(container.textContent).not.toContain('[object Object]');
    expect(global.fetch.mock.calls[0][1]?.headers?.Authorization).toBe('Bearer student-detail-token');
  });

  test('renders a modern analytics dashboard with profile details and metric cards', async () => {
    global.fetch = jest.fn(() => jsonResponse({
      progress: {
        student_id: 44,
        game_student_id: '001234',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
        current_quest: 'Oak Leaf Village Quest',
        difficulty_level: 'Easy',
        current_scene: 'oak_leaf_village.tscn',
        accuracy_rate: 82,
        progress_percentage: 74,
        correct_answers: 41,
        total_questions: 50,
        score: 925,
        total_quests_completed: 7,
        total_play_time: 5400,
      },
      analysis: {
        strengths: ['Strong accuracy across current quests.'],
        weaknesses: ['Needs review on word problems.'],
        recommendations: ['Practice fractions.'],
        difficultyBreakdown: { easy: 40, medium: 25, hard: 35 },
      },
      metrics: {
        validResultCount: 6,
        gameScore: 925,
        totalProgress: 74,
        accuracy: 82,
        correctAnswers: 41,
        incorrectAnswers: 9,
        totalQuestions: 50,
        completedQuests: 7,
        currentQuest: 'Oak Leaf Village Quest',
        difficultyBreakdown: { easy: { accuracy: 40 }, medium: { accuracy: 25 }, hard: { accuracy: 35 } },
      },
      aiInsight: {
        status: 'cached',
        insight: {
          performance_insight: 'Recorded results show steady progress.',
          strengths: ['Strong accuracy across current quests.'],
          weaknesses: ['Needs review on word problems.'],
          recommendations: ['Practice fractions.'],
        },
      },
    }));

    await act(async () => {
      root.render(<StudentAnalytics />);
    });

    expect(container.querySelector('.student-profile-card')).toBeTruthy();
    expect(container.querySelector('.student-profile-logo')).toBeFalsy();
    expect(container.querySelectorAll('.student-profile-meta > div')).toHaveLength(4);
    expect(container.querySelectorAll('.student-performance-meta > div')).toHaveLength(4);
    expect(container.querySelectorAll('.student-metric-card')).toHaveLength(6);
    expect(container.textContent).toContain('Student ID');
    expect(container.textContent).toContain('001234');
    expect(container.textContent).toContain('Grade & Section');
    expect(container.textContent).toContain('Grade 3 - Section A');
    expect(container.querySelector('.student-profile-meta > div:last-child').textContent).toContain('Oak Leaf Village Quest');
    expect(container.textContent).toContain('Current Scene');
    expect(container.textContent).toContain('oak_leaf_village.tscn');
    expect(container.textContent).toContain('Game Score');
    expect(container.textContent).toContain('925');
    expect(container.textContent).not.toContain('Total Playtime');
    expect(container.textContent).toContain('Game Performance');
    expect(container.textContent).toContain('Grounded AI Insight');
    expect(container.textContent).toContain('Recorded results show steady progress.');
    expect(container.textContent).toContain('Easy');
    expect(container.textContent).toContain('Normal');
    expect(container.textContent).toContain('Difficult');
  });

  test('offers a dedicated selected-student analytics print report without dashboard controls', async () => {
    global.fetch = jest.fn(() => jsonResponse({
      progress: { student_id: 44, game_student_id: '001234', student_name: 'Ava Santos', grade_level: 'Grade 3', section: 'Section A' },
      metrics: { accuracy: null, correctAnswers: null, incorrectAnswers: null, totalQuestions: null },
      aiInsight: { status: 'insufficient_data', message: 'Not enough gameplay data yet to generate a reliable analysis.' },
    }));

    await act(async () => {
      root.render(<StudentAnalytics />);
    });

    expect(container.querySelector('button[aria-label="Print Student Analytics"]')).toBeTruthy();
    expect(container.querySelectorAll('.student-profile-meta > div')).toHaveLength(4);
    expect(container.querySelectorAll('.student-performance-meta > div')).toHaveLength(4);
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});
    await act(async () => {
      container.querySelector('button[aria-label="Print Student Analytics"]').click();
      await Promise.resolve();
    });
    act(() => jest.runAllTimers());
    const report = document.querySelector('#print-report-root .printable-table-report');
    expect(report).toBeTruthy();
    expect(report.textContent).toContain('Ava Santos');
    expect(report.textContent).toContain('001234');
    expect(report.textContent).toContain('Records: 1');
    expect(report.textContent).toContain('Not available');
    expect(report.textContent).not.toContain('0%');
    expect(report.textContent).toContain('Not enough gameplay data yet to generate a reliable analysis.');
    expect(report.querySelector('.student-analytics-back')).toBeFalsy();
    printSpy.mockRestore();
  });
});
