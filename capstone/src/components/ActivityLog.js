import React, { useCallback, useEffect, useMemo, useState } from 'react';
import '../styles/activitylog.css';
import {
  buildActivityLogQueryParams,
  formatActivityLogDuration,
  getActivityLogActivity,
  getActivityLogGrade,
  normalizeActivityLogPayload,
  shouldShowActivityLogFilters,
} from './activityLog.utils';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { buildAuthHeaders } from './session.utils';
import { sortStudentsByName } from './studentProgress.utils';
import { TablePrintButton } from './TablePrintButton';
import { PrintableTableReport } from './PrintableTableReport';
import { collectAuthorizedReportRows, formatReportContext } from './tableReporting.utils';
import { usePreparedReportPrint } from './usePreparedReportPrint';

const GRADE_SECTIONS = {
  'Grade 1': ['Section A', 'Section B'],
  'Grade 2': ['Section A', 'Section B', 'Section C'],
  'Grade 3': ['Section A', 'Section B', 'Section C'],
  'Grade 4': ['Section A', 'Section B', 'Section C'],
  'Grade 5': ['Section A', 'Section B', 'Section C'],
  'Grade 6': ['Section A', 'Section B', 'Section C'],
};

const GRADES = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'];

export default function ActivityLog({ limit = 50, role = 'admin', userId = null }) {
  const [activities, setActivities] = useState([]);
  const [pagination, setPagination] = useState({ total: 0, pages: 1, current_page: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedGrade, setSelectedGrade] = useState('');
  const [selectedSection, setSelectedSection] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [parentChildren, setParentChildren] = useState([]);
  const [childrenLoaded, setChildrenLoaded] = useState(role !== 'parent');
  const [selectedChildId, setSelectedChildId] = useState('');
  const [reportError, setReportError] = useState('');
  const { preparedRows, hasPreparedReport, preparing: reportPreparing, prepareAndPrint } = usePreparedReportPrint();
  const requiresScopedUser = role === 'teacher' || role === 'parent';
  const scopedUserReady = !requiresScopedUser || Boolean(userId);
  const showFilters = shouldShowActivityLogFilters(role);
  const isParentView = role === 'parent';

  useEffect(() => {
    if (!showFilters) {
      setDebouncedSearch('');
      setSearchTerm('');
      setSelectedGrade('');
      setSelectedSection('');
      setCurrentPage(1);
      return undefined;
    }

    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm.trim().toLowerCase());
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm, showFilters]);

  useEffect(() => {
    let cancelled = false;

    const loadParentChildren = async () => {
      if (!isParentView || !userId) {
        setChildrenLoaded(true);
        return;
      }

      setChildrenLoaded(false);
      try {
        const response = await fetch(buildScopedApiUrl('/api/parent/children', 'parent'), {
          headers: buildAuthHeaders(),
        });
        if (!response.ok) throw new Error('Failed to load children');
        const payload = await response.json();
        const children = sortStudentsByName(Array.isArray(payload?.children) ? payload.children : []);
        if (cancelled) return;
        setParentChildren(children);
        setSelectedChildId((current) => {
          if (children.some((child) => String(child.student_id || child.id) === String(current))) {
            return current;
          }
          return children[0] ? String(children[0].student_id || children[0].id) : '';
        });
      } catch (err) {
        console.error('Error fetching parent children:', err);
        if (!cancelled) {
          setParentChildren([]);
          setSelectedChildId('');
        }
      } finally {
        if (!cancelled) setChildrenLoaded(true);
      }
    };

    loadParentChildren();
    return () => {
      cancelled = true;
    };
  }, [isParentView, userId]);

  useEffect(() => {
    const fetchActivityLogs = async () => {
      if (!scopedUserReady || !childrenLoaded) {
        return;
      }

      if (isParentView && !selectedChildId) {
        setActivities([]);
        setPagination({ total: 0, pages: 1, current_page: 1 });
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const queryParams = buildActivityLogQueryParams({
          limit,
          itemsPerPage,
          currentPage,
          role,
          userId,
          selectedStudentId: isParentView ? selectedChildId : '',
          debouncedSearch,
          selectedGrade,
          selectedSection,
        });

        const response = await fetch(buildScopedApiUrl(`/api/activity-logs?${queryParams.toString()}`, role), {
          headers: buildAuthHeaders(),
        });
        if (!response.ok) throw new Error('Failed to load activity logs');

        const payload = await response.json();
        const normalized = normalizeActivityLogPayload(payload);
        setActivities(normalized.records);
        setPagination(normalized.pagination);
      } catch (err) {
        console.error('Error fetching activity logs:', err);
        setActivities([]);
        setPagination({ total: 0, pages: 1, current_page: 1 });
        setError('Unable to load activity logs right now.');
      } finally {
        setLoading(false);
      }
    };

    fetchActivityLogs();
  }, [childrenLoaded, currentPage, debouncedSearch, isParentView, limit, role, scopedUserReady, selectedChildId, selectedGrade, selectedSection, userId]);

  const handleGradeChange = useCallback((grade) => {
    setSelectedGrade(grade);
    setSelectedSection('');
    setCurrentPage(1);
  }, []);

  const handleSectionChange = useCallback((section) => {
    setSelectedSection(section);
    setCurrentPage(1);
  }, []);

  const availableSections = selectedGrade ? GRADE_SECTIONS[selectedGrade] || [] : [];
  const totalPages = Math.max(1, pagination.pages || 1);
  const latestActivity = activities[0] || null;
  const reportRows = hasPreparedReport ? preparedRows : activities;
  const reportScope = [selectedGrade, selectedSection, debouncedSearch ? `Search: ${debouncedSearch}` : '']
    .filter(Boolean)
    .join(' / ') || (isParentView ? 'Selected child' : 'All authorised activity records');
  const reportLabel = isParentView || /^\d{6}$/.test(debouncedSearch)
    ? 'Print Student Activity'
    : selectedSection
      ? 'Print Section Activity'
      : 'Print Filtered Activity Log';
  const reportColumns = [
    {
      header: 'Date / Time',
      value: (row) => {
        const timestamp = row.activity_timestamp || row.created_at || row.last_played;
        return timestamp ? `${formatDate(timestamp)} ${formatTime(timestamp)}` : null;
      },
    },
    { header: 'Student ID', value: (row) => row.game_student_id },
    { header: 'Student Name', value: (row) => row.student_name },
    { header: 'Grade', value: (row) => getActivityLogGrade(row) },
    { header: 'Section', value: (row) => row.section },
    { header: 'Activity', value: (row) => getActivityLogActivity(row) },
    { header: 'Duration', value: (row) => formatActivityLogDuration(row) },
  ];

  const prepareActivityReport = async () => {
    setReportError('');
    await prepareAndPrint(async () => {
      try {
        return await collectAuthorizedReportRows({
          pageSize: 200,
          loadPage: async ({ page, limit: reportLimit }) => {
            const queryParams = buildActivityLogQueryParams({
              limit: reportLimit,
              itemsPerPage: reportLimit,
              currentPage: page,
              role,
              userId,
              selectedStudentId: isParentView ? selectedChildId : '',
              debouncedSearch,
              selectedGrade,
              selectedSection,
            });
            const response = await fetch(buildScopedApiUrl(`/api/activity-logs?${queryParams.toString()}`, role), {
              headers: buildAuthHeaders(),
            });
            if (!response.ok) throw new Error('Unable to prepare the activity report');
            const payload = await response.json();
            const normalized = normalizeActivityLogPayload(payload);
            return { rows: normalized.records, pagination: normalized.pagination };
          },
        });
      } catch (err) {
        setReportError('Unable to prepare the activity report right now.');
        throw err;
      }
    });
  };

  const summaryCards = useMemo(() => ([
    { label: 'Total records', value: pagination.total || activities.length || 0 },
    { label: 'Current page', value: `${currentPage} / ${totalPages}` },
    {
      label: 'Latest activity',
      value: latestActivity ? formatDate(latestActivity.activity_timestamp || latestActivity.created_at || latestActivity.last_played) : '-'
    },
  ]), [activities.length, currentPage, latestActivity, pagination.total, totalPages]);

  if (loading) {
    return <div className="al-loading">Loading activity log...</div>;
  }

  if (!scopedUserReady || !childrenLoaded) {
    return <div className="al-loading">Loading activity log...</div>;
  }

  if (error) {
    return <div className="al-error">{error}</div>;
  }

  return (
    <div className="activity-log-container">
      <div className="al-header">
        <h2>{role === 'parent' ? 'Child Activity Log' : 'Student Activity Log'}</h2>
        <p className="al-subtitle">
          {role === 'parent'
            ? "Review gameplay activity, timestamps, and learning progress in a clean parent-focused layout."
            : 'Monitor gameplay sessions, activity details, and engagement metrics with aligned records.'}
        </p>
      </div>

      <div className="al-summary-bar">
        {summaryCards.map((card) => (
          <div key={card.label} className="al-summary-card">
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </div>
        ))}
      </div>

      {showFilters && (
        <div className="al-filters">
          <div className="filter-group">
            <label htmlFor="search-input">Search Student</label>
            <input
              id="search-input"
              type="text"
              placeholder="Search by student name or Student ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="filter-input search-input"
            />
          </div>

          <div className="filter-group">
            <label htmlFor="grade-filter">Grade Level</label>
            <select
              id="grade-filter"
              value={selectedGrade}
              onChange={(e) => handleGradeChange(e.target.value)}
              className="filter-input"
            >
              <option value="">All Grades</option>
              {GRADES.map((grade) => (
                <option key={grade} value={grade}>{grade}</option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="section-filter">Section</label>
            <select
              id="section-filter"
              value={selectedSection}
              onChange={(e) => handleSectionChange(e.target.value)}
              className="filter-input"
              disabled={!selectedGrade}
            >
              <option value="">All Sections</option>
              {availableSections.map((section) => (
                <option key={section} value={section}>{section}</option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => {
              setSearchTerm('');
              setSelectedGrade('');
              setSelectedSection('');
              setCurrentPage(1);
            }}
            className="btn-reset"
          >
            Clear Filters
          </button>
        </div>
      )}

      {isParentView && parentChildren.length > 0 && (
        <div className="al-filters parent-child-filter">
          <div className="filter-group">
            <label htmlFor="child-filter">Child</label>
            <select
              id="child-filter"
              value={selectedChildId}
              onChange={(event) => {
                setSelectedChildId(event.target.value);
                setCurrentPage(1);
              }}
              className="filter-input"
            >
              {parentChildren.map((child) => {
                const childId = String(child.student_id || child.id);
                return (
                  <option key={childId} value={childId}>
                    {child.student_name || child.name || `Child ${childId}`}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      )}

      <div className="al-results-info">
        <div className="table-report-controls">
          <TablePrintButton
            reportTitle={role === 'parent' ? 'Child Activity Log' : 'Activity Log'}
            reportContext={formatReportContext({ scope: reportScope, recordCount: pagination.total || activities.length })}
            label={reportLabel}
            showPrintHeading={false}
            preparing={reportPreparing}
            onPrint={prepareActivityReport}
          />
        </div>
        <span className="results-count">
          Showing {activities.length === 0 ? 0 : (currentPage - 1) * itemsPerPage + 1} - {Math.min((currentPage - 1) * itemsPerPage + activities.length, pagination.total || activities.length)} of {pagination.total || activities.length} records
        </span>
      </div>
      {reportError && <p className="fallback-note no-print">{reportError}</p>}

      {activities.length === 0 ? (
        <div className="al-empty">
          <p>{showFilters ? 'No activity records found. Try adjusting your filters.' : 'No activity records found yet.'}</p>
        </div>
      ) : (
        <>
          <div className="al-table-wrapper">
            <table className="al-table">
              <thead>
                <tr>
                  <th>Student Name</th>
                  <th>Student ID</th>
                  <th>Grade</th>
                  <th>Time</th>
                  <th>Activity</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {activities.map((activity, index) => (
                  <tr key={activity.id ?? `${activity.student_id}-${activity.activity_timestamp}-${index}`} className={index % 2 === 0 ? 'even' : 'odd'}>
                    <td className="name-cell">
                      <strong>{activity.student_name || '-'}</strong>
                    </td>
                    <td>{activity.game_student_id || 'Not linked'}</td>
                    <td className="grade-cell">
                      <span className="grade-badge">{getActivityLogGrade(activity)}</span>
                    </td>
                    <td className="timestamp-cell">
                      <div className="timestamp-stack">
                        <strong>{formatTime(activity.started_at || activity.timestamp || activity.activity_timestamp || activity.last_played || activity.created_at)}</strong>
                      </div>
                    </td>
                    <td className="quest-cell">
                      <span className="quest-name">{getActivityLogActivity(activity)}</span>
                    </td>
                    <td className="playtime-cell">
                      <span className="playtime">{formatActivityLogDuration(activity)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="al-pagination">
              <button
                type="button"
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
                className="pagination-btn"
              >
                Previous
              </button>
              <span className="pagination-info">
                Page {currentPage} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={currentPage === totalPages}
                className="pagination-btn"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
      <PrintableTableReport
        title={reportLabel.replace(/^Print /, '')}
        context={reportScope}
        rows={reportRows}
        columns={reportColumns}
      />
    </div>
  );
}

function formatTime(dateTime) {
  if (!dateTime) return '-';
  const date = new Date(dateTime);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDate(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
