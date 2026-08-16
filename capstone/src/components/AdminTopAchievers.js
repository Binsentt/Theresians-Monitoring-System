import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import DashboardLoadingShell from './layout/DashboardLoadingShell';
import logoImage from '../assets/images/STS_Logo.png';
import { normalizeRole } from './manageUsers.utils';
import { apiUrl } from '../api';
import { buildAuthHeaders } from './session.utils';
import '../styles/topachievers.css';

export default function AdminTopAchievers() {
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
        if (!loggedInUser || normalizeRole(loggedInUser.role) !== 'admin') {
          navigate('/login');
          return;
        }

        setUser(loggedInUser);

        // Fetch top achievers data (admin sees all)
        const response = await fetch(apiUrl('/api/top-achievers'), {
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

  // Extract unique grades and sections
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
  const formatPercent = (value) => `${Number(value || 0).toFixed(1)}%`;
  const formatPlaytime = (seconds) => {
    const totalSeconds = Number(seconds || 0);
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'N/A';
    const minutes = Math.floor(totalSeconds / 60);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return hours > 0 ? `${hours}h ${remainingMinutes}m` : `${Math.max(1, minutes)}m`;
  };

  if (loading) {
    return (
      <DashboardLoadingShell
        role="admin"
        activeItem="top-achievers"
        logoSrc={logoImage}
        portalLabel="Admin Portal"
        heading="Top Achievers"
        subheading="View student achievements and learning progress."
      />
    );
  }

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role="admin"
          activeItem="top-achievers"
          logoSrc={logoImage}
          portalLabel="Admin Portal"
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div className="header-info">
              <h1>Top Achievers</h1>
              <p>Recognize students with exceptional performance across all grades and sections.</p>
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
                <div className="empty-message">No leaderboard data available yet.</div>
              ) : (
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
                      {filteredAchievers.map((achiever, index) => (
                        <tr key={achiever.id || `achiever-${index}`} className={index < 3 ? 'top-three' : ''}>
                          <td className="rank-cell">
                            <span className="rank-num">#{index + 1}</span>
                            {index === 0 && <span className="rank-badge gold">Gold</span>}
                            {index === 1 && <span className="rank-badge silver">Silver</span>}
                            {index === 2 && <span className="rank-badge bronze">Bronze</span>}
                          </td>
                          <td className="name-cell">{achiever.student_name || 'Unknown'}</td>
                          <td>{achiever.game_student_id || 'Not linked'}</td>
                          <td>{achiever.grade_level || 'N/A'}</td>
                          <td>{achiever.section || 'N/A'}</td>
                          <td className="progress-cell">
                            <div className="progress-bar">
                              <div
                                className="progress-fill"
                                style={{ width: `${Number(achiever.completion_percentage ?? achiever.progress_percentage ?? 0)}%` }}
                              />
                            </div>
                            <span className="progress-text">{formatPercent(achiever.completion_percentage ?? achiever.progress_percentage)}</span>
                          </td>
                          <td className="accuracy-cell">
                            <div className="accuracy-bar">
                              <div
                                className="accuracy-fill"
                                style={{ width: `${Number(achiever.accuracy ?? achiever.accuracy_rate ?? 0)}%` }}
                              />
                            </div>
                            <span className="accuracy-text">{formatPercent(achiever.accuracy ?? achiever.accuracy_rate)}</span>
                          </td>
                          <td>{achiever.total_correct_answers ?? achiever.correct_answers ?? 0}/{achiever.total_questions_answered ?? achiever.total_questions ?? 0}</td>
                          <td>{achiever.quests_completed ?? achiever.total_quests_completed ?? 0}</td>
                          <td>{formatPlaytime(achiever.total_play_time ?? achiever.duration_seconds)}</td>
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
