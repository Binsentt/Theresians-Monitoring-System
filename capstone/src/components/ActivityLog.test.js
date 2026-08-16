import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ActivityLog from './ActivityLog';

const jsonResponse = (payload) => Promise.resolve({
  ok: true,
  json: async () => payload,
});

describe('ActivityLog table', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.setItem('token', 'activity-log-token');
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
  });

  test('renders the activity columns with the external Student ID', async () => {
    global.fetch = jest.fn(() => jsonResponse({
      data: [{
        id: 1,
        student_id: 44,
        game_student_id: '001234',
        student_name: 'Ava Santos',
        grade_level: 'Grade 3',
        current_quest: 'Fractions Gate',
        activity_timestamp: '2026-05-27T08:30:00.000Z',
        total_play_time: 125,
        section: 'Section A',
        save_status: 'saved',
      }],
      pagination: { total: 1, pages: 1, current_page: 1 },
    }));

    await act(async () => {
      root.render(<ActivityLog role="admin" limit={10} />);
    });

    const headers = Array.from(container.querySelectorAll('th')).map((header) => header.textContent.trim());
    expect(headers).toEqual(['Student Name', 'Student ID', 'Grade', 'Time', 'Activity', 'Duration']);
    expect(container.textContent).toContain('Ava Santos');
    expect(container.textContent).toContain('001234');
    expect(container.textContent).toContain('Fractions Gate');
    expect(container.textContent).toContain('2m 5s');
    expect(headers).not.toContain('Section');
    expect(headers).not.toContain('Save Status');
    expect(headers).not.toContain('Progress');
  });

  test('parent activity logs are fetched for the selected child only', async () => {
    const requestedActivityUrls = [];
    global.fetch = jest.fn((url) => {
      const value = String(url);
      if (value.startsWith('/api/parent/children?')) {
        return jsonResponse({
          children: [
            { student_id: 44, student_name: 'Ava Santos' },
            { student_id: 45, student_name: 'Noah Santos' },
          ],
        });
      }
      if (value.startsWith('/api/activity-logs?')) {
        requestedActivityUrls.push(value);
        return jsonResponse({
          data: [{
            id: 2,
            student_id: 44,
            student_name: 'Ava Santos',
            grade_level: 'Grade 3',
            current_quest: 'Fractions Gate',
            duration_seconds: 60,
          }],
          pagination: { total: 1, pages: 1, current_page: 1 },
        });
      }
      return jsonResponse({});
    });

    await act(async () => {
      root.render(<ActivityLog role="parent" userId={19} limit={10} />);
    });

    expect(container.textContent).toContain('Child');
    expect(container.textContent).toContain('Ava Santos');
    expect(requestedActivityUrls.length).toBeGreaterThan(0);
    expect(requestedActivityUrls.every((url) => url.includes('student_id=44'))).toBe(true);
    expect(requestedActivityUrls.every((url) => url.includes('scope=parent'))).toBe(true);
    expect(requestedActivityUrls.every((url) => !url.includes('parent_id=19'))).toBe(true);
    expect(global.fetch.mock.calls.every(([, options]) => (
      options?.headers?.Authorization === 'Bearer activity-log-token'
    ))).toBe(true);
  });
});
