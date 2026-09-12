import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import DashboardLoadingShell from './layout/DashboardLoadingShell';
import logoImage from '../assets/images/STS_Logo.png';
import { apiUrl } from '../api';
import { buildAuthHeaders, getStoredUserSession } from './session.utils';
import { normalizeRole } from './manageUsers.utils';
import { sortStudentsByName } from './studentProgress.utils';
import { TablePrintButton } from './TablePrintButton';
import { PrintableTableReport } from './PrintableTableReport';
import { collectAuthorizedReportRows, formatReportContext } from './tableReporting.utils';
import { usePreparedReportPrint } from './usePreparedReportPrint';
import ModalPortal from './ModalPortal';
import '../styles/screenTime.css';

const SORT_OPTIONS = [
  { value: 'date', label: 'Date' },
  { value: 'student_name', label: 'Student Name' },
  { value: 'total_playtime', label: 'Total Playtime' },
];

const initialFilters = {
  search: '',
  lifecycle: 'active',
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
    effective_duration_seconds: getEffectiveDurationSeconds(record),
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
  const numericMinutes = Number(minutes);
  if (!Number.isFinite(numericMinutes) || numericMinutes < 0) return 'Unknown';
  const value = Math.max(0, Math.floor(numericMinutes));
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60);
  const remaining = value % 60;
  return remaining ? `${hours} hr ${remaining} min` : `${hours} hr`;
};

const getEffectiveDurationSeconds = (record = {}) => {
  const seconds = Number(record.total_playtime_seconds);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const minutes = Number(record.total_playtime_minutes);
  if (Number.isFinite(minutes) && minutes >= 0) return minutes * 60;
  return null;
};

const formatDurationSeconds = (seconds) => (
  Number.isFinite(Number(seconds)) && Number(seconds) >= 0
    ? formatDuration(Number(seconds) / 60)
    : 'Unknown'
);

