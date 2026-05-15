import React, { useEffect, useState } from 'react';
import '../styles/topachievers.css';

export default function TopAchievers() {
  const [topAchievers, setTopAchievers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchTopAchievers = async () => {
      try {
        const response = await fetch('http://localhost:5000/api/top-achievers');
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

  return (
    <div className="top-achievers-container">
      <div className="ta-header">
        <h2>Top Achievers</h2>
        <p className="ta-subtitle">Based on game-based learning performance</p>
      </div>

      {topAchievers.length === 0 ? (
        <div className="ta-empty">No achievement data available yet.</div>
      ) : (
        <div className="ta-table-wrapper">
          <table className="ta-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Student Name</th>
                <th>Grade/Level</th>
                <th>Current Quest</th>
                <th>Score</th>
                <th>Correct Answers</th>
                <th>Accuracy</th>
                <th>Progress</th>
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
                  <td>{achiever.student_name}</td>
                  <td>{achiever.grade_level}</td>
                  <td>
                    <span className="quest-badge">{achiever.current_quest}</span>
                  </td>
                  <td className="score-cell">
                    <strong>{achiever.score}</strong>
                  </td>
                  <td>{achiever.correct_answers}/{achiever.total_questions}</td>
                  <td className="accuracy-cell">
                    <div className="accuracy-bar">
                      <div 
                        className="accuracy-fill" 
                        style={{ width: `${achiever.accuracy_rate}%` }}
                      />
                    </div>
                    <span className="accuracy-text">{achiever.accuracy_rate.toFixed(1)}%</span>
                  </td>
                  <td className="progress-cell">
                    <div className="progress-bar">
                      <div 
                        className="progress-fill" 
                        style={{ width: `${achiever.progress_percentage}%` }}
                      />
                    </div>
                    <span className="progress-text">{achiever.progress_percentage.toFixed(1)}%</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
