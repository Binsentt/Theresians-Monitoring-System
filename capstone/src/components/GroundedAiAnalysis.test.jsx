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
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Refresh AI Insight');
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

  test.each(['paused', 'unavailable'])('%s provider state displays deterministic current-cycle evidence without claiming AI generation', async (status) => {
    await act(async () => root.render(
      <GroundedAiAnalysis
        aiInsight={{
          status,
          data_level: 'sufficient_data',
          valid_result_count: 5,
          generated_at: null,
          message: status === 'paused' ? 'AI generation is temporarily paused.' : 'Grounded AI Insights are unavailable right now.',
          deterministic_evidence: {
            topic_evidence_status: 'weaknesses_identified',
            strengths: ['Strong performance in Addition: 5 of 5 recorded answers correct (100%).'],
            weaknesses: ['Subtraction — Oakleaf Bandits: 4 of 5 answers were incorrect (20% accuracy).'],
            recommendations: ['Practice Grade 1 Subtraction, especially the types missed during Oakleaf Bandits.'],
            quest_insights: [{
              canonical_task_id: 'go-to-school', label: 'Go to the School',
              completion_status: 'completed', quiz_status: 'not_required',
              summary: 'Quest completed — no graded questions required.',
            }],
          },
        }}
      />
    ));

    expect(container.textContent).toContain('Strengths, weaknesses, recommendations, and quest facts below are deterministic summaries of validated current-cycle records. No AI-generated insight is available.');
    expect(container.textContent).toContain('Strong performance in Addition: 5 of 5 recorded answers correct (100%).');
    expect(container.textContent).toContain('Subtraction — Oakleaf Bandits');
    expect(container.textContent).toContain('Practice Grade 1 Subtraction');
    expect(container.textContent).toContain('Per-Quest Evidence');
    expect(container.textContent).toContain('Quest completed — no graded questions required.');
    expect(container.textContent).toContain('Generated: Not generated');
    expect(container.textContent).toContain('Cache: No cached insight');
    expect(container.textContent).not.toContain('Recorded overall accuracy');
  });

  test('shows truthful no-data state and allows a refresh after new committed answers', async () => {
    const onRefresh = jest.fn();
    await act(async () => root.render(
      <GroundedAiAnalysis
        aiInsight={{ status: 'no_data', data_level: 'no_data', valid_result_count: 0, message: 'No valid gameplay results are available.' }}
        onRefresh={onRefresh}
      />
    ));

    expect(container.textContent).toContain('No valid gameplay results are available.');
    expect(container.textContent).toContain('Generated: Not generated');
    expect(container.textContent).toContain('Cache: No cached insight');
    expect(container.textContent).not.toContain('Current');
    const refresh = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Refresh AI Insight');
    expect(refresh).not.toBeNull();
    await act(async () => refresh.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test('shows completed non-graded quest evidence even when no graded result exists', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis
        aiInsight={{
          status: 'no_data', data_level: 'no_data', valid_result_count: 0,
          message: 'No valid gameplay results are available.',
          insight: {
            strengths: [], weaknesses: [], recommendations: [],
            quest_insights: [{
              canonical_task_id: 'go-to-school',
              label: 'Go to the School.',
              summary: 'Quest completed — no graded questions required.',
            }],
          },
        }}
        onRefresh={jest.fn()}
      />
    ));

    expect(container.textContent).toContain('No valid gameplay results are available.');
    expect(container.textContent).toContain('Per-Quest Evidence');
    expect(container.textContent).toContain('Go to the School.');
    expect(container.textContent).toContain('Quest completed — no graded questions required.');
    expect(container.textContent).toContain('No recorded graded results are available for a Mathematics weakness assessment yet.');
    expect(container.textContent).not.toContain('No supported weakness is identified from the recorded evidence.');
    expect(Array.from(container.querySelectorAll('button'))
      .some((button) => button.textContent === 'Refresh AI Insight')).toBe(true);
  });

  test('preserves story-only completion evidence that is described as recorded activity', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis
        aiInsight={{
          status: 'no_data', data_level: 'no_data', valid_result_count: 0,
          message: 'No valid gameplay results are available.',
          insight: {
            strengths: [], weaknesses: [], recommendations: [],
            quest_insights: [{
              canonical_task_id: 'go-to-school',
              label: 'Go to the School.',
              summary: 'Task completed from recorded activity; canonical task trigger and completion were recorded.',
            }],
          },
        }}
      />
    ));

    expect(container.textContent).toContain('Task completed from recorded activity');
    expect(container.textContent).toContain('canonical task trigger and completion were recorded');
    expect(container.textContent).not.toContain('No canonical completion or graded evidence is recorded for this task yet.');
  });

  test.each([
    ['tutorial', 'Tutorial', 'Oakleaf Village'],
    ['go-to-teachers-house', "Go to the Teacher's House", 'Oakleaf Village'],
    ['talk-to-the-teacher', 'Talk to the Teacher', 'Oakleaf Village'],
  ])('completed exploration %s stays complete without a missing-evidence fallback', async (taskId, label, location) => {
    await act(async () => root.render(
      <GroundedAiAnalysis aiInsight={{
        status: 'generated',
        insight: { strengths: [], weaknesses: [], recommendations: [], quest_insights: [{
          canonical_task_id: taskId,
          label,
          quest_type: taskId === 'tutorial' || taskId === 'go-to-teachers-house' ? 'exploration' : 'npc_interaction',
          completion_status: 'completed',
          completion_date: '2026-10-30T12:00:00.000Z',
          requires_graded_questions: false,
          quiz_status: 'not_required',
          location_labels: [location],
          summary: 'Recorded duration 90 seconds.',
        }] },
      }} />
    ));

    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain('Status: Completed');
    expect(container.textContent).toContain('Quiz: Not required');
    expect(container.textContent).toContain('Completion date:');
    expect(container.textContent).toContain(`Location: ${location}`);
    expect(container.textContent).not.toContain('No canonical completion or graded evidence is recorded for this task yet.');
    expect(container.textContent).not.toContain('No recorded evidence.');
  });

  test('started exploration keeps a truthful Started status and suppresses an empty duration-only summary', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis aiInsight={{
        status: 'generated',
        insight: { strengths: [], weaknesses: [], recommendations: [], quest_insights: [{
          canonical_task_id: 'go-to-teachers-house', label: "Go to the Teacher's House",
          quest_type: 'exploration', completion_status: 'started', quiz_status: 'not_required',
          summary: 'Recorded duration 15 seconds.',
        }] },
      }} />
    ));

    expect(container.textContent).toContain('Status: Started');
    expect(container.textContent).not.toContain('Status: Completed');
    expect(container.textContent).not.toContain('No canonical completion or graded evidence is recorded for this task yet.');
    expect(container.textContent).not.toContain('No recorded evidence.');
  });

  test('battle results remain visible without implying canonical task completion', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis aiInsight={{
        status: 'generated',
        insight: { strengths: [], weaknesses: [], recommendations: [], quest_insights: [{
          canonical_task_id: 'oakleaf-bandits', label: 'Oakleaf Bandits',
          quest_type: 'mathematics_battle', completion_status: 'not_recorded',
          quiz_status: 'results_recorded', correct_answers: 2, incorrect_answers: 1,
          total_questions: 3, accuracy: 66.67, summary: 'Recorded duration 90 seconds.',
        }] },
      }} />
    ));

    expect(container.textContent).toContain('Status: Not yet recorded');
    expect(container.textContent).toContain('Quiz: Results recorded');
    expect(container.textContent).toContain('2 correct, 1 incorrect of 3 questions (67%)');
    expect(container.textContent).not.toContain('Status: Completed');
    expect(container.textContent).not.toContain('No canonical completion or graded evidence is recorded for this task yet.');
  });

  test('battle without graded results reports the missing results and does not invent scores', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis aiInsight={{
        status: 'generated',
        insight: { strengths: [], weaknesses: [], recommendations: [], quest_insights: [{
          canonical_task_id: 'oakleaf-bandits', label: 'Oakleaf Bandits',
          quest_type: 'mathematics_battle', completion_status: 'started',
          quiz_status: 'results_not_recorded', summary: '',
        }] },
      }} />
    ));

    expect(container.textContent).toContain('Status: Started');
    expect(container.textContent).toContain('Quiz: Graded results not recorded');
    expect(container.textContent).not.toMatch(/\b\d+ correct, \d+ incorrect of \d+ questions/);
    expect(container.textContent).not.toContain('No canonical completion or graded evidence is recorded for this task yet.');
    expect(container.textContent).not.toContain('No recorded evidence.');
  });

  test('explains when recorded misses cannot be assigned to a validated topic', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis aiInsight={{
        status: 'generated',
        topic_evidence_status: 'topic_metadata_unavailable',
        insight: { performance_insight: 'Recorded answers include mistakes.', strengths: [], weaknesses: [], recommendations: [] },
      }} />
    ));

    expect(container.textContent).toContain('Recorded incorrect answers exist, but the questions are not linked to enough validated Mathematics topic information to identify a specific weakness.');
    expect(container.textContent).toContain('Topic-specific recommendations cannot be generated until those recorded questions are linked to validated Mathematics topics.');
    expect(container.textContent).not.toContain('No supported weakness is identified from the recorded evidence.');
  });

  test('shows task-and-topic evidence coverage and clear perfect-score empty states', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis aiInsight={{
        status: 'generated',
        valid_result_count: 4,
        topic_linked_evidence_count: 4,
        quest_topic_linked_evidence_count: 4,
        total_question_count: 4,
        incorrect_answers: 0,
        topic_evidence_status: 'perfect_recorded_results',
        insight: { performance_insight: 'All four recorded answers were correct.', strengths: [], weaknesses: [], recommendations: [] },
      }} />
    ));

    expect(container.textContent).toContain('Topic-linked evidence: 4 of 4 recorded answers');
    expect(container.textContent).toContain('Quest/topic-linked evidence: 4 of 4 recorded answers');
    expect(container.textContent).toContain('No weaknesses identified — no incorrect answers were recorded.');
    expect(container.textContent).toContain('No additional practice recommendation is needed based on the current perfect recorded results.');
  });

  test('shows explicit weakness and recommendation cards plus a generate action when insight is not generated yet', async () => {
    const onRefresh = jest.fn();
    await act(async () => root.render(
      <GroundedAiAnalysis
        aiInsight={{ status: 'not_generated', data_level: 'limited_data', valid_result_count: 3, message: 'No grounded insight has been generated yet.' }}
        onRefresh={onRefresh}
      />
    ));

    expect(container.textContent).toContain('AI Learning Guidance');
    expect(container.textContent).toContain('AI-Identified Weaknesses');
    expect(container.textContent).toContain('AI-Grounded Recommendations');
    expect(container.textContent).toContain('Generate the AI insight to identify evidence-backed weaknesses.');
    expect(container.textContent).toContain('Generate the AI insight to show recommended next steps.');

    const generateButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Generate AI Insight');
    expect(generateButton).not.toBeNull();
    await act(async () => generateButton.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);
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

  test('renders deterministic per-quest evidence returned with the grounded insight', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis aiInsight={{
        status: 'generated', data_level: 'sufficient_data', valid_result_count: 5,
        insight: {
          performance_insight: 'Recorded overall accuracy is 40%.',
          strengths: [], weaknesses: ['Three of five recorded answers were incorrect.'],
          recommendations: ['Review the recorded missed items.'],
          quest_insights: [{
            canonical_task_id: 'first-bandit-math-challenge', label: 'Bandit challenge',
            map_id: 'oakleaf_village', duration_seconds: 240,
            quest_type: 'mathematics_battle',
            correct_answers: 2, incorrect_answers: 3, total_questions: 5,
            accuracy: 40, average_response_time_seconds: 25,
            average_response_seconds: 25,
            summary: 'Bandit challenge: 2 correct and 3 incorrect across 5 graded answers (40% accuracy); 4m 0s recorded activity; 25s average response time.',
          }],
        },
      }} />
    ));

    expect(container.textContent).toContain('Per-Quest Evidence');
    expect(container.textContent).toContain('Bandit challenge');
    expect(container.textContent).toContain('Type: Mathematics battle');
    expect(container.textContent).toContain('2 correct, 3 incorrect of 5 questions (40%)');
    expect(container.textContent).toContain('25s average response time');
    expect(container.textContent).not.toContain('4m 0s recorded activity');
    expect(container.textContent).not.toContain('canonical task timing');
  });

  test('shows quest type, recording state, location, completion date, and only saved Guard encounters', async () => {
    await act(async () => root.render(
      <GroundedAiAnalysis aiInsight={{
        status: 'generated', data_level: 'sufficient_data', valid_result_count: 5,
        insight: {
          performance_insight: 'Recorded overall accuracy is 40%.',
          strengths: [], weaknesses: [], recommendations: [],
          quest_insights: [{
            canonical_task_id: 'pinehill-bandits', label: 'Pinehill Bandits',
            quest_type: 'mathematics_battle', completion_status: 'completed',
            completion_date: '2026-10-30T12:00:00.000Z',
            requires_graded_questions: true, quiz_status: 'results_recorded',
            location_labels: ['Pinehill Village'],
            encounters: [{ id: 'pinehill_bandits2', label: 'Guard 2' }],
            correct_answers: 1, incorrect_answers: 1, total_questions: 2, accuracy: 50,
            topic_performance: [{
              topic_id: 'addition', topic: 'Addition', grade_level: 'Grade 1',
              correct_answers: 1, incorrect_answers: 1, total_questions: 2, accuracy: 50,
            }],
            last_result_at: '2026-10-30T11:59:00.000Z',
            summary: 'Recorded evidence: 1 correct and 1 incorrect (50%).',
          }],
        },
      }} />
    ));

    expect(container.textContent).toContain('Type: Mathematics battle');
    expect(container.textContent).toContain('Status: Completed');
    expect(container.textContent).toContain('Pinehill Village');
    expect(container.textContent).toContain('Guard 2');
    expect(container.textContent).toContain('1 correct, 1 incorrect of 2 questions (50%)');
    expect(container.textContent).toContain('Grade 1 Addition');
    expect(container.textContent).not.toContain('Guard 1');
    expect(container.textContent).not.toContain('Guard 3');
    expect(container.textContent).not.toContain('Guard 4');
  });

  test('hides canonical quest duration from presentation without mutating graded or response-time evidence', async () => {
    const questInsight = {
      canonical_task_id: 'oakleaf-bandits',
      label: 'Defeat All Bandits',
      summary: 'Recorded evidence: recorded duration 240 seconds; 2 correct and 3 incorrect (40%); average recorded response time 25 seconds.',
    };

    await act(async () => root.render(
      <GroundedAiAnalysis aiInsight={{
        status: 'generated', data_level: 'sufficient_data', valid_result_count: 5,
        insight: {
          performance_insight: 'Recorded overall accuracy is 40%.',
          strengths: [], weaknesses: [], recommendations: [],
          quest_insights: [questInsight],
        },
      }} />
    ));

    expect(container.textContent).toContain('2 correct and 3 incorrect (40%)');
    expect(container.textContent).toContain('average recorded response time 25 seconds');
    expect(container.textContent).not.toContain('recorded duration');
    expect(container.textContent).not.toContain('240 seconds');
    expect(questInsight.summary).toContain('recorded duration 240 seconds');
  });

  test('renders the Student Insights selector with the dashboard styling hook', async () => {
    await act(async () => root.render(<StudentInsightsPanel
      students={[{ student_id: 11, student_name: 'Ana Reyes', game_student_id: '00000011' }]}
      role="admin"
    />));

    const wrapper = container.querySelector('.embedded-student-insights');
    const label = container.querySelector('label[for="embedded-student-insight-select"]');
    const select = container.querySelector('#embedded-student-insight-select');
    expect(wrapper).not.toBeNull();
    expect(label).not.toBeNull();
    expect(label.textContent).toBe('Student Insights');
    expect(select.classList.contains('student-insight-selector')).toBe(true);
    expect(select.getAttribute('aria-label')).toBe('Student Insights student selector');
  });
});
