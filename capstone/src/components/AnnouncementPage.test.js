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

const setFieldValue = (field, value) => {
  const prototype = field.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

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

  test('uses same-origin announcement API paths when no API base URL is configured', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => [],
    }));

    await act(async () => {
      root.render(<AnnouncementPage mode="admin" />);
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/announcements?target_role=teacher&created_by=1&created_by_role=admin&limit=20');
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

  test('shows a failure banner when the announcement collection is not found', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    }));

    await act(async () => {
      root.render(<AnnouncementPage mode="admin" />);
    });

    expect(container.textContent).toContain('Failed to load announcements.');
  });

  test('shows a failure banner when a teacher announcement collection request fails', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 2, role: 'teacher', name: 'Teacher User' }));
    global.fetch = jest.fn(() => Promise.resolve({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    }));

    await act(async () => {
      root.render(<AnnouncementPage mode="teacher" />);
    });

    expect(container.textContent).toContain('Failed to load announcements.');
  });

  test('shows a failure banner when the announcement response body is malformed', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token <');
      },
    }));

    await act(async () => {
      root.render(<AnnouncementPage mode="admin" />);
    });

    expect(container.textContent).toContain('Failed to load announcements.');
  });

  test('loads parent announcements silently when the response succeeds', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 3, role: 'parent', name: 'Parent User' }));
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => [],
    }));

    await act(async () => {
      root.render(<AnnouncementPage mode="parent" />);
    });

    expect(container.textContent).toContain('No teacher announcements yet');
    expect(container.textContent).not.toContain('Failed to load announcements.');
  });

  test('shows a parent announcement load error banner on a failed response', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 3, role: 'parent', name: 'Parent User' }));
    global.fetch = jest.fn(() => Promise.resolve({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Server error' }),
    }));

    await act(async () => {
      root.render(<AnnouncementPage mode="parent" />);
    });

    expect(container.textContent).toContain('Failed to load announcements.');
  });

  test('allows parent teacher accounts to access parent announcements', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 4, role: 'parent_teacher', name: 'Parent Teacher' }));
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => [],
    }));

    await act(async () => {
      root.render(<AnnouncementPage mode="parent" />);
    });

    expect(mockNavigate).not.toHaveBeenCalledWith('/login');
    expect(container.textContent).toContain('No teacher announcements yet');
  });

  test('keeps a failed announcement post out of the generic connection error path when the response is not JSON', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => {
          throw new Error('Unexpected token <');
        },
      });

    await act(async () => {
      root.render(<AnnouncementPage mode="admin" />);
    });

    const titleInput = container.querySelector('input');
    const messageInput = container.querySelector('textarea');
    const form = container.querySelector('form');

    await act(async () => {
      setFieldValue(titleInput, 'School reminder');
      setFieldValue(messageInput, 'Please review the lesson files.');
    });

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('Failed to post announcement.');
    expect(container.textContent).not.toContain('Connection error while saving announcement.');
  });

  test('shows announcement skeletons while a collection request is still pending', async () => {
    let resolveRequest;
    global.fetch = jest.fn(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));

    await act(async () => {
      root.render(<AnnouncementPage mode="admin" />);
    });

    expect(container.querySelectorAll('.announcement-skeleton').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('Loading announcements...');

    await act(async () => {
      resolveRequest({
        ok: true,
        status: 200,
        json: async () => [],
      });
    });
  });

  test('clears the composer and renders the posted announcement after a successful save', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          id: 44,
          title: 'School reminder',
          message: 'Please review the lesson files.',
          posted_by: 'Admin User',
        }),
      });

    await act(async () => {
      root.render(<AnnouncementPage mode="admin" />);
    });

    const titleInput = container.querySelector('input');
    const messageInput = container.querySelector('textarea');

    await act(async () => {
      setFieldValue(titleInput, 'School reminder');
      setFieldValue(messageInput, 'Please review the lesson files.');
    });

    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(titleInput.value).toBe('');
    expect(messageInput.value).toBe('');
    expect(container.textContent).toContain('Announcement posted successfully.');
    expect(container.textContent).toContain('School reminder');
  });

  test('shows a post failure instead of a connection error when a successful save response is malformed', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => {
          throw new Error('Unexpected end of JSON input');
        },
      });

    await act(async () => {
      root.render(<AnnouncementPage mode="admin" />);
    });

    const titleInput = container.querySelector('input');
    const messageInput = container.querySelector('textarea');

    await act(async () => {
      setFieldValue(titleInput, 'School reminder');
      setFieldValue(messageInput, 'Please review the lesson files.');
    });

    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('Failed to post announcement.');
    expect(container.textContent).not.toContain('Connection error while saving announcement.');
  });
});
