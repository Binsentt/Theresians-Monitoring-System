import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AdminTopAchievers from './AdminTopAchievers';
import TeacherTopAchievers from './TeacherTopAchievers';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ main }) => <div>{main}</div>,
  MainContent: ({ children }) => <div>{children}</div>,
  TopBar: ({ children }) => <div>{children}</div>,
  PageContent: ({ children }) => <div>{children}</div>,
  ContentSection: ({ children }) => <section>{children}</section>,
}));

jest.mock('./layout/AnalyticsSidebar', () => () => <div>Sidebar</div>);
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

const jsonResponse = (body) => Promise.resolve({ ok: true, json: async () => body });

const leaderboardRows = Array.from({ length: 11 }, (_, index) => ({
  id: index + 1,
  student_name: `Student ${index + 1}`,
  game_student_id: index === 0 ? '001234' : String(100000 + index),
  grade_level: 'Grade 1',
  section: 'Section A',
  completion_percentage: 80,
  accuracy: 90,
  total_correct_answers: 9,
  total_questions_answered: 10,
  quests_completed: 1,
  total_play_time: 60,
}));

describe('Top Achievers authenticated analytics requests', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    mockNavigate.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete global.fetch;
  });

  test('admin and teacher requests send bearer authentication without caller-supplied teacher identity', async () => {
    global.fetch = jest.fn(() => jsonResponse([]));

    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin' }));
    localStorage.setItem('token', 'top-achievers-token');
    await act(async () => root.render(<AdminTopAchievers />));

    localStorage.setItem('loggedInUser', JSON.stringify({ id: 16, role: 'teacher' }));
    await act(async () => root.render(<TeacherTopAchievers />));

    expect(global.fetch.mock.calls).toHaveLength(2);
    expect(global.fetch.mock.calls[0][0]).toBe('/api/top-achievers');
    expect(global.fetch.mock.calls[1][0]).toBe('/api/top-achievers');
    expect(global.fetch.mock.calls.every(([, options]) => (
      options?.headers?.Authorization === 'Bearer top-achievers-token'
    ))).toBe(true);
  });

  test('admin leaderboard paginates authorised records and provides a printable Student ID report', async () => {
    global.fetch = jest.fn(() => jsonResponse(leaderboardRows));
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin' }));
    localStorage.setItem('token', 'top-achievers-token');

    await act(async () => root.render(<AdminTopAchievers />));

    expect(container.querySelectorAll('.ta-table tbody tr')).toHaveLength(10);
    expect(container.textContent).toContain('Page 1 of 2');
    expect(container.textContent).toContain('001234');
    expect(container.querySelector('button[aria-label="Print Top Achievers"]')).not.toBeNull();
  });

  test('teacher leaderboard applies the same controls only to its authorised response', async () => {
    global.fetch = jest.fn(() => jsonResponse(leaderboardRows));
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 16, role: 'teacher' }));
    localStorage.setItem('token', 'top-achievers-token');

    await act(async () => root.render(<TeacherTopAchievers />));

    expect(global.fetch.mock.calls[0][0]).toBe('/api/top-achievers');
    expect(container.querySelectorAll('.ta-table tbody tr')).toHaveLength(10);
    expect(container.textContent).toContain('Page 1 of 2');
    expect(container.querySelector('button[aria-label="Print Top Achievers"]')).not.toBeNull();
  });

  test('does not render zero-percent metric bars when the backend has no metric data', async () => {
    global.fetch = jest.fn(() => jsonResponse([{
      ...leaderboardRows[0],
      completion_percentage: null,
      accuracy: null,
    }]));
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin' }));
    localStorage.setItem('token', 'top-achievers-token');

    await act(async () => root.render(<AdminTopAchievers />));

    expect(container.textContent).toContain('No Data');
    expect(container.querySelectorAll('.progress-fill, .accuracy-fill')).toHaveLength(0);
  });
});
