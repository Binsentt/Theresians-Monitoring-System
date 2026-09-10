import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import DashboardLoadingShell from './layout/DashboardLoadingShell';
import logoImage from '../assets/images/STS_Logo.png';
import { apiUrl } from '../api';
import { buildAuthHeaders, clearStoredSession } from './session.utils';
import { normalizeRole } from './manageUsers.utils';
import { formatReportContext, paginateTableRows } from './tableReporting.utils';
import { TablePrintButton } from './TablePrintButton';
import { PrintableTableReport } from './PrintableTableReport';
import {
  filterDirectoryRows,
  formatDirectoryDate,
  formatDirectoryRole,
  formatDirectoryStatus,
} from './idDirectory.utils';
import '../styles/iddirectory.css';

const getParentDisplay = (row) => {
  const name = String(row?.parent_name || '').trim();
  const relationship = String(row?.parent_relationship || '').trim();
  if (!name && !relationship) return '—';
  if (!relationship) return name || '—';
  if (!name) return relationship;
  return `${name} (${relationship})`;
};

function StudentDirectoryTable({ rows }) {
  return (
    <div className="id-directory-table-wrap">
      <table className="id-directory-table" aria-label="Student ID Directory">
        <thead>
          <tr>
            <th scope="col">Student ID</th>
            <th scope="col">Student Name</th>
            <th scope="col">Grade Level</th>
            <th scope="col">Section</th>
            <th scope="col">Parent (Relationship)</th>
            <th scope="col">Account/Status</th>
            <th scope="col">Date Added</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id || row.student_id}>
              <td>{row.student_id || '—'}</td>
              <td>{row.student_name || '—'}</td>
              <td>{row.grade_level || '—'}</td>
              <td>{row.section || '—'}</td>
              <td>{getParentDisplay(row)}</td>
              <td>{formatDirectoryStatus(row)}</td>
              <td>{formatDirectoryDate(row.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="id-directory-empty">No student IDs match the current filters.</p>}
    </div>
  );
}

function TeacherDirectoryTable({ rows }) {
  return (
    <div className="id-directory-table-wrap">
      <table className="id-directory-table" aria-label="Teacher ID Directory">
        <thead>
          <tr>
            <th scope="col">Teacher ID</th>
            <th scope="col">Teacher Name</th>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Status</th>
            <th scope="col">Date Added</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id || row.teacher_id}>
              <td>{row.teacher_id || '—'}</td>
              <td>{row.teacher_name || '—'}</td>
              <td>{row.email || '—'}</td>
              <td>{formatDirectoryRole(row.role)}</td>
              <td>{formatDirectoryStatus(row)}</td>
              <td>{formatDirectoryDate(row.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="id-directory-empty">No teacher IDs match the current filters.</p>}
    </div>
  );
}

function DirectoryPagination({ page, setPage }) {
  return (
    <div className="id-directory-pagination" aria-label="ID Directory pagination">
      <span>{page.totalItems === 0 ? '0 records' : `Showing ${page.start} - ${page.end} of ${page.totalItems} records`}</span>
      <div>
        <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page.currentPage === 1}>Previous</button>
        <span>Page {page.currentPage} of {page.totalPages}</span>
        <button type="button" onClick={() => setPage((value) => Math.min(page.totalPages, value + 1))} disabled={page.currentPage === page.totalPages}>Next</button>
      </div>
    </div>
  );
}

