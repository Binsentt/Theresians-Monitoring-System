import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import { buildScopedApiUrl } from './analyticsEndpoints';
import { buildAuthHeaders } from './session.utils';
import {
  filterStudentProgress,
  formatPercent,
  loadStudentProgressListState,
  normalizeStudentProgressPayload,
  saveStudentProgressListState,
} from './studentProgress.utils';
import { StudentInsightsPanel } from './GroundedAiAnalysis';
import { TablePrintButton } from './TablePrintButton';
import { PrintableTableReport } from './PrintableTableReport';
import { formatReportContext } from './tableReporting.utils';
import { LearningCycleResetAction } from './LearningCycleResetAction';
import {
  BulkStudentProgressLifecycleAction,
  StudentProgressArchiveAction,
  StudentProgressPermanentDeleteAction,
} from './StudentProgressLifecycleActions';
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

export default function AdminStudentProgress() {
  const navigate = useNavigate();
  const initialListState = useMemo(() => loadStudentProgressListState('admin'), []);
  const filterChangeReadyRef = useRef(false);
  const scrollRestoredRef = useRef(false);
  const [students, setStudents] = useState([]);
  const [overview, setOverview] = useState(null);
  const [searchQuery, setSearchQuery] = useState(initialListState.searchQuery);
  const [page, setPage] = useState(initialListState.page);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [lifecycle, setLifecycle] = useState(initialListState.lifecycle);
  const pageSize = 10;

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      setError('');
      try {
        const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
        const role = loggedInUser?.role || 'admin';
        const requestOptions = { headers: buildAuthHeaders() };
        const [studentsResult, overviewResult] = await Promise.allSettled([
          fetch(buildScopedApiUrl(`/api/students/progress?lifecycle=${lifecycle}`, role), requestOptions),
          fetch(buildScopedApiUrl('/api/analytics/overview', role), requestOptions),
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

      } catch (err) {
        console.error('Load error:', err);
        setError('Analytics currently unavailable. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [refreshToken, lifecycle]);

  const filteredStudents = useMemo(() => {
    return filterStudentProgress(students, { searchQuery });
  }, [students, searchQuery]);

  useEffect(() => {
    if (!filterChangeReadyRef.current) {
      filterChangeReadyRef.current = true;
      return;
    }
    setPage(1);
  }, [searchQuery, lifecycle]);

  useEffect(() => {
    if (loading || scrollRestoredRef.current || initialListState.scrollTop <= 0) return;
    scrollRestoredRef.current = true;
    window.requestAnimationFrame(() => {
      const scrollContainer = document.querySelector('.page-content');
      if (scrollContainer) scrollContainer.scrollTop = initialListState.scrollTop;
      else window.scrollTo(0, initialListState.scrollTop);
    });
  }, [initialListState.scrollTop, loading]);

  const paginatedStudents = filteredStudents.slice((page - 1) * pageSize, page * pageSize);
  const pageCount = Math.max(1, Math.ceil(filteredStudents.length / pageSize));
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  const hasActiveStudentFilters = Boolean(searchQuery);
  const reportScope = [lifecycle === 'archived' ? 'Archived Progress' : 'Active Progress', searchQuery ? `Search: ${searchQuery}` : ''].filter(Boolean).join(' / ') || 'All authorised students';

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role="admin"
          activeItem="student-progress"
          logoSrc={logoImage}
          portalLabel="Admin Portal"
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div className="header-info">
              <h1>Student Performance Dashboard</h1>
              <p>Monitor deterministic student metrics. Open View Analysis for optional grounded, student-specific insights.</p>
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
                    <label>Progress view</label>
                    <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value)}>
                      <option value="active">Active Progress</option>
                      <option value="archived">Archived Progress</option>
                    </select>
                  </div>
                  <div className="filter-group filter-search">
                    <label>Search student progress</label>
                    <input
                      type="search"
                      aria-label="Search Admin Student Progress"
                      placeholder="Name, Student ID, Grade, Section, Quest, Difficulty, or Location"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="analytics-insights-panel">
                <StudentInsightsPanel students={filteredStudents} role="admin" />
              </div>
            </ContentSection>

            <ContentSection
              title={`${lifecycle === 'archived' ? 'Archived Student Progress' : 'Student Progress'} Table (${filteredStudents.length} records found)`}
              className="student-progress-table-section"
              contentClassName="student-progress-table-shell"
            >
              <div className="table-report-controls">
                <TablePrintButton
                  reportTitle={lifecycle === 'archived' ? 'Archived Student Progress List' : 'Student Progress List'}
                  reportContext={formatReportContext({ scope: reportScope, recordCount: filteredStudents.length })}
                  label="Print Student List"
                  showPrintHeading={false}
                />
                {lifecycle === 'active' && (
                  <div className="student-lifecycle-bulk-actions no-print">
                    <BulkStudentProgressLifecycleAction operation="reset" role="admin" onComplete={() => setRefreshToken((value) => value + 1)} />
                    <BulkStudentProgressLifecycleAction operation="archive" role="admin" onComplete={() => setRefreshToken((value) => value + 1)} />
                  </div>
                )}
              </div>
              <div className="table-wrapper">
                {loading ? (
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
                        <tr key={student.student_id}>
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
                            {lifecycle === 'active' ? (
                              <div className="student-progress-row-actions">
                                <button
                                  type="button"
                                  className="table-action-button"
                                  onClick={() => {
                                    const scrollContainer = document.querySelector('.page-content');
                                    saveStudentProgressListState('admin', {
                                      searchQuery,
                                      page,
                                      lifecycle,
                                      scrollTop: scrollContainer?.scrollTop ?? window.scrollY,
                                    });
                                    navigate(`/admin/student-progress/${student.student_id}`);
                                  }}
                                >
                                  View Analytics
                                </button>
                                <LearningCycleResetAction
                                  studentId={student.student_id}
                                  role="admin"
                                  onReset={() => setRefreshToken((value) => value + 1)}
                                />
                                <StudentProgressArchiveAction
                                  studentId={student.student_id}
                                  role="admin"
                                  onComplete={() => setRefreshToken((value) => value + 1)}
                                />
                              </div>
                            ) : (
                              <StudentProgressPermanentDeleteAction
                                studentId={student.student_id}
                                onComplete={() => setRefreshToken((value) => value + 1)}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="pagination-row no-print">
                <button disabled={page <= 1} onClick={() => setPage((prev) => Math.max(prev - 1, 1))}>Previous</button>
                <span>{filteredStudents.length === 0 ? '0 records' : `Showing ${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, filteredStudents.length)} of ${filteredStudents.length}`} · Page {page} of {pageCount}</span>
                <button disabled={page >= pageCount} onClick={() => setPage((prev) => Math.min(prev + 1, pageCount))}>Next</button>
              </div>
              <PrintableTableReport
                title={lifecycle === 'archived' ? 'Archived Student Progress List' : 'Student Progress List'}
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