const buildQueryString = (filters, mode, page, limit) => {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('page', String(page));
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
  const [summary, setSummary] = useState({ total_records: 0, total_playtime_seconds: 0, playing_count: 0 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reportError, setReportError] = useState('');
  const [reportTitle, setReportTitle] = useState('Screen Time Report');
  const [reportScope, setReportScope] = useState('All authorised records');
  const [pendingDeletion, setPendingDeletion] = useState(null);
  const [deletionReason, setDeletionReason] = useState('');
  const [deletionConfirmation, setDeletionConfirmation] = useState('');
  const [deletionTarget, setDeletionTarget] = useState(null);
  const [deletionError, setDeletionError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const { preparedRows, hasPreparedReport, preparing: reportPreparing, prepareAndPrint } = usePreparedReportPrint();
  const isChildView = mode === 'children';
  const pageSize = 10;
  const visibleRange = {
    totalItems: pagination.total || records.length,
    start: records.length ? (page - 1) * pageSize + 1 : 0,
    end: records.length ? (page - 1) * pageSize + records.length : 0,
  };
  const reportRows = hasPreparedReport ? preparedRows : records;

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
        const response = await fetch(apiUrl(`${endpoint}?${buildQueryString(filters, mode, page, pageSize)}`), {
          headers: buildAuthHeaders(),
        });
        if (!response.ok) throw new Error('Failed to load playtime sessions');
        const payload = await response.json();
        if (cancelled) return;
        const nextRecords = normalizePlaytimeRecords(payload.data, filters);
        const nextPagination = payload.pagination || { total: 0, pages: 1, page: 1 };
        const hasCompleteSummary = payload.summary
          && Number.isFinite(Number(payload.summary.total_playtime_seconds))
          && Number.isFinite(Number(payload.summary.playing_count));
        const completeDatasetIsVisible = Number(nextPagination.total || nextRecords.length) <= nextRecords.length;
        setRecords(nextRecords);
        setPagination(nextPagination);
        setSummary(hasCompleteSummary ? {
          total_records: Number(payload.summary.total_records ?? nextPagination.total ?? nextRecords.length),
          total_playtime_seconds: Math.max(0, Number(payload.summary.total_playtime_seconds) || 0),
          playing_count: Math.max(0, Number(payload.summary.playing_count) || 0),
        } : {
          total_records: Number(nextPagination.total || nextRecords.length),
          total_playtime_seconds: completeDatasetIsVisible
            ? nextRecords.reduce((sum, record) => sum + (record.effective_duration_seconds ?? 0), 0)
            : null,
          playing_count: completeDatasetIsVisible
            ? nextRecords.filter((record) => normalizeRole(record.status) === 'playing').length
            : null,
        });
      } catch (err) {
        console.error('Screen time load failed:', err);
        if (!cancelled) {
          setRecords([]);
          setPagination({ total: 0, pages: 1, page: 1 });
          setSummary({ total_records: 0, total_playtime_seconds: 0, playing_count: 0 });
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
  }, [authReady, filters, isChildView, mode, page, pageSize, refreshToken, user]);

  const title = isChildView ? 'My Child Screen Time' : 'Screen Time Monitoring';
  const portalLabel = isChildView ? 'Parent Portal' : normalizeRole(user?.role) === 'admin' ? 'Admin Portal' : 'Teacher Portal';
  const sidebarRole = isChildView
    ? (normalizeRole(user?.role) === 'parent_teacher' ? 'parent_teacher' : 'parent')
    : (normalizeRole(user?.role) === 'admin' ? 'admin' : 'teacher');
  const activeItem = isChildView ? 'my-child-screen-time' : 'screen-time';
  const activeReportScope = [
    filters.lifecycle === 'archived' ? 'Archived History' : 'Active Students',
    filters.search ? `Search: ${filters.search}` : '',
  ].filter(Boolean).join(' / ') || (isChildView ? 'Linked children' : 'All authorised records');
  const reportColumns = [
    { header: 'No.', value: (_, index) => index + 1 },
    { header: isChildView ? 'Child Name' : 'Student Name', value: (row) => row.student_name || row.child_name },
    { header: 'Student ID', value: (row) => row.game_student_id },
    { header: 'Grade', value: (row) => row.grade_level },
    { header: 'Section', value: (row) => row.section },
    { header: 'Date Played', value: (row) => formatDate(row.date_played) },
    { header: 'Start Time', value: (row) => formatTime(row.start_time) },
    { header: 'End Time', value: (row) => formatTime(row.end_time) },
    { header: 'Total Playtime', value: (row) => formatDurationSeconds(row.effective_duration_seconds ?? getEffectiveDurationSeconds(row)) },
    { header: 'Status', value: (row) => row.status },
  ];

  const summaryCards = useMemo(() => {
    return [
      { label: 'Records', value: summary.total_records },
      { label: 'Total playtime', value: summary.total_playtime_seconds === null ? 'Unavailable' : formatDuration(summary.total_playtime_seconds / 60) },
      { label: 'Playing now', value: summary.playing_count === null ? 'Unavailable' : summary.playing_count },
    ];
  }, [summary]);

  const setFilter = (name, value) => {
    setFilters((current) => ({ ...current, [name]: value }));
    setPage(1);
  };

  const clearFilters = () => {
    setFilters(initialFilters);
    setPage(1);
  };

  const isAdminAllView = !isChildView && normalizeRole(user?.role) === 'admin';
  const isHistoryDeletionEligible = (record) => record.screen_time_delete_eligible === true
    || typeof record.screen_time_delete_eligible === 'undefined';
  const closeDeletionDialog = () => {
    if (deleting) return;
    setPendingDeletion(null);
    setDeletionReason('');
    setDeletionConfirmation('');
    setDeletionTarget(null);
    setDeletionError('');
  };

  const openSingleDeletion = (record) => {
    setPendingDeletion({ kind: isHistoryDeletionEligible(record) ? 'single' : 'reset', record });
    setDeletionReason('');
    setDeletionConfirmation('');
    setDeletionError('');
  };

  const openBulkDeletion = async () => {
    setDeletionError('');
    setDeleting(true);
    try {
      const response = await fetch(apiUrl(`/api/playtime/deletion-summary?${buildQueryString(filters, mode, 1, 200)}&completed_only=true`), { headers: buildAuthHeaders() });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Unable to prepare completed Screen Time history removal.');
      setDeletionTarget(payload);
      setPendingDeletion({ kind: 'bulk' });
      setDeletionReason('');
      setDeletionConfirmation('');
    } catch (requestError) {
      setDeletionError(requestError.message || 'Unable to prepare completed Screen Time history removal.');
    } finally {
      setDeleting(false);
    }
  };

  const confirmDeletion = async (event) => {
    event.preventDefault();
    if (!deletionReason.trim()) return setDeletionError('Provide a reason for history removal.');
    const isReset = pendingDeletion?.kind === 'reset';
    if (deletionConfirmation !== (isReset ? 'RESET' : 'DELETE')) return setDeletionError(`Type ${isReset ? 'RESET' : 'DELETE'} to confirm.`);
    setDeleting(true);
    setDeletionError('');
    try {
       const isBulk = pendingDeletion?.kind === 'bulk';
       const endpoint = isBulk ? '/api/playtime/completed/bulk' : `/api/playtime/${pendingDeletion.record.id}${isReset ? '/reset' : ''}`;
       const response = await fetch(apiUrl(endpoint), {
         method: isBulk ? 'POST' : isReset ? 'POST' : 'DELETE',
        headers: { ...buildAuthHeaders(), 'Content-Type': 'application/json' },
         body: JSON.stringify(isBulk ? {
          reason: deletionReason.trim(),
          confirmation: deletionConfirmation,
          expected_count: Number(deletionTarget?.affected_count || 0),
          target_ids: Array.isArray(deletionTarget?.target_ids) ? deletionTarget.target_ids : [],
          target_fingerprint: deletionTarget?.target_fingerprint || '',
         } : { reason: deletionReason.trim(), confirmation: deletionConfirmation }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Unable to remove Screen Time history.');
      closeDeletionDialog();
      setPage(1);
      setRefreshToken((value) => value + 1);
    } catch (requestError) {
      setDeletionError(requestError.message || 'Unable to remove Screen Time history.');
    } finally {
      setDeleting(false);
    }
  };

  const prepareScreenTimeReport = async (loadRows, nextTitle, nextScope) => {
    setReportError('');
    setReportTitle(nextTitle);
    setReportScope(nextScope);
    await prepareAndPrint(async () => {
      try {
        return await loadRows();
      } catch (err) {
        setReportError('Unable to prepare the screen time report right now.');
        throw err;
      }
    });
  };

  const prepareFilteredScreenTimeReport = () => prepareScreenTimeReport(
    () => collectAuthorizedReportRows({
      pageSize: 200,
      loadPage: async ({ page: reportPage, limit }) => {
        const endpoint = isChildView ? '/api/playtime/my-children' : '/api/playtime';
        const response = await fetch(apiUrl(`${endpoint}?${buildQueryString(filters, mode, reportPage, limit)}`), {
          headers: buildAuthHeaders(),
        });
        if (!response.ok) throw new Error('Unable to load filtered screen time records');
        const payload = await response.json();
        return {
          rows: normalizePlaytimeRecords(payload.data, filters),
          pagination: payload.pagination,
        };
      },
    }),
    'Screen Time Report',
    activeReportScope
  );

  const handleSidebarSelection = (key) => {
    if (key === 'dashboard') {
      if (normalizeRole(user?.role) === 'admin') navigate('/admin-dashboard');
      else if (isChildView && normalizeRole(user?.role) === 'parent') navigate('/parent-dashboard');
      else navigate('/teacher-dashboard');
    }
  };

  if (loading && !user) {
    const loadingRole = normalizeRole(getStoredUserSession()?.role);
    const loadingIsChildView = mode === 'children';
    const loadingPortalLabel = loadingIsChildView
      ? 'Parent Portal'
      : loadingRole === 'admin'
        ? 'Admin Portal'
        : 'Teacher Portal';
    const loadingSidebarRole = loadingIsChildView
      ? (loadingRole === 'parent_teacher' ? 'parent_teacher' : 'parent')
      : (loadingRole === 'admin' ? 'admin' : 'teacher');
    return (
      <DashboardLoadingShell
        role={loadingSidebarRole}
        activeItem={loadingIsChildView ? 'my-child-screen-time' : 'screen-time'}
        logoSrc={logoImage}
        portalLabel={loadingPortalLabel}
        heading={loadingIsChildView ? 'My Child Screen Time' : 'Screen Time Monitoring'}
        subheading="Review recorded gameplay time and session activity."
      />
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
                      placeholder={isChildView
                        ? 'Search child name, ID, grade, section, date, duration, or status...'
                        : 'Search name, ID, grade, section, parent ID, date, duration, or status...'}
                    />
                  </label>

                  <label>
                    Monitoring View
                    <select
                      className="screen-time-input"
                      value={filters.lifecycle}
                      onChange={(event) => setFilter('lifecycle', event.target.value)}
                    >
                      <option value="active">Active Students</option>
                      <option value="archived">Archived History</option>
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
                  <div className="table-report-controls">
                    <TablePrintButton
                      reportTitle="Screen Time Report"
                      reportContext={formatReportContext({ scope: activeReportScope, recordCount: pagination.total || records.length })}
                      label="Print Filtered Report"
                      showPrintHeading={false}
                      preparing={reportPreparing}
                      onPrint={prepareFilteredScreenTimeReport}
                    />
                    {isAdminAllView && (
                      <button type="button" className="screen-time-danger-button" data-action="delete-all-completed-playtime" onClick={openBulkDeletion} disabled={deleting || loading}>
                        Delete All Completed Records
                      </button>
                    )}
                  </div>
                </div>
                {reportError && <p className="screen-time-error no-print">{reportError}</p>}

                {deletionError && !pendingDeletion && <p className="screen-time-error no-print" role="alert">{deletionError}</p>}

                {pendingDeletion && (
                  <ModalPortal onClose={closeDeletionDialog}>
                    <div className="screen-time-deletion-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDeletionDialog(); }}>
                      <form className="screen-time-deletion-dialog" role="dialog" aria-modal="true" aria-labelledby="screen-time-deletion-title" onSubmit={confirmDeletion} onMouseDown={(event) => event.stopPropagation()}>
                        <h2 id="screen-time-deletion-title">{pendingDeletion.kind === 'bulk' ? 'Delete All Completed Records' : pendingDeletion.kind === 'reset' ? 'Reset Screen Time' : 'Delete Screen Time Record'}</h2>
                        <p>This action removes the record from Screen Time history. Daily playtime usage accounting remains preserved.</p>
                        {pendingDeletion.kind === 'bulk' ? <p><strong>{deletionTarget?.affected_count || 0} completed records match the current filters.</strong></p> : <p><strong>{pendingDeletion.record.student_name || pendingDeletion.record.game_student_id || 'Selected student'} · {formatDate(pendingDeletion.record.date_played)}</strong></p>}
                        {pendingDeletion.kind === 'reset' && <p>This resets the Screen Time baseline for the active student. Existing history and the active session are preserved.</p>}
                        <label htmlFor="screen-time-deletion-reason">Reason for {pendingDeletion.kind === 'reset' ? 'reset' : 'removal'}</label>
                        <textarea id="screen-time-deletion-reason" value={deletionReason} onChange={(event) => setDeletionReason(event.target.value.slice(0, 1000))} maxLength={1000} rows={4} disabled={deleting} />
                        <label htmlFor="screen-time-deletion-confirmation">Type {pendingDeletion.kind === 'reset' ? 'RESET' : 'DELETE'} to confirm</label>
                        <input id="screen-time-deletion-confirmation" value={deletionConfirmation} onChange={(event) => setDeletionConfirmation(event.target.value)} autoComplete="off" disabled={deleting} />
                        {deletionError && <p className="screen-time-error" role="alert">{deletionError}</p>}
                        <div className="screen-time-deletion-actions">
                          <button type="button" className="screen-time-clear" onClick={closeDeletionDialog} disabled={deleting}>Cancel</button>
                          <button type="submit" className="screen-time-danger-button" disabled={deleting}>{deleting ? (pendingDeletion.kind === 'reset' ? 'Resetting…' : 'Deleting…') : pendingDeletion.kind === 'reset' ? 'Confirm Reset' : 'Confirm Delete'}</button>
                        </div>
                      </form>
                    </div>
                  </ModalPortal>
                )}

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
                        <th className="no-print">Report</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.length === 0 ? (
                        <tr>
                          <td colSpan={isChildView ? 11 : 12} className="screen-time-empty">
                            No playtime records available yet.
                          </td>
                        </tr>
                      ) : records.map((record, index) => (
                        <tr key={record.id || `${record.student_id}-${index}`}>
                          <td>{visibleRange.start + index}</td>
                          <td>{record.student_name || record.child_name || 'Unknown'}</td>
                          <td>{record.game_student_id || 'Not linked'}</td>
                          {!isChildView && <td>{record.parent_id || '-'}</td>}
                          <td>{record.grade_level || '-'}</td>
                          <td>{record.section || '-'}</td>
                          <td>{formatDate(record.date_played)}</td>
                          <td>{formatTime(record.start_time)}</td>
                          <td>{formatTime(record.end_time)}</td>
                          <td>{formatDurationSeconds(record.effective_duration_seconds)}</td>
                          <td><span className={`screen-time-status ${String(record.status || '').toLowerCase().replace(/\s+/g, '-')}`}>{record.status || 'Unknown'}</span></td>
                          <td className="no-print">
                            <TablePrintButton
                              reportTitle="Student Screen Time Record"
                              label="Print Student Record"
                              showPrintHeading={false}
                              onPrint={() => prepareScreenTimeReport(
                                async () => [record],
                                'Student Screen Time Record',
                                `Student: ${record.student_name || record.child_name || record.game_student_id || 'Selected student'}`
                              )}
                            />
                            {isAdminAllView && !isHistoryDeletionEligible(record) && (
                              <button type="button" className="screen-time-clear" data-action="reset-screen-time" onClick={() => openSingleDeletion(record)}>
                                Reset Screen Time
                              </button>
                            )}
                            {isAdminAllView && String(record.status || '').toLowerCase() !== 'playing' && isHistoryDeletionEligible(record) && (
                              <button type="button" className="screen-time-danger-link" data-action="delete-playtime-record" onClick={() => openSingleDeletion(record)}>
                                Delete
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!loading && !error && <div className="pagination-row no-print" aria-label="Screen Time pagination">
                  <span>{visibleRange.totalItems === 0 ? '0 records' : `Showing ${visibleRange.start} - ${visibleRange.end} of ${visibleRange.totalItems} records`}</span>
                  <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1}>Previous</button>
                  <span>Page {page} of {Math.max(1, pagination.pages || 1)}</span>
                  <button type="button" onClick={() => setPage((current) => Math.min(Math.max(1, pagination.pages || 1), current + 1))} disabled={page >= Math.max(1, pagination.pages || 1)}>Next</button>
                </div>}
                <PrintableTableReport
                  title={reportTitle}
                  context={reportScope}
                  rows={reportRows}
                  columns={reportColumns}
                />
              </div>
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}