export default function AdminIdDirectory() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [directory, setDirectory] = useState({ students: [], teachers: [] });
  const [studentSearch, setStudentSearch] = useState('');
  const [teacherSearch, setTeacherSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [activeTab, setActiveTab] = useState('students');
  const [studentPage, setStudentPage] = useState(1);
  const [teacherPage, setTeacherPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadDirectory = useCallback(async () => {
    setError('');
    try {
      const response = await fetch(apiUrl(`/api/admin/id-directory?archived=${showArchived}`), {
        headers: buildAuthHeaders(),
      });
      if (response.status === 401 || response.status === 403) {
        clearStoredSession();
        navigate('/login', { replace: true, state: { sessionExpired: true } });
        return;
      }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || 'Failed to load ID Directory');
      setDirectory({
        students: Array.isArray(payload?.students) ? payload.students : [],
        teachers: Array.isArray(payload?.teachers) ? payload.teachers : [],
      });
    } catch (loadError) {
      console.error('Error loading ID Directory:', loadError);
      setError('Unable to load the ID Directory. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [navigate, showArchived]);

  useEffect(() => {
    const initialize = async () => {
      document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') || 'light');
      let loggedInUser = null;
      try {
        loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
      } catch (parseError) {
        loggedInUser = null;
      }
      if (!loggedInUser || normalizeRole(loggedInUser.role) !== 'admin') {
        setLoading(false);
        navigate('/login');
        return;
      }
      setUser(loggedInUser);
      await loadDirectory();
    };

    initialize();
  }, [loadDirectory, navigate]);

  useEffect(() => {
    if (!user) return undefined;
    const refreshOnFocus = () => loadDirectory();
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [loadDirectory, user]);

  const filteredStudents = useMemo(
    () => filterDirectoryRows(directory.students, studentSearch, 'student'),
    [directory.students, studentSearch]
  );
  const filteredTeachers = useMemo(
    () => filterDirectoryRows(directory.teachers, teacherSearch, 'teacher'),
    [directory.teachers, teacherSearch]
  );
  const paginatedStudents = paginateTableRows(filteredStudents, studentPage, 10);
  const paginatedTeachers = paginateTableRows(filteredTeachers, teacherPage, 10);

  useEffect(() => {
    if (studentPage !== paginatedStudents.currentPage) setStudentPage(paginatedStudents.currentPage);
  }, [paginatedStudents.currentPage, studentPage]);

  useEffect(() => {
    if (teacherPage !== paginatedTeachers.currentPage) setTeacherPage(paginatedTeachers.currentPage);
  }, [paginatedTeachers.currentPage, teacherPage]);

  if (loading) {
    return (
      <DashboardLoadingShell
        role="admin"
        activeItem="id-directory"
        portalLabel="Admin Portal"
        heading="ID Directory"
        subheading="Authoritative Student and Teacher IDs."
      />
    );
  }

  return (
    <DashboardContainer
      sidebar={<AnalyticsSidebar role="admin" activeItem="id-directory" logoSrc={logoImage} portalLabel="Admin Portal" />}
      main={(
        <MainContent>
          <TopBar>
            <div className="header-info">
              <h1>ID Directory</h1>
              <p>Welcome, {user?.name || 'Administrator'}</p>
            </div>
          </TopBar>

          <PageContent>
            {error && <p className="id-directory-error" role="alert">{error}</p>}
            <div className="id-directory-toolbar">
              <p className="id-directory-source-note">IDs are read from authoritative account records. New accounts appear when this page is opened or refocused.</p>
              <button type="button" className="sts-add-btn" onClick={() => setShowArchived((current) => !current)}>
                {showArchived ? 'Show Active' : 'Show Archived'}
              </button>
            </div>

            <div className="id-directory-tabs" role="tablist" aria-label="ID Directory views">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'students'}
                className={activeTab === 'students' ? 'active' : ''}
                onClick={() => {
                  setActiveTab('students');
                  setStudentPage(1);
                  setTeacherPage(1);
                }}
              >
                Students
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'teachers'}
                className={activeTab === 'teachers' ? 'active' : ''}
                onClick={() => {
                  setActiveTab('teachers');
                  setStudentPage(1);
                  setTeacherPage(1);
                }}
              >
                Teachers
              </button>
            </div>

            {activeTab === 'students' ? (
              <ContentSection
                title={`Students (${filteredStudents.length})`}
                actions={(
                  <div className="id-directory-filters" aria-label="Student ID Directory controls">
                    <label className="id-directory-filter">
                      <span>Search students</span>
                      <input aria-label="Search Student ID Directory" type="search" value={studentSearch} onChange={(event) => { setStudentSearch(event.target.value); setStudentPage(1); }} placeholder="Name, Student ID, Grade, Section, Parent, Status, or date" />
                    </label>
                    <TablePrintButton reportTitle="Student ID Directory" reportContext={formatReportContext({ scope: studentSearch ? `Search: ${studentSearch}` : 'All active Student accounts', recordCount: filteredStudents.length })} label="Print Student Directory" showPrintHeading={false} />
                  </div>
                )}
                contentClassName="id-directory-section-content"
              >
                <StudentDirectoryTable rows={paginatedStudents.rows} />
                <DirectoryPagination page={paginatedStudents} setPage={setStudentPage} />
                <PrintableTableReport
                  title="Student ID Directory"
                  context={studentSearch ? `Search: ${studentSearch}` : 'All active Student accounts'}
                  rows={filteredStudents}
                  columns={[
                    { header: 'Student ID', value: (row) => row.student_id || '—' },
                    { header: 'Student Name', value: (row) => row.student_name || '—' },
                    { header: 'Grade Level', value: (row) => row.grade_level || '—' },
                    { header: 'Section', value: (row) => row.section || '—' },
                    { header: 'Parent', value: getParentDisplay },
                    { header: 'Status', value: formatDirectoryStatus },
                    { header: 'Date Added', value: (row) => formatDirectoryDate(row.created_at) },
                  ]}
                />
              </ContentSection>
            ) : (
              <ContentSection
                title={`Teachers (${filteredTeachers.length})`}
                actions={(
                  <div className="id-directory-filters" aria-label="Teacher ID Directory controls">
                    <label className="id-directory-filter">
                      <span>Search teachers</span>
                      <input aria-label="Search Teacher ID Directory" type="search" value={teacherSearch} onChange={(event) => { setTeacherSearch(event.target.value); setTeacherPage(1); }} placeholder="Name, Teacher ID, email, role, status, or date" />
                    </label>
                    <TablePrintButton reportTitle="Teacher ID Directory" reportContext={formatReportContext({ scope: teacherSearch ? `Search: ${teacherSearch}` : 'All active Teacher accounts', recordCount: filteredTeachers.length })} label="Print Teacher Directory" showPrintHeading={false} />
                  </div>
                )}
                contentClassName="id-directory-section-content"
              >
                <TeacherDirectoryTable rows={paginatedTeachers.rows} />
                <DirectoryPagination page={paginatedTeachers} setPage={setTeacherPage} />
                <PrintableTableReport
                  title="Teacher ID Directory"
                  context={teacherSearch ? `Search: ${teacherSearch}` : 'All active Teacher accounts'}
                  rows={filteredTeachers}
                  columns={[
                    { header: 'Teacher ID', value: (row) => row.teacher_id || '—' },
                    { header: 'Teacher Name', value: (row) => row.teacher_name || '—' },
                    { header: 'Email', value: (row) => row.email || '—' },
                    { header: 'Role', value: (row) => formatDirectoryRole(row.role) },
                    { header: 'Status', value: formatDirectoryStatus },
                    { header: 'Date Added', value: (row) => formatDirectoryDate(row.created_at) },
                  ]}
                />
              </ContentSection>
            )}
          </PageContent>
        </MainContent>
      )}
    />
  );
}
