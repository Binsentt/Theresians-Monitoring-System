import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ParentAddChildModal from './ParentAddChildModal';

jest.mock('../api', () => ({ apiUrl: (path) => path }));
jest.mock('./session.utils', () => ({ buildAuthHeaders: () => ({ Authorization: 'Bearer parent-token' }) }));

const setInputValue = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const setSelectValue = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

const sectionRegistryFixture = {
  grades: [
    { grade_level: 'Grade 1', sections: ['Amethyst', 'Amber'] },
    { grade_level: 'Grade 2', sections: ['Diamond', 'Emerald'] },
    { grade_level: 'Grade 3', sections: ['Garnet', 'Jade'] },
    { grade_level: 'Grade 4', sections: ['Onyx', 'Moonstone'] },
    { grade_level: 'Grade 5', sections: ['Pearl'] },
    { grade_level: 'Grade 6', sections: ['Sardonyx', 'Zircon'] },
  ],
};

const okJson = (body) => Promise.resolve({ ok: true, json: async () => body });

describe('ParentAddChildModal', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete global.fetch;
  });

  test('shows inline errors and does not call the API for an invalid child form', async () => {
    await act(async () => {
      root.render(<ParentAddChildModal onClose={jest.fn()} onCreated={jest.fn()} />);
    });

    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('First name is required.');
    expect(container.textContent).toContain('Last name is required.');
    expect(container.textContent).toContain('Grade is required.');
    expect(container.textContent).toContain('Student ID is required.');
    expect(global.fetch).toHaveBeenCalledWith('/api/sections/registry', expect.any(Object));
    expect(global.fetch).not.toHaveBeenCalledWith('/api/parent/children', expect.any(Object));
  });

  test('uses the backend registry for a required Grade-filtered Section dropdown and clears stale selection', async () => {
    global.fetch.mockImplementation((url) => {
      if (String(url).endsWith('/api/sections/registry')) return okJson(sectionRegistryFixture);
      return okJson({});
    });
    await act(async () => {
      root.render(<ParentAddChildModal onClose={jest.fn()} onCreated={jest.fn()} />);
      await Promise.resolve();
    });

    const grade = container.querySelector('#child-grade');
    const section = container.querySelector('#child-section');
    expect(container.querySelector('label[for="child-section"]')?.textContent).toBe('Section *');
    expect(section.tagName).toBe('SELECT');
    expect(section.disabled).toBe(true);

    await act(async () => { setSelectValue(grade, 'Grade 1'); });
    expect(Array.from(section.options).map((option) => option.value)).toEqual(['', 'Amethyst', 'Amber']);
    await act(async () => { setSelectValue(section, 'Amber'); });
    expect(section.value).toBe('Amber');
    await act(async () => { setSelectValue(grade, 'Grade 2'); });
    expect(section.value).toBe('');
    expect(Array.from(section.options).map((option) => option.value)).toEqual(['', 'Diamond', 'Emerald']);
  });

  test('submits the selected canonical Section and preserves the leading-zero Student ID', async () => {
    const onCreated = jest.fn();
    global.fetch.mockImplementation((url) => {
      if (String(url).endsWith('/api/sections/registry')) return okJson(sectionRegistryFixture);
      return okJson({
        child: {
          id: 44,
          student_name: 'Ava M Santos',
          game_student_id: '001234',
          grade_level: 'Grade 3',
          section: 'Jade',
        },
      });
    });
    await act(async () => {
      root.render(<ParentAddChildModal onClose={jest.fn()} onCreated={onCreated} />);
      await Promise.resolve();
    });

    const fields = {
      firstName: container.querySelector('#child-first-name'),
      lastName: container.querySelector('#child-last-name'),
      middleInitial: container.querySelector('#child-middle-initial'),
      gradeLevel: container.querySelector('#child-grade'),
      section: container.querySelector('#child-section'),
      studentId: container.querySelector('#child-student-id'),
    };
    await act(async () => {
      setInputValue(fields.firstName, 'Ava');
      setInputValue(fields.lastName, 'Santos');
      setInputValue(fields.middleInitial, 'M');
      setSelectValue(fields.gradeLevel, 'Grade 3');
      expect(fields.section.tagName).toBe('SELECT');
      setSelectValue(fields.section, 'Jade');
      setInputValue(fields.studentId, '001234');
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/parent/children', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer parent-token' }),
      body: JSON.stringify({
        first_name: 'Ava',
        last_name: 'Santos',
        middle_initial: 'M',
        grade_level: 'Grade 3',
        section: 'Jade',
        student_id: '001234',
      }),
    }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ game_student_id: '001234' }));
  });
});
