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
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('keeps Section optional without fabricated suggestion values', async () => {
    await act(async () => {
      root.render(<ParentAddChildModal onClose={jest.fn()} onCreated={jest.fn()} />);
    });

    expect(container.querySelector('label[for="child-section"]')?.textContent).toBe('Section (Optional)');
    expect(container.querySelector('#child-section')?.getAttribute('list')).toBeNull();
    expect(container.querySelector('#child-section-suggestions')).toBeNull();
    expect(container.textContent).toContain('Leave blank until official school Section data is available.');
  });

  test('accepts a normalized real section label and preserves the leading-zero Student ID', async () => {
    const onCreated = jest.fn();
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        child: {
          id: 44,
          student_name: 'Ava M Santos',
          game_student_id: '001234',
          grade_level: 'Grade 3',
          section: 'Rizal',
        },
      }),
    });
    await act(async () => {
      root.render(<ParentAddChildModal onClose={jest.fn()} onCreated={onCreated} />);
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
      expect(fields.section.tagName).toBe('INPUT');
      setInputValue(fields.section, '  Rizal  ');
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
        section: 'Rizal',
        student_id: '001234',
      }),
    }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ game_student_id: '001234' }));
  });
});
