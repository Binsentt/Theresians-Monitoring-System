const REGISTRY_VERSION = '2026-08-31';

const CANONICAL_GRADES = Object.freeze([
  'Grade 1',
  'Grade 2',
  'Grade 3',
  'Grade 4',
  'Grade 5',
  'Grade 6',
]);

const CANONICAL_DIFFICULTIES = Object.freeze([
  'Easy',
  'Normal',
  'Difficult',
]);

const GRADE_ALIASES = Object.freeze({
  '1': 'Grade 1',
  grade1: 'Grade 1',
  'grade 1': 'Grade 1',
  '2': 'Grade 2',
  grade2: 'Grade 2',
  'grade 2': 'Grade 2',
  '3': 'Grade 3',
  grade3: 'Grade 3',
  'grade 3': 'Grade 3',
  '4': 'Grade 4',
  grade4: 'Grade 4',
  'grade 4': 'Grade 4',
  '5': 'Grade 5',
  grade5: 'Grade 5',
  'grade 5': 'Grade 5',
  '6': 'Grade 6',
  grade6: 'Grade 6',
  'grade 6': 'Grade 6',
});

const DIFFICULTY_ALIASES = Object.freeze({
  easy: 'Easy',
  normal: 'Normal',
  medium: 'Normal',
  average: 'Normal',
  difficult: 'Difficult',
  hard: 'Difficult',
});

