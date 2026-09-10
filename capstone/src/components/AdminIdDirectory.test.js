import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AdminIdDirectory from './AdminIdDirectory';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('./layout/AppLayout', () => ({
  DashboardContainer: ({ main }) => <div data-testid="dashboard">{main}</div>,
  MainContent: ({ children }) => <main>{children}</main>,
  TopBar: ({ children }) => <header>{children}</header>,
  PageContent: ({ children }) => <div>{children}</div>,
  ContentSection: ({ children, title, actions }) => (
    <section>
      <h2>{title}</h2>
      {actions}
      {children}
    </section>
  ),
}));

jest.mock('./layout/AnalyticsSidebar', () => ({ activeItem }) => <div data-testid="sidebar">{activeItem}</div>);
jest.mock('./layout/DashboardLoadingShell', () => () => <div>Loading...</div>);
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

const directoryPayload = {
  students: [{
    id: 20,
    student_id: '00123456',
    student_name: 'Ana Santos',
    grade_level: 'Grade 4',
    section: 'St. Anne',
    parent_name: 'Paula Santos',
    parent_relationship: 'Parent',
    status: 'Active',
    is_archived: false,
    created_at: '2025-01-02T00:00:00.000Z',
  }],
  teachers: [{
    id: 21,
    teacher_id: 'T-1001',
    teacher_name: 'Maria Cruz',
    email: 'maria@example.com',
    role: 'parent_teacher',
    status: 'Offline',
    is_archived: false,
    created_at: '2025-01-03T00:00:00.000Z',
  }],
};

