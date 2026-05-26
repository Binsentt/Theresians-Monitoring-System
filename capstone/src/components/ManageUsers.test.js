import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ManageUsers from './ManageUsers';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ main }) => <div data-testid="dashboard">{main}</div>,
  MainContent: ({ children }) => <div>{children}</div>,
  TopBar: ({ children }) => <div>{children}</div>,
  PageContent: ({ children }) => <div>{children}</div>,
  ContentSection: ({ children, actions, title }) => (
    <div>
      {title ? <h2>{title}</h2> : null}
      {actions}
      {children}
    </div>
  ),
}));

jest.mock('./layout/AnalyticsSidebar', () => () => <div data-testid="sidebar">Sidebar</div>);
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

const accountsPayload = [
  {
    id: 7,
    name: 'Maria Santos',
    email: 'maria@gmail.com',
    role: 'teacher',
    mobile_number: '09123456789',
    birthday: '1990-01-15T00:00:00.000Z',
    gender: 'Female',
    employee_id: 'EMP-7',
    address: 'Main Street',
  },
  {
    id: 8,
    name: 'Parent User',
    email: 'parent@gmail.com',
    role: 'parent',
    mobile_number: '09987654321',
    birthday: '1988-02-10T00:00:00.000Z',
    gender: 'Female',
    address: 'Parent Street',
    parent_id: '482915',
  }
];

const setFieldValue = (field, value) => {
  const prototype = field.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('ManageUsers edit flow', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 1, role: 'admin', name: 'Admin User' }));
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/accounts')) {
        return Promise.resolve({
          ok: true,
          json: async () => accountsPayload,
        });
      }

      if (String(url).includes('/api/teacher-student-relationships')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ relationships: [] }),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
  });

  test('opens the edit modal with the selected user data when Edit is clicked', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const editButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Edit'
    );

    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Edit User');
    expect(container.querySelector('input[value="Maria"]')).toBeTruthy();
    expect(container.querySelector('input[value="maria@gmail.com"]')).toBeTruthy();
  });

  test('shows generated Parent ID in the users table for parent accounts', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    expect(container.textContent).toContain('PARENT ID');
    expect(container.textContent).toContain('482915');
  });

  test('Edit Parent form exposes linked children management', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const editButtons = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent === 'Edit'
    );

    await act(async () => {
      editButtons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Linked Children');
    expect(container.textContent).toContain('Student Email');
    expect(container.textContent).toContain('Parent ID');
    expect(global.fetch).toHaveBeenCalledWith('/api/teacher-student-relationships?teacherId=8');
  });

  test('Add User form uses system-generated credentials without manual password input', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const addButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add'
    );

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('A strong temporary password will be generated and emailed automatically.');
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  test('Add User form does not require birthday or gender for admin-created parent accounts', async () => {
    global.fetch = jest.fn((url, options = {}) => {
      if (String(url).includes('/api/accounts') && options.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            user: { id: 88, name: 'Paula Parent', email: 'paula@gmail.com', role: 'parent', parent_id: '482915' },
            emailSent: true,
          }),
        });
      }
      if (String(url).includes('/api/accounts')) {
        return Promise.resolve({
          ok: true,
          json: async () => accountsPayload,
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      root.render(<ManageUsers />);
    });

    const addButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add'
    );

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const form = container.querySelector('form');
    const inputs = form.querySelectorAll('input');
    await act(async () => {
      setFieldValue(inputs[0], 'Paula');
      setFieldValue(inputs[2], 'Parent');
      setFieldValue(inputs[3], 'paula@gmail.com');
    });

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/accounts',
      expect.objectContaining({ method: 'POST' })
    );
    expect(container.textContent).not.toContain('Please fill in all required fields (First Name, Last Name, Email, Gender)');
  });

  test('Teacher Employee ID input strips non-digits and stops at 10 digits', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const addButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add'
    );

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const roleSelect = container.querySelector('.role-selector select');
    await act(async () => {
      roleSelect.value = 'Teacher';
      roleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const employeeInput = Array.from(container.querySelectorAll('input')).find(
      (input) => input.placeholder === '1234567890'
    );

    await act(async () => {
      setFieldValue(employeeInput, 'EMP-123456789012');
    });

    expect(employeeInput.value).toBe('1234567890');
    expect(employeeInput.maxLength).toBe(10);
  });

  test('Add User form exposes split address fields for new accounts', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const addButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add'
    );

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Street');
    expect(container.textContent).toContain('City');
    expect(container.textContent).toContain('Province');
    expect(container.querySelector('input[placeholder="Enter address"]')).toBeNull();
  });

  test('Edit User form splits a stored address into street, city, and province inputs', async () => {
    accountsPayload[0].address = 'T. Alonzo St, Manila, Metro Manila';

    await act(async () => {
      root.render(<ManageUsers />);
    });

    const editButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Edit'
    );

    await act(async () => {
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('input[value="T. Alonzo St"]')).toBeTruthy();
    expect(container.querySelector('input[value="Manila"]')).toBeTruthy();
    expect(container.querySelector('input[value="Metro Manila"]')).toBeTruthy();
  });

  test('submits updates for the selected user through the existing save flow', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const editButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Edit'
    );

    await act(async () => {
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const firstNameInput = container.querySelector('input[value="Maria"]');

    await act(async () => {
      firstNameInput.value = 'Marian';
      firstNameInput.dispatchEvent(new Event('input', { bubbles: true }));
      firstNameInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const updateButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Update User'
    );

    await act(async () => {
      updateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/accounts/7',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });
});
