import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import StudentAnalytics from './StudentAnalytics';

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
    }));

    await act(async () => {
      root.render(<StudentAnalytics />);
    });

    expect(container.textContent).toContain('Student analytics');
    expect(container.textContent).toContain('88%');
    expect(container.textContent).toContain('Practice fractions.');
    expect(container.textContent).not.toContain('[object Object]');
  });
});
