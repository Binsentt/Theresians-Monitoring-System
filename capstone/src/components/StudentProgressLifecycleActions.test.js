import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BulkStudentProgressLifecycleAction,
  StudentProgressArchiveAction,
  StudentProgressPermanentDeleteAction,
} from './StudentProgressLifecycleActions';

const jsonResponse = (body, status = 200) => Promise.resolve({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('StudentProgressLifecycleActions', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    localStorage.setItem('token', 'lifecycle-token');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete global.fetch;
  });

  test('archives only the selected Student after a required reason and keeps modal events from the row', async () => {
    const onComplete = jest.fn();
    const rowClick = jest.fn();
    global.fetch = jest.fn(() => jsonResponse({ success: true }));
    await act(async () => root.render(<div onClick={rowClick}><StudentProgressArchiveAction studentId={44} role="teacher" onComplete={onComplete} /></div>));

    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Archive Progress');
    await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(rowClick).not.toHaveBeenCalled();

    const select = container.querySelector('select[name="archive-reason"]');
    await act(async () => {
      select.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      select.value = 'Transferred';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(rowClick).not.toHaveBeenCalled();
    const submit = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Archive Progress' && item.type === 'submit');
    await act(async () => submit.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/student-progress/44/archive',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer lifecycle-token' }),
        body: JSON.stringify({ reason: 'Transferred', custom_reason: '' }),
      })
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test('requires DELETE before the admin-only gameplay delete request', async () => {
    global.fetch = jest.fn(() => jsonResponse({ success: true }));
    await act(async () => root.render(<StudentProgressPermanentDeleteAction studentId={44} onComplete={jest.fn()} />));
    const open = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Permanent Delete');
    await act(async () => open.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const submit = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Delete Gameplay Data');
    await act(async () => submit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('Provide a deletion reason.');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('retrieves the authorized affected count and requires the typed bulk confirmation', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).includes('lifecycle-summary')) return jsonResponse({ affected_count: 3 });
      return jsonResponse({ success: true, affected_count: 3 });
    });
    await act(async () => root.render(<BulkStudentProgressLifecycleAction operation="reset" role="teacher" onComplete={jest.fn()} />));
    const open = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Reset All');
    await act(async () => open.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('3 Students will be affected.');
    const select = container.querySelector('select[name="bulk-reset-reason"]');
    await act(async () => { select.value = 'New Lesson'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    const submit = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Reset All' && item.type === 'submit');
    await act(async () => submit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('Type RESET to confirm.');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
