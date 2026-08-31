import {
  getRegistryScopeTopics,
  getRegistryTopicIdForDisplayLabel,
  normalizeCurriculumRegistry,
} from './curriculumRegistry';

const registryFixture = {
  version: '2026-08-31',
  grades: ['Grade 1', 'Grade 2'],
  difficulties: ['Easy', 'Normal', 'Difficult'],
  topics: [
    { topic_id: 'basic_addition', display_label: 'Basic Addition' },
    { topic_id: 'shapes', display_label: 'Shapes' },
  ],
  scopes: [{
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    topic_ids: ['basic_addition', 'shapes'],
  }],
};

test('uses backend registry scope memberships and labels without a local topic map', () => {
  const registry = normalizeCurriculumRegistry(registryFixture);

  expect(getRegistryScopeTopics(registry, 'Grade 1', 'Easy')).toEqual([
    { topic_id: 'basic_addition', display_label: 'Basic Addition', aliases: [] },
    { topic_id: 'shapes', display_label: 'Shapes', aliases: [] },
  ]);
  expect(getRegistryTopicIdForDisplayLabel(registry, 'Grade 1', 'Easy', 'Shapes')).toBe('shapes');
  expect(getRegistryScopeTopics(registry, 'Grade 2', 'Easy')).toEqual([]);
});