const TOPICS = Object.freeze([
  { topic_id: 'basic_addition', display_label: 'Basic Addition', aliases: [], fixed_question_evidence: 'deterministic' },
  { topic_id: 'subtraction', display_label: 'Subtraction', aliases: [], fixed_question_evidence: 'deterministic' },
  { topic_id: 'shapes', display_label: 'Shapes', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'place_value', display_label: 'Place Value', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'addition', display_label: 'Addition', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'multiplication', display_label: 'Multiplication', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'word_problems', display_label: 'Word Problems', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'problem_solving_addition_subtraction', display_label: 'Problem Solving (Addition and Subtraction)', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'ordinal_numbers', display_label: 'Ordinal Numbers', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'basic_addition_subtraction', display_label: 'Basic Addition/Subtraction', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'division', display_label: 'Division', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'problem_solving', display_label: 'Problem Solving', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'fractions', display_label: 'Fractions', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'addition_of_money', display_label: 'Addition of Money', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'whole_numbers', display_label: 'Whole Numbers', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'multi_step_problem_solving', display_label: 'Multi-step Problem Solving', aliases: ['Multi-Step Problem Solving'], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'number_theory', display_label: 'Number Theory', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'place_value_of_whole_numbers', display_label: 'Place Value of Whole Numbers', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'reading_writing_comparing_whole_numbers', display_label: 'Reading, Writing, and Comparing Whole Numbers', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'basic_arithmetic', display_label: 'Basic Arithmetic', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'time_conversion', display_label: 'Time Conversion', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'order_of_operations', display_label: 'Order of Operations', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'number_sense_and_operations', display_label: 'Number Sense and Operations', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'rational_numbers', display_label: 'Rational Numbers', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
  { topic_id: 'geometric_measurements', display_label: 'Geometric Measurements', aliases: [], fixed_question_evidence: 'explicit_topic_id' },
].map((topic) => Object.freeze({ ...topic, aliases: Object.freeze([...topic.aliases]) })));

const SCOPES = Object.freeze([
  { grade_level: 'Grade 1', difficulty: 'Easy', topic_ids: ['basic_addition', 'subtraction', 'shapes', 'place_value'] },
  { grade_level: 'Grade 1', difficulty: 'Normal', topic_ids: ['addition', 'multiplication', 'word_problems'] },
  { grade_level: 'Grade 1', difficulty: 'Difficult', topic_ids: ['problem_solving_addition_subtraction'] },
  { grade_level: 'Grade 2', difficulty: 'Easy', topic_ids: ['shapes', 'ordinal_numbers', 'basic_addition_subtraction'] },
  { grade_level: 'Grade 2', difficulty: 'Normal', topic_ids: ['multiplication', 'division', 'word_problems'] },
  { grade_level: 'Grade 2', difficulty: 'Difficult', topic_ids: ['problem_solving', 'multiplication', 'division', 'fractions'] },
  { grade_level: 'Grade 3', difficulty: 'Easy', topic_ids: ['addition_of_money', 'whole_numbers'] },
  { grade_level: 'Grade 3', difficulty: 'Normal', topic_ids: ['multiplication', 'division', 'fractions'] },
  { grade_level: 'Grade 3', difficulty: 'Difficult', topic_ids: ['multi_step_problem_solving'] },
  { grade_level: 'Grade 4', difficulty: 'Easy', topic_ids: ['number_theory'] },
  { grade_level: 'Grade 4', difficulty: 'Normal', topic_ids: ['place_value_of_whole_numbers'] },
  { grade_level: 'Grade 4', difficulty: 'Difficult', topic_ids: ['reading_writing_comparing_whole_numbers'] },
  { grade_level: 'Grade 5', difficulty: 'Easy', topic_ids: ['number_theory', 'basic_arithmetic'] },
  { grade_level: 'Grade 5', difficulty: 'Normal', topic_ids: ['number_theory', 'basic_arithmetic'] },
  { grade_level: 'Grade 5', difficulty: 'Difficult', topic_ids: ['time_conversion', 'number_theory', 'word_problems', 'order_of_operations'] },
  { grade_level: 'Grade 6', difficulty: 'Easy', topic_ids: ['number_sense_and_operations'] },
  { grade_level: 'Grade 6', difficulty: 'Normal', topic_ids: ['number_sense_and_operations'] },
  { grade_level: 'Grade 6', difficulty: 'Difficult', topic_ids: ['rational_numbers', 'geometric_measurements'] },
].map((scope) => Object.freeze({ ...scope, topic_ids: Object.freeze([...scope.topic_ids]) })));

const TOPIC_BY_ID = new Map(TOPICS.map((topic) => [topic.topic_id, topic]));
const SCOPE_BY_KEY = new Map(SCOPES.map((scope) => [`${scope.grade_level}|${scope.difficulty}`, scope]));

const normalizedKey = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const normalizeGradeLevel = (value) => GRADE_ALIASES[normalizedKey(value)] || null;

const normalizeDifficulty = (value) => DIFFICULTY_ALIASES[normalizedKey(value)] || null;

const normalizeTopicId = (value) => {
  const topicId = String(value || '').trim();
  return TOPIC_BY_ID.has(topicId) ? topicId : null;
};

const getTopicById = (topicId) => TOPIC_BY_ID.get(normalizeTopicId(topicId)) || null;

const getScope = (gradeLevel, difficulty) => {
  const grade = normalizeGradeLevel(gradeLevel);
  const level = normalizeDifficulty(difficulty);
  return grade && level ? SCOPE_BY_KEY.get(`${grade}|${level}`) || null : null;
};

const getTopicsForScope = (gradeLevel, difficulty) => {
  const scope = getScope(gradeLevel, difficulty);
  return scope ? scope.topic_ids.map((topicId) => TOPIC_BY_ID.get(topicId)) : [];
};

const isValidScope = (gradeLevel, difficulty, topicId) => {
  const scope = getScope(gradeLevel, difficulty);
  const canonicalTopicId = normalizeTopicId(topicId);
  return Boolean(scope && canonicalTopicId && scope.topic_ids.includes(canonicalTopicId));
};

const normalizeScope = ({ grade_level: gradeLevel, difficulty, topic_id: topicId } = {}) => {
  const grade = normalizeGradeLevel(gradeLevel);
  const level = normalizeDifficulty(difficulty);
  const canonicalTopicId = normalizeTopicId(topicId);
  if (!grade || !level || !canonicalTopicId) return null;
  return { grade_level: grade, difficulty: level, topic_id: canonicalTopicId };
};

const resolveLegacyDisplayTopic = (gradeLevel, difficulty, displayLabel) => {
  const scope = getScope(gradeLevel, difficulty);
  const label = normalizedKey(displayLabel);
  if (!scope || !label) return null;

  const matchingTopicIds = scope.topic_ids.filter((topicId) => {
    const topic = TOPIC_BY_ID.get(topicId);
    return [topic.display_label, ...topic.aliases].some((candidate) => normalizedKey(candidate) === label);
  });

  return matchingTopicIds.length === 1 ? matchingTopicIds[0] : null;
};

const cloneTopic = (topic) => ({
  topic_id: topic.topic_id,
  display_label: topic.display_label,
  aliases: [...topic.aliases],
  fixed_question_evidence: topic.fixed_question_evidence,
});

const getPublicRegistrySnapshot = () => ({
  version: REGISTRY_VERSION,
  grades: CANONICAL_GRADES.map((value) => ({
    value,
    display_label: value,
    aliases: Object.entries(GRADE_ALIASES)
      .filter(([, canonical]) => canonical === value)
      .map(([alias]) => alias),
  })),
  difficulties: CANONICAL_DIFFICULTIES.map((value) => ({
    value,
    display_label: value,
    aliases: Object.entries(DIFFICULTY_ALIASES)
      .filter(([alias, canonical]) => canonical === value && alias !== value.toLowerCase())
      .map(([alias]) => alias),
  })),
  topics: TOPICS.map(cloneTopic),
  scopes: SCOPES.map((scope) => ({
    grade_level: scope.grade_level,
    difficulty: scope.difficulty,
    topic_ids: [...scope.topic_ids],
  })),
});

module.exports = {
  CANONICAL_DIFFICULTIES,
  CANONICAL_GRADES,
  DIFFICULTY_ALIASES,
  GRADE_ALIASES,
  REGISTRY_VERSION,
  SCOPES,
  TOPICS,
  getPublicRegistrySnapshot,
  getScope,
  getTopicById,
  getTopicsForScope,
  isValidScope,
  normalizeDifficulty,
  normalizeGradeLevel,
  normalizeScope,
  normalizeTopicId,
  resolveLegacyDisplayTopic,
};
