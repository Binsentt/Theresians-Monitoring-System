import React from 'react';
import { AlertTriangle, CheckCircle2, Lightbulb, MapPin } from 'lucide-react';
import { normalizeDisplayList, safeDisplayText } from './studentProgress.utils';

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
  const noData = state.status === 'no_data' || state.data_level === 'no_data';
  const strengths = normalizeDisplayList(insight?.strengths);
  const weaknesses = normalizeDisplayList(insight?.weaknesses);
  const recommendations = normalizeDisplayList(insight?.recommendations);
  const message = safeDisplayText(error || state.message, 'Grounded analysis is loading from recorded gameplay evidence.');
  const showRecovery = Boolean(onRefresh && !noData && (unavailable || stale || error));

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
        {(unavailable || stale || error) && (
          <p className="grounded-ai-status warning" role="status">
            {stale ? `Insight is stale. ${message}` : message}
          </p>
        )}
        {insight?.performance_insight
          ? <strong className="student-insight-highlight">{safeDisplayText(insight.performance_insight, '')}</strong>
          : <p className="student-insight-copy">{message}</p>}
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
