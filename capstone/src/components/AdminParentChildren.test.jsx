import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AdminParentChildren from './AdminParentChildren';
import { createAdminChildDraft } from './adminParentChildren.utils';

const registry = { grades: [{ grade_level: 'Grade 1', sections: ['Amethyst', 'Amber'] }] };

describe('AdminParentChildren', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
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
});
