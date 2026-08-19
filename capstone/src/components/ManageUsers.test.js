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
  },
  {
    id: 9,
    name: 'Game Student',
    email: 'game-student@example.com',
    role: 'student',
  },
  {
    id: 10,
    name: 'Admin User',
    email: 'admin@gmail.com',
    role: 'admin',
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
    expect(container.querySelector('button[aria-label="Print Manage Users"]')).not.toBeNull();
  });

  test('loads managed accounts with the existing authenticated session header', async () => {
    localStorage.setItem('rememberToken', 'manage-users-token');
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const accountListCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/api/accounts?archived=false'));
    expect(accountListCall).toBeTruthy();
    expect(accountListCall[1].headers.Authorization).toBe('Bearer manage-users-token');
  });

  test('keeps the dashboard shell visible while the managed-user list is loading', async () => {
    let resolveAccounts;
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/accounts')) {
        return new Promise((resolve) => {
          resolveAccounts = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      root.render(<ManageUsers />);
    });

    expect(container.textContent).toContain('Manage Users');
    expect(container.querySelector('[data-testid="dashboard"]')).toBeTruthy();
    expect(container.querySelector('.sts-loader-container')).toBeNull();

    await act(async () => {
      resolveAccounts({ ok: true, json: async () => accountsPayload });
    });
  });

  test('admin can issue a replacement temporary password without receiving it in the UI', async () => {
    localStorage.setItem('rememberToken', 'manage-users-token');
    window.confirm = jest.fn(() => true);
    global.fetch = jest.fn((url, options = {}) => {
      if (String(url).includes('/api/accounts/7/temporary-password')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ emailSent: true, tempPassword: 'must-not-render' }),
        });
      }
      if (String(url).includes('/api/accounts')) {
        return Promise.resolve({ ok: true, json: async () => accountsPayload });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      root.render(<ManageUsers />);
    });
    const resendButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Send Temporary Password'
    );
    await act(async () => {
      resendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const request = global.fetch.mock.calls.find(([url]) => String(url).includes('/api/accounts/7/temporary-password'));
    expect(request[1].method).toBe('POST');
    expect(request[1].headers.Authorization).toBe('Bearer manage-users-token');
    expect(container.textContent).toContain('Temporary Password Issued');
    expect(container.textContent).not.toContain('must-not-render');
  });

  test('uses the compact shared action-button treatment for active users', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const targetRow = Array.from(container.querySelectorAll('tbody tr')).find((row) => row.textContent.includes('Maria Santos'));
    const actions = targetRow.querySelector('.actions-cell');
    const actionButtons = Array.from(actions.querySelectorAll('button'));

    expect(actions.classList.contains('manage-user-actions')).toBe(true);
    expect(actionButtons.map((button) => button.textContent)).toEqual(['Edit', 'Send Temporary Password', 'Delete']);
    actionButtons.forEach((button) => {
      expect(button.classList.contains('manage-user-action-btn')).toBe(true);
    });
  });

  test('uses the compact shared action-button treatment for archived-user restore', async () => {
    const archivedAccount = {
      ...accountsPayload[0],
      id: 77,
      name: 'Archived Teacher',
      email: 'archived.teacher@example.com',
    };
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/accounts?archived=true')) {
        return Promise.resolve({ ok: true, json: async () => [archivedAccount] });
      }
      if (String(url).includes('/api/accounts')) {
        return Promise.resolve({ ok: true, json: async () => accountsPayload });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      root.render(<ManageUsers />);
    });
    const showArchivedButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Show Archived');
    await act(async () => {
      showArchivedButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const archivedRow = Array.from(container.querySelectorAll('tbody tr')).find((row) => row.textContent.includes('Archived Teacher'));
    const actions = archivedRow.querySelector('.actions-cell');
    const restoreButton = Array.from(actions.querySelectorAll('button')).find((button) => button.textContent === 'Restore');

    expect(actions.classList.contains('manage-user-actions')).toBe(true);
    expect(restoreButton.classList.contains('manage-user-action-btn')).toBe(true);
  });

  test('marks long user identity cells for contained ellipsis instead of character wrapping', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const targetRow = Array.from(container.querySelectorAll('tbody tr')).find((row) => row.textContent.includes('Maria Santos'));
    const nameCell = targetRow.querySelector('.user-name-cell');
    const emailCell = targetRow.querySelector('.email-cell');

    expect(nameCell).toBeTruthy();
    expect(nameCell.getAttribute('title')).toBe('Maria Santos');
    expect(emailCell.getAttribute('title')).toBe('maria@gmail.com');
  });

  test('Manage Users shows website accounts and hides Godot student accounts from search and table counts', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    expect(container.textContent).toContain('Users List (3)');
    expect(container.textContent).toContain('Maria Santos');
    expect(container.textContent).toContain('Parent User');
    expect(container.textContent).toContain('Admin User');
    expect(container.textContent).not.toContain('Game Student');

    const searchInput = container.querySelector('input[placeholder="Search users..."]');
    await act(async () => {
      setFieldValue(searchInput, 'student');
    });

    expect(container.textContent).toContain('Users List (0)');
    expect(container.textContent).toContain('No results found for "student"');
    expect(container.textContent).not.toContain('Game Student');
  });

  test('marks the logged-in account and removes clickable row actions for it', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({
      id: 10,
      role: 'admin',
      name: 'Admin User',
      email: 'admin@gmail.com',
    }));

    await act(async () => {
      root.render(<ManageUsers />);
    });

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const currentAccountRow = rows.find((row) => row.textContent.includes('admin@gmail.com'));
    const otherAccountRow = rows.find((row) => row.textContent.includes('maria@gmail.com'));

    expect(currentAccountRow).toBeTruthy();
    expect(currentAccountRow.textContent).toContain('Current Account');
    expect(currentAccountRow.textContent).toContain('Protected');
    expect(currentAccountRow.querySelector('.edit-action-btn')).toBeNull();
    expect(currentAccountRow.querySelector('.delete-action-btn')).toBeNull();
    expect(otherAccountRow.querySelector('.edit-action-btn')).toBeTruthy();
    expect(otherAccountRow.querySelector('.delete-action-btn')).toBeTruthy();
  });

  test('requires a reason and final confirmation before archiving an account', async () => {
    localStorage.setItem('rememberToken', 'manage-users-token');
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const targetRow = Array.from(container.querySelectorAll('tbody tr')).find((row) => row.textContent.includes('Maria Santos'));
    const deleteButton = targetRow.querySelector('.delete-action-btn');
    await act(async () => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Delete Account');
    expect(container.textContent).toContain('Maria Santos');
    expect(container.textContent).toContain('Teacher');
    const continueButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Continue');
    await act(async () => {
      continueButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Reason for deletion is required.');
    expect(global.fetch.mock.calls.some(([url, options]) => String(url).includes('/api/accounts/7') && options?.method === 'DELETE')).toBe(false);

    const reason = container.querySelector('textarea[name="deletion-reason"]');
    await act(async () => {
      setFieldValue(reason, '  Account requested deactivation.  ');
    });
    await act(async () => {
      continueButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Are you sure you want to remove this account?');
    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Yes, Delete Account');
    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const deleteRequest = global.fetch.mock.calls.find(([url, options]) => (
      String(url).includes('/api/accounts/7') && options?.method === 'DELETE'
    ));
    expect(deleteRequest).toBeTruthy();
    expect(deleteRequest[1].headers.Authorization).toBe('Bearer manage-users-token');
    expect(JSON.parse(deleteRequest[1].body)).toEqual({ reason: 'Account requested deactivation.' });
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

  test('Linked Children shows the authoritative Student ID returned by the backend', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/accounts')) {
        return Promise.resolve({ ok: true, json: async () => accountsPayload });
      }
      if (String(url).includes('/api/teacher-student-relationships')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            relationships: [{
              id: 44,
              student_name: 'Child One',
              student_email: 'child@example.com',
              game_student_id: '001234',
            }],
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      root.render(<ManageUsers />);
    });
    const editButtons = Array.from(container.querySelectorAll('button')).filter((button) => button.textContent === 'Edit');
    await act(async () => {
      editButtons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('STUDENT ID');
    expect(container.textContent).toContain('001234');
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

  test('shows inline Philippine mobile and email validation and blocks an invalid Add Account request', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const addButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Add');
    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const email = container.querySelector('input[placeholder="user@gmail.com"]');
    const mobile = container.querySelector('input[placeholder="09123456789"]');
    await act(async () => {
      setFieldValue(email, 'not-an-email');
      email.dispatchEvent(new Event('blur', { bubbles: true }));
      setFieldValue(mobile, '0917-123-4567');
      mobile.dispatchEvent(new Event('blur', { bubbles: true }));
    });

    expect(container.textContent).toContain('Please enter a valid email address.');
    expect(container.textContent).toContain('Mobile number must be in the format 09XXXXXXXXX.');

    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(global.fetch.mock.calls.some(([url, options]) => (
      String(url) === '/api/accounts' && options?.method === 'POST'
    ))).toBe(false);

    await act(async () => {
      setFieldValue(email, 'parent@example.edu');
      setFieldValue(mobile, '09171234567');
    });
    expect(container.textContent).not.toContain('Please enter a valid email address.');
    expect(container.textContent).not.toContain('Mobile number must be in the format 09XXXXXXXXX.');
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
