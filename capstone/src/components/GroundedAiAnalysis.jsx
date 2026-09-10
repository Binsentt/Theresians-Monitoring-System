import React, { useCallback, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lightbulb, MapPin } from 'lucide-react';
import { normalizeDisplayList, safeDisplayText } from './studentProgress.utils';
import { buildStudentProgressDetailUrl } from './analyticsEndpoints';
import { buildAuthHeaders } from './session.utils';

const InsightList = ({ title, icon: Icon, tone, items }) => (
  <div className="student-dashboard-card student-insight-list">
    <div className="student-card-heading">
      <span className={`student-card-icon ${tone}`}><Icon size={20} aria-hidden="true" /></span>
      <div><h2>{title}</h2><p>Backend-grounded statements from recorded gameplay evidence.</p></div>
    </div>
    {items.length > 0
      ? <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul>
      : <p>No grounded {title.toLowerCase()} are available for this evidence.</p>}
  </div>
);

export default function GroundedAiAnalysis({ aiInsight, error = '', loading = false, onRefresh }) {
  const state = aiInsight && typeof aiInsight === 'object' ? aiInsight : {};
  const insight = state.insight && typeof state.insight === 'object' ? state.insight : null;
  const validResultCount = Number.isInteger(state.valid_result_count) ? state.valid_result_count : null;
  const preliminary = state.preliminary === true || state.data_level === 'limited_data';
  const stale = state.is_stale === true || state.status === 'stale';
  const unavailable = state.status === 'unavailable';
  const paused = state.status === 'paused' || state.code === 'AI_PAUSED';
  const noData = state.status === 'no_data' || state.data_level === 'no_data';
  const strengths = normalizeDisplayList(insight?.strengths);
  const weaknesses = normalizeDisplayList(insight?.weaknesses);
  const recommendations = normalizeDisplayList(insight?.recommendations);
  const message = safeDisplayText(error || state.message, 'Grounded analysis is loading from recorded gameplay evidence.');
  const showRecovery = Boolean(onRefresh && !noData && !paused && (unavailable || stale || error));
  const generatedAt = state.generated_at ? new Date(state.generated_at) : null;
  const generatedLabel = generatedAt && !Number.isNaN(generatedAt.getTime())
    ? generatedAt.toLocaleString()
    : 'Not generated';
  const cacheLabel = stale
    ? 'Stale'
    : state.status === 'cached'
      ? 'Cached'
      : state.cache_status === 'current' || insight
        ? 'Current'
        : 'Not generated';

  return (
    <section className="student-insights-grid grounded-ai-analysis" aria-label="Grounded AI analysis">
      <div className="student-dashboard-card student-insight-card">
        <div className="student-card-heading">
          <span className="student-card-icon green"><Lightbulb size={20} aria-hidden="true" /></span>
          <div><h2>Grounded AI Insight</h2><p>Automatically generated from the canonical student analytics evidence.</p></div>
        </div>
        <h3 className="grounded-ai-performance-label">Performance Insight</h3>
        {preliminary && (
          <p className="grounded-ai-status preliminary" role="status">
            Preliminary insight — based on {validResultCount ?? 'fewer than 5'} recorded result{validResultCount === 1 ? '' : 's'}.
          </p>
        )}
        {(paused || unavailable || stale || error) && (
          <p className="grounded-ai-status warning" role="status">
            {paused ? `${stale ? 'Insight is stale. ' : ''}${message}` : stale ? `Insight is stale. ${message}` : message}
          </p>
        )}
        {insight?.performance_insight
          ? <strong className="student-insight-highlight">{safeDisplayText(insight.performance_insight, '')}</strong>
          : !(paused || unavailable || stale || error) && <p className="student-insight-copy">{message}</p>}
        <p className="grounded-ai-evidence-meta">
          Evidence: {validResultCount ?? 0} valid results · Generated: {generatedLabel} · {cacheLabel}
        </p>
        {showRecovery && (
          <button type="button" className="btn btn-primary student-insight-action" onClick={onRefresh} disabled={loading}>
            {loading ? 'Retrying grounded insight...' : 'Retry grounded insight'}
          </button>
        )}
      </div>

      {insight && (
        <>
          <InsightList title="Strengths" icon={CheckCircle2} tone="blue" items={strengths} />
          <InsightList title="Weaknesses" icon={AlertTriangle} tone="red" items={weaknesses} />
          <InsightList title="Recommendations" icon={MapPin} tone="orange" items={recommendations} />
        </>
      )}
    </section>
  );
}

const buildInsightUrl = (detailUrl) => {
  const [pathname, query = ''] = String(detailUrl || '').split('?');
  return `${pathname}/ai-insight${query ? `?${query}` : ''}`;
};

export function StudentInsightsPanel({ students = [], role = 'admin' }) {
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [aiInsight, setAiInsight] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const requestVersion = useRef(0);

  const requestInsight = useCallback(async (studentId, { regenerate = false } = {}) => {
    if (!studentId) return;
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setLoading(true);
    setError('');
    const detailUrl = buildStudentProgressDetailUrl(studentId, role);
    try {
      const response = await fetch(regenerate ? buildInsightUrl(detailUrl) : detailUrl, {
        method: regenerate ? 'POST' : 'GET',
        headers: regenerate
          ? { ...buildAuthHeaders(), 'Content-Type': 'application/json' }
          : buildAuthHeaders(),
      });
      const payload = await response.json().catch(() => ({}));
      if (requestVersion.current !== version) return;
      const nextInsight = regenerate ? payload : payload.aiInsight;
      if (!response.ok && !['no_data', 'insufficient_data'].includes(nextInsight?.status)) {
        throw new Error(payload.error || 'Grounded insight is unavailable right now.');
      }
      setAiInsight(nextInsight || { status: 'not_generated', message: 'No grounded insight has been generated for this evidence yet.' });
    } catch (requestError) {
      if (requestVersion.current !== version) return;
      setError(requestError.message || 'Grounded insight is unavailable right now.');
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [role]);

  const handleSelection = (event) => {
    const nextStudentId = event.target.value;
    setSelectedStudentId(nextStudentId);
    setAiInsight(null);
    setError('');
    if (nextStudentId) requestInsight(nextStudentId);
  };

  return (
    <div className="embedded-student-insights">
      <label htmlFor="embedded-student-insight-select">Student Insights</label>
      <select id="embedded-student-insight-select" value={selectedStudentId} onChange={handleSelection}>
        <option value="">Select a student</option>
        {students.map((student) => (
          <option key={student.student_id} value={student.student_id}>
            {student.student_name || 'Unnamed Student'}{student.game_student_id ? ` — ${student.game_student_id}` : ''}
          </option>
        ))}
      </select>
      {!selectedStudentId ? (
        <p className="fallback-note">Select a student to show grounded insight here.</p>
      ) : loading && !aiInsight ? (
        <p className="loading-state" role="status">Loading grounded insight...</p>
      ) : (
        <GroundedAiAnalysis
          aiInsight={aiInsight}
          error={error}
          loading={loading}
          onRefresh={() => requestInsight(selectedStudentId, { regenerate: true })}
        />
      )}
    </div>
  );
}
