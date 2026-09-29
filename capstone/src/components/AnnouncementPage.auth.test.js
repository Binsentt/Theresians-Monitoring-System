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
    <section>{title ? <h2>{title}</h2> : null}{children}</section>
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

describe('AnnouncementPage authenticated mutations', () => {
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
    act(() => root.unmount());
    container.remove();
    delete global.fetch;
    delete global.confirm;
    console.error.mockRestore();
  });

  test('POST sends the session Bearer header and no client actor identity', async () => {
    localStorage.setItem('token', 'announcement-post-token');
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 44, title: 'School reminder', message: 'Review the lesson.' }),
      });

    await act(async () => root.render(<AnnouncementPage mode="admin" />));
    await act(async () => {
      setFieldValue(container.querySelector('input'), 'School reminder');
      setFieldValue(container.querySelector('textarea'), 'Review the lesson.');
    });
    await act(async () => container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    const request = global.fetch.mock.calls.find(([, options = {}]) => options.method === 'POST');
    expect(request[1].headers.Authorization).toBe('Bearer announcement-post-token');
    expect(JSON.parse(request[1].body)).toEqual({ title: 'School reminder', message: 'Review the lesson.', target_role: 'teacher' });
  });

  test('PUT sends the session Bearer header and no client actor identity', async () => {
    localStorage.setItem('token', 'announcement-edit-token');
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 8, title: 'Existing update', message: 'Original message', created_by: 1, created_by_role: 'admin' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 8, title: 'Edited update', message: 'Revised message', created_by_role: 'admin' }),
      });

    await act(async () => root.render(<AnnouncementPage mode="admin" />));
    await act(async () => container.querySelector('.announcement-edit-action').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      setFieldValue(container.querySelector('input'), 'Edited update');
      setFieldValue(container.querySelector('textarea'), 'Revised message');
    });
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Save Changes')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const request = global.fetch.mock.calls.find(([, options = {}]) => options.method === 'PUT');
    expect(request[0]).toBe('/api/announcements/8');
    expect(request[1].headers.Authorization).toBe('Bearer announcement-edit-token');
    expect(JSON.parse(request[1].body)).toEqual({ title: 'Edited update', message: 'Revised message', target_role: 'teacher' });
  });

  test('DELETE sends the session Bearer header without actor query or body fields', async () => {
    localStorage.setItem('token', 'announcement-delete-token');
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 8, title: 'Remove me', message: 'Announcement body', created_by: 1, created_by_role: 'admin' }],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, id: 8 }) });

    await act(async () => root.render(<AnnouncementPage mode="admin" />));
    await act(async () => container.querySelector('.announcement-delete-action').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Delete Announcement')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const [url, options] = global.fetch.mock.calls.find(([, requestOptions = {}]) => requestOptions.method === 'DELETE');
    expect(url).not.toContain('actor_id');
    expect(url).not.toContain('actor_role');
    expect(options.headers.Authorization).toBe('Bearer announcement-delete-token');
    expect(options.body).toBeUndefined();
  });

  test('Parent-Teacher Teacher-scope mutations send scope context and session auth only', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 15, role: 'parent_teacher', name: 'Parent Teacher' }));
    localStorage.setItem('token', 'parent-teacher-announcement-token');
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 44, title: 'Class update', message: 'Review the lesson.' }) });

    await act(async () => root.render(<AnnouncementPage mode="teacher" />));
    await act(async () => {
      setFieldValue(container.querySelector('input'), 'Class update');
      setFieldValue(container.querySelector('textarea'), 'Review the lesson.');
    });
    await act(async () => container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    const [url, options] = global.fetch.mock.calls.find(([, requestOptions = {}]) => requestOptions.method === 'POST');
    expect(url).toContain('scope=teacher');
    expect(options.headers.Authorization).toBe('Bearer parent-teacher-announcement-token');
    expect(JSON.parse(options.body)).toEqual({ title: 'Class update', message: 'Review the lesson.', target_role: 'parent' });
  });
});
