import { apiUrl } from './api';

const asString = (value) => String(value || '').trim();

export const normalizeCurriculumRegistry = (payload = {}) => ({
  version: asString(payload.version),
  grades: Array.isArray(payload.grades) ? payload.grades.map(asString).filter(Boolean) : [],
  difficulties: Array.isArray(payload.difficulties) ? payload.difficulties.map(asString).filter(Boolean) : [],
  topics: Array.isArray(payload.topics)
    ? payload.topics.map((topic) => ({
      topic_id: asString(topic?.topic_id),
      display_label: asString(topic?.display_label),
      aliases: Array.isArray(topic?.aliases) ? topic.aliases.map(asString).filter(Boolean) : [],
    })).filter((topic) => topic.topic_id && topic.display_label)
    : [],
  scopes: Array.isArray(payload.scopes)
    ? payload.scopes.map((scope) => ({
      grade_level: asString(scope?.grade_level),
      difficulty: asString(scope?.difficulty),
      topic_ids: Array.isArray(scope?.topic_ids) ? scope.topic_ids.map(asString).filter(Boolean) : [],
    })).filter((scope) => scope.grade_level && scope.difficulty)
    : [],
});

export const getRegistryScopeTopics = (registry, gradeLevel, difficulty) => {
  const scope = registry?.scopes?.find((candidate) => (
    candidate.grade_level === asString(gradeLevel)
    && candidate.difficulty === asString(difficulty)
  ));
  if (!scope) return [];
  return scope.topic_ids
    .map((topicId) => registry?.topics?.find((topic) => topic.topic_id === topicId))
    .filter(Boolean);
};

export const getRegistryTopicIdForDisplayLabel = (registry, gradeLevel, difficulty, displayLabel) => {
  const selectedLabel = asString(displayLabel);
  return getRegistryScopeTopics(registry, gradeLevel, difficulty)
    .find((topic) => topic.display_label === selectedLabel)?.topic_id || '';
};

export const fetchCurriculumRegistry = async (fetchImpl = globalThis.fetch) => {
  const response = await fetchImpl(apiUrl('/api/curriculum/registry'));
  if (!response.ok) throw new Error('Unable to load the curriculum registry.');
  return normalizeCurriculumRegistry(await response.json());
};
