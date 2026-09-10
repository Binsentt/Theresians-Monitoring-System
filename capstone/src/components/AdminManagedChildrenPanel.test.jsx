import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AdminManagedChildrenPanel from './AdminManagedChildrenPanel';

const registry = { grades: [{ grade_level: 'Grade 1', sections: ['Amethyst'] }] };
const child = {
  student_id: 44,
  student_name: 'Ava Santos',
  game_student_id: '00123456',
  grade_level: 'Grade 1',
  section: 'Amethyst',
};

const response = (body, ok = true) => ({ ok, json: async () => body });

describe('AdminManagedChildrenPanel', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    global.fetch = jest.fn(async () => response({ children: [child] }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  const renderPanel = async () => {
    await act(async () => root.render(
      <AdminManagedChildrenPanel parentId={19} sectionRegistry={registry} authHeaders={{ Authorization: 'Bearer admin' }} />
    ));
    await act(async () => {});
  };

  test('shows the authoritative Children count and requested columns', async () => {
    await renderPanel();
    expect(container.textContent).toContain('Children (1)');
    expect(container.textContent).toContain('Ava Santos');
    expect(container.textContent).toContain('00123456');
    expect(container.textContent).toContain('Grade 1');
    expect(container.textContent).toContain('Amethyst');
  });

  test('uses one search, paginates after filtering, and keeps all filtered children printable', async () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({
      ...child,
      student_id: 40 + index,
      student_name: `Child ${index + 1}`,
      game_student_id: index === 10 ? '00000042' : String(10000000 + index),
    }));
    global.fetch = jest.fn(async () => response({ children: rows }));
    await renderPanel();
    expect(container.querySelectorAll('input[type="search"]')).toHaveLength(1);
    expect(container.querySelectorAll('table[aria-label="Managed Parent children"] tbody tr')).toHaveLength(10);
    expect(container.textContent).toContain('Page 1 of 2');
    expect(container.querySelector('button[aria-label="Print Children"]')).not.toBeNull();

    const search = container.querySelector('input[type="search"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(search, '00000042');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelectorAll('table[aria-label="Managed Parent children"] tbody tr')).toHaveLength(1);
    expect(container.textContent).toContain('Child 11');
  });

  test('Remove Child confirms unlink-only behavior and preserves the Student account', async () => {
    await renderPanel();
    await act(async () => container.querySelector('button[data-action="unlink-child"]').click());
    expect(container.textContent).toContain('Student account and gameplay data will be preserved');
    expect(container.textContent).toContain('00123456');
    expect(container.querySelector('button[data-action="confirm-unlink-child"]').disabled).toBe(true);
    const reason = container.querySelector('textarea[aria-label="Reason for removing this child relationship"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(reason, 'Linked to the wrong Parent during setup.');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
      reason.dispatchEvent(new Event('change', { bubbles: true }));
    });
    global.fetch.mockResolvedValueOnce(response({ success: true }));
    global.fetch.mockResolvedValueOnce(response({ children: [] }));
    await act(async () => container.querySelector('button[data-action="confirm-unlink-child"]').click());
    const request = global.fetch.mock.calls.find(([url, options]) => String(url).includes('/children/44') && options?.method === 'DELETE');
    expect(request[0]).not.toContain('permanent=true');
    expect(JSON.parse(request[1].body).reason).toBe('Linked to the wrong Parent during setup.');
  });

  test('permanent Student deletion requires an explicit irreversible typed confirmation', async () => {
    await renderPanel();
    await act(async () => container.querySelector('button[data-action="delete-student-permanently"]').click());
    expect(container.textContent).toContain('irreversible');
    const confirmButton = container.querySelector('button[data-action="confirm-delete-student"]');
    expect(confirmButton.disabled).toBe(true);
    const input = container.querySelector('input[aria-label="Type DELETE to confirm Student deletion"]');
    const reason = container.querySelector('textarea[aria-label="Reason for permanently deleting this Student account"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'DELETE');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(reason, 'Duplicate disposable Student account.');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
      reason.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('button[data-action="confirm-delete-student"]').disabled).toBe(false);
    global.fetch.mockResolvedValueOnce(response({ success: true }));
    global.fetch.mockResolvedValueOnce(response({ children: [] }));
    await act(async () => container.querySelector('button[data-action="confirm-delete-student"]').click());
    const request = global.fetch.mock.calls.find(([url, options]) => String(url).includes('/children/44?permanent=true') && options?.method === 'DELETE');
    expect(JSON.parse(request[1].body).permanent_confirmation).toBe('DELETE');
    expect(JSON.parse(request[1].body).reason).toBe('Duplicate disposable Student account.');
  });
});
