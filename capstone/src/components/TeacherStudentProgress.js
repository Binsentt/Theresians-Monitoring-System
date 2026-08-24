import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { buildAuthHeaders, resolveAuthorizedSession } from './session.utils';
import { normalizeRole } from './manageUsers.utils';
import {
  filterStudentProgress,
  formatPercent,
  getStudentProgressSectionOptions,
  normalizeDisplayList,
  normalizeStudentProgressPayload,
} from './studentProgress.utils';
import { TablePrintButton } from './TablePrintButton';
import { PrintableTableReport } from './PrintableTableReport';
import { formatReportContext } from './tableReporting.utils';
import { LearningCycleResetAction } from './LearningCycleResetAction';
import '../styles/studentprogress.css';

const studentReportColumns = [
  { header: 'No.', value: (_, index) => index + 1 },
  { header: 'Student Name', value: (row) => row.student_name },
  { header: 'Student ID', value: (row) => row.game_student_id },
  { header: 'Grade', value: (row) => row.grade_level },
  { header: 'Section', value: (row) => row.section },
  { header: 'Current Quest', value: (row) => row.current_quest },
  { header: 'Correct', value: (row) => row.correct_answers },
  { header: 'Incorrect', value: (row) => row.incorrect_answers },
  { header: 'Accuracy', value: (row) => formatPercent(row.performance_percentage, 'Not available') },
  { header: 'Difficulty', value: (row) => row.difficulty_level || row.difficulty },
];