const setInputValue = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('Admin ID Directory', () => {
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
    localStorage.setItem('rememberToken', 'admin-token');
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => directoryPayload,
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete global.fetch;
  });

  test('loads authoritative Student and Teacher rows with the admin-only endpoint', async () => {
    await act(async () => root.render(<AdminIdDirectory />));

    expect(global.fetch.mock.calls[0][0]).toContain('/api/admin/id-directory?archived=false');
    expect(container.textContent).toContain('00123456');
    expect(container.textContent).toContain('Paula Santos (Parent)');
    expect(container.querySelector('table[aria-label="Student ID Directory"]')).not.toBeNull();
    expect(container.querySelector('table[aria-label="Teacher ID Directory"]')).toBeNull();

    const teacherTab = Array.from(container.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent === 'Teachers');
    await act(async () => teacherTab.click());

    expect(container.textContent).toContain('T-1001');
    expect(container.textContent).toContain('Parent/Teacher');
    expect(container.querySelector('table[aria-label="Teacher ID Directory"]')).not.toBeNull();
  });

  test('filters rows immediately without changing the source records', async () => {
    await act(async () => root.render(<AdminIdDirectory />));
    const idFilter = container.querySelector('[aria-label="Search Student ID Directory"]');

    await act(async () => setInputValue(idFilter, 'not-found'));

    expect(container.textContent).toContain('No student IDs match the current filters.');
  });

  test('uses one visible search field and always shows truthful disabled pagination for one page', async () => {
    await act(async () => root.render(<AdminIdDirectory />));

    expect(container.querySelectorAll('[aria-label="Student ID Directory controls"] input[type="search"]')).toHaveLength(1);
    expect(container.textContent).toContain('Showing 1 - 1 of 1');
    expect(container.textContent).toContain('Page 1 of 1');
    const controls = container.querySelector('.id-directory-pagination');
    expect(Array.from(controls.querySelectorAll('button')).every((button) => button.disabled)).toBe(true);
  });

  test('filters before paging, resets page on filters, and keeps truthful per-tab counts with pagination below the table', async () => {
    const students = Array.from({ length: 12 }, (_, index) => ({
      ...directoryPayload.students[0],
      id: 100 + index,
      student_id: `001234${String(index).padStart(2, '0')}`,
      student_name: index === 11 ? 'Unique Last Student' : `Student ${index + 1}`,
    }));
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...directoryPayload, students }) });
    await act(async () => root.render(<AdminIdDirectory />));

    expect(container.textContent).toContain('Students (12)');
    expect(container.textContent).toContain('Page 1 of 2');
    expect(container.querySelectorAll('table[aria-label="Student ID Directory"] tbody tr')).toHaveLength(10);
    const pagination = container.querySelector('.id-directory-pagination');
    expect(Array.from(container.querySelectorAll('.id-directory-pagination, .id-directory-table-wrap'))[0]).toBe(container.querySelector('.id-directory-table-wrap'));
    expect(Array.from(container.querySelectorAll('.id-directory-pagination, .id-directory-table-wrap')).at(-1)).toBe(pagination);
    const next = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Next');
    await act(async () => next.click());
    expect(container.textContent).toContain('Page 2 of 2');
    expect(container.querySelectorAll('table[aria-label="Student ID Directory"] tbody tr')).toHaveLength(2);

    const nameFilter = container.querySelector('[aria-label="Search Student ID Directory"]');
    await act(async () => setInputValue(nameFilter, 'Unique Last Student'));
    expect(container.textContent).toContain('Students (1)');
    expect(container.textContent).toContain('Page 1 of 1');
    expect(container.textContent).toContain('Unique Last Student');
  });

  test('prints all 17 filtered Student rows while the live page remains limited to 10', async () => {
    const students = Array.from({ length: 17 }, (_, index) => ({
      ...directoryPayload.students[0],
      id: 600 + index,
      student_id: `0001${String(index).padStart(4, '0')}`,
      student_name: `Printable Student ${index + 1}`,
      grade_level: 'Grade 4',
    }));
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...directoryPayload, students }) });
    const printSpy = jest.spyOn(window, 'print').mockImplementation(() => {});

    await act(async () => root.render(<AdminIdDirectory />));
    const search = container.querySelector('[aria-label="Search Student ID Directory"]');
    await act(async () => setInputValue(search, 'Grade 4'));

    expect(container.querySelectorAll('table[aria-label="Student ID Directory"] tbody tr')).toHaveLength(10);
    await act(async () => container.querySelector('button[aria-label="Print Student Directory"]').click());

    const report = document.querySelector('#print-report-root .printable-table-report');
    expect(report.querySelectorAll('tbody tr')).toHaveLength(17);
    expect(report.textContent).toContain('Records: 17');

    act(() => window.dispatchEvent(new Event('afterprint')));
    printSpy.mockRestore();
  });

  test('renders independent Teacher pagination below the table and resets filtered results to page one', async () => {
    const teachers = Array.from({ length: 12 }, (_, index) => ({
      ...directoryPayload.teachers[0],
      id: 200 + index,
      teacher_id: `T-${String(2000 + index)}`,
      teacher_name: index === 11 ? 'Unique Last Teacher' : `Teacher ${index + 1}`,
      email: index === 11 ? 'unique-last@example.com' : `teacher-${index + 1}@example.com`,
    }));
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...directoryPayload, teachers }) });
    await act(async () => root.render(<AdminIdDirectory />));

    const teacherTab = Array.from(container.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent === 'Teachers');
    await act(async () => teacherTab.click());

    const pagination = container.querySelector('.id-directory-pagination');
    expect(container.textContent).toContain('Teachers (12)');
    expect(container.textContent).toContain('Page 1 of 2');
    expect(container.querySelectorAll('table[aria-label="Teacher ID Directory"] tbody tr')).toHaveLength(10);
    expect(Array.from(container.querySelectorAll('.id-directory-pagination, .id-directory-table-wrap'))[0]).toBe(container.querySelector('.id-directory-table-wrap'));
    expect(Array.from(container.querySelectorAll('.id-directory-pagination, .id-directory-table-wrap')).at(-1)).toBe(pagination);

    const next = Array.from(pagination.querySelectorAll('button')).find((button) => button.textContent === 'Next');
    await act(async () => next.click());
    expect(container.textContent).toContain('Page 2 of 2');
    expect(container.querySelectorAll('table[aria-label="Teacher ID Directory"] tbody tr')).toHaveLength(2);

    const emailFilter = container.querySelector('[aria-label="Search Teacher ID Directory"]');
    await act(async () => setInputValue(emailFilter, 'unique-last@example.com'));
    expect(container.textContent).toContain('Teachers (1)');
    expect(container.textContent).toContain('Page 1 of 1');
    expect(container.textContent).toContain('Unique Last Teacher');
  });

  test('switching tabs resets both independent directory pages to page one', async () => {
    const students = Array.from({ length: 12 }, (_, index) => ({
      ...directoryPayload.students[0], id: 300 + index, student_id: `0030${String(index).padStart(4, '0')}`, student_name: `Student ${index + 1}`,
    }));
    const teachers = Array.from({ length: 12 }, (_, index) => ({
      ...directoryPayload.teachers[0], id: 400 + index, teacher_id: `T-${3000 + index}`, teacher_name: `Teacher ${index + 1}`,
    }));
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ students, teachers }) });
    await act(async () => root.render(<AdminIdDirectory />));

    const clickNext = async () => {
      const next = Array.from(container.querySelectorAll('.id-directory-pagination button')).find((button) => button.textContent === 'Next');
      await act(async () => next.click());
    };
    const tab = (label) => Array.from(container.querySelectorAll('[role="tab"]')).find((button) => button.textContent === label);

    await clickNext();
    expect(container.textContent).toContain('Page 2 of 2');
    await act(async () => tab('Teachers').click());
    expect(container.textContent).toContain('Page 1 of 2');
    await clickNext();
    expect(container.textContent).toContain('Page 2 of 2');
    await act(async () => tab('Students').click());
    expect(container.textContent).toContain('Page 1 of 2');
  });

  test('refreshing with fewer rows clamps the rendered directory without a phantom page', async () => {
    const students = Array.from({ length: 12 }, (_, index) => ({
      ...directoryPayload.students[0], id: 500 + index, student_id: `0050${String(index).padStart(4, '0')}`, student_name: `Student ${index + 1}`,
    }));
    const reducedStudents = students.slice(0, 5);
    global.fetch
      .mockReset()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...directoryPayload, students }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...directoryPayload, students: reducedStudents }) });
    await act(async () => root.render(<AdminIdDirectory />));

    const next = Array.from(container.querySelectorAll('.id-directory-pagination button')).find((button) => button.textContent === 'Next');
    await act(async () => next.click());
    expect(container.textContent).toContain('Page 2 of 2');

    await act(async () => window.dispatchEvent(new Event('focus')));

    expect(container.querySelector('.id-directory-pagination')).not.toBeNull();
    expect(container.querySelectorAll('table[aria-label="Student ID Directory"] tbody tr')).toHaveLength(5);
    expect(container.textContent).not.toContain('Page 2 of 2');
  });

  test('refreshes from the authoritative source when the page regains focus', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => directoryPayload })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...directoryPayload, students: [{ ...directoryPayload.students[0], student_name: 'New Child' }] }),
      });
    await act(async () => root.render(<AdminIdDirectory />));

    await act(async () => window.dispatchEvent(new Event('focus')));

    expect(container.textContent).toContain('New Child');
  });

  test('uses the existing archive lifecycle slice without changing account status data', async () => {
    await act(async () => root.render(<AdminIdDirectory />));
    const archiveToggle = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Show Archived');

    await act(async () => archiveToggle.click());

    expect(global.fetch.mock.calls.at(-1)[0]).toContain('/api/admin/id-directory?archived=true');
  });

  test('redirects non-admin sessions before showing directory data', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 2, role: 'teacher' }));
    await act(async () => root.render(<AdminIdDirectory />));

    expect(mockNavigate).toHaveBeenCalledWith('/login');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
