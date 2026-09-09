import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import DashboardLoadingShell from './layout/DashboardLoadingShell';
import logoImage from '../assets/images/STS_Logo.png';
import { apiUrl } from '../api';
import { buildAuthHeaders, clearStoredSession } from './session.utils';
import { normalizeRole } from './manageUsers.utils';
import { paginateTableRows } from './tableReporting.utils';
import {
  filterDirectoryRows,
  formatDirectoryDate,
  formatDirectoryRole,
  formatDirectoryStatus,
} from './idDirectory.utils';
import '../styles/iddirectory.css';

const emptyFilters = {
  id: '',
  name: '',
  grade: '',
  section: '',
  status: '',
  email: '',
  role: '',
};

const updateFilter = (setter, field, value) => {
  setter((current) => ({ ...current, [field]: value }));
};

const getParentDisplay = (row) => {
  const name = String(row?.parent_name || '').trim();
  const relationship = String(row?.parent_relationship || '').trim();
  if (!name && !relationship) return '—';
  if (!relationship) return name || '—';
  if (!name) return relationship;
  return `${name} (${relationship})`;
};

function DirectoryFilter({ label, value, onChange, placeholder }) {
  return (
    <label className="id-directory-filter">
      <span>{label}</span>
      <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder || label} />
    </label>
  );
}

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
  if (page.totalPages <= 1) return null;
  return (
    <div className="id-directory-pagination" aria-label="ID Directory pagination">
      <span>Showing {page.start} - {page.end} of {page.totalItems}</span>
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
  const [studentFilters, setStudentFilters] = useState(emptyFilters);
  const [teacherFilters, setTeacherFilters] = useState(emptyFilters);
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
    () => filterDirectoryRows(directory.students, studentFilters, 'student'),
    [directory.students, studentFilters]
  );
  const filteredTeachers = useMemo(
    () => filterDirectoryRows(directory.teachers, teacherFilters, 'teacher'),
    [directory.teachers, teacherFilters]
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
                  <div className="id-directory-filters" aria-label="Student ID filters">
                    <DirectoryFilter label="ID" value={studentFilters.id} onChange={(value) => { updateFilter(setStudentFilters, 'id', value); setStudentPage(1); }} />
                    <DirectoryFilter label="Name" value={studentFilters.name} onChange={(value) => { updateFilter(setStudentFilters, 'name', value); setStudentPage(1); }} />
                    <DirectoryFilter label="Grade" value={studentFilters.grade} onChange={(value) => { updateFilter(setStudentFilters, 'grade', value); setStudentPage(1); }} />
                    <DirectoryFilter label="Section" value={studentFilters.section} onChange={(value) => { updateFilter(setStudentFilters, 'section', value); setStudentPage(1); }} />
                    <DirectoryFilter label="Status" value={studentFilters.status} onChange={(value) => { updateFilter(setStudentFilters, 'status', value); setStudentPage(1); }} />
                  </div>
                )}
                contentClassName="id-directory-section-content"
              >
                <DirectoryPagination page={paginatedStudents} setPage={setStudentPage} />
                <StudentDirectoryTable rows={paginatedStudents.rows} />
              </ContentSection>
            ) : (
              <ContentSection
                title={`Teachers (${filteredTeachers.length})`}
                actions={(
                  <div className="id-directory-filters" aria-label="Teacher ID filters">
                    <DirectoryFilter label="ID" value={teacherFilters.id} onChange={(value) => { updateFilter(setTeacherFilters, 'id', value); setTeacherPage(1); }} />
                    <DirectoryFilter label="Name" value={teacherFilters.name} onChange={(value) => { updateFilter(setTeacherFilters, 'name', value); setTeacherPage(1); }} />
                    <DirectoryFilter label="Email" value={teacherFilters.email} onChange={(value) => { updateFilter(setTeacherFilters, 'email', value); setTeacherPage(1); }} />
                    <DirectoryFilter label="Role" value={teacherFilters.role} onChange={(value) => { updateFilter(setTeacherFilters, 'role', value); setTeacherPage(1); }} />
                    <DirectoryFilter label="Status" value={teacherFilters.status} onChange={(value) => { updateFilter(setTeacherFilters, 'status', value); setTeacherPage(1); }} />
                  </div>
                )}
                contentClassName="id-directory-section-content"
              >
                <DirectoryPagination page={paginatedTeachers} setPage={setTeacherPage} />
                <TeacherDirectoryTable rows={paginatedTeachers.rows} />
              </ContentSection>
            )}
          </PageContent>
        </MainContent>
      )}
    />
  );
}