export default function TeacherStudentProgress() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [students, setStudents] = useState([]);
  const [overview, setOverview] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [selectedGrade, setSelectedGrade] = useState('');
  const [selectedSection, setSelectedSection] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const pageSize = 10;

  useEffect(() => {
    const hydrateSession = () => {
      const savedTheme = localStorage.getItem('theme') || 'light';
      document.documentElement.setAttribute('data-theme', savedTheme);

      const authorizedUser = resolveAuthorizedSession('teacher');
      setUser(authorizedUser);
      setAuthReady(true);
    };

    hydrateSession();
  }, []);

  useEffect(() => {
    if (!authReady) return;

    if (!user) {
      navigate('/login');
    }
  }, [authReady, navigate, user]);

  useEffect(() => {
    if (!authReady || !user) return;

    const loadData = async () => {
      setLoading(true);
      setError('');
      try {
        const requestOptions = {
          headers: buildAuthHeaders(),
        };
        const [studentsResult, overviewResult, recommendationsResult] = await Promise.allSettled([
          fetch(buildScopedApiUrl('/api/students/progress', user.role, user.id), requestOptions),
          fetch(buildScopedApiUrl('/api/analytics/overview', user.role, user.id), requestOptions),
          fetch(buildScopedApiUrl('/api/analytics/recommendations', user.role, user.id), requestOptions),
        ]);

        if (studentsResult.status !== 'fulfilled' || !studentsResult.value.ok) {
          throw new Error('Could not load students');
        }

        const studentPayload = await studentsResult.value.json();
        setStudents(normalizeStudentProgressPayload(studentPayload));

        if (overviewResult.status === 'fulfilled' && overviewResult.value.ok) {
          const overviewData = await overviewResult.value.json();
          setOverview(overviewData);
        } else {
          setOverview(null);
        }

        if (recommendationsResult.status === 'fulfilled' && recommendationsResult.value.ok) {
          const recommendationsData = await recommendationsResult.value.json();
          setRecommendations(normalizeDisplayList(recommendationsData?.recommendations));
        } else {
          setRecommendations([]);
        }
      } catch (err) {
        console.error('Load error:', err);
        setError('Analytics currently unavailable. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [authReady, user, refreshToken]);

  const grades = useMemo(() => {
    return Array.from(new Set(students.map((student) => student.grade_level || 'Unknown'))).sort();
  }, [students]);

  const sectionOptions = useMemo(() => {
    return getStudentProgressSectionOptions(students, selectedGrade);
  }, [students, selectedGrade]);

  const filteredStudents = useMemo(() => {
    return filterStudentProgress(students, {
      searchQuery,
      selectedGrade,
      selectedSection,
    });
  }, [students, searchQuery, selectedGrade, selectedSection]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, selectedGrade, selectedSection]);

  const paginatedStudents = filteredStudents.slice((page - 1) * pageSize, page * pageSize);
  const pageCount = Math.max(1, Math.ceil(filteredStudents.length / pageSize));
  const hasActiveStudentFilters = Boolean(searchQuery || selectedGrade || selectedSection);
  const reportScope = [selectedGrade, selectedSection, searchQuery ? `Search: ${searchQuery}` : ''].filter(Boolean).join(' / ') || 'All authorised students';

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role={normalizeRole(user?.role) === 'parent_teacher' ? 'parent_teacher' : 'teacher'}
          activeItem="student-progress"
          logoSrc={logoImage}
          portalLabel="Teacher Portal"
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div className="header-info">
              <h1>Student Progress</h1>
              <p>Monitor your students' performance and progress across all grades.</p>
            </div>
          </TopBar>

          <PageContent>
            <ContentSection
              title="Performance Overview"
              contentClassName="student-progress-summary-grid"
            >
              <div className="analytics-card">
                <span>Total students</span>
                <strong>{overview?.studentCount ?? students.length}</strong>
              </div>
              <div className="analytics-card">
                <span>Average accuracy</span>
                <strong>{overview?.averageAccuracy ?? '--'}%</strong>
              </div>
              <div className="analytics-card">
                <span>Average completion</span>
                <strong>{overview?.averageProgress ?? '--'}%</strong>
              </div>
            </ContentSection>

            <ContentSection
              title="Filters & Student Insights"
              contentClassName="student-progress-panel"
            >
              <div className="student-progress-filters-card">
                <div className="student-progress-filters">
                  <div className="filter-group">
                    <label>Grade</label>
                    <select value={selectedGrade} onChange={(e) => setSelectedGrade(e.target.value)}>
                      <option value="">All grades</option>
                      {grades.map((grade) => (
                        <option key={grade} value={grade}>{grade}</option>
                      ))}
                    </select>
                  </div>
                  <div className="filter-group">
                    <label>Section</label>
                    <select value={selectedSection} onChange={(e) => setSelectedSection(e.target.value)} disabled={!sectionOptions.length}>
                      <option value="">All sections</option>
                      {sectionOptions.map((section) => (
                        <option key={section} value={section}>{section}</option>
                      ))}
                    </select>
                  </div>
                  <div className="filter-group filter-search">
                    <label>Search student</label>
                    <input
                      type="search"
                      placeholder="Search by name or Student ID"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="analytics-insights-panel">
                <div className="insights-header">
                  <h2>Student Insights</h2>
                  <p>Grounded AI interpretation is requested per student from View Analysis.</p>
                </div>
                {recommendations.length > 0 ? (
                  <ul className="recommendation-list">
                    {recommendations.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="fallback-note">Open a student’s View Analysis to see recorded metrics or request a grounded insight when enough results are available.</div>
                )}
              </div>
            </ContentSection>

            <ContentSection
              title={`Student Progress Table (${filteredStudents.length} records found)`}
              className="student-progress-table-section"
              contentClassName="student-progress-table-shell"
            >
              <div className="table-report-controls">
                <TablePrintButton
                  reportTitle="Student Progress List"
                  reportContext={formatReportContext({ scope: reportScope, recordCount: filteredStudents.length })}
                  label="Print Student List"
                  showPrintHeading={false}
                  disabled={!filteredStudents.length}
                />
              </div>
              <div className="table-wrapper">
                {!authReady || loading ? (
                  <div className="loading-state">Loading performance data...</div>
                ) : error ? (
                  <div className="fallback-note">{error}</div>
                ) : filteredStudents.length === 0 ? (
                  <div className="empty-state">{hasActiveStudentFilters ? 'No student records match the current filter.' : 'No student records are available yet.'}</div>
                ) : (
                  <table className="student-progress-table">
                    <thead>
                      <tr>
                        <th>No.</th>
                        <th>Student Name</th>
                        <th>Student ID</th>
                        <th>Grade Level</th>
                        <th>Section</th>
                        <th>Current Quest</th>
                        <th>Correct</th>
                        <th>Incorrect</th>
                        <th>Accuracy</th>
                        <th>Difficulty</th>
                        <th className="no-print">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedStudents.map((student, index) => (
                        <tr
                          key={student.student_id}
                          className="clickable-row"
                          onClick={() => navigate(`/teacher/student-progress/${student.student_id}`)}
                        >
                          <td>{((page - 1) * pageSize) + index + 1}</td>
                          <td>{student.student_name || 'Unknown'}</td>
                          <td>{student.game_student_id || 'Not linked'}</td>
                          <td>{student.grade_level || 'N/A'}</td>
                          <td>{student.section || 'Not assigned'}</td>
                          <td>{student.current_quest || 'N/A'}</td>
                          <td>{student.correct_answers ?? 'Not available'}</td>
                          <td>{student.incorrect_answers ?? 'Not available'}</td>
                          <td>{formatPercent(student.performance_percentage, 'Not available')}</td>
                          <td className="difficulty-cell">
                            <div className={`difficulty-chip ${String(student.difficulty_level || student.difficulty || 'Unknown').toLowerCase()}`}>
                              {student.difficulty_level || student.difficulty || 'Unknown'}
                            </div>
                          </td>
                          <td className="table-action-cell no-print">
                            <button
                              type="button"
                              className="table-action-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                navigate(`/teacher/student-progress/${student.student_id}`);
                              }}
                            >
                              View Analytics
                            </button>
                            <LearningCycleResetAction
                              studentId={student.student_id}
                              role={user?.role || 'teacher'}
                              onReset={() => setRefreshToken((value) => value + 1)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="pagination-row no-print">
                <button disabled={page <= 1} onClick={() => setPage((prev) => Math.max(prev - 1, 1))}>Previous</button>
                <span>Page {page} of {pageCount}</span>
                <button disabled={page >= pageCount} onClick={() => setPage((prev) => Math.min(prev + 1, pageCount))}>Next</button>
              </div>
              <PrintableTableReport
                title="Student Progress List"
                context={reportScope}
                rows={filteredStudents}
                columns={studentReportColumns}
              />
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}
