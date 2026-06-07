import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import { apiUrl } from '../api';
import { buildAuthHeaders, getStoredUserSession } from './session.utils';
import { normalizeRole } from './manageUsers.utils';
import { sortStudentsByName } from './studentProgress.utils';
import '../styles/screenTime.css';

const GRADES = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'];
const STATUSES = ['Active', 'Playing', 'Online', 'Offline', 'Completed', 'In Progress'];
const SORT_OPTIONS = [
  { value: 'date', label: 'Date' },
  { value: 'student_name', label: 'Student Name' },
  { value: 'total_playtime', label: 'Total Playtime' },
];

const initialFilters = {
  search: '',
  date: '',
  grade_level: '',
  section: '',
  student_name: '',
  student_id: '',
  parent_id: '',
  status: '',
  sort_by: 'student_name',
};

const statusLabels = {
  active: 'Active',
  playing: 'Playing',
  online: 'Online',
  offline: 'Offline',
  completed: 'Completed',
  inprogress: 'In Progress',
};

const normalizeMonitoringStatus = (status) => {
  const key = String(status || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

  if (['autosave', 'autosaved', 'limitreached'].includes(key)) return 'Completed';
  if (key === 'loggedout') return 'Offline';
  return statusLabels[key] || 'Offline';
};

const normalizePlaytimeRecords = (items, filters) => {
  const normalized = (Array.isArray(items) ? items : []).map((record) => ({
    ...record,
    status: normalizeMonitoringStatus(record.status),
  }));

  return filters?.sort_by === 'student_name' ? sortStudentsByName(normalized) : normalized;
};

const formatDate = (value) => {
  if (!value) return '-';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const [year, month, day] = text.slice(0, 10).split('-');
    return `${month}/${day}/${year}`;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleDateString();
};

const formatTime = (value) => {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatDuration = (minutes) => {
  const value = Math.max(0, Math.floor(Number(minutes) || 0));
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60);
  const remaining = value % 60;
  return remaining ? `${hours} hr ${remaining} min` : `${hours} hr`;
};

const buildQueryString = (filters, mode) => {
  const params = new URLSearchParams();
  params.set('limit', '50');
  params.set('sort_by', filters.sort_by || 'student_name');

  Object.entries(filters).forEach(([key, value]) => {
    const trimmed = String(value || '').trim();
    if (!trimmed || key === 'sort_by') return;
    if (mode === 'children' && ['grade_level', 'section', 'parent_id'].includes(key)) return;
    params.set(key, trimmed);
  });

  return params.toString();
};

const canOpenMode = (role, mode) => {
  if (mode === 'children') return ['parent', 'parent_teacher'].includes(role);
  return ['admin', 'teacher', 'parent_teacher'].includes(role);
};

export default function ScreenTimeMonitoring({ mode = 'all' }) {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [filters, setFilters] = useState(initialFilters);
  const [records, setRecords] = useState([]);
  const [pagination, setPagination] = useState({ total: 0, pages: 1, page: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const isChildView = mode === 'children';

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);

    const session = getStoredUserSession();
    const role = normalizeRole(session?.role);
    if (!session?.id || !canOpenMode(role, mode)) {
      setAuthReady(true);
      setLoading(false);
      navigate('/login');
      return;
    }

    setUser({ ...session, role });
    setAuthReady(true);
  }, [mode, navigate]);

  useEffect(() => {
    if (!authReady || !user) return;

    let cancelled = false;
    const endpoint = isChildView ? '/api/playtime/my-children' : '/api/playtime';

    const loadSessions = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(apiUrl(`${endpoint}?${buildQueryString(filters, mode)}`), {
          headers: buildAuthHeaders(),
        });
        if (!response.ok) throw new Error('Failed to load playtime sessions');
        const payload = await response.json();
        if (cancelled) return;
        setRecords(normalizePlaytimeRecords(payload.data, filters));
        setPagination(payload.pagination || { total: 0, pages: 1, page: 1 });
      } catch (err) {
        console.error('Screen time load failed:', err);
        if (!cancelled) {
          setRecords([]);
          setPagination({ total: 0, pages: 1, page: 1 });
          setError('Unable to load screen time records right now.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadSessions();
    return () => {
      cancelled = true;
    };
  }, [authReady, filters, isChildView, mode, user]);

  const title = isChildView ? 'My Child Screen Time' : 'Screen Time Monitoring';
  const portalLabel = isChildView ? 'Parent Portal' : normalizeRole(user?.role) === 'admin' ? 'Admin Portal' : 'Teacher Portal';
  const sidebarRole = isChildView
    ? (normalizeRole(user?.role) === 'parent_teacher' ? 'parent_teacher' : 'parent')
    : (normalizeRole(user?.role) === 'admin' ? 'admin' : 'teacher');
  const activeItem = isChildView ? 'my-child-screen-time' : 'screen-time';

  const summaryCards = useMemo(() => {
    const totalMinutes = records.reduce((sum, record) => sum + (Number(record.total_playtime_minutes) || 0), 0);
    const playingCount = records.filter((record) => normalizeRole(record.status) === 'playing').length;
    return [
      { label: 'Records', value: pagination.total || records.length },
      { label: 'Total playtime', value: formatDuration(totalMinutes) },
      { label: 'Playing now', value: playingCount },
    ];
  }, [pagination.total, records]);

  const setFilter = (name, value) => {
    setFilters((current) => ({ ...current, [name]: value }));
  };

  const clearFilters = () => {
    setFilters(initialFilters);
  };

  const handleSidebarSelection = (key) => {
    if (key === 'dashboard') {
      if (normalizeRole(user?.role) === 'admin') navigate('/admin-dashboard');
      else if (isChildView && normalizeRole(user?.role) === 'parent') navigate('/parent-dashboard');
      else navigate('/teacher-dashboard');
    }
  };

  if (loading && !user) {
    return (
      <div className="sts-loader-container">
        <div className="sts-spinner"></div>
        <p>Loading Screen Time...</p>
      </div>
    );
  }

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role={sidebarRole}
          activeItem={activeItem}
          onSelect={handleSidebarSelection}
          logoSrc={logoImage}
          portalLabel={portalLabel}
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div>
              <h1>{title}</h1>
              <p>{isChildView ? "Review your child's gameplay sessions and daily playtime." : 'Monitor student gameplay sessions and daily screen time.'}</p>
            </div>
          </TopBar>

          <PageContent>
            <ContentSection contentClassName="screen-time-section-shell">
              <div className="screen-time-container">
                <div className="screen-time-summary">
                  {summaryCards.map((card) => (
                    <div className="screen-time-summary-card" key={card.label}>
                      <span>{card.label}</span>
                      <strong>{card.value}</strong>
                    </div>
                  ))}
                </div>

                <div className="screen-time-filters">
                  <label>
                    Search
                    <input
                      className="screen-time-input"
                      value={filters.search}
                      onChange={(event) => setFilter('search', event.target.value)}
                      placeholder={isChildView ? 'Search child...' : 'Search records...'}
                    />
                  </label>

                  <label>
                    Date
                    <input
                      className="screen-time-input"
                      type="date"
                      value={filters.date}
                      onChange={(event) => setFilter('date', event.target.value)}
                    />
                  </label>

                  {!isChildView && (
                    <>
                      <label>
                        Grade Level
                        <select
                          className="screen-time-input"
                          value={filters.grade_level}
                          onChange={(event) => setFilter('grade_level', event.target.value)}
                        >
                          <option value="">All Grades</option>
                          {GRADES.map((grade) => <option key={grade} value={grade}>{grade}</option>)}
                        </select>
                      </label>

                      <label>
                        Section
                        <input
                          className="screen-time-input"
                          value={filters.section}
                          onChange={(event) => setFilter('section', event.target.value)}
                          placeholder="Section"
                        />
                      </label>
                    </>
                  )}

                  <label>
                    {isChildView ? 'Child Name' : 'Student Name'}
                    <input
                      className="screen-time-input"
                      value={filters.student_name}
                      onChange={(event) => setFilter('student_name', event.target.value)}
                      placeholder={isChildView ? 'Child name' : 'Student name'}
                    />
                  </label>

                  <label>
                    Student ID
                    <input
                      className="screen-time-input"
                      value={filters.student_id}
                      onChange={(event) => setFilter('student_id', event.target.value.replace(/\D/g, ''))}
                      placeholder="Student ID"
                    />
                  </label>

                  {!isChildView && (
                    <label>
                      Parent ID
                      <input
                        className="screen-time-input"
                        value={filters.parent_id}
                        onChange={(event) => setFilter('parent_id', event.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="Parent ID"
                      />
                    </label>
                  )}

                  <label>
                    Status
                    <select
                      className="screen-time-input"
                      value={filters.status}
                      onChange={(event) => setFilter('status', event.target.value)}
                    >
                      <option value="">All Statuses</option>
                      {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                  </label>

                  <label>
                    Sort By
                    <select
                      className="screen-time-input"
                      value={filters.sort_by}
                      onChange={(event) => setFilter('sort_by', event.target.value)}
                    >
                      {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>

                  <button type="button" className="screen-time-clear" onClick={clearFilters}>
                    Clear Filters
                  </button>
                </div>

                {error ? <div className="screen-time-error">{error}</div> : null}

                <div className="screen-time-results">
                  <span>{pagination.total || records.length} records</span>
                </div>

                <div className="screen-time-table-wrap">
                  <table className="screen-time-table">
                    <thead>
                      <tr>
                        <th>No.</th>
                        <th>{isChildView ? 'Child Name' : 'Student Name'}</th>
                        <th>Student ID</th>
                        {!isChildView && <th>Parent ID</th>}
                        <th>Grade Level</th>
                        <th>Section</th>
                        <th>Date Played</th>
                        <th>Start Time</th>
                        <th>End Time</th>
                        <th>Total Playtime</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.length === 0 ? (
                        <tr>
                          <td colSpan={isChildView ? 10 : 11} className="screen-time-empty">
                            No playtime records available yet.
                          </td>
                        </tr>
                      ) : records.map((record, index) => (
                        <tr key={record.id || `${record.student_id}-${index}`}>
                          <td>{index + 1}</td>
                          <td>{record.student_name || record.child_name || 'Unknown'}</td>
                          <td>{record.student_id || '-'}</td>
                          {!isChildView && <td>{record.parent_id || '-'}</td>}
                          <td>{record.grade_level || '-'}</td>
                          <td>{record.section || '-'}</td>
                          <td>{formatDate(record.date_played)}</td>
                          <td>{formatTime(record.start_time)}</td>
                          <td>{formatTime(record.end_time)}</td>
                          <td>{formatDuration(record.total_playtime_minutes)}</td>
                          <td><span className={`screen-time-status ${String(record.status || '').toLowerCase().replace(/\s+/g, '-')}`}>{record.status || 'Unknown'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}
