import React, { useCallback, useEffect, useMemo, useState } from 'react';
import '../styles/activitylog.css';
import {
  buildActivityLogQueryParams,
  normalizeActivityLogPayload,
  shouldShowActivityLogFilters,
} from './activityLog.utils';
import { buildScopedApiUrl } from './analyticsEndpoints';

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
  const requiresScopedUser = role === 'teacher' || role === 'parent';
  const scopedUserReady = !requiresScopedUser || Boolean(userId);
  const showFilters = shouldShowActivityLogFilters(role);

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
    const fetchActivityLogs = async () => {
      if (!scopedUserReady) {
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
          debouncedSearch,
          selectedGrade,
          selectedSection,
        });

        const response = await fetch(buildScopedApiUrl(`/api/activity-logs?${queryParams.toString()}`, role, userId));
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
  }, [currentPage, debouncedSearch, limit, role, scopedUserReady, selectedGrade, selectedSection, userId]);

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

  if (!scopedUserReady) {
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
              placeholder="Search by student name..."
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

      <div className="al-results-info">
        <span className="results-count">
          Showing {activities.length === 0 ? 0 : (currentPage - 1) * itemsPerPage + 1} - {Math.min((currentPage - 1) * itemsPerPage + activities.length, pagination.total || activities.length)} of {pagination.total || activities.length} records
        </span>
      </div>

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
                  <th>Student</th>
                  <th>Grade Level</th>
                  <th>Section</th>
                  <th>Action</th>
                  <th>Current Quest</th>
                  <th>Save Status</th>
                  <th>Play Time</th>
                  <th>Last Played</th>
                  <th>Progress</th>
                  <th>Difficulty</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {activities.map((activity, index) => (
                  <tr key={activity.id ?? `${activity.student_id}-${activity.activity_timestamp}-${index}`} className={index % 2 === 0 ? 'even' : 'odd'}>
                    <td className="name-cell">
                      <div className="student-detail-stack">
                        <strong>{activity.student_name || '-'}</strong>
                        <span className={`status-chip ${(activity.status || '').toLowerCase() === 'online' ? 'online' : 'offline'}`}>
                          {activity.status || 'Offline'}
                        </span>
                      </div>
                    </td>
                    <td className="grade-cell">
                      <span className="grade-badge">{activity.grade_level || '-'}</span>
                    </td>
                    <td className="section-cell">{activity.section || '-'}</td>
                    <td className="action-cell">
                      <span className="action-text">{activity.activity_description || 'Gameplay Session'}</span>
                    </td>
                    <td className="quest-cell">
                      <span className="quest-name">{activity.current_quest || 'No Active Quest'}</span>
                    </td>
                    <td className="save-status-cell">{getSaveStatusBadge(activity.save_status)}</td>
                    <td className="playtime-cell">
                      <span className="playtime">{formatDuration(activity.total_play_time)}</span>
                    </td>
                    <td className="last-played-cell">{formatTime(activity.last_played)}</td>
                    <td className="progress-cell">
                      <div className="al-progress-bar">
                        <div className="al-progress-track">
                          <div className="al-progress-fill" style={{ width: `${activity.quest_progress || 0}%` }} />
                        </div>
                        <span className="al-progress-text">{activity.quest_progress || 0}%</span>
                      </div>
                    </td>
                    <td className="difficulty-cell">
                      <span className={`difficulty-badge difficulty-${String(activity.difficulty_level || 'normal').toLowerCase()}`}>
                        {activity.difficulty_level || 'Normal'}
                      </span>
                    </td>
                    <td className="timestamp-cell">
                      <div className="timestamp-stack">
                        <strong>{formatDate(activity.activity_timestamp || activity.created_at)}</strong>
                        <span>{formatTime(activity.activity_timestamp || activity.created_at)}</span>
                      </div>
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

function formatDuration(seconds) {
  if (!seconds) return '-';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getSaveStatusBadge(status) {
  const isSaved = String(status || '').toLowerCase() === 'saved' || String(status || '').toLowerCase() === 'completed';
  return (
    <span className={`save-badge ${isSaved ? 'saved' : 'pending'}`}>
      {isSaved ? 'Saved' : 'Pending'}
    </span>
  );
}
