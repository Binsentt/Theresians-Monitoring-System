import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import GroundedAiAnalysis, { StudentInsightsPanel } from './GroundedAiAnalysis';

describe('GroundedAiAnalysis', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('renders the same four grounded sections and labels one-to-four results preliminary', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis aiInsight={{
        status: 'generated',
        data_level: 'limited_data',
        preliminary: true,
        valid_result_count: 4,
        insight: {
          performance_insight: 'Recorded overall accuracy is 75%.',
          strengths: ['Recorded Easy accuracy is 75%.'],
          weaknesses: ['No sufficient Normal evidence yet.'],
          recommendations: ['Record more Normal gameplay.'],
        },
      }} />
    ));

    expect(container.textContent).toContain('Preliminary insight');
    expect(container.textContent).toContain('4 recorded results');
    expect(container.textContent).toContain('Performance Insight');
    expect(container.textContent).toContain('Strengths');
    expect(container.textContent).toContain('Weaknesses');
    expect(container.textContent).toContain('Recommendations');
    expect(container.textContent).toContain('Recorded overall accuracy is 75%.');
  });

  test('uses a compact-panel layout hook for a readable full-width default column', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis aiInsight={{ status: 'paused', code: 'AI_PAUSED', message: 'Paused.' }} />
    ));

    const panel = container.querySelector('.grounded-ai-analysis');
    expect(panel).not.toBeNull();
    expect(panel.getAttribute('aria-label')).toBe('Grounded AI analysis');
  });

  test('exposes a compact-panel layout hook for a readable full-width default column', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis aiInsight={{ status: 'paused', code: 'AI_PAUSED', message: 'Paused.' }} />
    ));

    const panel = container.querySelector('.grounded-ai-analysis');
    expect(panel).not.toBeNull();
    expect(panel.getAttribute('aria-label')).toBe('Grounded AI analysis');
  });

  test('retains cached content with a clear stale warning and offers manual recovery only', async () => {
    const onRefresh = jest.fn();
    await act(async () => root.render(
      <GroundedAiAnalysis
        aiInsight={{
          status: 'unavailable',
          data_level: 'sufficient_data',
          is_stale: true,
          message: 'New evidence is available, but the insight service is unavailable.',
          insight: {
            performance_insight: 'Previously generated evidence.',
            strengths: [], weaknesses: [], recommendations: [],
          },
        }}
        onRefresh={onRefresh}
      />
    ));

    expect(container.textContent).toContain('stale');
    expect(container.textContent).toContain('Previously generated evidence.');
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry grounded insight');
    expect(retry).not.toBeNull();
    await act(async () => retry.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test('shows the paused contract, preserves genuine cached content, and offers no retry', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis
        aiInsight={{
          status: 'paused',
          code: 'AI_PAUSED',
          data_level: 'sufficient_data',
          is_stale: true,
          generated_at: '2026-09-08T00:00:00.000Z',
          message: 'AI generation is temporarily paused. Recorded data and available questions remain accessible.',
          insight: {
            performance_insight: 'Previously generated evidence.',
            strengths: [], weaknesses: [], recommendations: [],
          },
        }}
        onRefresh={jest.fn()}
      />
    ));

    expect(container.textContent).toContain('AI generation is temporarily paused.');
    expect(container.textContent).toContain('Previously generated evidence.');
    expect(container.textContent).toContain('stale');
    expect(container.textContent).toContain('2026');
    expect(container.querySelector('button')).toBeNull();
  });

  test('shows truthful no-data state without invented analysis or a generation action', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis
        aiInsight={{ status: 'no_data', data_level: 'no_data', valid_result_count: 0, message: 'No valid gameplay results are available.' }}
        onRefresh={jest.fn()}
      />
    ));

    expect(container.textContent).toContain('No valid gameplay results are available.');
    expect(container.querySelector('button')).toBeNull();
  });

  test('renders an unavailable error once while preserving deterministic metrics outside the panel', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis
        aiInsight={{ status: 'unavailable', message: 'Grounded insight service is unavailable.' }}
        error="Grounded insight service is unavailable."
        onRefresh={jest.fn()}
      />
    ));

    expect(container.textContent.match(/Grounded insight service is unavailable\./g)).toHaveLength(1);
  });

  test('loads only the explicitly selected authorized student insight in the progress page', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 8, role: 'teacher' }));
    localStorage.setItem('rememberToken', 'test-token');
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        aiInsight: {
          status: 'generated', preliminary: true, data_level: 'limited_data', valid_result_count: 3,
          generated_at: '2026-09-10T10:00:00.000Z', cache_status: 'current',
          insight: {
            performance_insight: 'Three recorded Easy results show 67% accuracy.',
            strengths: ['Two recorded answers were correct.'],
            weaknesses: ['One recorded answer was incorrect.'],
            recommendations: ['Review the missed Easy item before continuing.'],
          },
        },
      }),
    }));
    await act(async () => root.render(<StudentInsightsPanel
      students={[
        { student_id: 11, student_name: 'Ana Reyes', game_student_id: '001234' },
        { student_id: 12, student_name: 'Ben Cruz', game_student_id: '001235' },
      ]}
      role="teacher"
    />));
    expect(global.fetch).not.toHaveBeenCalled();
    const select = container.querySelector('select');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, '11');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String(global.fetch.mock.calls[0][0])).toContain('/api/student-progress/11');
    expect(container.textContent).toContain('Preliminary insight');
    expect(container.textContent).toContain('Review the missed Easy item before continuing.');
    expect(container.textContent).toContain('Evidence: 3 valid results');
    expect(container.textContent).toContain('Current');
  });
});
