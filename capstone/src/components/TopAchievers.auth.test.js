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
});
