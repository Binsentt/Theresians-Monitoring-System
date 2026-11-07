import React, { useMemo, useState } from 'react';
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

export const ScoreOverTimeSection = ({ mapPerformance = null, studentLabel = 'this Student', historyNotice = '' }) => {
  const [view, setView] = useState('map');
  const records = useMemo(() => {
    const values = view === 'battle'
      ? mapPerformance?.byBattleSession
      : mapPerformance?.byMap;
    return Array.isArray(values) ? values : [];
  }, [mapPerformance, view]);
  const available = mapPerformance && typeof mapPerformance === 'object';
  const chartReady = records.length > 0;
  const formatAccuracy = (value) => Number.isFinite(value)
    ? `${Number(value).toFixed(1).replace(/\.0$/, '')}%` : 'N/A';
  const formatDate = (value) => value && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toLocaleString() : 'Date unavailable';
  return (
    <section className="child-activity-panel child-score-panel" aria-labelledby="student-score-history-title">
      <div className="insights-header">
        <h2 id="student-score-history-title">Performance by Map</h2>
        <p>Accuracy is calculated from all valid current-cycle Mathematics answers grouped by recorded canonical map.</p>
      </div>
      <label className="child-performance-view-control" htmlFor="student-performance-view">
        View performance
        <select id="student-performance-view" value={view} onChange={(event) => setView(event.target.value)}>
          <option value="map">By Map</option>
          <option value="battle">By Battle/Session</option>
        </select>
      </label>
      {historyNotice ? <p className="fallback-note child-score-history-notice" role="status">{historyNotice}</p> : null}
      {!chartReady ? (
        <div className="fallback-note">
          {!available
            ? `Map-level performance is unavailable for ${studentLabel} because complete current-cycle result evidence was not returned.`
            : view === 'battle'
              ? `No valid battle or session result details are recorded for ${studentLabel}.`
              : `No valid current-cycle Mathematics results are recorded for ${studentLabel}.`}
        </div>
      ) : (
        <div className="child-performance-view">
          <div className="child-score-chart">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={records}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey={view === 'map' ? 'mapName' : 'label'} interval="preserveStartEnd" height={42} />
                <YAxis domain={[0, 100]} unit="%" />
                <Tooltip content={<MapPerformanceTooltip formatAccuracy={formatAccuracy} formatDate={formatDate} view={view} />} />
                <Bar dataKey="accuracy" name="Accuracy" fill="#2563eb" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="child-performance-table-scroll" role="region" aria-label={view === 'map' ? 'Performance by map details' : 'Performance by battle or session details'} tabIndex={0}>
            <table className="child-performance-table">
              <thead><tr>
                {view === 'map' ? <th scope="col">Map</th> : <th scope="col">Battle / Session</th>}
                {view === 'battle' && <th scope="col">Map</th>}
                <th scope="col">Correct</th>
                <th scope="col">Incorrect</th>
                <th scope="col">Total questions</th>
                <th scope="col">Accuracy</th>
                {view === 'map' && <th scope="col">Recorded encounters</th>}
                <th scope="col">Chronology</th>
              </tr></thead>
              <tbody>{records.map((record, index) => (
                <tr key={record.key || `${record.mapId || 'unrecorded'}-${record.sessionId || index}`}>
                  <th scope="row">{view === 'map' ? record.mapName : record.label}</th>
                  {view === 'battle' && <td>{record.mapName}</td>}
                  <td>{record.correctAnswers}</td>
                  <td>{record.incorrectAnswers}</td>
                  <td>{record.totalQuestions}</td>
                  <td>{formatAccuracy(record.accuracy)}</td>
                  {view === 'map' && <td>{Number.isInteger(record.encounterCount) ? record.encounterCount : 'Not available'}</td>}
                  <td>
                    {record.firstPlayedAt && <small>First: {formatDate(record.firstPlayedAt)}</small>}
                    {record.lastPlayedAt && <small>Latest: {formatDate(record.lastPlayedAt)}</small>}
                    {!record.firstPlayedAt && !record.lastPlayedAt && 'Date unavailable'}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
};

const MapPerformanceTooltip = ({ active, payload, formatAccuracy, formatDate, view }) => {
  if (!active || !payload?.length) return null;
  const record = payload[0]?.payload || {};
  return (
    <div className="child-score-tooltip">
      <strong>{view === 'map' ? record.mapName : record.label}</strong>
      {view === 'battle' && <span>Map: {record.mapName}</span>}
      <span>Correct answers: {record.correctAnswers}</span>
      <span>Incorrect answers: {record.incorrectAnswers}</span>
      <span>Total questions: {record.totalQuestions}</span>
      <b>Accuracy: {formatAccuracy(record.accuracy)}</b>
      {view === 'map' && <span>Recorded encounters: {Number.isInteger(record.encounterCount) ? record.encounterCount : 'Not available'}</span>}
      <span>First played: {formatDate(record.firstPlayedAt)}</span>
      <span>Latest played: {formatDate(record.lastPlayedAt)}</span>
      {record.sessionId && <span>Session ID: {record.sessionId}</span>}
    </div>
  );
};

export { buildLatestActivity, buildScoreTimeline, formatLatestActivityScore };
