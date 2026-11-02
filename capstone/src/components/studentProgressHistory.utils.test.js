const { buildScoreTimeline, buildLatestActivity, formatLatestActivityScore } = require('./studentProgressHistory.utils');

describe('student progress history utilities', () => {
  test('keeps the latest 20 valid scores in chronological order and preserves zero', () => {
    const results = Array.from({ length: 23 }, (_, index) => ({
      id: index + 1,
      session_id: index + 101,
      percentage: index === 0 ? 0 : index * 4,
      score: index,
      total_items: 25,
      played_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    }));
    results.push(
      { id: 90, percentage: null, played_at: '2026-02-01T00:00:00.000Z' },
      { id: 91, percentage: 101, played_at: '2026-02-02T00:00:00.000Z' },
      { id: 92, percentage: 'bad', played_at: '2026-02-03T00:00:00.000Z' },
    );

    const timeline = buildScoreTimeline(results);

    expect(timeline).toHaveLength(20);
    expect(timeline[0]).toEqual(expect.objectContaining({ resultId: 4, sessionId: 104, label: 'Q1', percentage: 12 }));
    expect(timeline.at(-1)).toEqual(expect.objectContaining({ resultId: 23, sessionId: 123, label: 'Q20', percentage: 88 }));
    expect(timeline[0].playedAt).toBe('2026-01-04T00:00:00.000Z');
    expect(timeline.map((point) => point.label)).toEqual(Array.from({ length: 20 }, (_, index) => 'Q' + (index + 1)));
  });

  test('does not substitute a result row ID when the session ID is unavailable', () => {
    const [point] = buildScoreTimeline([{ id: 44, percentage: 100, played_at: '2026-01-01T00:00:00.000Z' }]);

    expect(point).toEqual(expect.objectContaining({ resultId: 44, sessionId: null }));
  });

  test('sorts latest activity by available timestamp and takes five', () => {
    const rows = [
      { id: 1, activity_timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 2, completed_at: '2026-01-02T00:00:00.000Z' },
      { id: 3, started_at: '2026-01-03T00:00:00.000Z' },
      { id: 4, created_at: '2026-01-04T00:00:00.000Z' },
      { id: 5, activity_timestamp: '2026-01-05T00:00:00.000Z' },
      { id: 6, activity_timestamp: '2026-01-06T00:00:00.000Z' },
      { id: 7, activity_timestamp: '2026-01-07T00:00:00.000Z' },
    ];

    expect(buildLatestActivity(rows).map((row) => row.id)).toEqual([7, 6, 5, 4, 3]);
  });

  test('does not report ungraded story events as a zero score', () => {
    expect(formatLatestActivityScore({ activity_description: 'Task Completed — talk to the Old Lady', score: 0 }))
      .toBe('Not graded');
    expect(formatLatestActivityScore({ activity_description: 'Quiz Result', score: 0, total_items: 1 }))
      .toBe('0 / 1');
  });
});
