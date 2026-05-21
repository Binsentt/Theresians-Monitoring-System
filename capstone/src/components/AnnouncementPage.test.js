import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AnnouncementPage from './AnnouncementPage';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
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

describe('AnnouncementPage load states', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin', name: 'Admin User' }));
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

  test('shows an empty state without a failure banner when announcements are empty', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => [],
    }));

    await act(async () => {
      root.render(<AnnouncementPage mode="admin" />);
    });

    expect(container.textContent).toContain('No teacher announcements posted yet');
    expect(container.textContent).not.toContain('Failed to load announcements.');
  });

  test('shows a failure banner when the announcement API fails', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Server error' }),
    }));

    await act(async () => {
      root.render(<AnnouncementPage mode="admin" />);
    });

    expect(container.textContent).toContain('Failed to load announcements.');
  });
});
