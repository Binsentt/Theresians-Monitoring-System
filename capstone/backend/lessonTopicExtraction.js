const {
  getPublicRegistrySnapshot,
  getTopicsForScope,
  normalizeGradeLevel,
  normalizeDifficulty,
} = require('./curriculumScopeRegistry');

class LessonTopicExtractionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LessonTopicExtractionError';
    this.code = code;
  }
}

const ALL_TOPICS = getPublicRegistrySnapshot().topics;
const normalizeLabel = (value) => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');

const parseTopicHeading = (line) => {
  const normalizedLine = String(line || '').trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .trim();
  const explicit = normalizedLine.match(/^(?:mathematics\s+)?topic(?:\s+name)?\s*(?::|[-–—])\s*(.*?)\s*$/i);
  if (explicit) return { label: explicit[1], explicit: true };
  if (/^(?:mathematics\s+)?topic(?:\s+name)?\s*:/i.test(normalizedLine)) {
    return { label: '', explicit: true };
  }

  const prefixed = normalizedLine.match(/^(?:unit|chapter|lesson|section)\s+(?:\d+|[ivxlcdm]+)(?:\s*[:.)–—-]\s*|\s+)(.+?)\s*$/i)
    || normalizedLine.match(/^mathematics\s*[–—-]\s*(.+?)\s*$/i);
  if (prefixed) return { label: prefixed[1], explicit: false };
  return { label: normalizedLine, explicit: false };
};

const resolveHeadingTopic = (label, topics, allTopics) => {
  const normalized = normalizeLabel(label);
  if (!normalized) return { kind: 'unknown' };
  const match = topics.filter((topic) => [topic.display_label, ...(topic.aliases || [])]
    .some((candidate) => normalizeLabel(candidate) === normalized));
  if (match.length === 1) return { kind: 'valid', topic: match[0] };
  if (match.length > 1) return { kind: 'ambiguous' };
  const elsewhere = allTopics.some((topic) => [topic.display_label, ...(topic.aliases || [])]
    .some((candidate) => normalizeLabel(candidate) === normalized));
  return { kind: elsewhere ? 'out_of_scope' : 'unknown' };
};

const resolveScopeQualifiedTopicLabel = (line) => {
  const normalizedLine = normalizeLabel(String(line || '').trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, ''));
  if (!/\bgrade\s*[1-6]\b/i.test(normalizedLine)
    || !/\b(?:easy|normal|medium|difficult|hard)\b/i.test(normalizedLine)) return null;

  const matches = [];
  for (const topic of ALL_TOPICS) {
    for (const label of [topic.display_label, ...(topic.aliases || [])]) {
      const normalizedLabel = normalizeLabel(label);
      if (!normalizedLine.includes(normalizedLabel)) continue;
      const remainder = normalizedLine.replace(normalizedLabel, ' ')
        .replace(/\bgrade\s*[1-6]\b/gi, ' ')
        .replace(/\b(?:easy|normal|medium|difficult|hard)\b/gi, ' ')
        .replace(/\b\d+\s*(?:questions?|items?)\b/gi, ' ')
        .replace(/\b(?:mathematics|math|lesson|topic|set|unit|chapter|section|question|questions|item|items)\b/gi, ' ')
        .replace(/\b\d+\b/g, ' ')
        .replace(/[\s\p{P}\p{S}]+/gu, '');
      if (!remainder) matches.push(label);
    }
  }
  const uniqueLabels = [...new Set(matches.map(normalizeLabel))];
  return uniqueLabels.length === 1 ? matches.find((label) => normalizeLabel(label) === uniqueLabels[0]) : null;
};

const looksLikeScopeQualifiedTopicHeading = (line) => {
  const value = String(line || '').trim();
  return /\bgrade\s*[1-6]\b/i.test(value)
    && /\b(?:easy|normal|medium|difficult|hard)\b/i.test(value)
    && /\b\d+\s*(?:questions?|items?)\b/i.test(value)
    && /[·•|–—:-]/.test(value);
};

const resolveCanonicalTopicHeading = (line, gradeLevel, difficulty) => {
  const parsed = parseTopicHeading(line);
  const qualifiedLabel = resolveScopeQualifiedTopicLabel(line);
  const label = qualifiedLabel || parsed.label;
  const normalized = normalizeLabel(label);
  const knownCanonicalLabel = normalized && ALL_TOPICS.some((topic) => [topic.display_label, ...(topic.aliases || [])]
    .some((candidate) => normalizeLabel(candidate) === normalized));
  const hasSequencePrefix = /^(?:unit|chapter|lesson|section)\s+(?:\d+|[ivxlcdm]+)/i.test(String(line || '').trim());
  const hasMathematicsPrefix = /^mathematics\s*[–—-]/i.test(String(line || '').trim());
  const hasScopeQualifiedHeading = looksLikeScopeQualifiedTopicHeading(line);
  if (!parsed.explicit && !knownCanonicalLabel && !hasSequencePrefix && !hasMathematicsPrefix && !hasScopeQualifiedHeading) return null;

  if (hasScopeQualifiedHeading) {
    const declaredGrade = String(line).match(/\bgrade\s*([1-6])\b/i)?.[1];
    const declaredDifficulty = String(line).match(/\b(easy|normal|medium|difficult|hard)\b/i)?.[1];
    if ((declaredGrade && normalizeGradeLevel(gradeLevel) !== `Grade ${declaredGrade}`)
      || (declaredDifficulty && normalizeDifficulty(difficulty) !== normalizeDifficulty(declaredDifficulty))) {
      return { is_heading: true, kind: 'scope_mismatch', label };
    }
  }

  const resolved = resolveHeadingTopic(label, getTopicsForScope(gradeLevel, difficulty), ALL_TOPICS);
  if (!parsed.explicit && !knownCanonicalLabel && !hasSequencePrefix && !hasMathematicsPrefix && resolved.kind === 'unknown') {
    return hasSequencePrefix || hasMathematicsPrefix
      ? { is_heading: true, kind: 'unknown', label }
      : hasScopeQualifiedHeading ? { is_heading: true, kind: 'unknown', label } : null;
  }
  return { is_heading: true, ...resolved, label };
};

