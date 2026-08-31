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
    document.querySelectorAll('.learning-cycle-reset-overlay').forEach((overlay) => overlay.remove());
    container.remove();
    delete global.fetch;
  });

  test('archives only the selected Student after a required reason and keeps every modal event out of the row', async () => {
    const onComplete = jest.fn();
    const rowClick = jest.fn();
    global.fetch = jest.fn(() => jsonResponse({ success: true }));
    await act(async () => root.render(<div onClick={rowClick}><StudentProgressArchiveAction studentId={44} role="teacher" onComplete={onComplete} /></div>));

    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Archive Student Progress');
    await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(rowClick).not.toHaveBeenCalled();

    const overlay = document.body.querySelector('.learning-cycle-reset-overlay');
    expect(overlay?.parentElement).toBe(document.body);
    expect(overlay.textContent).toContain('Archive Student Progress');
    expect(overlay.textContent).toContain('Reason for Archive');
    const select = overlay.querySelector('select[name="archive-reason"]');
    await act(async () => {
      select.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      select.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      select.value = 'Transferred';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(rowClick).not.toHaveBeenCalled();
    const submit = Array.from(overlay.querySelectorAll('button')).find((item) => item.textContent === 'Archive Student Progress' && item.type === 'submit');
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
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  test('requires DELETE before the admin-only gameplay delete request', async () => {
    global.fetch = jest.fn(() => jsonResponse({ success: true }));
    await act(async () => root.render(<StudentProgressPermanentDeleteAction studentId={44} onComplete={jest.fn()} />));
    const open = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Permanent Delete');
    await act(async () => open.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const submit = Array.from(document.body.querySelectorAll('button')).find((item) => item.textContent === 'Delete Gameplay Data');
    await act(async () => submit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.body.textContent).toContain('Provide a deletion reason.');
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
    const overlay = document.body.querySelector('.learning-cycle-reset-overlay');
    expect(overlay.textContent).toContain('3 Students will be affected.');
    const select = overlay.querySelector('select[name="bulk-reset-reason"]');
    await act(async () => { select.value = 'New Lesson'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    const submit = Array.from(overlay.querySelectorAll('button')).find((item) => item.textContent === 'Reset All' && item.type === 'submit');
    await act(async () => submit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(overlay.textContent).toContain('Type RESET to confirm.');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const confirmation = overlay.querySelector('input[id="bulk-reset-confirmation"]');
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      valueSetter.call(confirmation, 'RESET');
      confirmation.dispatchEvent(new Event('input', { bubbles: true }));
      confirmation.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => submit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/student-progress/bulk/reset',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'New Lesson', custom_reason: '', expected_count: 3, confirmation: 'RESET' }),
      })
    );
  });

  test('archives all authorized active Students only after ARCHIVE is typed', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).includes('lifecycle-summary')) return jsonResponse({ affected_count: 2 });
      return jsonResponse({ success: true, affected_count: 2 });
    });
    await act(async () => root.render(<BulkStudentProgressLifecycleAction operation="archive" role="admin" onComplete={jest.fn()} />));
    const open = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Archive All');
    await act(async () => open.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const overlay = document.body.querySelector('.learning-cycle-reset-overlay');
    expect(overlay.textContent).toContain('Archive all currently authorized active Students');
    expect(overlay.textContent).toContain('Type ARCHIVE to confirm');

    const select = overlay.querySelector('select[name="bulk-archive-reason"]');
    await act(async () => { select.value = 'End of School Year'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    const confirmation = overlay.querySelector('input[id="bulk-archive-confirmation"]');
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      valueSetter.call(confirmation, 'ARCHIVE');
      confirmation.dispatchEvent(new Event('input', { bubbles: true }));
      confirmation.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const submit = Array.from(overlay.querySelectorAll('button')).find((item) => item.textContent === 'Archive All' && item.type === 'submit');
    await act(async () => submit.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/student-progress/bulk/archive',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'End of School Year', custom_reason: '', expected_count: 2, confirmation: 'ARCHIVE' }),
      })
    );
  });
});
