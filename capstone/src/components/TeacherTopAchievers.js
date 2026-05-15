import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
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

  useEffect(() => {
    const initializeComponent = async () => {
      try {
        // Load and apply theme
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
        if (!loggedInUser || loggedInUser.role !== 'teacher') {
          navigate('/login');
          return;
        }

        setUser(loggedInUser);

        // Fetch top achievers data for teacher's assigned students
        const response = await fetch(`http://localhost:5000/api/top-achievers?teacher_id=${loggedInUser.id}`);
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
  const filteredAchievers = topAchievers.filter(achiever => {
    const matchesGrade = !selectedGrade || achiever.grade_level === selectedGrade;
    const matchesSection = !selectedSection || achiever.section === selectedSection;
    const matchesSearch = !searchQuery || achiever.student_name?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesGrade && matchesSection && matchesSearch;
  });

  // Reset all filters
  const resetFilters = () => {
    setSelectedGrade('');
    setSelectedSection('');
    setSearchQuery('');
  };

  // Check if any filters are active
  const hasActiveFilters = selectedGrade || selectedSection || searchQuery;

  if (loading) {
    return (
      <DashboardContainer
        sidebar={
          <AnalyticsSidebar
            role="teacher"
            activeItem="top-achievers"
            logoSrc={logoImage}
            portalLabel="Teacher Portal"
          />
        }
        main={
          <MainContent>
            <TopBar>
              <h1>Loading...</h1>
            </TopBar>
            <PageContent>
              <div className="loading-state">Loading Top Achievers...</div>
            </PageContent>
          </MainContent>
        }
      />
    );
  }

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role="teacher"
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
                      onChange={(e) => setSelectedSection(e.target.value)}
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
                      placeholder="Search by student name..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
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
              {error ? (
                <div className="error-message">{error}</div>
              ) : filteredAchievers.length === 0 ? (
                <div className="empty-message">
                  {hasActiveFilters
                    ? 'No students match the selected filters.'
                    : 'No achievement data available for your assigned students yet.'
                  }
                </div>
              ) : (
                <div className="top-achievers-container">
                  <table className="ta-table">
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Student Name</th>
                        <th>Grade</th>
                        <th>Section</th>
                        <th>Current Quest</th>
                        <th>Score</th>
                        <th>Correct Answers</th>
                        <th>Accuracy</th>
                        <th>Progress</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAchievers.map((achiever, index) => (
                        <tr key={achiever.id || `achiever-${index}`} className={index < 3 ? 'top-three' : ''}>
                          <td className="rank-cell">
                            <span className="rank-num">#{index + 1}</span>
                            {index === 0 && <span className="rank-badge gold">Gold</span>}
                            {index === 1 && <span className="rank-badge silver">Silver</span>}
                            {index === 2 && <span className="rank-badge bronze">Bronze</span>}
                          </td>
                          <td className="name-cell">{achiever.student_name || 'Unknown'}</td>
                          <td>{achiever.grade_level || 'N/A'}</td>
                          <td>{achiever.section || 'N/A'}</td>
                          <td>
                            <span className="quest-badge">{achiever.current_quest || 'N/A'}</span>
                          </td>
                          <td className="score-cell">
                            <strong>{achiever.score ?? '—'}</strong>
                          </td>
                          <td>{achiever.correct_answers ?? 0}/{achiever.total_questions ?? 0}</td>
                          <td className="accuracy-cell">
                            <div className="accuracy-bar">
                              <div 
                                className="accuracy-fill" 
                                style={{ width: `${achiever.accuracy_rate ?? 0}%` }}
                              />
                            </div>
                            <span className="accuracy-text">{((achiever.accuracy_rate ?? 0).toFixed(1))}%</span>
                          </td>
                          <td className="progress-cell">
                            <div className="progress-bar">
                              <div 
                                className="progress-fill" 
                                style={{ width: `${achiever.progress_percentage ?? 0}%` }}
                              />
                            </div>
                            <span className="progress-text">{((achiever.progress_percentage ?? 0).toFixed(1))}%</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </ContentSection>
          </PageContent>
        </MainContent>
      }
    />
  );
}
