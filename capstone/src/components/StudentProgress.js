import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import '../styles/studentprogress.css';

const defaultSectionMap = {
  'Grade 1': ['Section A', 'Section B', 'Section C'],
  'Grade 2': ['Section A', 'Section B', 'Section C'],
  'Grade 3': ['Section A', 'Section B', 'Section C'],
  'Grade 4': ['Section A', 'Section B', 'Section C'],
  'Grade 5': ['Section A', 'Section B', 'Section C'],
  'Grade 6': ['Section A', 'Section B', 'Section C'],
};

const getDefaultSection = (grade, studentId) => {
  const letters = ['A', 'B', 'C'];
  const index = studentId ? studentId % letters.length : 0;
  return `Section ${letters[index]}`;
};

export default function StudentProgress() {
  const navigate = useNavigate();
  const [userRole, setUserRole] = useState('admin');
  const [students, setStudents] = useState([]);
  const [overview, setOverview] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [selectedGrade, setSelectedGrade] = useState('');
  const [selectedSection, setSelectedSection] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pageSize = 10;

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      setError('');
      try {
        // Determine user role
        const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
        if (loggedInUser && loggedInUser.role) {
          setUserRole(loggedInUser.role.toLowerCase());
        }

        const [studentsResult, overviewResult, recommendationsResult] = await Promise.allSettled([
          fetch('http://localhost:5000/api/students/progress'),
          fetch('http://localhost:5000/api/analytics/overview'),
          fetch('http://localhost:5000/api/analytics/recommendations'),
        ]);

        if (studentsResult.status !== 'fulfilled' || !studentsResult.value.ok) {
          throw new Error('Could not load students');
        }

        const studentsRes = studentsResult.value;
        if (!studentsRes.ok) throw new Error('Could not load students');
        const studentData = await studentsRes.json();
        const normalized = studentData.map((row) => ({
          ...row,
          section: row.section || getDefaultSection(row.grade_level, row.student_id),
          incorrect_answers: Number(row.incorrect_answers ?? (row.total_questions - row.correct_answers || 0)),
          performance_percentage: Number(row.performance_percentage || row.accuracy_rate || row.progress_percentage || 0),
        }));
        setStudents(normalized);

        if (overviewResult.status === 'fulfilled' && overviewResult.value.ok) {
          const overviewData = await overviewResult.value.json();
          setOverview(overviewData);
        } else {
          setOverview(null);
        }

        if (recommendationsResult.status === 'fulfilled' && recommendationsResult.value.ok) {
          const recommendationsData = await recommendationsResult.value.json();
          setRecommendations(Array.isArray(recommendationsData.recommendations) ? recommendationsData.recommendations : []);
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
  }, []);

  const grades = useMemo(() => {
    return Array.from(new Set(students.map((student) => student.grade_level || 'Unknown'))).sort();
  }, [students]);

  const sectionOptions = useMemo(() => {
    const available = Array.from(
      new Set(
        students
          .filter((s) => !selectedGrade || s.grade_level === selectedGrade)
          .map((s) => s.section || getDefaultSection(s.grade_level, s.student_id))
          .filter(Boolean)
      )
    ).sort();

    if (selectedGrade && available.length === 0) {
      return defaultSectionMap[selectedGrade] || ['Section A', 'Section B', 'Section C'];
    }
    return available;
  }, [students, selectedGrade]);

  const filteredStudents = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return students.filter((student) => {
      const matchesGrade = selectedGrade ? student.grade_level === selectedGrade : true;
      const matchesSection = selectedSection ? student.section === selectedSection : true;
      const matchesSearch = query ? student.student_name?.toLowerCase().includes(query) : true;
      return matchesGrade && matchesSection && matchesSearch;
    });
  }, [students, searchQuery, selectedGrade, selectedSection]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, selectedGrade, selectedSection]);

  const paginatedStudents = filteredStudents.slice((page - 1) * pageSize, page * pageSize);
  const pageCount = Math.max(1, Math.ceil(filteredStudents.length / pageSize));

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role={userRole}
          activeItem="student-progress"
          logoSrc={logoImage}
          portalLabel={`${userRole.charAt(0).toUpperCase() + userRole.slice(1)} Portal`}
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div className="header-info">
              <h1>Student Performance Dashboard</h1>
              <p>Monitor all students across Grades 1–6 with smart filters, live search, and AI-driven recommendations.</p>
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
              <div className="analytics-card">
                <span>Grade groups</span>
                <strong>{grades.length}</strong>
              </div>
            </ContentSection>

            <ContentSection
              title="Filters & Recommendations"
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
                      placeholder="Search by name"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="analytics-insights-panel">
                <div className="insights-header">
                  <h2>AI Recommendations</h2>
                  <p>Smart guidance based on current quest and grade performance.</p>
                </div>
                {recommendations.length > 0 ? (
                  <ul className="recommendation-list">
                    {recommendations.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="fallback-note">Analytics currently unavailable. Please try again later.</div>
                )}
              </div>
            </ContentSection>

            <ContentSection
              title={`Student Progress Table (${filteredStudents.length} records found)`}
              className="student-progress-table-section"
              contentClassName="student-progress-table-shell"
            >
              <div className="table-wrapper">
          {loading ? (
            <div className="loading-state">Loading performance data...</div>
          ) : error ? (
            <div className="fallback-note">{error}</div>
          ) : filteredStudents.length === 0 ? (
            <div className="empty-state">No student records match the current filter.</div>
          ) : (
            <table className="student-progress-table">
              <thead>
                <tr>
                  <th>Student Name</th>
                  <th>Grade Level</th>
                  <th>Section</th>
                  <th>Current Quest</th>
                  <th>Correct</th>
                  <th>Incorrect</th>
                  <th>Accuracy</th>
                  <th>Difficulty</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginatedStudents.map((student) => (
                  <tr
                    key={student.student_id}
                    className="clickable-row"
                    onClick={() => navigate(`/student-progress/${student.student_id}`)}
                  >
                    <td>{student.student_name || 'Unknown'}</td>
                    <td>{student.grade_level || 'N/A'}</td>
                    <td>{student.section || getDefaultSection(student.grade_level, student.student_id)}</td>
                    <td>{student.current_quest || 'N/A'}</td>
                    <td>{student.correct_answers ?? 0}</td>
                    <td>{student.incorrect_answers ?? 0}</td>
                    <td>{Number(student.performance_percentage || 0).toFixed(0)}%</td>
                    <td className="difficulty-cell">
                      <div className="difficulty-chip easy">E {student.difficultyBreakdown?.easy ?? 0}%</div>
                      <div className="difficulty-chip medium">M {student.difficultyBreakdown?.medium ?? 0}%</div>
                      <div className="difficulty-chip hard">H {student.difficultyBreakdown?.hard ?? 0}%</div>
                    </td>
                    <td className="table-action-cell">
                      <button
                        type="button"
                        className="table-action-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          navigate(`/student-progress/${student.student_id}`);
                        }}
                      >
                        View Analytics
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </div>

          <div className="pagination-row">
            <button disabled={page <= 1} onClick={() => setPage((prev) => Math.max(prev - 1, 1))}>Previous</button>
            <span>Page {page} of {pageCount}</span>
            <button disabled={page >= pageCount} onClick={() => setPage((prev) => Math.min(prev + 1, pageCount))}>Next</button>
          </div>
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}
