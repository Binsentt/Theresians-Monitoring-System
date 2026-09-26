import React, { useCallback, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lightbulb, MapPin } from 'lucide-react';
import { normalizeDisplayList, safeDisplayText } from './studentProgress.utils';
import { buildStudentProgressDetailUrl } from './analyticsEndpoints';
import { buildAuthHeaders } from './session.utils';

const InsightList = ({ title, icon: Icon, tone, items, description, emptyMessage, className = '' }) => (
  <div className={`student-dashboard-card student-insight-list ${className}`.trim()}>
    <div className="student-card-heading">
      <span className={`student-card-icon ${tone}`}><Icon size={20} aria-hidden="true" /></span>
      <div>
        <h2>{title}</h2>
        <p>{description || 'Backend-grounded statements from recorded gameplay evidence.'}</p>
      </div>
    </div>
    {items.length > 0
      ? <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul>
      : <p className="student-insight-empty">{emptyMessage || `No grounded ${title.toLowerCase()} are available for this evidence.`}</p>}
  </div>
);

const withoutVisibleQuestDuration = (value) => {
  const summary = safeDisplayText(value, '');
  if (!summary) return 'No recorded evidence.';
  const visibleClauses = summary.split(/\s*;\s*/).filter((clause) => {
    const normalizedClause = clause.replace(/^Recorded evidence:\s*/i, '').trim();
    return !/^(?:recorded\s+)?duration\b/i.test(normalizedClause)
      && !/\brecorded activity\b/i.test(normalizedClause);
  });
  return visibleClauses.join('; ').trim() || 'No graded evidence is recorded for this task yet.';
};

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
  const questInsights = Array.isArray(insight?.quest_insights) ? insight.quest_insights : [];
  const message = safeDisplayText(error || state.message, 'Grounded analysis is loading from recorded gameplay evidence.');
  const showInsightAction = Boolean(onRefresh && !noData && !paused);
  const insightActionLabel = loading
    ? (insight ? 'Refreshing AI insight...' : 'Generating AI insight...')
    : insight
      ? 'Refresh AI Insight'
      : 'Generate AI Insight';
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
        {showInsightAction && (
          <button type="button" className="btn btn-primary student-insight-action" onClick={onRefresh} disabled={loading}>
            {insightActionLabel}
          </button>
        )}
      </div>

      <div className="student-insight-guidance-heading">
        <div>
          <h2>AI Learning Guidance</h2>
          <p>Weaknesses and recommendations below are generated only from recorded student performance evidence.</p>
        </div>
      </div>

      <div className="student-insight-guidance-grid">
        <InsightList
          title="AI-Identified Weaknesses"
          icon={AlertTriangle}
          tone="red"
          items={weaknesses}
          className="student-insight-weaknesses"
          description="Areas where the recorded results show that the student may need more mathematics practice."
          emptyMessage={insight
            ? 'No supported weakness is identified from the recorded evidence.'
            : 'Generate the AI insight to identify evidence-backed weaknesses.'}
        />
        <InsightList
          title="AI-Grounded Recommendations"
          icon={MapPin}
          tone="orange"
          items={recommendations}
          className="student-insight-recommendations"
          description="Recommended next steps linked to the recorded weaknesses and evidence gaps."
          emptyMessage={insight
            ? 'No additional recommendation is supported by the current recorded evidence.'
            : 'Generate the AI insight to show recommended next steps.'}
        />
      </div>

      <InsightList
        title="Strengths"
        icon={CheckCircle2}
        tone="blue"
        items={strengths}
        description="Positive patterns selected from recorded gameplay evidence."
        emptyMessage={insight
          ? 'No supported strength is identified from the recorded evidence yet.'
          : 'Generate the AI insight to identify supported strengths from recorded gameplay.'}
      />
      {questInsights.length > 0 && (
        <div className="student-dashboard-card student-insight-list grounded-ai-quest-insights">
          <div className="student-card-heading">
            <span className="student-card-icon blue"><MapPin size={20} aria-hidden="true" /></span>
            <div><h2>Per-Quest Evidence</h2><p>Structured facts from canonical quest records and graded results.</p></div>
          </div>
          <ul>{questInsights.map((quest) => (
            <li key={quest.canonical_task_id}><strong>{safeDisplayText(quest.label, quest.canonical_task_id)}</strong>: {withoutVisibleQuestDuration(quest.summary)}</li>
          ))}</ul>
        </div>
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
      <select
        id="embedded-student-insight-select"
        className="student-insight-selector"
        aria-label="Student Insights student selector"
        value={selectedStudentId}
        onChange={handleSelection}
      >
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