const resolveLessonTopicSections = ({ lessonText, gradeLevel, difficulty } = {}) => {
  const grade = normalizeGradeLevel(gradeLevel);
  const level = normalizeDifficulty(difficulty);
  if (!grade || !level) {
    throw new LessonTopicExtractionError('LESSON_TOPIC_SCOPE_INVALID', 'Select a supported Grade and Difficulty before generating questions.');
  }

  const text = String(lessonText || '').replace(/\r\n?/g, '\n');
  if (!text.trim()) {
    throw new LessonTopicExtractionError('LESSON_TOPIC_HEADING_REQUIRED', 'The lesson document needs a clear heading that matches a canonical Mathematics topic before questions can be generated.');
  }

  const rawSections = [];
  let active = null;

  for (const line of text.split('\n')) {
    const heading = resolveCanonicalTopicHeading(line, grade, level);
    if (heading) {
      // Ordinary prose is ignored. Explicit or recognizable document heading
      // forms fail closed when their label is unknown or outside this scope.
      if (active) rawSections.push(active);
      if (heading.kind !== 'valid') {
        const code = heading.kind === 'out_of_scope'
          ? 'LESSON_TOPIC_OUT_OF_SCOPE'
          : heading.kind === 'scope_mismatch'
            ? 'LESSON_TOPIC_SCOPE_MISMATCH'
          : heading.kind === 'ambiguous'
            ? 'LESSON_TOPIC_HEADING_AMBIGUOUS'
            : 'LESSON_TOPIC_UNKNOWN';
        throw new LessonTopicExtractionError(code, heading.kind === 'out_of_scope'
          ? 'A topic in the lesson is not eligible for the selected Grade and Difficulty.'
          : heading.kind === 'scope_mismatch'
            ? 'The document Grade/Difficulty heading does not match the selected Grade and Difficulty.'
          : 'A topic heading in the lesson does not match one canonical Mathematics topic. Correct the heading before generating questions.');
      }
      active = { topic: heading.topic, lines: [] };
      continue;
    }
    if (active && String(line || '').trim()) active.lines.push(String(line).trim());
  }
  if (active) rawSections.push(active);
  if (rawSections.length === 0) {
    throw new LessonTopicExtractionError('LESSON_TOPIC_HEADING_REQUIRED', 'The lesson document needs a clear heading that matches a canonical Mathematics topic. A standalone topic name or clear Topic, Unit, Chapter, Lesson, or Section heading is accepted.');
  }

  const grouped = new Map();
  rawSections.forEach(({ topic, lines }) => {
    const sectionText = lines.join('\n').trim();
    if (!sectionText) {
      throw new LessonTopicExtractionError('LESSON_TOPIC_SECTION_EMPTY', 'Each canonical topic heading must have lesson content beneath it.');
    }
    const prior = grouped.get(topic.topic_id);
    grouped.set(topic.topic_id, {
      topic_id: topic.topic_id,
      math_topic: topic.display_label,
      section_text: prior ? `${prior.section_text}\n\n${sectionText}` : sectionText,
    });
  });

  return [...grouped.values()];
};

const allocateLessonQuestionTargets = ({ sections, questionCount, existingQuestions = [] } = {}) => {
  const selectedSections = Array.isArray(sections) ? sections : [];
  const total = Number(questionCount);
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new LessonTopicExtractionError('LESSON_QUESTION_COUNT_INVALID', 'Question Count must be a positive whole number.');
  }
  if (!selectedSections.length) {
    throw new LessonTopicExtractionError('LESSON_TOPIC_HEADING_REQUIRED', 'A canonical topic heading is required before generating questions.');
  }
  if (total < selectedSections.length) {
    throw new LessonTopicExtractionError('LESSON_QUESTION_COUNT_BELOW_TOPIC_COUNT', `Question Count must be at least ${selectedSections.length} so every verified lesson topic is represented.`);
  }

  const sectionIds = new Set(selectedSections.map((section) => section.topic_id));
  const counts = selectedSections.map((section) => (Array.isArray(existingQuestions) ? existingQuestions : [])
    .filter((question) => question?.topic_id === section.topic_id).length);
  const priorTotal = (Array.isArray(existingQuestions) ? existingQuestions : []).length;
  if (priorTotal > total) {
    throw new LessonTopicExtractionError('LESSON_EXISTING_QUESTION_COUNT_EXCEEDS_TARGET', 'The saved question set already exceeds the requested question count. Existing questions were preserved.');
  }

  for (let remaining = total - priorTotal; remaining > 0; remaining -= 1) {
    let targetIndex = -1;
    for (let index = 0; index < selectedSections.length; index += 1) {
      if (!sectionIds.has(selectedSections[index].topic_id)) continue;
      if (targetIndex < 0 || counts[index] < counts[targetIndex]) targetIndex = index;
    }
    counts[targetIndex] += 1;
  }

  return selectedSections.map((section, index) => ({
    topic_id: section.topic_id,
    target_count: counts[index],
    existing_count: (Array.isArray(existingQuestions) ? existingQuestions : [])
      .filter((question) => question?.topic_id === section.topic_id).length,
  }));
};

module.exports = {
  LessonTopicExtractionError,
  allocateLessonQuestionTargets,
  resolveHeadingTopic,
  resolveCanonicalTopicHeading,
  resolveLessonTopicSections,
};
