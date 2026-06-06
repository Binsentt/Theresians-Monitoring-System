import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { buildStudentProgressDetailUrl } from './analyticsEndpoints';
import { normalizeRole } from './manageUsers.utils';
import { clampPercent, normalizeDisplayList, safeDisplayText, toFiniteNumber } from './studentProgress.utils';
import logoImage from '../assets/images/STS_Logo.png';
import '../styles/studentprogress.css';

export default function StudentAnalytics() {
  const { studentId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [progress, setProgress] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [userRole, setUserRole] = useState('admin');

  useEffect(() => {
    const loadDetail = async () => {
      setLoading(true);
      setError('');
      
      // Determine user role
      const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
      if (loggedInUser && loggedInUser.role) {
        setUserRole(normalizeRole(loggedInUser.role));
      }
      
      try {
        const response = await fetch(buildStudentProgressDetailUrl(studentId, loggedInUser?.role, loggedInUser?.id));
        if (!response.ok) throw new Error('Unable to load student analytics');
        const data = await response.json();
        setProgress(data.progress || null);
        setAnalysis(data.analysis || null);
      } catch (err) {
        console.error('Detail load failed:', err);
        setError('Analytics currently unavailable. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    loadDetail();
  }, [studentId]);

  const getBackRoute = () => {
    if (location.pathname.startsWith('/teacher')) return '/teacher/student-progress';
    if (location.pathname.startsWith('/parent')) return '/parent/child-progress';
    switch(userRole) {
      case 'teacher':
      case 'parent_teacher':
        return '/teacher/student-progress';
      case 'parent':
        return '/parent/child-progress';
      default:
        return '/admin/student-progress';
    }
  };

  const accuracy = clampPercent(progress?.accuracy_rate, 0);
  const questCompletion = clampPercent(progress?.progress_percentage, 0);
  const difficulty = {
    easy: clampPercent(analysis?.difficultyBreakdown?.easy, 0),
    medium: clampPercent(analysis?.difficultyBreakdown?.medium, 0),
    hard: clampPercent(analysis?.difficultyBreakdown?.hard, 0),
  };
  const completedQuests = Math.min(10, Math.round(questCompletion / 10));
  const gameScore = toFiniteNumber(progress?.score, 0);
  const strengths = normalizeDisplayList(analysis?.strengths);
  const weaknesses = normalizeDisplayList(analysis?.weaknesses);
  const recommendations = normalizeDisplayList(analysis?.recommendations);
  const correctAnswers = toFiniteNumber(analysis?.totalCorrectAnswers ?? progress?.correct_answers, 0);
  const totalQuestions = toFiniteNumber(progress?.total_questions, 0);
  const incorrectAnswers = toFiniteNumber(analysis?.totalIncorrectAnswers, Math.max(totalQuestions - correctAnswers, 0));

  return (
    <div className="student-analytics-page">
      <div className="student-analytics-header">
        <button className="back-action" onClick={() => navigate(getBackRoute())}>
          ← Back to Table
        </button>
        <div className="student-analytics-logo" aria-label="Saint Theresa School logo">
          <img src={logoImage} alt="Saint Theresa School logo" />
        </div>
        <div className="student-analytics-title">
          <p className="crumb">Analytics / Student Details</p>
          <h1>{safeDisplayText(progress?.student_name, 'Student analytics')}</h1>
          <p className="subtitle">Detailed performance insights, progress metrics, and AI recommendations for this student.</p>
        </div>
      </div>

      {loading ? (
        <div className="loading-state">Loading student details...</div>
      ) : error ? (
        <div className="fallback-note">{error}</div>
      ) : (
        <>
          <section className="student-detail-grid">
            <div className="student-card">
              <h3>Student Information</h3>
              <p><strong>Name:</strong> {safeDisplayText(progress?.student_name, 'N/A')}</p>
              <p><strong>Grade:</strong> {safeDisplayText(progress?.grade_level, 'N/A')}</p>
              <p><strong>Section:</strong> {safeDisplayText(progress?.section, 'N/A')}</p>
              <p><strong>Difficulty:</strong> {safeDisplayText(progress?.difficulty_level || progress?.difficulty, 'Unknown')}</p>
            </div>
            <div className="student-card">
              <h3>Performance Summary</h3>
              <p><strong>Total Progress:</strong> {questCompletion.toFixed(0)}%</p>
              <p><strong>Correct Answers:</strong> {correctAnswers}</p>
              <p><strong>Incorrect Answers:</strong> {incorrectAnswers}</p>
              <p><strong>Accuracy:</strong> {accuracy.toFixed(0)}%</p>
              <p><strong>Current Quest:</strong> {safeDisplayText(analysis?.currentQuest || progress?.current_quest, 'N/A')}</p>
              <p><strong>Estimated Completed Quests:</strong> {completedQuests}</p>
            </div>
            <div className="student-card">
              <h3>Game Performance</h3>
              <p><strong>Game Score:</strong> {gameScore}</p>
              <p><strong>Total Questions:</strong> {totalQuestions}</p>
              <p><strong>Learning Progress:</strong> {questCompletion.toFixed(0)}%</p>
              <p><strong>Performance Insight:</strong> {accuracy >= 80 ? 'Consistently strong results' : 'Needs guided reinforcement'}</p>
            </div>
            <div className="student-card">
              <h3>Difficulty Breakdown</h3>
              <div className="mini-bar-row">
                <span>Easy</span>
                <div className="progress-track"><div className="progress-fill easy" style={{ width: `${difficulty.easy}%` }} /></div>
                <strong>{difficulty.easy}%</strong>
              </div>
              <div className="mini-bar-row">
                <span>Medium</span>
                <div className="progress-track"><div className="progress-fill medium" style={{ width: `${difficulty.medium}%` }} /></div>
                <strong>{difficulty.medium}%</strong>
              </div>
              <div className="mini-bar-row">
                <span>Hard</span>
                <div className="progress-track"><div className="progress-fill hard" style={{ width: `${difficulty.hard}%` }} /></div>
                <strong>{difficulty.hard}%</strong>
              </div>
            </div>
          </section>

          <section className="student-charts-grid">
            <div className="student-chart-card">
              <h3>Accuracy Trend</h3>
              <div className="progress-chart">
                <div className="progress-chart-bar" style={{ width: `${accuracy}%` }}>{accuracy.toFixed(0)}%</div>
              </div>
            </div>
            <div className="student-chart-card">
              <h3>Quest Completion</h3>
              <div className="progress-chart">
                <div className="progress-chart-bar medium" style={{ width: `${questCompletion}%` }}>{questCompletion.toFixed(0)}%</div>
              </div>
            </div>
          </section>

          <section className="student-ai-panel">
            <div className="student-ai-block">
              <h3>AI Interpretation</h3>
              {strengths.length > 0 ? (
                <ul>
                  {strengths.map((item, index) => <li key={`strength-${index}`}>{item}</li>)}
                </ul>
              ) : (
                <p>No interpretation available for this student yet.</p>
              )}
            </div>
            <div className="student-ai-block">
              <h3>Weaknesses</h3>
              {weaknesses.length > 0 ? (
                <ul>
                  {weaknesses.map((item, index) => <li key={`weak-${index}`}>{item}</li>)}
                </ul>
              ) : (
                <p>No weak areas identified.</p>
              )}
            </div>
            <div className="student-ai-block">
              <h3>Recommendations</h3>
              {recommendations.length > 0 ? (
                <ul>
                  {recommendations.map((item, index) => <li key={`reco-${index}`}>{item}</li>)}
                </ul>
              ) : (
                <p>Please try again later for recommendations.</p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
