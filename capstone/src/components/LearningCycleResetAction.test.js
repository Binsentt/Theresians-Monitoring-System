import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { LearningCycleResetAction } from './LearningCycleResetAction';

const jsonResponse = (body, status = 200) => Promise.resolve({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('LearningCycleResetAction', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    localStorage.setItem('token', 'reset-test-token');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete global.fetch;
  });

  test('requires a reason and sends only a scoped, confirmed reset request', async () => {
    const onReset = jest.fn();
    global.fetch = jest.fn(() => jsonResponse({ success: true, learning_cycle_started_at: '2026-08-24T00:00:00.000Z' }));

    await act(async () => {
      root.render(<LearningCycleResetAction studentId={44} role="parent" onReset={onReset} />);
    });

    const openButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reset Progress');
    await act(async () => openButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Historical Screen Time, Activity Log, and gameplay results remain preserved.');
    const submitButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Start New Learning Cycle');
    await act(async () => submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('Select a reason for reset.');
    expect(global.fetch).not.toHaveBeenCalled();

    const reasonSelect = container.querySelector('select[name="learning-cycle-reason"]');
    await act(async () => {
      reasonSelect.value = 'New Lesson';
      reasonSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/student-progress/44/reset?scope=parent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer reset-test-token', 'Content-Type': 'application/json' }),
        body: JSON.stringify({ reason: 'New Lesson', custom_reason: '' }),
      })
    );
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test('requires a custom reason only when Other is selected and allows cancel without a request', async () => {
    global.fetch = jest.fn();
    await act(async () => {
      root.render(<LearningCycleResetAction studentId={44} role="teacher" onReset={jest.fn()} />);
    });
    const openButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reset Progress');
    await act(async () => openButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const reasonSelect = container.querySelector('select[name="learning-cycle-reason"]');
    await act(async () => {
      reasonSelect.value = 'Other';
      reasonSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const submitButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Start New Learning Cycle');
    await act(async () => submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('Provide a reason for Other.');
    expect(global.fetch).not.toHaveBeenCalled();

    const cancelButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Cancel');
    await act(async () => cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
