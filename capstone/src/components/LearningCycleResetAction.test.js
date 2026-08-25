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
    document.querySelectorAll('.learning-cycle-reset-overlay').forEach((overlay) => overlay.remove());
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

    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Historical Screen Time, Activity Log, and gameplay results remain preserved.');
    const submitButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Start New Learning Cycle');
    await act(async () => submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.body.textContent).toContain('Select a reason for reset.');
    expect(global.fetch).not.toHaveBeenCalled();

    const reasonSelect = document.body.querySelector('select[name="learning-cycle-reason"]');
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
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  test('requires a custom reason only when Other is selected and allows cancel without a request', async () => {
    global.fetch = jest.fn();
    await act(async () => {
      root.render(<LearningCycleResetAction studentId={44} role="teacher" onReset={jest.fn()} />);
    });
    const openButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reset Progress');
    await act(async () => openButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const reasonSelect = document.body.querySelector('select[name="learning-cycle-reason"]');
    await act(async () => {
      reasonSelect.value = 'Other';
      reasonSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const submitButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Start New Learning Cycle');
    await act(async () => submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.body.textContent).toContain('Provide a reason for Other.');
    expect(global.fetch).not.toHaveBeenCalled();

    const cancelButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Cancel');
    await act(async () => cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('does not bubble the reset reason selector click into a clickable Student Progress row', async () => {
    const rowClick = jest.fn();
    await act(async () => {
      root.render(<div onClick={rowClick}><LearningCycleResetAction studentId={44} role="teacher" onReset={jest.fn()} /></div>);
    });
    const openButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reset Progress');
    await act(async () => openButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(rowClick).not.toHaveBeenCalled();

    const reasonSelect = document.body.querySelector('select[name="learning-cycle-reason"]');
    await act(async () => reasonSelect.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(rowClick).not.toHaveBeenCalled();
  });

  test('renders the reset dialog in a document-level event boundary so every selector interaction stays out of a clickable row', async () => {
    const rowClick = jest.fn();
    await act(async () => {
      root.render(<div onClick={rowClick}><LearningCycleResetAction studentId={44} role="teacher" onReset={jest.fn()} /></div>);
    });

    const openButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reset Progress');
    await act(async () => openButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const overlay = document.body.querySelector('.learning-cycle-reset-overlay');
    const reasonSelect = overlay?.querySelector('select[name="learning-cycle-reason"]');
    expect(overlay?.parentElement).toBe(document.body);

    await act(async () => {
      reasonSelect.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      reasonSelect.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      reasonSelect.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      reasonSelect.value = 'New Lesson';
      reasonSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(rowClick).not.toHaveBeenCalled();
    expect(reasonSelect.value).toBe('New Lesson');
  });
});
