import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ParentChildProgress, { buildScoreTimeline, formatLatestActivityScore } from './ParentChildProgress';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('recharts', () => ({
  Bar: () => <div>Bar</div>,
  BarChart: ({ children }) => <div>{children}</div>,
  CartesianGrid: () => <div>Grid</div>,
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  Tooltip: () => <div>Tooltip</div>,
  XAxis: () => <div>XAxis</div>,
  YAxis: () => <div>YAxis</div>,
}));

jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ main }) => <div>{main}</div>,
  MainContent: ({ children }) => <div>{children}</div>,
  TopBar: ({ children }) => <div>{children}</div>,
  PageContent: ({ children }) => <div>{children}</div>,
  ContentSection: ({ children, title }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  ),
}));

jest.mock('./layout/AnalyticsSidebar', () => () => <div>Sidebar</div>);
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

const jsonResponse = (body) => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => body,
});

const successPayloadForUrl = (url, childrenPayload) => {
  if (url.startsWith('/api/parent/children?')) return jsonResponse(childrenPayload);
  if (url.startsWith('/api/students/progress?')) return jsonResponse([]);
  if (url.startsWith('/api/analytics/overview?')) return jsonResponse({});
  if (url.startsWith('/api/analytics/recommendations?')) return jsonResponse({ recommendations: [] });
  if (url.startsWith('/api/activity-logs?')) return jsonResponse({ data: [] });
  if (url.startsWith('/api/student-progress/44?')) return jsonResponse({
    progress: {
      student_id: 44,
      student_name: 'Ava Santos',
    },
    metrics: {
      gameScore: 12,
      accuracy: 60,
      totalProgress: 42,
      totalQuestions: 5,
    },
    aiInsight: {
      status: 'cached', data_level: 'sufficient_data', valid_result_count: 5,
      insight: {
        performance_insight: 'Ava recorded 60% accuracy.',
        strengths: ['Ava has recorded Easy evidence.'],
        weaknesses: ['Ava has limited Normal evidence.'],
        recommendations: ['Practice fractions for Ava.'],
      },
    },
    analyticsReadiness: {
      aiIntegration: { ready: true },
    },
  });
  if (url.startsWith('/api/student-progress/45?')) return jsonResponse({
    progress: {
      student_id: 45,
      student_name: 'Noah Santos',
    },
    metrics: {
      gameScore: 8,
      accuracy: 50,
      totalProgress: 35,
      totalQuestions: 5,
    },
    aiInsight: {
      status: 'cached', data_level: 'sufficient_data', valid_result_count: 5,
      insight: {
        performance_insight: 'Noah recorded 50% accuracy.',
        strengths: [], weaknesses: [], recommendations: ['Practice shapes for Noah.'],
      },
    },
    analyticsReadiness: {
      aiIntegration: { ready: true },
    },
  });
  if (url.includes('/quizzes?')) return jsonResponse({ data: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  if (url.includes('/topics?')) return jsonResponse([]);
  throw new Error(`Unexpected URL: ${url}`);
};

describe('ParentChildProgress child selection and game warnings', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 19, role: 'parent', name: 'Parent User' }));
    localStorage.setItem('token', 'parent-analytics-token');
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
    console.error.mockRestore();
  });

  test('skips the child selector when the parent has one linked child', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [{
        id: 44,
        game_student_id: '001234',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Jade',
        total_quizzes: 0,
      }],
      unlinked_count: 0,
    }));

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    expect(container.textContent).toContain('Ava Santos');
    expect(container.textContent).toContain('Student ID');
    expect(container.textContent).toContain('001234');
    expect(container.textContent).toContain('Ava recorded 60% accuracy.');
    expect(container.textContent).toContain('Ava has recorded Easy evidence.');
    expect(container.textContent).toContain('Ava has limited Normal evidence.');
    expect(container.textContent).toContain('Practice fractions for Ava.');
    expect(container.textContent).toContain('Grade 3 - Jade');
    expect(container.textContent).not.toContain('Quiz Sessions');
    expect(container.textContent).not.toContain('Topic Coverage');
    expect(container.textContent).not.toContain('Analytics Readiness');
    expect(container.textContent).not.toContain('Achievements — Coming Soon');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Reset Progress')).toBe(false);
    expect(container.textContent).not.toContain('My Children');
    expect(mockNavigate).not.toHaveBeenCalledWith('/login');
    expect(global.fetch.mock.calls.every(([, options]) => (
      options?.headers?.Authorization === 'Bearer parent-analytics-token'
    ))).toBe(true);
  });

  test('shows Not assigned for a linked child whose canonical Section is null', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [{
        id: 44,
        game_student_id: '001234',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: null,
        total_quizzes: 0,
      }],
      unlinked_count: 0,
    }));

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    expect(container.textContent).toContain('Grade 3 - Not assigned');
  });

  test('displays legacy quiz difficulties with the canonical current terminology', async () => {
    global.fetch = jest.fn((url) => {
      if (url.includes('/quizzes?')) {
        return jsonResponse({
          data: [{
            id: 901,
            math_topic: 'Addition',
            difficulty: 'Hard',
            score: 4,
            total_items: 5,
            percentage: 80,
            played_at: '2026-08-27T00:00:00.000Z',
          }],
        });
      }
      return successPayloadForUrl(url, {
        children: [{
          id: 44,
          game_student_id: '001234',
          student_name: 'Ava Santos',
          grade_level: 'Grade 3',
          section: 'Section A',
        }],
        unlinked_count: 0,
      });
    });

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    expect(container.textContent).toContain('Difficult');
    expect(container.textContent).not.toContain('(Hard)');
  });

  test('shows historical progress for an active child despite a legacy progress archive marker', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [{
        id: 44,
        game_student_id: '001234',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: null,
        progress_archived_at: '2026-08-25T00:00:00.000Z',
      }],
      unlinked_count: 0,
    }));

    await act(async () => root.render(<ParentChildProgress />));

    expect(container.textContent).not.toContain('This child’s progress is archived.');
    expect(container.textContent).toContain('12');
    expect(container.textContent).toContain('60%');
    expect(global.fetch.mock.calls.some(([url]) => String(url).startsWith('/api/student-progress/44?'))).toBe(true);
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Archive Progress')).toBe(false);
  });

  test('shows the selector first when the parent has multiple linked children', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [
        { id: 44, student_name: 'Ava Santos', grade_level: 'Grade 3', section: 'Section A' },
        { id: 45, student_name: 'Noah Santos', grade_level: 'Grade 1', section: 'Section B' },
      ],
      unlinked_count: 0,
    }));

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    expect(container.textContent).toContain('My Children');
    expect(container.textContent).toContain('Ava Santos');
    expect(container.textContent).toContain('Noah Santos');
    expect(container.textContent).not.toContain('Quiz Sessions');
  });

  test('orders multiple child selectors alphabetically by child name', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [
        { id: 45, student_name: 'Noah Santos', grade_level: 'Grade 1', section: 'Section B' },
        { id: 44, student_name: 'Ava Santos', grade_level: 'Grade 3', section: 'Section A' },
      ],
      unlinked_count: 0,
    }));

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    const childButtons = Array.from(container.querySelectorAll('.child-selector-card'));
    expect(childButtons.map((button) => button.querySelector('strong')?.textContent)).toEqual(['Ava Santos', 'Noah Santos']);
  });

  test('shows the unlinked game session warning from the parent children response', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [{
        id: 44,
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
      }],
      unlinked_count: 2,
    }));

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    expect(container.textContent).toContain('Some game sessions could not be matched to a child profile.');
    expect(container.textContent).toContain('Please contact the school admin.');
  });

  test('shows grounded recommendations for only the selected child', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [ {
        id: 44,
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        section: 'Section A',
      } ],
      unlinked_count: 0,
    }));

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    expect(container.textContent).toContain('Practice fractions for Ava.');
    expect(container.textContent).not.toContain('Practice shapes for Noah.');
  });

  test('uses the shared detail current quest instead of a conflicting child or list snapshot', async () => {
    global.fetch = jest.fn((url) => {
      if (url.startsWith('/api/students/progress?')) {
        return jsonResponse([{ student_id: 44, current_quest: 'Earlier list quest' }]);
      }
      if (url.startsWith('/api/student-progress/44?')) {
        return jsonResponse({
          progress: { student_id: 44, current_quest: 'Earlier detail alias' },
          metrics: { currentQuest: 'Authoritative current quest', accuracy: 75, totalProgress: null },
          aiInsight: { status: 'insufficient_data' },
        });
      }
      return successPayloadForUrl(url, {
        children: [{ id: 44, student_name: 'Ava Santos', current_quest: 'Earlier child query quest' }],
        unlinked_count: 0,
      });
    });

    await act(async () => root.render(<ParentChildProgress />));

    const questCard = Array.from(container.querySelectorAll('.child-progress-stat'))
      .find((card) => card.querySelector('span')?.textContent === 'Current Quest');
    expect(questCard.querySelector('strong').textContent).toBe('Authoritative current quest');
    expect(container.textContent).not.toContain('Earlier child query quest');
    expect(container.textContent).not.toContain('Earlier list quest');
  });

  test.each(['parent', 'parent_teacher'])('shows the shared student facts in the %s child view', async (role) => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 19, role }));
    global.fetch = jest.fn((url) => {
      if (url.startsWith('/api/student-progress/44?')) {
        return jsonResponse({
          progress: { student_id: 44, difficulty_level: 'Difficult', current_location: 'Oakleaf Village' },
          metrics: {
            currentQuest: 'Current canonical quest', currentDifficulty: 'Easy',
            correctAnswers: 3, incorrectAnswers: 1, completedQuests: 1,
            accuracy: 75, totalProgress: null, reportedTotalProgress: 75,
            totalProgressUnavailableReason: 'full_game_milestones_unverified',
            difficultyBreakdown: { easy: { accuracy: 75 }, medium: { accuracy: null }, hard: { accuracy: null } },
          },
          aiInsight: { status: 'insufficient_data' },
        });
      }
      return successPayloadForUrl(url, {
        children: [{ id: 44, student_name: 'Ava Santos' }], unlinked_count: 0,
      });
    });

    await act(async () => root.render(<ParentChildProgress />));

    const stats = Object.fromEntries(Array.from(container.querySelectorAll('.child-progress-stat'))
      .map((card) => [card.querySelector('span')?.textContent, card.querySelector('strong')?.textContent]));
    expect(stats).toEqual(expect.objectContaining({
      'Current Quest': 'Current canonical quest', 'Current Difficulty': 'Easy',
      'Current Location': 'Oakleaf Village',
      'Correct Answers': '3', 'Incorrect Answers': '1', 'Completed Quests': '1',
      Accuracy: '75%', Progress: 'Not available',
    }));
    const breakdown = container.querySelector('.child-difficulty-panel');
    expect(breakdown.textContent).toContain('Easy75%');
    expect(breakdown.textContent).toContain('NormalNot available');
    expect(breakdown.textContent).toContain('DifficultNot available');
    expect(breakdown.textContent).not.toContain('0%');
    expect(container.textContent).toContain('Progress unavailable: full-game milestones are not yet verified.');
    expect(container.textContent).not.toContain('No game progress data available yet.');
  });

  test.each(['quizzes', 'topics'])('keeps authoritative child metrics when %s are unavailable', async (resource) => {
    global.fetch = jest.fn((url) => {
      if (url.includes(`/${resource}?`)) return Promise.reject(new Error('Offline optional endpoint failure'));
      return successPayloadForUrl(url, {
        children: [{ id: 44, student_name: 'Ava Santos' }], unlinked_count: 0,
      });
    });

    await act(async () => root.render(<ParentChildProgress />));

    const accuracy = Array.from(container.querySelectorAll('.child-progress-stat'))
      .find((card) => card.querySelector('span')?.textContent === 'Accuracy');
    expect(accuracy.querySelector('strong').textContent).toBe('60%');
    expect(container.textContent).toContain('Practice fractions for Ava.');
  });

  test('does not expose a reset action for a selected child', async () => {
    global.fetch = jest.fn((url) => successPayloadForUrl(url, {
      children: [{ id: 44, student_name: 'Ava Santos' }], unlinked_count: 0,
    }));
    await act(async () => root.render(<ParentChildProgress />));

    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Reset Progress')).toBe(false);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('/reset'))).toBe(false);
  });

  test('uses short chronological chart labels and keeps topic details in the timeline data', () => {
    expect(buildScoreTimeline([
      { id: 2, math_topic: 'Subtraction', difficulty: 'Difficult', percentage: 80, played_at: '2026-10-21T10:00:00.000Z' },
      { id: 1, math_topic: 'Addition', difficulty: 'Easy', percentage: 60, played_at: '2026-10-20T10:00:00.000Z' },
    ])).toEqual([
      expect.objectContaining({ label: '#1', percentage: 60, topic: 'Addition', difficulty: 'Easy', sessionId: 1 }),
      expect.objectContaining({ label: '#2', percentage: 80, topic: 'Subtraction', difficulty: 'Difficult', sessionId: 2 }),
    ]);
  });

  test('does not display a zero score for ungraded story activity', () => {
    expect(formatLatestActivityScore({ activity_description: 'Task Completed — talk to the old lady', score: 0 })).toBe('Not graded');
    expect(formatLatestActivityScore({ activity_description: 'Quiz Result', score: 0, total_items: 1 })).toBe('0 / 1');
  });

  test('renders Not graded for story activity instead of a misleading Score 0', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).startsWith('/api/activity-logs?')) {
        return jsonResponse({ data: [{
          id: 7,
          student_id: 44,
          activity_description: 'Task Completed — talk to the old lady',
          current_quest: 'Thank you for defeating the Wizard',
          score: 0,
          activity_timestamp: '2026-10-21T10:00:00.000Z',
        }] });
      }
      return successPayloadForUrl(url, {
        children: [{ id: 44, student_name: 'Ava Santos' }], unlinked_count: 0,
      });
    });

    await act(async () => root.render(<ParentChildProgress />));

    expect(container.textContent).toContain('Not graded');
    expect(container.textContent).not.toContain('Score 0');
  });

  test('does not apply an earlier child insight after the selected child changes', async () => {
    let finishInsight;
    const pendingInsight = new Promise((resolve) => { finishInsight = resolve; });
    global.fetch = jest.fn((url) => {
      if (url.startsWith('/api/student-progress/44/ai-insight?')) return pendingInsight;
      if (url.startsWith('/api/student-progress/44?')) return jsonResponse({
        progress: { student_id: 44, student_name: 'Ava Santos' },
        metrics: { accuracy: 60, totalQuestions: 5 },
        aiInsight: {
          status: 'unavailable', data_level: 'sufficient_data', is_stale: true,
          message: 'New evidence is available, but the insight service is unavailable.',
          insight: { performance_insight: 'Prior Ava evidence.', strengths: [], weaknesses: [], recommendations: ['Practice fractions for Ava.'] },
        },
      });
      return successPayloadForUrl(url, {
        children: [
          { id: 44, student_name: 'Ava Santos' },
          { id: 45, student_name: 'Noah Santos' },
        ], unlinked_count: 0,
      });
    });
    await act(async () => root.render(<ParentChildProgress />));
    await act(async () => Array.from(container.querySelectorAll('.child-selector-card'))
      .find((button) => button.textContent.includes('Ava Santos')).click());
    await act(async () => Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Refresh AI Insight').click());
    await act(async () => Array.from(container.querySelectorAll('.child-selector-card'))
      .find((button) => button.textContent.includes('Noah Santos')).click());
    expect(container.textContent).toContain('Practice shapes for Noah.');

    await act(async () => finishInsight({
      ok: true,
      json: async () => ({ status: 'generated', insight: { recommendations: ['Late Ava-only insight.'] } }),
    }));

    expect(container.textContent).toContain('Practice shapes for Noah.');
    expect(container.textContent).not.toContain('Late Ava-only insight.');
  });

  test('Refresh AI Insight forces a fresh parent-scoped analysis and applies its evidence snapshot', async () => {
    global.fetch = jest.fn((url, options = {}) => {
      if (url.startsWith('/api/student-progress/44/ai-insight?')) {
        expect(options.method).toBe('POST');
        expect(JSON.parse(options.body)).toEqual({ refresh: true });
        return jsonResponse({
          status: 'regenerated',
          generated_at: '2026-10-21T08:30:00.000Z',
          insight: {
            performance_insight: 'Fresh committed Addition evidence is available.',
            strengths: [],
            weaknesses: ['Addition — Oakleaf Bandits: 2 incorrect answers were recorded.'],
            recommendations: ['Keep practicing Grade 1 Addition from Oakleaf Bandits.'],
          },
          evidence_snapshot: {
            progress: { student_id: 44, student_name: 'Ava Santos', current_quest: 'Deepest Forest Bandits' },
            metrics: {
              currentQuest: 'Deepest Forest Bandits',
              correctAnswers: 3,
              incorrectAnswers: 2,
              totalQuestions: 5,
              accuracy: 60,
              totalProgress: 35,
            },
          },
        });
      }
      return successPayloadForUrl(url, {
        children: [{ id: 44, student_name: 'Ava Santos' }], unlinked_count: 0,
      });
    });

    await act(async () => root.render(<ParentChildProgress />));
    const refresh = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Refresh AI Insight');
    expect(refresh).toBeTruthy();

    await act(async () => refresh.click());

    expect(container.textContent).toContain('Fresh committed Addition evidence is available.');
    expect(container.textContent).toContain('Addition — Oakleaf Bandits: 2 incorrect answers were recorded.');
    expect(container.textContent).toContain('Deepest Forest Bandits');
    expect(container.textContent).toContain('Correct Answers3');
    expect(container.textContent).toContain('Incorrect Answers2');
  });

  test('Refresh AI Insight renders the authoritative no-evidence state instead of a transient error', async () => {
    global.fetch = jest.fn((url) => {
      if (url.startsWith('/api/student-progress/44/ai-insight?')) {
        return Promise.resolve({
          ok: false,
          status: 422,
          json: async () => ({
            status: 'no_data',
            data_level: 'no_data',
            valid_result_count: 0,
            message: 'No valid gameplay results are available for grounded AI analysis yet.',
            evidence_snapshot: {
              progress: { student_id: 44, student_name: 'Ava Santos', current_quest: 'Tutorial' },
              metrics: { currentQuest: 'Tutorial', totalQuestions: 0, correctAnswers: 0, incorrectAnswers: 0, accuracy: null, totalProgress: 0 },
            },
          }),
        });
      }
      return successPayloadForUrl(url, {
        children: [{ id: 44, student_name: 'Ava Santos' }], unlinked_count: 0,
      });
    });

    await act(async () => root.render(<ParentChildProgress />));
    const refresh = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Refresh AI Insight');
    await act(async () => refresh.click());

    expect(container.textContent).toContain('No valid gameplay results are available for grounded AI analysis yet.');
    expect(container.textContent).toContain('Tutorial');
    expect(Array.from(container.querySelectorAll('button'))
      .some((button) => button.textContent === 'Refresh AI Insight')).toBe(false);
  });

  test('loads only the chosen child after the parent selects from multiple children', async () => {
    const fetchedUrls = [];
    global.fetch = jest.fn((url) => {
      fetchedUrls.push(url);
      return successPayloadForUrl(url, {
        children: [
          { id: 44, game_student_id: '001234', student_name: 'Ava Santos', grade_level: 'Grade 3', section: 'Section A' },
          { id: 45, game_student_id: '001245', student_name: 'Noah Santos', grade_level: 'Grade 1', section: 'Section B' },
        ],
        unlinked_count: 0,
      });
    });

    await act(async () => {
      root.render(<ParentChildProgress />);
    });

    const noahButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent.includes('Noah Santos'));

    await act(async () => {
      noahButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Noah Santos');
    expect(container.textContent).toContain('Student ID');
    expect(container.textContent).toContain('001245');
    expect(fetchedUrls.some((url) => url.startsWith('/api/parent/children/45/quizzes?'))).toBe(true);
    expect(fetchedUrls.some((url) => url.startsWith('/api/parent/children/44/quizzes?'))).toBe(false);
  });
});
