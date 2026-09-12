const DEFAULT_MILESTONE_WEIGHT = 1;

function normalizeMilestoneId(value) {
  const id = String(value || '').trim().toLowerCase();
  return id && /^[a-z0-9][a-z0-9._:-]{0,191}$/.test(id) ? id : null;
}

function classifyMilestoneWeight(milestoneId) {
  const id = normalizeMilestoneId(milestoneId) || '';
  if (/(^|[-_.:])(boss|final)([-_.:]|$)/.test(id)) return 4;
  if (/(battle|bandit|quiz|challenge)/.test(id)) return 3;
  return DEFAULT_MILESTONE_WEIGHT;
}

function countUniqueCompletedMilestones(rows = []) {
  return new Set((Array.isArray(rows) ? rows : [])
    .map((row) => normalizeMilestoneId(row?.milestone_id ?? row?.task_id ?? row?.event_key))
    .filter(Boolean)).size;
}

function calculateWeightedCompletion({ completed = [], required = [] } = {}) {
  const requiredRows = Array.isArray(required) ? required : [];
  const requiredById = new Map();
  requiredRows.forEach((row) => {
    const id = normalizeMilestoneId(row?.milestone_id ?? row?.task_id);
    if (!id) return;
    const weight = Number(row?.weight);
    requiredById.set(id, Number.isFinite(weight) && weight > 0 ? weight : classifyMilestoneWeight(id));
  });
  const denominator = Array.from(requiredById.values()).reduce((sum, weight) => sum + weight, 0);
  if (!denominator) return null;
  const completedIds = new Set((Array.isArray(completed) ? completed : [])
    .map((row) => normalizeMilestoneId(row?.milestone_id ?? row?.task_id ?? row?.event_key))
    .filter((id) => id && requiredById.has(id)));
  const numerator = Array.from(completedIds).reduce((sum, id) => sum + requiredById.get(id), 0);
  return Number(((numerator / denominator) * 100).toFixed(2));
}

module.exports = {
  DEFAULT_MILESTONE_WEIGHT,
  normalizeMilestoneId,
  classifyMilestoneWeight,
  countUniqueCompletedMilestones,
  calculateWeightedCompletion,
};
