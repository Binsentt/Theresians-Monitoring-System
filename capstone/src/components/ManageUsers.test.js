import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ManageUsers from './ManageUsers';
import { clearPreparedReport, openPreparedReport } from './PrintReportPortal';

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

const buildManagedAccounts = (count, { archived = false } = {}) => (
  Array.from({ length: count }, (_, index) => ({
    id: 100 + index,
    name: `Managed User ${String(index + 1).padStart(2, '0')}`,
    email: `managed-${index + 1}@example.com`,
    role: index >= count - 2 ? 'parent' : 'teacher',
    status: archived ? 'Archived' : 'Active',
    is_archived: archived,
  }))
);

const setFieldValue = (field, value) => {
  const prototype = field.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
};

const setSelectValue = (field, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(field, value);
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
      if (String(url).includes('/api/accounts/8/children')) {
        return Promise.resolve({ ok: true, json: async () => ({ children: [] }) });
      }
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

      if (String(url).includes('/api/teacher-class-assignments')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ assignments: [] }),
        });
      }

      if (String(url).includes('/api/sections/registry')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ grades: [{ grade_level: 'Grade 1', sections: ['Amethyst', 'Amber'] }] }),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  });

  afterEach(() => {
    act(() => clearPreparedReport());
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
  });

  test('renders eight-row pagination controls before the actual users table and navigates records', async () => {
    const managedAccounts = buildManagedAccounts(11);
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => managedAccounts }));

    await act(async () => root.render(<ManageUsers />));

    const pagination = container.querySelector('.manage-users-pagination');
    const tableContainer = container.querySelector('.table-container');
    expect(pagination).not.toBeNull();
    expect(container.textContent).toContain('Page 1 of 2');
    expect(container.querySelectorAll('.sts-data-table tbody tr')).toHaveLength(8);
    expect(Array.from(container.querySelectorAll('.manage-users-pagination, .table-container'))[0]).toBe(pagination);

    const next = Array.from(pagination.querySelectorAll('button')).find((button) => button.textContent === 'Next');
    await act(async () => next.click());

    expect(container.textContent).toContain('Page 2 of 2');
    expect(container.querySelectorAll('.sts-data-table tbody tr')).toHaveLength(3);
    expect(tableContainer.textContent).toContain('Managed User 09');
    expect(tableContainer.textContent).not.toContain('Managed User 01');
  });

  test('search and role filters run before paging and reset the rendered table to page one', async () => {
    const managedAccounts = buildManagedAccounts(11);
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => managedAccounts }));
    await act(async () => root.render(<ManageUsers />));

    const next = () => Array.from(container.querySelectorAll('.manage-users-pagination button'))
      .find((button) => button.textContent === 'Next');
    await act(async () => next().click());

    const search = container.querySelector('input[placeholder="Search users..."]');
    await act(async () => setFieldValue(search, 'Managed User 01'));
    expect(container.textContent).toContain('Users List (1)');
    expect(container.querySelectorAll('.sts-data-table tbody tr')).toHaveLength(1);
    expect(container.textContent).toContain('Managed User 01');

    await act(async () => setFieldValue(search, ''));
    expect(container.textContent).toContain('Page 1 of 2');
    expect(container.querySelector('.table-container').textContent).toContain('Managed User 01');
    expect(container.querySelector('.table-container').textContent).not.toContain('Managed User 09');

    await act(async () => next().click());
    const role = container.querySelector('.controls-wrapper select');
    await act(async () => setSelectValue(role, 'Parent'));
    expect(container.textContent).toContain('Users List (2)');
    expect(container.querySelectorAll('.sts-data-table tbody tr')).toHaveLength(2);

    await act(async () => setSelectValue(role, 'All'));
    expect(container.textContent).toContain('Page 1 of 2');
    expect(container.querySelector('.table-container').textContent).toContain('Managed User 01');
  });

  test('archiving the sole record on the last page clamps the rendered table to the previous page', async () => {
    let managedAccounts = buildManagedAccounts(17);
    global.fetch = jest.fn((url, options = {}) => {
      if (options.method === 'DELETE') {
        const deletedId = Number(String(url).match(/\/api\/accounts\/(\d+)/)?.[1]);
        managedAccounts = managedAccounts.filter((account) => account.id !== deletedId);
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => managedAccounts });
    });
    await act(async () => root.render(<ManageUsers />));

    const clickNext = async () => {
      const next = Array.from(container.querySelectorAll('.manage-users-pagination button'))
        .find((button) => button.textContent === 'Next');
      await act(async () => next.click());
    };
    await clickNext();
    await clickNext();
    expect(container.textContent).toContain('Page 3 of 3');

    const lastPageRow = container.querySelector('.sts-data-table tbody tr');
    await act(async () => lastPageRow.querySelector('.delete-action-btn').click());
    await act(async () => setFieldValue(document.body.querySelector('textarea[name="deletion-reason"]'), 'Pagination lifecycle check'));
    await act(async () => Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Continue').click());
    await act(async () => Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Yes, Delete Account').click());

    expect(container.textContent).toContain('Page 2 of 2');
    expect(container.querySelectorAll('.sts-data-table tbody tr')).toHaveLength(8);
    expect(container.querySelector('.table-container').textContent).toContain('Managed User 09');
    expect(container.querySelector('.table-container').textContent).not.toContain('Managed User 17');
  });

  test('restoring the sole archived record on the last page also clamps to the previous page', async () => {
    let archivedAccounts = buildManagedAccounts(17, { archived: true });
    global.fetch = jest.fn((url, options = {}) => {
      if (options.method === 'POST' && String(url).includes('/restore')) {
        const restoredId = Number(String(url).match(/\/api\/accounts\/(\d+)/)?.[1]);
        archivedAccounts = archivedAccounts.filter((account) => account.id !== restoredId);
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }
      const rows = String(url).includes('archived=true') ? archivedAccounts : [];
      return Promise.resolve({ ok: true, json: async () => rows });
    });
    await act(async () => root.render(<ManageUsers />));
    await act(async () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Show Archived').click());

    const clickNext = async () => {
      const next = Array.from(container.querySelectorAll('.manage-users-pagination button'))
        .find((button) => button.textContent === 'Next');
      await act(async () => next.click());
    };
    await clickNext();
    await clickNext();
    expect(container.textContent).toContain('Page 3 of 3');

    await act(async () => container.querySelector('.sts-data-table tbody tr .restore-action-btn').click());
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain('Page 2 of 2');
    expect(container.querySelectorAll('.sts-data-table tbody tr')).toHaveLength(8);
    expect(container.querySelector('.table-container').textContent).not.toContain('Managed User 17');
  });

  test('opens the edit modal with the selected user data when Edit is clicked', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const editButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Edit'
    );

    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Edit User');
    expect(document.body.querySelector('input[value="Maria"]')).toBeTruthy();
    expect(document.body.querySelector('input[value="maria@gmail.com"]')).toBeTruthy();
  });

  test.each(['Edit', 'Delete'])('%s dialog escapes a transformed scrolled page and restores keyboard focus', async (label) => {
    container.style.transform = 'translateY(0)';
    container.classList.add('page-content');
    container.scrollTop = 798;
    await act(async () => root.render(<ManageUsers />));
    const trigger = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === label);
    trigger.focus();
    await act(async () => trigger.click());
    const overlay = document.body.querySelector('.modal-overlay');
    expect(overlay.parentElement).toBe(document.body);
    const dialog = overlay.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(container.classList.contains('modal-scroll-locked')).toBe(true);
    await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('.modal-overlay')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(container.scrollTop).toBe(798);
    expect(container.classList.contains('modal-scroll-locked')).toBe(false);
  });

  test('shows generated Parent ID in the users table for parent accounts', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    expect(document.body.textContent).toContain('PARENT ID');
    expect(document.body.textContent).toContain('482915');
    expect(document.body.querySelector('button[aria-label="Print User List"]')).not.toBeNull();
    let opened = false;
    act(() => { opened = openPreparedReport(); });
    expect(opened).toBe(true);
    const report = document.querySelector('#print-report-root .printable-table-report');
    expect(report.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(Array.from(report.querySelectorAll('th')).map((header) => header.textContent)).toEqual([
      'User Name', 'Email', 'Role', 'Account Status',
    ]);
    expect(report.textContent).not.toContain('Parent ID');
    expect(report.textContent).not.toContain('Mobile Number');
    expect(report.textContent).not.toContain('Birthday');
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

    expect(document.body.textContent).toContain('Manage Users');
    expect(document.body.querySelector('[data-testid="dashboard"]')).toBeTruthy();
    expect(document.body.querySelector('.sts-loader-container')).toBeNull();

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
    const resendButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Send Temporary Password'
    );
    await act(async () => {
      resendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const request = global.fetch.mock.calls.find(([url]) => String(url).includes('/api/accounts/7/temporary-password'));
    expect(request[1].method).toBe('POST');
    expect(request[1].headers.Authorization).toBe('Bearer manage-users-token');
    expect(document.body.textContent).toContain('Temporary Password Issued');
    expect(document.body.textContent).not.toContain('must-not-render');
  });

  test('uses the compact shared action-button treatment for active users', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const targetRow = Array.from(document.body.querySelectorAll('tbody tr')).find((row) => row.textContent.includes('Maria Santos'));
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
    const showArchivedButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Show Archived');
    await act(async () => {
      showArchivedButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const archivedRow = Array.from(document.body.querySelectorAll('tbody tr')).find((row) => row.textContent.includes('Archived Teacher'));
    const actions = archivedRow.querySelector('.actions-cell');
    const restoreButton = Array.from(actions.querySelectorAll('button')).find((button) => button.textContent === 'Restore');

    expect(actions.classList.contains('manage-user-actions')).toBe(true);
    expect(restoreButton.classList.contains('manage-user-action-btn')).toBe(true);
  });

  test('requires typed DELETE before permanently deleting an archived account', async () => {
    const archivedAccount = {
      ...accountsPayload[1],
      id: 77,
      name: 'Archived Parent',
      email: 'archived.parent@example.com',
    };
    global.fetch = jest.fn((url, options = {}) => {
      if (String(url).includes('/api/accounts?archived=true')) {
        return Promise.resolve({ ok: true, json: async () => [archivedAccount] });
      }
      if (String(url).includes('/api/accounts/77?permanent=true') && options.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, message: 'Account permanently deleted' }) });
      }
      if (String(url).includes('/api/accounts')) return Promise.resolve({ ok: true, json: async () => accountsPayload });
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      root.render(<ManageUsers />);
    });
    await act(async () => {
      Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Show Archived')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const permanentDelete = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Delete Permanently'
    );
    expect(permanentDelete).toBeTruthy();

    await act(async () => {
      permanentDelete.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('This action is irreversible.');
    expect(document.body.textContent).toContain('all exclusively owned child Student accounts');

    await act(async () => {
      setFieldValue(document.body.querySelector('textarea[name="deletion-reason"]'), 'Duplicate account cleanup.');
    });
    await act(async () => {
      Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Continue')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const typedConfirmation = document.body.querySelector('input[name="permanent-delete-confirmation"]');
    expect(typedConfirmation).toBeTruthy();
    const permanentConfirm = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Permanently Delete Account'
    );
    expect(permanentConfirm.disabled).toBe(true);

    await act(async () => {
      setFieldValue(typedConfirmation, 'DELETE');
    });
    expect(permanentConfirm.disabled).toBe(false);
    await act(async () => {
      permanentConfirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const permanentRequest = global.fetch.mock.calls.filter(([url, options]) => (
      String(url).includes('/api/accounts/77?permanent=true') && options?.method === 'DELETE'
    ));
    expect(permanentRequest).toHaveLength(1);
    expect(JSON.parse(permanentRequest[0][1].body)).toEqual({
      reason: 'Duplicate account cleanup.',
      permanent_confirmation: 'DELETE',
    });
  });

  test('marks long user identity cells for contained ellipsis instead of character wrapping', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const targetRow = Array.from(document.body.querySelectorAll('tbody tr')).find((row) => row.textContent.includes('Maria Santos'));
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

    expect(document.body.textContent).toContain('Users List (3)');
    expect(document.body.textContent).toContain('Maria Santos');
    expect(document.body.textContent).toContain('Parent User');
    expect(document.body.textContent).toContain('Admin User');
    expect(document.body.textContent).not.toContain('Game Student');

    const searchInput = document.body.querySelector('input[placeholder="Search users..."]');
    await act(async () => {
      setFieldValue(searchInput, 'student');
    });

    expect(document.body.textContent).toContain('Users List (0)');
    expect(document.body.textContent).toContain('No results found for "student"');
    expect(document.body.textContent).not.toContain('Game Student');
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

    const rows = Array.from(document.body.querySelectorAll('tbody tr'));
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

    const targetRow = Array.from(document.body.querySelectorAll('tbody tr')).find((row) => row.textContent.includes('Maria Santos'));
    const deleteButton = targetRow.querySelector('.delete-action-btn');
    await act(async () => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Delete Account');
    expect(document.body.textContent).toContain('can be restored');
    expect(document.body.textContent).toContain('Maria Santos');
    expect(document.body.textContent).toContain('Teacher');
    const continueButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Continue');
    await act(async () => {
      continueButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('Reason for archiving is required.');
    expect(global.fetch.mock.calls.some(([url, options]) => String(url).includes('/api/accounts/7') && options?.method === 'DELETE')).toBe(false);

    const reason = document.body.querySelector('textarea[name="deletion-reason"]');
    await act(async () => {
      setFieldValue(reason, '  Account requested deactivation.  ');
    });
    await act(async () => {
      continueButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('This removes the account from active users. It can be restored later.');
    const confirmButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Yes, Delete Account');
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
    localStorage.setItem('rememberToken', 'manage-users-token');

    await act(async () => {
      root.render(<ManageUsers />);
    });

    const editButtons = Array.from(document.body.querySelectorAll('button')).filter(
      (button) => button.textContent === 'Edit'
    );

    await act(async () => {
      editButtons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Children (0)');
    expect(document.body.textContent).toContain('Add Child');
    expect(document.body.textContent).toContain('Parent ID');
    expect(global.fetch).toHaveBeenCalledWith('/api/accounts/8/children', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer manage-users-token' }),
    }));
  });

  test('Admin can review a Teacher class assignment separately from individual student exceptions', async () => {
    localStorage.setItem('rememberToken', 'manage-users-token');
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/accounts')) {
        return Promise.resolve({ ok: true, json: async () => accountsPayload });
      }
      if (String(url).includes('/api/teacher-class-assignments')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            assignments: [{ id: 71, grade_level: 'Grade 3', section: 'Rizal', section_key: 'rizal' }],
          }),
        });
      }
      if (String(url).includes('/api/teacher-student-relationships')) {
        return Promise.resolve({ ok: true, json: async () => ({ relationships: [] }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      root.render(<ManageUsers />);
    });
    const editButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Edit');
    await act(async () => {
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Class Assignments');
    expect(document.body.textContent).toContain('Grade 3');
    expect(document.body.textContent).toContain('Rizal');
    expect(document.body.textContent).toContain('Individual Student Exceptions');
    expect(global.fetch).toHaveBeenCalledWith('/api/teacher-class-assignments?teacherId=7', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer manage-users-token' }),
    }));
  });

  test('Admin keeps Parent/Teacher class assignments, teacher exceptions, and linked children distinct', async () => {
    const parentTeacher = {
      id: 11,
      name: 'Parent Teacher User',
      email: 'parent-teacher@example.com',
      role: 'parent_teacher',
      employee_id: 'EMP-11',
      parent_id: '482916',
    };
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/accounts/11/children')) {
        return Promise.resolve({ ok: true, json: async () => ({ children: [{
          student_id: 52,
          student_name: 'Linked Child',
          game_student_id: '001102',
          grade_level: 'Grade 1',
          section: 'Amethyst',
        }] }) });
      }
      if (String(url).includes('/api/accounts')) {
        return Promise.resolve({ ok: true, json: async () => [...accountsPayload, parentTeacher] });
      }
      if (String(url).includes('/api/teacher-class-assignments')) {
        return Promise.resolve({ ok: true, json: async () => ({ assignments: [] }) });
      }
      if (String(url).includes('/api/teacher-student-relationships')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            relationships: [
              { id: 51, relationship_type: 'teacher', student_name: 'Assigned Exception', game_student_id: '001101' },
              { id: 52, relationship_type: 'parent', student_name: 'Linked Child', game_student_id: '001102' },
            ],
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      root.render(<ManageUsers />);
    });
    const parentTeacherRow = Array.from(document.body.querySelectorAll('tr')).find((row) => row.textContent.includes('Parent Teacher User'));
    const editButton = Array.from(parentTeacherRow.querySelectorAll('button')).find((button) => button.textContent === 'Edit');
    await act(async () => {
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Class Assignments');
    expect(document.body.textContent).toContain('Individual Student Exceptions');
    expect(document.body.textContent).toContain('Assigned Exception');
    expect(document.body.textContent).toContain('Children (1)');
    expect(document.body.textContent).toContain('Linked Child');
  });

  test('Linked Children shows the authoritative Student ID returned by the backend', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/accounts/8/children')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ children: [{
            student_id: 44,
            student_name: 'Child One',
            game_student_id: '001234',
            grade_level: 'Grade 1',
            section: 'Amethyst',
          }] }),
        });
      }
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
              relationship_type: 'parent',
            }],
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      root.render(<ManageUsers />);
    });
    const editButtons = Array.from(document.body.querySelectorAll('button')).filter((button) => button.textContent === 'Edit');
    await act(async () => {
      editButtons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('STUDENT ID');
    expect(document.body.textContent).toContain('001234');
  });

  test('Add User form uses system-generated credentials without manual password input', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const addButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add'
    );

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('A strong temporary password will be generated and emailed automatically.');
    expect(document.body.querySelector('input[type="password"]')).toBeNull();
  });

  test('Admin creates a Parent with multiple create/link child rows in one account request', async () => {
    let submittedPayload = null;
    global.fetch = jest.fn((url, options = {}) => {
      if (String(url) === '/api/sections/registry') {
        return Promise.resolve({ ok: true, json: async () => ({ grades: [{ grade_level: 'Grade 1', sections: ['Amethyst', 'Amber'] }] }) });
      }
      if (String(url) === '/api/accounts' && options.method === 'POST') {
        submittedPayload = JSON.parse(options.body);
        return Promise.resolve({
          ok: true,
          json: async () => ({ user: { id: 88, role: 'parent', parent_id: '482915' }, children: [] }),
        });
      }
      if (String(url).includes('/api/accounts')) return Promise.resolve({ ok: true, json: async () => accountsPayload });
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => root.render(<ManageUsers />));
    await act(async () => Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Add').click());

    expect(document.body.textContent).toContain('Child 1');
    await act(async () => document.body.querySelector('button[data-action="add-child"]').click());
    expect(document.body.textContent).toContain('Child 2');

    await act(async () => {
      setFieldValue(document.body.querySelector('input[placeholder="John"]'), 'Paula');
      setFieldValue(document.body.querySelector('input[placeholder="Doe"]'), 'Parent');
      setFieldValue(document.body.querySelector('input[placeholder="user@gmail.com"]'), 'paula@example.edu');
      setFieldValue(document.body.querySelector('input[aria-label="Child 1 first name"]'), 'Ava');
      setFieldValue(document.body.querySelector('input[aria-label="Child 1 last name"]'), 'Santos');
      setSelectValue(document.body.querySelector('select[aria-label="Child 1 grade"]'), 'Grade 1');
    });
    await act(async () => {
      setSelectValue(document.body.querySelector('select[aria-label="Child 1 section"]'), 'Amethyst');
      setFieldValue(document.body.querySelector('input[aria-label="Child 1 Student ID"]'), '00123456');
      setSelectValue(document.body.querySelector('select[aria-label="Child 2 account action"]'), 'link');
    });
    await act(async () => setFieldValue(document.body.querySelector('input[aria-label="Child 2 Student ID"]'), '654321'));
    await act(async () => document.body.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(submittedPayload.children).toEqual([
      {
        operation: 'create', student_id: '00123456', first_name: 'Ava', middle_initial: '',
        last_name: 'Santos', grade_level: 'Grade 1', section: 'Amethyst',
      },
      { operation: 'link', student_id: '654321' },
    ]);
  });

  test('Add User form does not require birthday or gender for admin-created parent accounts', async () => {
    global.fetch = jest.fn((url, options = {}) => {
      if (String(url).includes('/api/sections/registry')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ grades: [{ grade_level: 'Grade 1', sections: ['Amethyst', 'Amber'] }] }),
        });
      }
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

    const addButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add'
    );

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const form = document.body.querySelector('form');
    const inputs = form.querySelectorAll('input');
    await act(async () => {
      setFieldValue(inputs[0], 'Paula');
      setFieldValue(inputs[2], 'Parent');
      setFieldValue(inputs[3], 'paula@gmail.com');
      setFieldValue(document.body.querySelector('input[aria-label="Child 1 first name"]'), 'Ava');
      setFieldValue(document.body.querySelector('input[aria-label="Child 1 last name"]'), 'Santos');
      setSelectValue(document.body.querySelector('select[aria-label="Child 1 grade"]'), 'Grade 1');
    });
    await act(async () => {
      setSelectValue(document.body.querySelector('select[aria-label="Child 1 section"]'), 'Amethyst');
      setFieldValue(document.body.querySelector('input[aria-label="Child 1 Student ID"]'), '00123456');
    });

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/accounts',
      expect.objectContaining({ method: 'POST' })
    );
    expect(document.body.textContent).not.toContain('Please fill in all required fields (First Name, Last Name, Email, Gender)');
  });

  test('shows inline Philippine mobile and email validation and blocks an invalid Add Account request', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const addButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Add');
    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const email = document.body.querySelector('input[placeholder="user@gmail.com"]');
    const mobile = document.body.querySelector('input[placeholder="09123456789"]');
    await act(async () => {
      setFieldValue(email, 'not-an-email');
      email.dispatchEvent(new Event('blur', { bubbles: true }));
      setFieldValue(mobile, '0917-123-4567');
      mobile.dispatchEvent(new Event('blur', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Please enter a valid email address.');
    expect(document.body.textContent).toContain('Mobile number must be in the format 09XXXXXXXXX.');

    await act(async () => {
      document.body.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(global.fetch.mock.calls.some(([url, options]) => (
      String(url) === '/api/accounts' && options?.method === 'POST'
    ))).toBe(false);

    await act(async () => {
      setFieldValue(email, 'parent@example.edu');
      setFieldValue(mobile, '09171234567');
    });
    expect(document.body.textContent).not.toContain('Please enter a valid email address.');
    expect(document.body.textContent).not.toContain('Mobile number must be in the format 09XXXXXXXXX.');
  });

  test('uses a numeric mobile-friendly input for new accounts', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const addButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Add');
    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const mobile = document.body.querySelector('input[placeholder="09123456789"]');
    expect(mobile.type).toBe('tel');
    expect(mobile.inputMode).toBe('numeric');
    expect(mobile.maxLength).toBe(11);
  });

  test('allows an unrelated edit with an unchanged legacy mobile number and keeps it in the request', async () => {
    const originalMobile = accountsPayload[0].mobile_number;
    accountsPayload[0].mobile_number = '0917-123-4567';

    try {
      await act(async () => {
        root.render(<ManageUsers />);
      });

      const editButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Edit');
      await act(async () => {
        editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const mobile = document.body.querySelector('input[value="0917-123-4567"]');
      expect(mobile.type).toBe('tel');
      expect(mobile.inputMode).toBe('numeric');
      expect(mobile.maxLength).toBe(11);

      await act(async () => {
        setFieldValue(document.body.querySelector('input[value="Maria"]'), 'Marian');
      });
      const updateButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Update User');
      await act(async () => {
        updateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const updateRequest = global.fetch.mock.calls.find(([url, options]) => (
        String(url) === '/api/accounts/7' && options?.method === 'PUT'
      ));
      expect(updateRequest).toBeTruthy();
      expect(JSON.parse(updateRequest[1].body).mobile_number).toBe('0917-123-4567');
    } finally {
      accountsPayload[0].mobile_number = originalMobile;
    }
  });

  test('Teacher Employee ID input strips non-digits and stops at 10 digits', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const addButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add'
    );

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const roleSelect = document.body.querySelector('.role-selector select');
    await act(async () => {
      roleSelect.value = 'Teacher';
      roleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const employeeInput = Array.from(document.body.querySelectorAll('input')).find(
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

    const addButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add'
    );

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Street');
    expect(document.body.textContent).toContain('City');
    expect(document.body.textContent).toContain('Province');
    expect(document.body.querySelector('input[placeholder="Enter address"]')).toBeNull();
  });

  test('Edit User form splits a stored address into street, city, and province inputs', async () => {
    accountsPayload[0].address = 'T. Alonzo St, Manila, Metro Manila';

    await act(async () => {
      root.render(<ManageUsers />);
    });

    const editButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Edit'
    );

    await act(async () => {
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.querySelector('input[value="T. Alonzo St"]')).toBeTruthy();
    expect(document.body.querySelector('input[value="Manila"]')).toBeTruthy();
    expect(document.body.querySelector('input[value="Metro Manila"]')).toBeTruthy();
  });

  test('submits updates for the selected user through the existing save flow', async () => {
    await act(async () => {
      root.render(<ManageUsers />);
    });

    const editButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Edit'
    );

    await act(async () => {
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const firstNameInput = document.body.querySelector('input[value="Maria"]');

    await act(async () => {
      firstNameInput.value = 'Marian';
      firstNameInput.dispatchEvent(new Event('input', { bubbles: true }));
      firstNameInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const updateButton = Array.from(document.body.querySelectorAll('button')).find(
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
