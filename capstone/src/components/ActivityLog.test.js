import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ActivityLog from './ActivityLog';
import { clearPreparedReport, openPreparedReport } from './PrintReportPortal';

const jsonResponse = (payload) => Promise.resolve({
  ok: true,
  json: async () => payload,
});

const waitForActivityText = async (container, text) => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (container.textContent.includes(text)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Timed out waiting for ${text}`);
};

describe('ActivityLog table', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.setItem('token', 'activity-log-token');
    jest.spyOn(window, 'print').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => clearPreparedReport());
    window.print.mockRestore();
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

    const headers = Array.from(container.querySelectorAll('.al-table th')).map((header) => header.textContent.trim());
    expect(headers).toEqual(['Student Name', 'Student ID', 'Grade', 'Time', 'Activity', 'Duration']);
    expect(container.textContent).toContain('Ava Santos');
    expect(container.textContent).toContain('001234');
    expect(container.textContent).toContain('Fractions Gate');
    expect(container.textContent).toContain('2m 5s');
    expect(container.querySelector('button[aria-label="Print Filtered Activity Log"]')).not.toBeNull();
    let opened = false;
    act(() => { opened = openPreparedReport(); });
    expect(opened).toBe(true);
    const report = document.querySelector('#print-report-root .printable-table-report');
    expect(report.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(report.textContent).toContain('May 27, 2026');
    expect(report.querySelector('tbody tr td').textContent).toMatch(/^May 27, 2026\s+.+/);
    expect(headers).not.toContain('Section');
    expect(headers).not.toContain('Save Status');
    expect(headers).not.toContain('Progress');
  });

  test('renders canonical quest payloads without exposing generic website activity descriptions', async () => {
    global.fetch = jest.fn(() => jsonResponse({
      data: [
        {
          id: 1,
          student_id: 44,
          student_name: 'Ava Santos',
          grade_level: 'Grade 3',
          current_quest: 'Tutorial',
          activity_description: 'New Game',
          activity_timestamp: '2026-05-27T08:30:00.000Z',
        },
        {
          id: 2,
          student_id: 44,
          student_name: 'Ava Santos',
          grade_level: 'Grade 3',
          current_quest: 'Teacher House',
          activity_description: 'Load Game',
          activity_timestamp: '2026-05-27T08:31:00.000Z',
        },
        {
          id: 3,
          student_id: 44,
          student_name: 'Ava Santos',
          grade_level: 'Grade 3',
          current_quest: 'Oakleaf Bandit',
          difficulty_level: 'Easy',
          activity_timestamp: '2026-05-27T08:32:00.000Z',
        },
        {
          id: 4,
          student_id: 44,
          student_name: 'Ava Santos',
          grade_level: 'Grade 3',
          activity_description: 'Viewed https://portal.example/admin',
          activity_timestamp: '2026-05-27T08:33:00.000Z',
        },
      ],
      pagination: { total: 4, pages: 1, current_page: 1 },
    }));

    await act(async () => {
      root.render(<ActivityLog role="admin" limit={10} />);
    });

    await waitForActivityText(container, 'Oakleaf Bandit');
    expect(container.textContent).toContain('Tutorial');
    expect(container.textContent).toContain('Teacher House');
    expect(container.textContent).toContain('Oakleaf Bandit — Easy');
    expect(container.textContent).toContain('No active quest');
    expect(container.textContent).not.toContain('Viewed https://portal.example/admin');
    expect(container.textContent).not.toContain('Load Game');
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

  test('prints the complete authorised filtered activity dataset without changing the current page', async () => {
    const allRecords = Array.from({ length: 11 }, (_, index) => ({
      id: index + 1,
      student_id: 100 + index,
      game_student_id: String(100000 + index),
      student_name: `Student ${index + 1}`,
      grade_level: 'Grade 3',
      section: 'Section A',
      current_quest: 'Fractions Gate',
      activity_timestamp: `2026-05-${String(index + 1).padStart(2, '0')}T08:30:00.000Z`,
      duration_seconds: 60,
    }));
    global.fetch = jest.fn((url) => jsonResponse({
      data: String(url).includes('limit=200') ? allRecords : allRecords.slice(0, 10),
      pagination: String(url).includes('limit=200')
        ? { total: 11, pages: 1, current_page: 1 }
        : { total: 11, pages: 2, current_page: 1 },
    }));
    await act(async () => {
      root.render(<ActivityLog role="admin" limit={10} />);
    });
    await waitForActivityText(container, 'Student 1');

    await act(async () => {
      container.querySelector('button[aria-label="Print Filtered Activity Log"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitForActivityText(container, 'Student 11');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelectorAll('.al-table tbody tr')).toHaveLength(10);
    expect(document.querySelectorAll('#print-report-root .printable-table-report tbody tr')).toHaveLength(11);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('limit=200'))).toBe(true);
    // The shared portal regression covers browser invocation; this view test
    // verifies the complete authorized dataset reaches that portal.
    expect(document.querySelector('#print-report-root')).not.toBeNull();
  });
});
