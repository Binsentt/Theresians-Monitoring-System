import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AdminParentChildren from './AdminParentChildren';
import { createAdminChildDraft } from './adminParentChildren.utils';

const registry = { grades: [{ grade_level: 'Grade 1', sections: ['Amethyst', 'Amber'] }] };

describe('AdminParentChildren', () => {
  let container;
  let root;

  beforeEach(() => {
    jest.useFakeTimers();
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    global.fetch = jest.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('starts with one child, adds/removes unsaved rows, and never removes the last row', async () => {
    let value = [createAdminChildDraft('row-1')];
    const render = async () => {
      await act(async () => root.render(
        <AdminParentChildren value={value} onChange={(next) => { value = next; }} sectionRegistry={registry} errors={[]} />
      ));
    };
    await render();

    expect(container.textContent).toContain('Child 1');
    expect(container.querySelector('button[aria-label="Remove Child 1"]')).toBeNull();

    await act(async () => container.querySelector('button[data-action="add-child"]').click());
    await render();
    expect(value).toHaveLength(2);
    expect(container.textContent).toContain('Child 2');

    await act(async () => container.querySelector('button[aria-label="Remove Child 2"]').click());
    await render();
    expect(value).toHaveLength(1);
  });

  test('switches between complete New Student fields and ID-only Link Existing Student', async () => {
    let value = [createAdminChildDraft('row-1')];
    const onChange = (next) => { value = next; };
    await act(async () => root.render(
      <AdminParentChildren value={value} onChange={onChange} sectionRegistry={registry} errors={[]} />
    ));

    expect(container.querySelector('input[aria-label="Child 1 first name"]')).not.toBeNull();
    const operation = container.querySelector('select[aria-label="Child 1 account action"]');
    await act(async () => {
      operation.value = 'link';
      operation.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => root.render(
      <AdminParentChildren value={value} onChange={onChange} sectionRegistry={registry} errors={[]} />
    ));

    expect(container.querySelector('input[aria-label="Child 1 first name"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Child 1 Student ID"]')).not.toBeNull();
    expect(container.textContent).toContain('Only Students without an active Parent relationship can be linked.');
  });

  test('validates a locally valid Student ID against authoritative ownership and exposes the result inline', async () => {
    let value = [{ ...createAdminChildDraft('row-1'), operation: 'link', studentId: '00123456' }];
    const validationStates = [];
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ available: true, student_id: '00123456', operation: 'link' }) });

    await act(async () => root.render(
      <AdminParentChildren
        value={value}
        onChange={(next) => { value = next; }}
        sectionRegistry={registry}
        errors={[]}
        authHeaders={{ Authorization: 'Bearer admin' }}
        onValidationStateChange={(state) => validationStates.push(state)}
      />
    ));
    expect(container.textContent).toContain('Checking Student ID');
    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('/api/accounts/student-link-eligibility?student_id=00123456&operation=link');
    expect(container.textContent).toContain('Student ID is available');
    expect(validationStates.at(-1)).toEqual({ pending: false, isValid: true });
  });

  test('shows the single-Parent ownership error and ignores a stale earlier validation response', async () => {
    let value = [{ ...createAdminChildDraft('row-1'), operation: 'link', studentId: '00123456' }];
    let resolveFirst;
    global.fetch
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: 'This Student is already linked to a Parent account.' }),
      });
    const onChange = (next) => { value = next; };
    const render = async () => act(async () => root.render(
      <AdminParentChildren value={value} onChange={onChange} sectionRegistry={registry} errors={[]} authHeaders={{ Authorization: 'Bearer admin' }} />
    ));
    await render();
    await act(async () => { jest.advanceTimersByTime(300); });

    value = [{ ...value[0], studentId: '00999999' }];
    await render();
    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('This Student is already linked to a Parent account.');

    await act(async () => {
      resolveFirst({ ok: true, json: async () => ({ available: true }) });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('This Student is already linked to a Parent account.');
    expect(container.textContent).not.toContain('Student ID is available');
  });

  test('rejects invalid lengths locally without an availability request', async () => {
    const value = [{ ...createAdminChildDraft('row-1'), operation: 'link', studentId: '1234567' }];
    await act(async () => root.render(
      <AdminParentChildren value={value} onChange={() => {}} sectionRegistry={registry} errors={[]} authHeaders={{ Authorization: 'Bearer admin' }} />
    ));
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Existing Student IDs must be exactly 6 or 8 digits.');
  });
});
