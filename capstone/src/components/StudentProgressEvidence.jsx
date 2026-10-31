import React, { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { safeDisplayText } from './studentProgress.utils';
import {
  buildLatestActivity,
  buildScoreTimeline,
  formatLatestActivityScore,
} from './studentProgressHistory.utils';

const formatActivityTimestamp = (activity = {}) => {
  const raw = activity.activity_timestamp || activity.completed_at || activity.started_at || activity.created_at;
  if (!raw || !Number.isFinite(new Date(raw).getTime())) return 'Timestamp unavailable';
  return new Date(raw).toLocaleString();
};

export const LatestActivitySection = ({ activities = [], error = '', description = 'Recent gameplay updates for the selected Student.' }) => {
  const latest = useMemo(() => buildLatestActivity(activities), [activities]);
  return (
    <section className="child-activity-panel" aria-labelledby="student-latest-activity-title">
      <div className="insights-header">
        <h2 id="student-latest-activity-title">Latest Activity</h2>
        <p>{description}</p>
      </div>
      {error ? (
        <div className="fallback-note validation-error-text">{error}</div>
      ) : latest.length === 0 ? (
        <div className="fallback-note">No recorded activity available for this Student.</div>
      ) : (
        <div className="child-activity-list">
          {latest.map((log) => (
            <div key={log.id || log.activity_event_id || [
              log.student_id, log.activity_timestamp, log.activity_description,
            ].join('-')} className="child-activity-item">
              <strong>{safeDisplayText(log.activity_description || log.canonical_activity_id, 'Gameplay Session')}</strong>
              <span>
                {safeDisplayText(log.current_quest || log.canonical_quest_id || log.quest_progress, 'No active quest')}
                {' | '}
                {formatLatestActivityScore(log)}
              </span>
              <small>{formatActivityTimestamp(log)}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

export const ScoreTimelineTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload || {};
  const sessionId = point.sessionId === null || point.sessionId === undefined || String(point.sessionId).trim() === ''
    ? 'unavailable'
    : point.sessionId;
  return (
    <div className="child-score-tooltip">
      <strong>{point.label}</strong>
      <span>Topic: {point.topic}</span>
      <span>Difficulty: {point.difficulty}</span>
      <span>Session ID: {sessionId}</span>
      <span>Date: {point.playedAt ? new Date(point.playedAt).toLocaleString() : 'Date unavailable'}</span>
      {Number.isInteger(point.score) && Number.isInteger(point.totalItems) && (
        <span>Score: {point.score} / {point.totalItems}</span>
      )}
      <b>Percentage: {Number(point.percentage).toFixed(0)}%</b>
    </div>
  );
};

export const ScoreOverTimeSection = ({ sessions = [], studentLabel = 'this Student' }) => {
  const scoreTimeline = useMemo(() => buildScoreTimeline(sessions), [sessions]);
  return (
    <section className="child-activity-panel child-score-panel" aria-labelledby="student-score-history-title">
      <div className="insights-header">
        <h2 id="student-score-history-title">Score Over Time</h2>
        <p>Most recent 20 recorded quiz results in chronological order. Hover a bar for topic and session details.</p>
      </div>
      {scoreTimeline.length === 0 ? (
        <div className="fallback-note">No quiz percentages recorded for {studentLabel}.</div>
      ) : (
        <div className="child-score-chart">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={scoreTimeline}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" interval="preserveStartEnd" height={32} />
              <YAxis domain={[0, 100]} />
              <Tooltip content={<ScoreTimelineTooltip />} />
              <Bar dataKey="percentage" fill="#2563eb" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
};

export { buildLatestActivity, buildScoreTimeline, formatLatestActivityScore };
