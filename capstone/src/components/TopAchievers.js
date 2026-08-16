import React, { useEffect, useState } from 'react';
import { apiUrl } from '../api';
import { buildAuthHeaders } from './session.utils';
import '../styles/topachievers.css';

export default function TopAchievers() {
  const [topAchievers, setTopAchievers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchTopAchievers = async () => {
      try {
        const response = await fetch(apiUrl('/api/top-achievers'), {
          headers: buildAuthHeaders(),
        });
        if (response.ok) {
          const data = await response.json();
          setTopAchievers(data);
        } else {
          setError('Failed to load top achievers');
        }
      } catch (err) {
        console.error('Error fetching top achievers:', err);
        setError('Connection error');
      } finally {
        setLoading(false);
      }
    };

    fetchTopAchievers();
  }, []);

  if (loading) {
    return <div className="ta-loading">Loading Top Achievers...</div>;
  }

  if (error) {
    return <div className="ta-error">{error}</div>;
  }

  const formatPercent = (value) => `${Number(value || 0).toFixed(1)}%`;
  const formatPlaytime = (seconds) => {
    const totalSeconds = Number(seconds || 0);
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'N/A';
    const minutes = Math.floor(totalSeconds / 60);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return hours > 0 ? `${hours}h ${remainingMinutes}m` : `${Math.max(1, minutes)}m`;
  };

  return (
    <div className="top-achievers-container">
      <div className="ta-header">
        <h2>Top Achievers</h2>
        <p className="ta-subtitle">Based on game-based learning performance</p>
      </div>

      {topAchievers.length === 0 ? (
        <div className="ta-empty">No leaderboard data available yet.</div>
      ) : (
        <div className="ta-table-wrapper">
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
              {topAchievers.map((achiever, index) => (
                <tr key={achiever.id} className={index < 3 ? 'top-three' : ''}>
                  <td className="rank-cell">
                    {index < 3 ? (
                      <span className="rank-badge" data-rank={index + 1}>
                        #{index + 1}
                      </span>
                    ) : (
                      <span className="rank-num">#{index + 1}</span>
                    )}
                  </td>
                  <td>{achiever.student_name || 'Unknown'}</td>
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
    </div>
  );
}
