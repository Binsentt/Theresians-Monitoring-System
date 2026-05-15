import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { buildStudentProgressDetailUrl } from './analyticsEndpoints';
import '../styles/studentprogress.css';

export default function StudentAnalytics() {
  const { studentId } = useParams();
  const navigate = useNavigate();
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
        setUserRole(loggedInUser.role.toLowerCase());
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
    switch(userRole) {
      case 'teacher':
        return '/teacher/student-progress';
      case 'parent':
        return '/parent/child-progress';
      default:
        return '/admin/student-progress';
    }
  };

  const accuracy = progress?.accuracy_rate ?? 0;
  const questCompletion = progress?.progress_percentage ?? 0;
  const difficulty = analysis?.difficultyBreakdown || { easy: 0, medium: 0, hard: 0 };
  const completedQuests = Math.min(10, Math.round(questCompletion / 10));
  const gameScore = progress?.score ?? 0;

  return (
    <div className="student-analytics-page">
      <div className="student-analytics-header">
        <button className="back-action" onClick={() => navigate(getBackRoute())}>
          ← Back to Table
        </button>
        <div>
          <p className="crumb">Analytics / Student Details</p>
          <h1>{progress?.student_name || 'Student analytics'}</h1>
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
              <p><strong>Name:</strong> {progress?.student_name || 'N/A'}</p>
              <p><strong>Grade:</strong> {progress?.grade_level || 'N/A'}</p>
              <p><strong>Section:</strong> {progress?.section || 'N/A'}</p>
            </div>
            <div className="student-card">
              <h3>Performance Summary</h3>
              <p><strong>Total Progress:</strong> {questCompletion.toFixed(0)}%</p>
              <p><strong>Correct Answers:</strong> {analysis?.totalCorrectAnswers ?? progress?.correct_answers ?? 0}</p>
              <p><strong>Incorrect Answers:</strong> {analysis?.totalIncorrectAnswers ?? Math.max((progress?.total_questions ?? 0) - (progress?.correct_answers ?? 0), 0)}</p>
              <p><strong>Accuracy:</strong> {accuracy.toFixed(0)}%</p>
              <p><strong>Current Quest:</strong> {analysis?.currentQuest || progress?.current_quest || 'N/A'}</p>
              <p><strong>Estimated Completed Quests:</strong> {completedQuests}</p>
            </div>
            <div className="student-card">
              <h3>Game Performance</h3>
              <p><strong>Game Score:</strong> {gameScore}</p>
              <p><strong>Total Questions:</strong> {progress?.total_questions ?? 0}</p>
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
              {analysis?.strengths?.length > 0 ? (
                <ul>
                  {analysis.strengths.map((item, index) => <li key={`strength-${index}`}>{item}</li>)}
                </ul>
              ) : (
                <p>No interpretation available for this student yet.</p>
              )}
            </div>
            <div className="student-ai-block">
              <h3>Weaknesses</h3>
              {analysis?.weaknesses?.length > 0 ? (
                <ul>
                  {analysis.weaknesses.map((item, index) => <li key={`weak-${index}`}>{item}</li>)}
                </ul>
              ) : (
                <p>No weak areas identified.</p>
              )}
            </div>
            <div className="student-ai-block">
              <h3>Recommendations</h3>
              {analysis?.recommendations?.length > 0 ? (
                <ul>
                  {analysis.recommendations.map((item, index) => <li key={`reco-${index}`}>{item}</li>)}
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
