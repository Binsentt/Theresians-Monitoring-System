import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as lifecycleActions from './StudentProgressLifecycleActions';

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

  test('progress lifecycle UI exposes no archive or progress-only delete action', () => {
    expect(lifecycleActions.StudentProgressArchiveAction).toBeUndefined();
    expect(lifecycleActions.StudentProgressPermanentDeleteAction).toBeUndefined();
    expect(lifecycleActions.BulkStudentProgressPermanentDeleteAction).toBeUndefined();
    expect(lifecycleActions.BulkStudentProgressLifecycleAction).toBeUndefined();
    expect(lifecycleActions.StudentProgressResetAction).toEqual(expect.any(Function));
  });

  test('Reset Progress remains available without exposing archive workflow', async () => {
    global.fetch = jest.fn(() => jsonResponse({ affected_count: 2 }));
    await act(async () => root.render(<lifecycleActions.StudentProgressResetAction role="admin" />));

    expect(container.textContent).toContain('Reset All');
    expect(container.textContent).not.toMatch(/archive|archived progress|permanent delete/i);
    const button = container.querySelector('button');
    await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/student-progress/lifecycle-summary?operation=reset',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer lifecycle-token' }) })
    );
  });

  test('bulk Reset keeps its affected-count and typed RESET safeguards', async () => {
    global.fetch = jest.fn((url) => (
      String(url).includes('lifecycle-summary')
        ? jsonResponse({ affected_count: 3 })
        : jsonResponse({ success: true, affected_count: 3 })
    ));
    await act(async () => root.render(<lifecycleActions.StudentProgressResetAction role="teacher" />));
    await act(async () => container.querySelector('button').dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.textContent).toContain('3 Students will be affected.');
    const reason = dialog.querySelector('select[name="bulk-reset-reason"]');
    await act(async () => {
      reason.value = 'New Lesson';
      reason.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const submit = Array.from(dialog.querySelectorAll('button')).find((button) => button.type === 'submit');
    await act(async () => submit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(dialog.textContent).toContain('Type RESET to confirm.');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const confirmation = dialog.querySelector('#bulk-reset-confirmation');
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setValue.call(confirmation, 'RESET');
      confirmation.dispatchEvent(new Event('input', { bubbles: true }));
      confirmation.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => submit.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(global.fetch).toHaveBeenLastCalledWith(
      '/api/student-progress/bulk/reset',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'New Lesson', custom_reason: '', expected_count: 3, confirmation: 'RESET' }),
      })
    );
  });
});
