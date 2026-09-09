import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import GroundedAiAnalysis from './GroundedAiAnalysis';

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
});
