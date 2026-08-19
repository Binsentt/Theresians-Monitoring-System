import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import DashboardLoadingShell from './layout/DashboardLoadingShell';
import logoImage from '../assets/images/STS_Logo.png';
import { isTeacherRole, normalizeRole } from './manageUsers.utils';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { buildAuthHeaders, getStoredUserSession } from './session.utils';
import { TablePrintButton } from './TablePrintButton';
import { formatTableRange, matchesTableSearch, paginateTableRows } from './tableReporting.utils';
import '../styles/topachievers.css';

export default function TeacherTopAchievers() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [topAchievers, setTopAchievers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedGrade, setSelectedGrade] = useState('');
  const [selectedSection, setSelectedSection] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 10;

  useEffect(() => {
    const initializeComponent = async () => {
      try {
        // Load and apply theme
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
        if (!loggedInUser || !isTeacherRole(loggedInUser.role)) {
          navigate('/login');
          return;
        }

        setUser({ ...loggedInUser, role: normalizeRole(loggedInUser.role) });

        // Fetch top achievers data for teacher's assigned students
        const response = await fetch(buildScopedApiUrl('/api/top-achievers', loggedInUser.role), {
          headers: buildAuthHeaders(),
        });
        if (response.ok) {
          const data = await response.json();
          setTopAchievers(Array.isArray(data) ? data : []);
        } else {
          setError('Failed to load top achievers');
        }
      } catch (err) {
        console.error('Error initializing component:', err);
        setError('Connection error');
      } finally {
        setLoading(false);
      }
    };

    initializeComponent();
  }, [navigate]);

  // Extract unique grades and sections from teacher's assigned students
  const grades = [...new Set(topAchievers.map(a => a.grade_level).filter(Boolean))].sort();
  const sections = selectedGrade
    ? [...new Set(topAchievers.filter(a => a.grade_level === selectedGrade).map(a => a.section).filter(Boolean))].sort()
    : [...new Set(topAchievers.map(a => a.section).filter(Boolean))].sort();

  // Filter achievers based on selected filters
  const filteredAchievers = useMemo(() => topAchievers.filter(achiever => {
    const matchesGrade = !selectedGrade || achiever.grade_level === selectedGrade;
    const matchesSection = !selectedSection || achiever.section === selectedSection;
    const matchesSearch = matchesTableSearch(achiever, searchQuery, ['student_name', 'game_student_id']);
    return matchesGrade && matchesSection && matchesSearch;
  }), [searchQuery, selectedGrade, selectedSection, topAchievers]);
  const paginatedAchievers = paginateTableRows(filteredAchievers, page, pageSize);

  useEffect(() => {
    if (page !== paginatedAchievers.currentPage) setPage(paginatedAchievers.currentPage);
  }, [page, paginatedAchievers.currentPage]);

  // Reset all filters
  const resetFilters = () => {
    setSelectedGrade('');
    setSelectedSection('');
    setSearchQuery('');
    setPage(1);
  };

  // Check if any filters are active
  const hasActiveFilters = selectedGrade || selectedSection || searchQuery;
  const formatPercent = (value) => {
    if (value === null || value === undefined || value === '') return 'No Data';
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? `${numericValue.toFixed(1)}%` : 'No Data';
  };
  const metricPercentWidth = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.min(100, Math.max(0, numericValue)) : null;
  };
  const formatMetric = (value) => (value === null || value === undefined || value === '' ? '—' : value);
  const formatPlaytime = (seconds) => {
    const totalSeconds = Number(seconds || 0);
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'N/A';
    const minutes = Math.floor(totalSeconds / 60);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return hours > 0 ? `${hours}h ${remainingMinutes}m` : `${Math.max(1, minutes)}m`;
  };


  if (loading) {
    const loadingRole = normalizeRole(getStoredUserSession()?.role);
    return (
      <DashboardLoadingShell
        role={loadingRole === 'parent_teacher' ? 'parent_teacher' : 'teacher'}
        activeItem="top-achievers"
        logoSrc={logoImage}
        portalLabel="Teacher Portal"
        heading="Top Achievers"
        subheading="View student achievements and learning progress."
      />
    );
  }

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role={normalizeRole(user?.role) === 'parent_teacher' ? 'parent_teacher' : 'teacher'}
          activeItem="top-achievers"
          logoSrc={logoImage}
          portalLabel="Teacher Portal"
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div className="header-info">
              <h1>Top Achievers</h1>
              <p>Recognition of students with exceptional performance and quest completion.</p>
            </div>
          </TopBar>

          <PageContent>
            <ContentSection>
              <div className="filters-section">
                <div className="filters-row">
                  <div className="filter-group">
                    <label>Grade Level</label>
                    <select
                      value={selectedGrade}
                      onChange={(e) => {
                        setSelectedGrade(e.target.value);
                        setSelectedSection(''); // Reset section when grade changes
                        setPage(1);
                      }}
                    >
                      <option value="">All Grades</option>
                      {grades.map(grade => (
                        <option key={grade} value={grade}>{grade}</option>
                      ))}
                    </select>
                  </div>

                  <div className="filter-group">
                    <label>Section</label>
                    <select
                      value={selectedSection}
                      onChange={(e) => {
                        setSelectedSection(e.target.value);
                        setPage(1);
                      }}
                      disabled={!selectedGrade && sections.length === 0}
                    >
                      <option value="">
                        {selectedGrade ? 'All Sections' : 'Select Grade First'}
                      </option>
                      {sections.map(section => (
                        <option key={section} value={section}>{section}</option>
                      ))}
                    </select>
                  </div>

                  <div className="filter-group">
                    <label>Search Students</label>
                    <input
                      type="search"
                      placeholder="Search by student name or Student ID..."
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        setPage(1);
                      }}
                    />
                  </div>

                  <div className="filter-actions">
                    {hasActiveFilters && (
                      <button
                        className="btn-reset"
                        onClick={resetFilters}
                        type="button"
                      >
                        Clear Filters
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </ContentSection>

            <ContentSection title={`Top Achievers (${filteredAchievers.length} found)`}>
              <div className="table-report-controls">
                <TablePrintButton reportTitle="Top Achievers" reportContext={formatTableRange(paginatedAchievers)} />
              </div>
              {error ? (
                <div className="error-message">{error}</div>
              ) : filteredAchievers.length === 0 ? (
                <div className="empty-message">
                  {hasActiveFilters
                    ? 'No students match the selected filters.'
                    : 'No leaderboard data available yet.'
                  }
                </div>
              ) : (
                <>
                  <div className="top-achievers-container">
                  <table className="ta-table">
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Student Name</th>
                        <th>Student ID</th>
                        <th>Grade</th>
                        <th>Section</th>
                        <th>Completion</th>
                        <th>Accuracy</th>
                        <th>Correct Answers</th>
                        <th>Quests</th>
                        <th>Playtime</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedAchievers.rows.map((achiever, index) => {
                        const rank = paginatedAchievers.start + index;
                        const completion = achiever.completion_percentage ?? achiever.progress_percentage;
                        const accuracy = achiever.accuracy ?? achiever.accuracy_rate;
                        const completionWidth = metricPercentWidth(completion);
                        const accuracyWidth = metricPercentWidth(accuracy);
                        return (
                        <tr key={achiever.id || `achiever-${rank}`} className={rank <= 3 ? 'top-three' : ''}>
                          <td className="rank-cell">
                            <span className="rank-num">#{rank}</span>
                            {rank === 1 && <span className="rank-badge gold">Gold</span>}
                            {rank === 2 && <span className="rank-badge silver">Silver</span>}
                            {rank === 3 && <span className="rank-badge bronze">Bronze</span>}
                          </td>
                          <td className="name-cell">{achiever.student_name || 'Unknown'}</td>
                          <td>{achiever.game_student_id || 'Not linked'}</td>
                          <td>{achiever.grade_level || 'N/A'}</td>
                          <td>{achiever.section || 'N/A'}</td>
                          <td className="progress-cell">
                            <div className="progress-bar">
                              {completionWidth !== null && (
                                <div className="progress-fill" style={{ width: `${completionWidth}%` }} />
                              )}
                            </div>
                            <span className="progress-text">{formatPercent(completion)}</span>
                          </td>
                          <td className="accuracy-cell">
                            <div className="accuracy-bar">
                              {accuracyWidth !== null && (
                                <div className="accuracy-fill" style={{ width: `${accuracyWidth}%` }} />
                              )}
                            </div>
                            <span className="accuracy-text">{formatPercent(accuracy)}</span>
                          </td>
                          <td>{formatMetric(achiever.total_correct_answers ?? achiever.correct_answers)}/{formatMetric(achiever.total_questions_answered ?? achiever.total_questions)}</td>
                          <td>{formatMetric(achiever.quests_completed ?? achiever.total_quests_completed)}</td>
                          <td>{formatPlaytime(achiever.total_play_time ?? achiever.duration_seconds)}</td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                  {paginatedAchievers.totalPages > 1 && (
                    <div className="pagination-row no-print">
                      <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={paginatedAchievers.currentPage === 1}>Previous</button>
                      <span>Page {paginatedAchievers.currentPage} of {paginatedAchievers.totalPages}</span>
                      <button type="button" onClick={() => setPage((current) => Math.min(paginatedAchievers.totalPages, current + 1))} disabled={paginatedAchievers.currentPage === paginatedAchievers.totalPages}>Next</button>
                    </div>
                  )}
                </>
              )}
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}
