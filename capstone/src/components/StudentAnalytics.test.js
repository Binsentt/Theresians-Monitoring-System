import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import StudentAnalytics from './StudentAnalytics';
import { clearPreparedReport } from './PrintReportPortal';

jest.mock('recharts', () => ({
  Bar: () => <div>Bar</div>,
  BarChart: ({ children, data = [] }) => (
    <div data-testid="score-timeline-data">
      {data.map((point) => <span key={point.sessionId || point.label}>{point.label}:{point.percentage}%</span>)}
      {children}
    </div>
  ),
  CartesianGrid: () => <div>Grid</div>,
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  Tooltip: () => <div>Tooltip</div>,
  XAxis: () => <div>XAxis</div>,
  YAxis: () => <div>YAxis</div>,
}));

const mockNavigate = jest.fn();
let mockStudentId = '44';

jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/admin/student-progress/44' }),
  useNavigate: () => mockNavigate,
  useParams: () => ({ studentId: mockStudentId }),
}));

jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');
jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ sidebar, main }) => <div data-testid="analytics-dashboard">{sidebar}{main}</div>,
  MainContent: ({ children }) => <main>{children}</main>,
  TopBar: ({ children }) => <header>{children}</header>,
  PageContent: ({ children }) => <div>{children}</div>,
}));
jest.mock('./layout/AnalyticsSidebar', () => ({ role, activeItem }) => (
  <nav data-testid="analytics-sidebar" data-role={role} data-active={activeItem}>Sidebar</nav>
));

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
    mockStudentId = '44';
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

  test('keeps the role-aware dashboard shell during loading, success, and error states', async () => {
    let resolveRequest;
    global.fetch = jest.fn((url) => String(url).startsWith('/api/activity-logs?') ? jsonResponse({ data: [] }) : new Promise((resolve) => { resolveRequest = resolve; }));

    await act(async () => root.render(<StudentAnalytics />));
    expect(container.querySelector('[data-testid="analytics-sidebar"]')).not.toBeNull();
    expect(container.textContent).toContain('Loading student details...');

    await act(async () => resolveRequest({
      ok: true,
      status: 200,
      json: async () => ({ progress: { student_id: 44, student_name: 'Ava Santos' }, metrics: {}, aiInsight: null }),
    }));
    expect(container.querySelector('[data-testid="analytics-sidebar"]')).not.toBeNull();
    expect(container.textContent).toContain('Ava Santos');

    await act(async () => root.unmount());
    root = createRoot(container);
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));
    await act(async () => root.render(<StudentAnalytics />));
    expect(container.querySelector('[data-testid="analytics-sidebar"]')).not.toBeNull();
    expect(container.textContent).toContain('Analytics currently unavailable');
  });

  test.each(['admin', 'teacher', 'parent_teacher'])('shows authoritative current difficulty for %s', async (role) => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role }));
    global.fetch = jest.fn(() => jsonResponse({
      progress: { student_id: 44, student_name: 'Ava Santos', difficulty_level: 'Difficult' },
      metrics: { currentDifficulty: 'Easy' },
      aiInsight: { status: 'insufficient_data' },
    }));

    await act(async () => root.render(<StudentAnalytics />));

    const difficulty = Array.from(container.querySelectorAll('.student-profile-meta > div'))
      .find((item) => item.querySelector('span')?.textContent === 'Current Difficulty');
    expect(difficulty.querySelector('strong').textContent).toBe('Easy');
  });

  test('preserves an unavailable canonical current quest instead of showing a stale alias', async () => {
    global.fetch = jest.fn(() => jsonResponse({
      progress: { student_id: 44, student_name: 'Ava Santos', current_quest: 'Stale quest alias' },
      metrics: { currentQuest: null },
      aiInsight: { status: 'insufficient_data' },
    }));

    await act(async () => root.render(<StudentAnalytics />));

    const quest = Array.from(container.querySelectorAll('.student-profile-meta > div'))
      .find((item) => item.querySelector('span')?.textContent === 'Current Quest');
    expect(quest.querySelector('strong').textContent).toBe('Not available');
    expect(container.textContent).not.toContain('Stale quest alias');
  });

  test('renders canonical weighted progress while keeping recorded accuracy separate', async () => {
    global.fetch = jest.fn(() => jsonResponse({
      progress: { student_id: 44, student_name: 'Ava Santos', progress_percentage: 75 },
      metrics: {
        totalProgress: 25, reportedTotalProgress: 75, totalProgressVerified: true, totalProgressSource: 'canonical_quest_milestones',
        accuracy: 75, correctAnswers: 3, incorrectAnswers: 1,
      },
      aiInsight: { status: 'not_generated' },
    }));

    await act(async () => root.render(<StudentAnalytics />));

    const progressCard = Array.from(container.querySelectorAll('.student-metric-card'))
      .find((card) => card.textContent.includes('Total Progress'));
    expect(progressCard.querySelector('strong').textContent).toBe('25%');
    expect(progressCard.textContent).not.toContain('Progress unavailable');
    const accuracyCard = Array.from(container.querySelectorAll('.student-metric-card'))
      .find((card) => card.textContent.includes('Accuracy'));
    expect(accuracyCard.querySelector('strong').textContent).toBe('75%');
  });

  test('renders truthful zero counts and no-attempt labels before any graded result', async () => {
    global.fetch = jest.fn(() => jsonResponse({
      progress: { student_id: 44, student_name: 'Ava Santos' },
      metrics: {
        validResultCount: 0,
        totalProgress: 0,
        questCompletionPercentage: 0,
        accuracy: null,
        correctAnswers: 0,
        incorrectAnswers: 0,
        totalQuestions: 0,
        gameScore: 0,
        completedQuests: 0,
        difficultyBreakdown: {
          easy: { accuracy: null }, medium: { accuracy: null }, hard: { accuracy: null },
        },
      },
      aiInsight: { status: 'insufficient_data', message: 'No valid gameplay results are recorded yet.' },
    }));

    await act(async () => root.render(<StudentAnalytics />));

    const cardValue = (label) => Array.from(container.querySelectorAll('.student-metric-card'))
      .find((card) => card.textContent.includes(label))?.querySelector('strong')?.textContent;
    expect(cardValue('Total Progress')).toBe('0%');
    expect(cardValue('Accuracy')).toBe('No attempts yet');
    expect(cardValue('Correct Answers')).toBe('0');
    expect(cardValue('Incorrect Answers')).toBe('0');
    expect(cardValue('Game Score')).toBe('0');
    expect(container.querySelector('.student-performance-meta')?.textContent).toContain('Recorded Results0');
    expect(container.querySelector('.student-difficulty-bars')?.textContent).toContain('No attempts yet');
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
        current_location: 'Oakleaf Village',
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
    expect(container.textContent).toContain('Current Location');
    expect(container.textContent).toContain('Oakleaf Village');
    expect(container.textContent).not.toContain('oak_leaf_village.tscn');
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

  test('labels an automatically generated four-result analysis as preliminary', async () => {
    global.fetch = jest.fn(() => jsonResponse({
      progress: { student_id: 44, student_name: 'Ava Santos', grade_level: 'Grade 1' },
      metrics: { validResultCount: 4, accuracy: 75, totalQuestions: 4 },
      aiInsight: {
        status: 'generated', data_level: 'limited_data', preliminary: true, valid_result_count: 4,
        insight: {
          performance_insight: 'Recorded overall accuracy is 75%.',
          strengths: ['Recorded Easy accuracy is 75%.'],
          weaknesses: [],
          recommendations: ['Record more gameplay evidence.'],
        },
      },
    }));

    await act(async () => root.render(<StudentAnalytics />));

    expect(container.textContent).toContain('Preliminary insight');
    expect(container.textContent).toContain('4 recorded results');
    expect(container.textContent).toContain('Recorded overall accuracy is 75%.');
    expect(container.textContent).toContain('Record more gameplay evidence.');
  });

  test('Refresh AI Insight keeps the current snapshot visible while one fresh request is active', async () => {
    let resolveRefresh;
    global.fetch = jest.fn((url, options = {}) => {
      if (String(url).startsWith('/api/activity-logs?')) return jsonResponse({ data: [] });
      if (options.method === 'POST') return new Promise((resolve) => { resolveRefresh = resolve; });
      return jsonResponse({
        progress: { student_id: 44, student_name: 'Ava Santos', grade_level: 'Grade 1' },
        metrics: { validResultCount: 4, topicLinkedEvidenceCount: 0, accuracy: 75, totalQuestions: 4, correctAnswers: 3, incorrectAnswers: 1, gameScore: 3 },
        aiInsight: {
          status: 'cached', valid_result_count: 4, total_question_count: 4,
          topic_linked_evidence_count: 0, quest_topic_linked_evidence_count: 0,
          generated_at: '2026-10-12T06:30:00.000Z',
          insight: { performance_insight: 'Old cached insight.', strengths: [], weaknesses: [], recommendations: [] },
        },
      });
    });
    await act(async () => root.render(<StudentAnalytics />));
    const refresh = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Refresh AI Insight');
    expect(refresh).toBeTruthy();
    await act(async () => {
      refresh.click();
      refresh.click();
    });

    const request = global.fetch.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(request).toBeTruthy();
    expect(JSON.parse(request[1].body)).toEqual({ refresh: true });
    const refreshingButton = container.querySelector('.student-insight-action');
    expect(refreshingButton).toBeTruthy();
    expect(refreshingButton.textContent).toBe('Refreshing AI insight...');
    expect(refreshingButton.disabled).toBe(true);
    expect(container.querySelector('.student-metrics-grid')).toBeTruthy();
    expect(container.textContent).toContain('Old cached insight.');
    expect(global.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(global.fetch.mock.calls.some(([url]) => String(url).startsWith('/api/activity-logs?student_id=44'))).toBe(true);

    const refreshedAt = '2026-10-13T06:30:00.000Z';
    await act(async () => resolveRefresh({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'regenerated', valid_result_count: 8, total_question_count: 8,
        topic_linked_evidence_count: 7, quest_topic_linked_evidence_count: 6,
        generated_at: refreshedAt,
        evidence_snapshot: {
          progress: { student_id: 44, student_name: 'Ava Santos', grade_level: 'Grade 1', section: 'Section A', current_quest: 'New committed quest', current_location: 'Deepest Forest' },
          metrics: {
            validResultCount: 8, topicLinkedEvidenceCount: 7, questTopicLinkedEvidenceCount: 6, accuracy: 37.5, totalQuestions: 8, correctAnswers: 3, incorrectAnswers: 5,
            gameScore: 3, completedQuests: 2, currentQuest: 'New committed quest', currentDifficulty: 'Normal',
            difficultyBreakdown: { easy: { accuracy: 25 }, medium: { accuracy: 40 }, hard: { accuracy: null } },
            topicPerformance: [
              { topicId: 'addition', topic: 'Addition', gradeLevel: 'Grade 1', correctAnswers: 1, incorrectAnswers: 3, totalQuestions: 4, accuracy: 25 },
              { topicId: 'subtraction', topic: 'Subtraction', gradeLevel: 'Grade 1', correctAnswers: 2, incorrectAnswers: 8, totalQuestions: 10, accuracy: 20 },
              { topic: 'Unvalidated guessed topic', gradeLevel: 'Grade 1', correctAnswers: 0, totalQuestions: 1, accuracy: 0 },
            ],
        },
          scoreHistory: [{ id: 99, math_topic: 'Addition', difficulty: 'Easy', score: 0, total_items: 1, percentage: 0, played_at: '2026-10-13T06:20:00.000Z' }],
        },
        insight: {
          performance_insight: 'Updated from the latest committed results.',
          strengths: [],
          weaknesses: ['Grade 1 Subtraction is now the weakest topic.'],
          recommendations: ['Practice Grade 1 Subtraction.'],
        },
      }),
    }));

    expect(container.textContent).not.toContain('Old cached insight.');
    expect(container.textContent).toContain('Updated from the latest committed results.');
    expect(container.textContent).toContain('New committed quest');
    expect(container.textContent).toContain('Deepest Forest');
    expect(container.textContent).toContain('38%');
    expect(container.textContent).toContain('5');
    const metricValue = (label) => Array.from(container.querySelectorAll('.student-metric-card'))
      .find((card) => card.textContent.includes(label))?.querySelector('strong')?.textContent;
    expect(metricValue('Correct Answers')).toBe('3');
    expect(metricValue('Incorrect Answers')).toBe('5');
    expect(metricValue('Game Score')).toBe('3');
    expect(metricValue('Completed Quests')).toBe('2');
    expect(container.textContent).toContain('Grade 1 Addition');
    expect(container.textContent).toContain('Grade 1 Subtraction');
    expect(container.textContent).toContain('Topic-linked evidence: 7 of 8 recorded answers');
    expect(container.textContent).toContain('Q1:0%');
    expect(container.textContent).toContain('Quest/topic-linked evidence: 6 of 8 recorded answers');
    expect(container.textContent).not.toContain('Unvalidated guessed topic');
    expect(container.textContent).not.toContain(new Date('2026-10-12T06:30:00.000Z').toLocaleString());
    expect(container.querySelector('.student-topic-performance-table')).toBeTruthy();
    expect(container.textContent).toContain(new Date(refreshedAt).toLocaleString());
    expect(container.textContent).not.toContain('Refreshing student progress...');
  });

  test('keeps the prior snapshot and offers another refresh when a refreshed snapshot is incomplete', async () => {
    global.fetch = jest.fn((url, options = {}) => {
      if (String(url).startsWith('/api/activity-logs?')) return jsonResponse({ data: [] });
      if (options.method === 'POST') return jsonResponse({ status: 'regenerated', insight: {} });
      return jsonResponse({
        progress: { student_id: 44, student_name: 'Ava Santos', grade_level: 'Grade 1' },
        metrics: { validResultCount: 4, accuracy: 75, totalQuestions: 4, correctAnswers: 3, incorrectAnswers: 1 },
        aiInsight: { status: 'cached', insight: { performance_insight: 'Existing insight.', strengths: [], weaknesses: [], recommendations: [] } },
      });
    });
    await act(async () => root.render(<StudentAnalytics />));
    const refresh = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Refresh AI Insight');
    await act(async () => refresh.click());

    expect(container.textContent).toContain('The refreshed Student Progress snapshot was incomplete.');
    expect(container.textContent).toContain('Existing insight.');
    expect(container.querySelector('.student-metrics-grid')).toBeTruthy();
    const retry = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Refresh AI Insight');
    expect(retry).toBeTruthy();
    expect(retry.disabled).toBe(false);
  });

  test('Refresh AI Insight creates the first analysis from saved topic evidence when no prior insight exists', async () => {
    let refreshBody;
    global.fetch = jest.fn((url, options = {}) => {
      if (String(url).startsWith('/api/activity-logs?')) return jsonResponse({ data: [] });
      if (options.method === 'POST') {
        refreshBody = JSON.parse(options.body);
        return jsonResponse({
          status: 'generated',
          valid_result_count: 10,
          total_question_count: 10,
          topic_linked_evidence_count: 10,
          generated_at: '2026-10-31T04:00:00.000Z',
          evidence_snapshot: {
            progress: { student_id: 44, student_name: 'Ava Santos', grade_level: 'Grade 1' },
            metrics: {
              validResultCount: 10, totalQuestions: 10, correctAnswers: 7, incorrectAnswers: 3, accuracy: 70,
              topicLinkedEvidenceCount: 10,
              topicPerformance: [
                { topic: 'Addition', gradeLevel: 'Grade 1', correctAnswers: 5, incorrectAnswers: 0, totalQuestions: 5, accuracy: 100 },
                { topic: 'Subtraction', gradeLevel: 'Grade 1', correctAnswers: 2, incorrectAnswers: 3, totalQuestions: 5, accuracy: 40 },
              ],
            },
            scoreHistory: [],
          },
          insight: {
            performance_insight: 'Fresh analysis of ten saved Grade 1 answers.',
            strengths: ['Grade 1 Addition: 5 of 5 recorded answers correct (100%).'],
            weaknesses: ['Grade 1 Subtraction has three recorded incorrect answers.'],
            recommendations: ['Practice Grade 1 Subtraction based on the recorded errors.'],
          },
        });
      }
      return jsonResponse({
        progress: { student_id: 44, student_name: 'Ava Santos', grade_level: 'Grade 1' },
        metrics: {
          validResultCount: 10, totalQuestions: 10, correctAnswers: 7, incorrectAnswers: 3, accuracy: 70,
          topicLinkedEvidenceCount: 10,
          topicPerformance: [
            { topic: 'Addition', gradeLevel: 'Grade 1', correctAnswers: 5, incorrectAnswers: 0, totalQuestions: 5, accuracy: 100 },
            { topic: 'Subtraction', gradeLevel: 'Grade 1', correctAnswers: 2, incorrectAnswers: 3, totalQuestions: 5, accuracy: 40 },
          ],
        },
        aiInsight: null,
        scoreHistory: [],
      });
    });

    await act(async () => root.render(<StudentAnalytics />));
    expect(container.textContent).toContain('Generate AI Insight');
    expect(container.textContent).toContain('Generate the AI insight to identify evidence-backed weaknesses.');

    const generate = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Generate AI Insight');
    await act(async () => generate.click());

    expect(refreshBody).toEqual({ refresh: true });
    expect(container.textContent).toContain('Fresh analysis of ten saved Grade 1 answers.');
    expect(container.textContent).toContain('Grade 1 Addition: 5 of 5 recorded answers correct (100%).');
    expect(container.textContent).toContain('Grade 1 Subtraction has three recorded incorrect answers.');
    expect(container.textContent).toContain('Practice Grade 1 Subtraction based on the recorded errors.');
    expect(Array.from(container.querySelectorAll('button'))
      .some((button) => button.textContent === 'Refresh AI Insight')).toBe(true);
  });

  test('keeps an unavailable refresh actionable and displays the result after a successful retry', async () => {
    let refreshAttempts = 0;
    const snapshot = {
      progress: { student_id: 44, student_name: 'Ava Santos', grade_level: 'Grade 1' },
      metrics: { validResultCount: 5, totalQuestions: 5, correctAnswers: 2, incorrectAnswers: 3, accuracy: 40 },
      scoreHistory: [],
    };
    global.fetch = jest.fn((url, options = {}) => {
      if (String(url).startsWith('/api/activity-logs?')) return jsonResponse({ data: [] });
      if (options.method === 'POST') {
        refreshAttempts += 1;
        if (refreshAttempts === 1) {
          return jsonResponse({
            status: 'unavailable',
            message: 'Grounded AI Insights are unavailable right now. Recorded analytics remain available.',
            evidence_snapshot: snapshot,
            insight: null,
          });
        }
        return jsonResponse({
          status: 'generated',
          evidence_snapshot: snapshot,
          insight: {
            performance_insight: 'The retry analyzed the saved answers.',
            strengths: [],
            weaknesses: ['Subtraction needs more practice.'],
            recommendations: ['Practice subtraction problems.'],
          },
        });
      }
      return jsonResponse({ progress: snapshot.progress, metrics: snapshot.metrics, aiInsight: null, scoreHistory: [] });
    });

    await act(async () => root.render(<StudentAnalytics />));
    const generate = () => Array.from(container.querySelectorAll('button'))
      .find((button) => ['Generate AI Insight', 'Refresh AI Insight'].includes(button.textContent));
    await act(async () => generate().click());

    expect(container.textContent).toContain('Grounded AI Insights are unavailable right now. Recorded analytics remain available.');
    expect(generate()).toBeTruthy();
    expect(generate().disabled).toBe(false);

    await act(async () => generate().click());
    expect(refreshAttempts).toBe(2);
    expect(container.textContent).toContain('The retry analyzed the saved answers.');
    expect(container.textContent).toContain('Subtraction needs more practice.');
  });

  test('loads the selected Student activity and displays the shared score history section', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).startsWith('/api/activity-logs?')) {
        return jsonResponse({ data: [{
          id: 8, student_id: 44, activity_description: 'Completed addition quiz',
          current_quest: 'Oakleaf Bandit Battle', activity_timestamp: '2026-10-21T10:00:00.000Z',
          canonical_activity_id: 'quiz_result', score: 0, total_items: 1,
        }] });
      }
      return jsonResponse({
        progress: { student_id: 44, student_name: 'Ava Santos' },
        metrics: { validResultCount: 1 },
        scoreHistory: [{
          id: 8, math_topic: 'Addition', difficulty: 'Easy', score: 0,
          total_items: 1, percentage: 0, played_at: '2026-10-21T10:00:00.000Z',
        }],
        aiInsight: { status: 'insufficient_data' },
      });
    });

    await act(async () => root.render(<StudentAnalytics />));

    expect(global.fetch.mock.calls.some(([url]) => (
      String(url).startsWith('/api/activity-logs?student_id=44&limit=100')
      && !String(url).includes('scope=parent')
    ))).toBe(true);
    expect(container.textContent).toContain('Latest Activity');
    expect(container.textContent).toContain('Completed addition quiz');
    expect(container.textContent).toContain('Oakleaf Bandit Battle');
    expect(container.textContent).toContain('0 / 1');
    expect(container.textContent).toContain('Score Over Time');
    expect(container.querySelector('.child-score-panel')).toBeTruthy();
  });

  test('ignores a late detail response after the selected Student changes', async () => {
    let resolveA;
    global.fetch = jest.fn((url) => {
      const value = String(url);
      if (value.startsWith('/api/activity-logs?')) return jsonResponse({ data: [] });
      if (value.startsWith('/api/student-progress/44')) {
        return new Promise((resolve) => { resolveA = resolve; });
      }
      if (value.startsWith('/api/student-progress/45')) {
        return jsonResponse({
          progress: { student_id: 45, student_name: 'Noah Santos' },
          metrics: {}, scoreHistory: [], aiInsight: { status: 'insufficient_data' },
        });
      }
      throw new Error('Unexpected request: ' + value);
    });

    await act(async () => root.render(<StudentAnalytics />));
    mockStudentId = '45';
    await act(async () => root.render(<StudentAnalytics />));
    expect(container.textContent).toContain('Noah Santos');

    await act(async () => resolveA(jsonResponse({
      progress: { student_id: 44, student_name: 'Ava Santos' },
      metrics: {}, scoreHistory: [], aiInsight: { status: 'insufficient_data' },
    })));

    expect(container.textContent).toContain('Noah Santos');
    expect(container.textContent).not.toContain('Ava Santos');
  });

  test('does not let a prior Student refresh overwrite the selected Student or block their refresh', async () => {
    let resolveOldRefresh;
    let resolveNewRefresh;
    global.fetch = jest.fn((url, options = {}) => {
      const value = String(url);
      if (value.startsWith('/api/activity-logs?')) return jsonResponse({ data: [] });
      if (options.method === 'POST' && value.startsWith('/api/student-progress/44')) {
        return new Promise((resolve) => { resolveOldRefresh = resolve; });
      }
      if (options.method === 'POST' && value.startsWith('/api/student-progress/45')) {
        return new Promise((resolve) => { resolveNewRefresh = resolve; });
      }
      if (value.startsWith('/api/student-progress/44')) {
        return jsonResponse({
          progress: { student_id: 44, student_name: 'Ava Santos' }, metrics: {},
          scoreHistory: [], aiInsight: { status: 'cached', insight: { performance_insight: 'Existing insight.', strengths: [], weaknesses: [], recommendations: [] } },
        });
      }
      if (value.startsWith('/api/student-progress/45')) {
        return jsonResponse({
          progress: { student_id: 45, student_name: 'Noah Santos' }, metrics: {},
          scoreHistory: [], aiInsight: { status: 'cached', insight: { performance_insight: 'Existing insight.', strengths: [], weaknesses: [], recommendations: [] } },
        });
      }
      throw new Error('Unexpected request: ' + value);
    });

    await act(async () => root.render(<StudentAnalytics />));
    const firstRefresh = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Refresh AI Insight');
    await act(async () => firstRefresh.click());

    mockStudentId = '45';
    await act(async () => root.render(<StudentAnalytics />));
    expect(container.textContent).toContain('Noah Santos');
    const secondRefresh = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Refresh AI Insight');
    await act(async () => secondRefresh.click());
    expect(global.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(2);

    const refreshedResponse = (studentId, studentName) => jsonResponse({
      status: 'regenerated',
      evidence_snapshot: {
        progress: { student_id: studentId, student_name: studentName },
        metrics: { validResultCount: 1 },
        scoreHistory: [],
      },
      insight: { performance_insight: 'Fresh for ' + studentName, strengths: [], weaknesses: [], recommendations: [] },
    });
    await act(async () => resolveOldRefresh(refreshedResponse(44, 'Ava Santos')));
    expect(container.textContent).toContain('Noah Santos');
    expect(container.textContent).not.toContain('Fresh for Ava Santos');

    await act(async () => resolveNewRefresh(refreshedResponse(45, 'Noah Santos')));
    expect(container.textContent).toContain('Fresh for Noah Santos');
    expect(container.textContent).not.toContain('Fresh for Ava Santos');
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
