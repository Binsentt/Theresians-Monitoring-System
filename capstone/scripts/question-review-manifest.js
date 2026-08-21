const crypto = require('crypto');

const GAME_LOCATION_BY_DIFFICULTY = Object.freeze({
  Easy: 'Oakleaf Village',
  Medium: 'City of Knowledge',
  Hard: 'Pinehill Village',
});

// These assignments are deliberately keyed by immutable content fingerprints,
// not source position or broad language heuristics. Each one was reviewed as a
// direct, single-topic mathematical statement. New or changed content remains
// manual until a reviewer supplies equivalent controlled evidence.
const DETERMINISTIC_TOPIC_ASSIGNMENTS = Object.freeze({
  '9b72820de80cd8cb7fc49b615031e9a2433123318d9a3dd8ccb2990b0e9a8b39': { topic: 'Basic Addition', reason: 'Direct addition expression.' },
  '6da9153287e9bf2b7dfe09769f641074efef5a0de05174ecaa24b0d4b3016554': { topic: 'Shapes', reason: 'Direct geometric-shape question.' },
  '515d07c8843e818598452afc8860cb24f3f19da3d3349bfa9e93f5a16ae6e2aa': { topic: 'Subtraction', reason: 'Direct remaining-quantity subtraction question.' },
  'ad0fadef4133a83cc96ec6e07c2d344032c045fc8faf1bd3ce79fc9ff2c39169': { topic: 'Subtraction', reason: 'Direct subtraction expression.' },
  '2f056cc5a04d0f1aa8780ac3dbe00c5774e658eba808dee02a2c64878c6fc419': { topic: 'Place Value', reason: 'Direct place-value question.' },
  'babc98d97c6c4c2cc2e5c6ae4eb435cae4a42a0a41a1f9c62b92742922162656': { topic: 'Addition', reason: 'Direct combined-total addition question.' },
  '207d8ca37d3f424a53445f843346aecf9f3138df20a8fcd387c59e5920e6558f': { topic: 'Multiplication', reason: 'Direct multiplication expression.' },
  '546626963d8d6ef33d94d398294e45839edec4af38323ca6ddc827fed3dc2297': { topic: 'Word Problems', reason: 'Single-operation narrative not represented by the other Grade 1 Medium controlled topics.' },
  '488ca84d7d2922bc322698c96828db0139ed845483262df73b7c6da02ba96be9': { topic: 'Addition', reason: 'Direct combined-total addition question.' },
  'a549406c5b44802efe0a263653c7705c97d53b528405e32f2765e25c72298434': { topic: 'Multiplication', reason: 'Equal groups with a total requested.' },
  'a9a52a0aa33f00d669d0ad5430bad9832aec385a1af3af9c6187b005bde0c098': { topic: 'Division', reason: 'Equal-sharing division question.' },
  'f352dab9a81b693383e7695ce1549080ca5fe0552203a33ab95b65700c910875': { topic: 'Problem Solving', reason: 'Narrative comparison problem within the Grade 2 Hard controlled vocabulary.' },
  '00a596932e70187e7cf17ae8045985490af630e6017dd19eb053265091b11a54': { topic: 'Problem Solving', reason: 'Narrative remaining-quantity problem within the Grade 2 Hard controlled vocabulary.' },
  '34834761441cfeeef56a25e92e63c374ffc064a20b7f405259eb3cb75f96676b': { topic: 'Fractions', reason: 'Direct fraction-of-a-set question.' },
  '778f5034884a04dcad119a5ccc8c2f969ac4ebbcb82dcc4ff232b278b96bb821': { topic: 'Shapes', reason: 'Direct geometric-shape question.' },
  '116d63bd4550dfbb5638ffcf2612e8cd3717d77b3e2fee9c9e728c65002362ca': { topic: 'Ordinal Numbers', reason: 'Direct ordinal-number question.' },
  '5669ad09bb01843ad296fcff0f48d5aa67c8ac71fd760f240eac3c6e87e061ac': { topic: 'Basic Addition/Subtraction', reason: 'Direct combined-total arithmetic question.' },
  'c2ba0478379d8b7330dd31316e338f5136e2d98090ba29e66635b5fd081939d1': { topic: 'Basic Addition/Subtraction', reason: 'Direct comparison subtraction question.' },
  'bce5937dd7fa7cd7fb1cd0c4f676edf2fb36daa421769117677af2256801e069': { topic: 'Basic Addition/Subtraction', reason: 'Direct combined-total arithmetic question.' },
  '8d1285a089e564da68f8fcc6e9c39c30eaf1cda626ed04e43fc39fb211874fbc': { topic: 'Multiplication', reason: 'Repeated-number groups expressed as a sum.' },
  '1e9f9cbf884a64960b5f8ac0f4639fcb596fd40237c85f311a7a3eb38ccf1593': { topic: 'Multiplication', reason: 'Equal groups with a total requested.' },
  '2e40bf734213612011cadbc5895c7f8e0a1e16716a5d8edffb7be4d19790a74a': { topic: 'Word Problems', reason: 'Single-operation narrative not represented by the other Grade 2 Medium controlled topics.' },
  'a56e94c9e4f21cf1cb4cbccdc400b63f8c39718fd8ee5cce0a0346708d5ee512': { topic: 'Division', reason: 'Direct equal-group division question.' },
  'f2c037bc6216ed6d823be0302cb3d928a0564214218c89ee31d5f200b3b6901f': { topic: 'Basic Addition', reason: 'Direct addition expression.' },
  '67ef1c327bb38392e2dcd41aeebcb0d4b2300cb60d77d19769f3f71f3f982603': { topic: 'Basic Addition', reason: 'Direct addition expression.' },
  '2189382d4388664e8caebbcde0b4336c690f142f130ccfddd14a438e7193f738': { topic: 'Subtraction', reason: 'Direct subtraction expression.' },
  '14ea10acf09377064c69d82f886ebcb25635d6e5f03441c656f0b442b228dbcb': { topic: 'Basic Addition', reason: 'Direct addition expression.' },
  'bbe7bf9d740d1090474dc4f1338bf089a82fc661cc1e3ee41250f793f96afb84': { topic: 'Subtraction', reason: 'Direct subtraction expression.' },
  '23f7fb61ff8098b87a3158ea8c1a478af96669b85f94956d2657b4b6b1e66640': { topic: 'Addition of Money', reason: 'Direct monetary addition question.' },
  '514fe08c2f910c157d27f2546e7cca9df2e43787f370e335a669f530eb18d047': { topic: 'Addition of Money', reason: 'Direct monetary total question.' },
  'f4fd6cbf8b241f3e573f876cedb5dbeac5ba3a891c4a05c64e62f5a964ad4733': { topic: 'Addition of Money', reason: 'Direct monetary addition question.' },
  'cc7a41b7b7bec8cf5253e04c566e4804d5845ef9e4f65c4cfecd5de49b5cd07e': { topic: 'Addition of Money', reason: 'Direct monetary addition question.' },
  '22ac7ee53a60eeac20581a05d92a824aee99657edadd7518e7c74b8b75bba493': { topic: 'Whole Numbers', reason: 'Whole-number addition with no monetary unit.' },
  '17846a58bd6b852ba2eeaf8b625bc4b4b68ac0c466b1d3e3aa39edea58e3876e': { topic: 'Multiplication', reason: 'Repeated groups expressed as multiples.' },
  '26b281c920d0dcd390e6ab9e6e2717b250916da39c3fa4ffda646997fddc1f8e': { topic: 'Multiplication', reason: 'Equal groups with a total requested.' },
  '691fde9e3780b14eeafb080188b5e2e4bd5ccbd1f5316352ef338111e9710948': { topic: 'Division', reason: 'Equal-group division question.' },
  'ef9ecc5f2121454d6c5643f8869cee3dd3a2026a8b87b4025c486381a880b996': { topic: 'Fractions', reason: 'Direct mixed-fraction question.' },
  '707ad4730bcdc8a3ed87814963cd919fbab08d5f340684f2cd2eac700e6ad030': { topic: 'Fractions', reason: 'Direct mixed-fraction question.' },
});

// Explicit reviewer decisions are separate from deterministic assignments.
// They are fingerprint-keyed so a changed question must be reviewed again.
const MANUAL_TOPIC_CONFIRMATIONS = Object.freeze({
  'b7ad013852646f0c337df1dcd384f73bd7bf201dff4c9e5a0dae00c4f992014d': {
    topic: 'Word Problems',
    reason: 'Explicit manual confirmation by the authorized reviewer.',
  },
  '5a99e2f5c444ed6dda97fb4184b679091612e1b2375318714870af52f5df6e4b': {
    topic: 'Place Value',
    reason: 'Explicit manual confirmation by the authorized reviewer.',
  },
});

const canonicalDifficultyAndLocation = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  const canonical_difficulty = normalized === 'easy'
    ? 'Easy'
    : (['normal', 'medium', 'average'].includes(normalized)
      ? 'Medium'
      : (['difficult', 'hard'].includes(normalized) ? 'Hard' : null));
  return {
    canonical_difficulty,
    game_location: canonical_difficulty ? GAME_LOCATION_BY_DIFFICULTY[canonical_difficulty] : null,
  };
};

const normalizeFingerprintValue = (value) => String(value ?? '')
  .normalize('NFC')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase('en-US');

const extractQuestionValues = (question = {}) => ({
  question: String(question.question || question.question_text || question.text || '').trim() || null,
  choices: (Array.isArray(question.choices) ? question.choices : question.options || [])
    .map((choice) => String(choice ?? '').trim())
    .filter(Boolean),
  correct_answer: String(question.answer || question.correct_answer || question.correct || '').trim() || null,
});

const stableQuestionFingerprint = (question) => {
  const values = extractQuestionValues(question);
  const signature = {
    question: normalizeFingerprintValue(values.question),
    choices: values.choices.map(normalizeFingerprintValue),
    correct_answer: normalizeFingerprintValue(values.correct_answer),
  };
  return crypto.createHash('sha256').update(JSON.stringify(signature)).digest('hex');
};

const normalizeSnapshot = (productionSnapshot = {}) => {
  const rows = Array.isArray(productionSnapshot.question_fingerprints)
    ? productionSnapshot.question_fingerprints
    : (Array.isArray(productionSnapshot.questions) ? productionSnapshot.questions : []);
  return new Map(rows
    .filter((row) => row && typeof row === 'object' && row.question_fingerprint)
    .map((row) => [row.question_fingerprint, {
      learning_file_id: row.learning_file_id ?? null,
      grade: row.grade ?? row.grade_level ?? null,
      canonical_difficulty: row.canonical_difficulty ?? row.difficulty ?? null,
      topic: row.topic ?? row.math_topic ?? null,
    }]));
};

const topicConfirmationFor = ({
  question,
  record,
  canonicalDifficulty,
  deterministicAssignment = null,
  manualConfirmation = null,
}) => {
  const allowedTopics = Array.isArray(record.topic_options) ? record.topic_options : [];
  const sourceTopic = String(question.topic || question.math_topic || '').trim();
  const headerTopic = String(record.source_topic_header || '').trim();
  const candidate = sourceTopic || headerTopic || null;

  if (manualConfirmation?.topic && allowedTopics.includes(manualConfirmation.topic)) {
    return {
      proposed_topic: manualConfirmation.topic,
      confirmed_topic: manualConfirmation.topic,
      reason: manualConfirmation.reason || 'Explicit manual confirmation by the authorized reviewer.',
    };
  }

  if (deterministicAssignment?.topic && allowedTopics.includes(deterministicAssignment.topic)) {
    return {
      proposed_topic: deterministicAssignment.topic,
      confirmed_topic: deterministicAssignment.topic,
      reason: deterministicAssignment.reason || 'Fingerprint-keyed deterministic review assignment.',
    };
  }

  if (candidate && allowedTopics.includes(candidate)) {
    return {
      proposed_topic: candidate,
      confirmed_topic: candidate,
      reason: sourceTopic
        ? 'Explicit controlled topic metadata is present on this question.'
        : 'An explicit controlled topic header applies to this source.',
    };
  }

  if (allowedTopics.length === 1 && record.grade && canonicalDifficulty) {
    return {
      proposed_topic: allowedTopics[0],
      confirmed_topic: allowedTopics[0],
      reason: 'Exactly one controlled topic exists for this Grade and canonical Difficulty.',
    };
  }

  return {
    proposed_topic: candidate && allowedTopics.includes(candidate) ? candidate : null,
    confirmed_topic: null,
    reason: candidate
      ? `Source topic "${candidate}" is not one controlled topic for this Grade and Difficulty.`
      : 'No explicit or uniquely determined controlled topic is available for this question.',
  };
};

const sourceRowsForRecord = (record) => {
  if (Array.isArray(record.source_questions)) return record.source_questions;
  if (Array.isArray(record.questions)) return record.questions;
  return [];
};

const buildQuestionRows = (audit) => (audit?.records || [])
  .slice()
  .sort((left, right) => String(left.path || '').localeCompare(String(right.path || '')))
  .flatMap((record) => sourceRowsForRecord(record).map((question, index) => ({
    record,
    question,
    source_index: Number(question?.source_index) || index + 1,
  })));

const buildPerQuestionReviewManifest = ({
  audit,
  productionSnapshot = {},
  generatedAt = null,
  deterministicTopicAssignments = DETERMINISTIC_TOPIC_ASSIGNMENTS,
  manualTopicConfirmations = MANUAL_TOPIC_CONFIRMATIONS,
} = {}) => {
  const representedByFingerprint = normalizeSnapshot(productionSnapshot);
  const canonicalBundleRows = new Map();
  const questions = buildQuestionRows(audit).map(({ record, question, source_index }) => {
    const { canonical_difficulty, game_location } = canonicalDifficultyAndLocation(
      record.legacy_difficulty || record.difficulty
    );
    const values = question?.invalid
      ? {
        question: question.raw_question_text || question.question || null,
        choices: Array.isArray(question.raw_choices) ? question.raw_choices : [],
        correct_answer: question.raw_correct_answer || question.answer || null,
      }
      : extractQuestionValues(question);
    const stable_fingerprint = stableQuestionFingerprint(values);
    const base = {
      source_file: record.path,
      source_index,
      stable_fingerprint,
      grade: record.grade || null,
      original_difficulty: record.legacy_difficulty || record.difficulty || null,
      canonical_difficulty,
      game_location,
      question_text: values.question,
      choices: values.choices,
      correct_answer: values.correct_answer,
      proposed_topic: null,
      confirmed_topic: null,
      controlled_topic_options: Array.isArray(record.topic_options) ? record.topic_options : [],
      status: null,
      represented: null,
      duplicate_of: null,
      reason: null,
    };

    if (question?.invalid) {
      return {
        ...base,
        status: 'MALFORMED',
        reason: question.reason || 'Question could not be normalized.',
      };
    }

    const canonical = canonicalBundleRows.get(stable_fingerprint);
    if (canonical) {
      return {
        ...base,
        status: 'DUPLICATE',
        duplicate_of: canonical,
        reason: 'An earlier bundled question has the same stable content fingerprint.',
      };
    }
    canonicalBundleRows.set(stable_fingerprint, {
      source_file: base.source_file,
      source_index: base.source_index,
      stable_fingerprint,
    });

    const represented = representedByFingerprint.get(stable_fingerprint);
    if (represented) {
      return {
        ...base,
        status: 'ALREADY REPRESENTED',
        represented,
        reason: 'A question with this stable content fingerprint is already represented in the read-only production snapshot.',
      };
    }

    const topic = topicConfirmationFor({
      question,
      record,
      canonicalDifficulty: canonical_difficulty,
      deterministicAssignment: deterministicTopicAssignments?.[stable_fingerprint] || null,
      manualConfirmation: manualTopicConfirmations?.[stable_fingerprint] || null,
    });
    if (topic.confirmed_topic) {
      return {
        ...base,
        ...topic,
        status: 'CONFIRMED',
      };
    }
    return {
      ...base,
      ...topic,
      status: 'NEEDS MANUAL CONFIRMATION',
    };
  });

  const source_issues = (audit?.records || [])
    .filter((record) => sourceRowsForRecord(record).length === 0)
    .map((record) => ({
      source_file: record.path,
      grade: record.grade || null,
      original_difficulty: record.legacy_difficulty || record.difficulty || null,
      canonical_difficulty: canonicalDifficultyAndLocation(record.legacy_difficulty || record.difficulty).canonical_difficulty,
      status: 'MALFORMED',
      reason: record.parse_error || 'No question records were found in this source.',
    }));

  return {
    schema_version: 1,
    mode: 'local-review-only',
    production_import_performed: false,
    generated_at: generatedAt,
    source_bundle: 'capstone-theresians-quest/Questions',
    production_snapshot: {
      source: productionSnapshot.source || 'read-only PostgreSQL fingerprint snapshot',
      captured_at: productionSnapshot.captured_at || null,
      scope: productionSnapshot.scope || null,
      question_fingerprint_count: representedByFingerprint.size,
    },
    game_location_mapping: GAME_LOCATION_BY_DIFFICULTY,
    questions,
    source_issues,
  };
};

const buildProspectiveImportGroups = (manifest) => {
  const groups = new Map();
  (manifest?.questions || [])
    .filter((question) => question.status === 'CONFIRMED' && question.confirmed_topic)
    .forEach((question) => {
      if (!question.grade || !question.canonical_difficulty || !question.game_location) {
        throw new Error(`Confirmed question ${question.stable_fingerprint} is missing Grade, Difficulty, or game Location.`);
      }
      if (!Array.isArray(question.controlled_topic_options)
        || !question.controlled_topic_options.includes(question.confirmed_topic)) {
        throw new Error(`Confirmed topic for ${question.stable_fingerprint} is outside the controlled Grade/Difficulty vocabulary.`);
      }
      const key = [question.grade, question.canonical_difficulty, question.confirmed_topic].join('::');
      const group = groups.get(key) || {
        grade: question.grade,
        canonical_difficulty: question.canonical_difficulty,
        topic: question.confirmed_topic,
        game_location: question.game_location,
        question_count: 0,
        question_fingerprints: [],
      };
      group.question_count += 1;
      group.question_fingerprints.push(question.stable_fingerprint);
      groups.set(key, group);
    });
  return [...groups.values()]
    .map((group) => ({ ...group, question_fingerprints: group.question_fingerprints.sort() }))
    .sort((left, right) => [left.grade, left.canonical_difficulty, left.topic].join('::')
      .localeCompare([right.grade, right.canonical_difficulty, right.topic].join('::')));
};

const buildFinalReviewedImportManifest = (manifest) => {
  const questions = (manifest?.questions || [])
    .filter((question) => question.status === 'CONFIRMED'
      && question.confirmed_topic
      && Array.isArray(question.controlled_topic_options)
      && question.controlled_topic_options.includes(question.confirmed_topic))
    .map((question) => ({
      source_file: question.source_file,
      source_index: question.source_index,
      stable_fingerprint: question.stable_fingerprint,
      grade: question.grade,
      canonical_difficulty: question.canonical_difficulty,
      game_location: question.game_location,
      confirmed_topic: question.confirmed_topic,
      question_text: question.question_text,
      choices: question.choices,
      correct_answer: question.correct_answer,
    }));
  const distribution = (key) => questions.reduce((result, question) => {
    const value = question[key];
    if (value) result[value] = (result[value] || 0) + 1;
    return result;
  }, {});
  const question_set_groups = buildProspectiveImportGroups(manifest);
  return {
    schema_version: 1,
    mode: 'reviewed-import-manifest',
    production_import_performed: false,
    topic_inference_performed_during_apply: false,
    source_review_manifest_schema_version: manifest?.schema_version || null,
    source_bundle: manifest?.source_bundle || null,
    production_snapshot: manifest?.production_snapshot || null,
    question_count: questions.length,
    question_set_count: question_set_groups.length,
    grade_distribution: distribution('grade'),
    difficulty_distribution: distribution('canonical_difficulty'),
    location_distribution: distribution('game_location'),
    topic_distribution: distribution('confirmed_topic'),
    questions,
    question_set_groups,
  };
};

const REVIEW_STATUSES = Object.freeze([
  'CONFIRMED',
  'NEEDS MANUAL CONFIRMATION',
  'ALREADY REPRESENTED',
  'DUPLICATE',
  'MALFORMED',
]);

const emptyCoverageCell = () => ({
  confirmed: 0,
  needs_manual_confirmation: 0,
  already_represented: 0,
  duplicate: 0,
  malformed: 0,
});

const coverageKeyForStatus = (status) => ({
  CONFIRMED: 'confirmed',
  'NEEDS MANUAL CONFIRMATION': 'needs_manual_confirmation',
  'ALREADY REPRESENTED': 'already_represented',
  DUPLICATE: 'duplicate',
  MALFORMED: 'malformed',
}[status] || null);

const buildCoverageMatrix = (manifest) => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    grade: `Grade ${index + 1}`,
    Easy: emptyCoverageCell(),
    Medium: emptyCoverageCell(),
    Hard: emptyCoverageCell(),
  }));
  const rowsByGrade = new Map(rows.map((row) => [row.grade, row]));
  (manifest?.questions || []).forEach((question) => {
    const statusKey = coverageKeyForStatus(question.status);
    const row = rowsByGrade.get(question.grade);
    if (statusKey && row?.[question.canonical_difficulty]) {
      row[question.canonical_difficulty][statusKey] += 1;
    }
  });
  return rows;
};

const markdownCell = (cell) => `C ${cell.confirmed} / M ${cell.needs_manual_confirmation} / R ${cell.already_represented} / D ${cell.duplicate} / X ${cell.malformed}`;

const escapeMarkdown = (value) => String(value ?? '')
  .replace(/\|/g, '\\|')
  .replace(/\r?\n/g, ' ');

const statusCounts = (manifest) => (manifest?.questions || []).reduce((counts, question) => {
  counts[question.status] = (counts[question.status] || 0) + 1;
  return counts;
}, {});

const buildReviewReport = (manifest) => {
  const counts = statusCounts(manifest);
  const matrix = buildCoverageMatrix(manifest);
  const manualQuestions = (manifest?.questions || []).filter((question) => question.status === 'NEEDS MANUAL CONFIRMATION');
  const groups = buildProspectiveImportGroups(manifest);
  const lines = [
    '# Per-Question Client Bundle Review',
    '',
    '> Local review artifact only. It does not connect to Railway, write PostgreSQL, publish, or import questions.',
    '',
    '## Snapshot and normalization',
    '',
    `- Bundle: \`${manifest.source_bundle}\``,
    `- Production fingerprint snapshot: ${escapeMarkdown(manifest.production_snapshot?.source || 'not supplied')} (${manifest.production_snapshot?.question_fingerprint_count || 0} fingerprints)`,
    `- Captured at: ${manifest.production_snapshot?.captured_at || 'not recorded'}`,
    manifest.production_snapshot?.scope ? `- Snapshot scope: ${escapeMarkdown(manifest.production_snapshot.scope)}` : null,
    '- Difficulty/location: Easy → Oakleaf Village; Normal/Medium → City of Knowledge; Difficult/Hard → Pinehill Village.',
    '- A future importer may consume only entries with `status: CONFIRMED` and a controlled `confirmed_topic`; it must not infer a topic during apply.',
    '',
    '## Status totals',
    '',
    '| Confirmed | Needs Manual Confirmation | Already Represented | Duplicate | Malformed |',
    '| ---: | ---: | ---: | ---: | ---: |',
    `| ${counts.CONFIRMED || 0} | ${counts['NEEDS MANUAL CONFIRMATION'] || 0} | ${counts['ALREADY REPRESENTED'] || 0} | ${counts.DUPLICATE || 0} | ${counts.MALFORMED || 0} |`,
    '',
    '## Grade × Difficulty coverage matrix',
    '',
    'Cell legend: C = Confirmed, M = Needs Manual Confirmation, R = Already Represented, D = Duplicate, X = Malformed.',
    '',
    '| Grade | Easy — Oakleaf Village | Medium — City of Knowledge | Hard — Pinehill Village |',
    '| --- | --- | --- | --- |',
    ...matrix.map((row) => `| ${row.grade} | ${markdownCell(row.Easy)} | ${markdownCell(row.Medium)} | ${markdownCell(row.Hard)} |`),
    '',
    '## Questions requiring manual topic decision',
    '',
  ];

  if (manualQuestions.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Source | # | Grade | Difficulty | Location | Question | Controlled topic options | Reason |');
    lines.push('| --- | ---: | --- | --- | --- | --- | --- | --- |');
    lines.push(...manualQuestions.map((question) => (
      `| ${escapeMarkdown(question.source_file)} | ${question.source_index} | ${escapeMarkdown(question.grade)} | ${escapeMarkdown(question.canonical_difficulty)} | ${escapeMarkdown(question.game_location)} | ${escapeMarkdown(question.question_text)} | ${escapeMarkdown((question.controlled_topic_options || []).join('; '))} | ${escapeMarkdown(question.reason)} |`
    )));
  }

  lines.push('', '## Prospective groups from confirmed questions only', '');
  if (groups.length === 0) {
    lines.push('No prospective groups are eligible. No topic was inferred for import preparation.');
  } else {
    lines.push('| Grade | Difficulty | Location | Confirmed topic | Questions |');
    lines.push('| --- | --- | --- | --- | ---: |');
    lines.push(...groups.map((group) => `| ${group.grade} | ${group.canonical_difficulty} | ${group.game_location} | ${escapeMarkdown(group.topic)} | ${group.question_count} |`));
  }

  lines.push('', '## Full per-question review', '');
  REVIEW_STATUSES.forEach((status) => {
    const entries = (manifest?.questions || []).filter((question) => question.status === status);
    lines.push(`### ${status}`, '');
    if (entries.length === 0) {
      lines.push('None.', '');
      return;
    }
    entries.forEach((question) => {
      lines.push(...[
        `#### ${question.source_file} — question ${question.source_index}`,
        '',
        `- Stable fingerprint: \`${question.stable_fingerprint}\``,
        `- Grade / difficulty / location: ${question.grade || 'Unknown'} | ${question.canonical_difficulty || 'Unknown'} | ${question.game_location || 'Unknown'}`,
        `- Original difficulty: ${question.original_difficulty || 'Unknown'}`,
        `- Proposed topic: ${question.proposed_topic || 'None'}`,
        `- Confirmed topic: ${question.confirmed_topic || 'None'}`,
        `- Question: ${question.question_text || 'Unavailable because the source record is malformed.'}`,
        `- Choices: ${(question.choices || []).join(' | ') || 'Unavailable'}`,
        `- Correct answer: ${question.correct_answer || 'Unavailable'}`,
        `- Reason: ${question.reason || 'None'}`,
        question.represented ? `- Production representation: learning_file_id ${question.represented.learning_file_id ?? 'unknown'}` : null,
        question.duplicate_of ? `- Duplicate of: ${question.duplicate_of.source_file} question ${question.duplicate_of.source_index}` : null,
        ''
      ].filter((line) => line !== null));
    });
  });

  if ((manifest?.source_issues || []).length > 0) {
    lines.push('## Source files without parseable question records', '');
    lines.push('| Source | Grade | Difficulty | Reason |', '| --- | --- | --- | --- |');
    lines.push(...manifest.source_issues.map((issue) => `| ${escapeMarkdown(issue.source_file)} | ${escapeMarkdown(issue.grade)} | ${escapeMarkdown(issue.canonical_difficulty)} | ${escapeMarkdown(issue.reason)} |`));
    lines.push('');
  }

  return `${lines.filter((line) => line !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
};

module.exports = {
  GAME_LOCATION_BY_DIFFICULTY,
  DETERMINISTIC_TOPIC_ASSIGNMENTS,
  MANUAL_TOPIC_CONFIRMATIONS,
  REVIEW_STATUSES,
  buildCoverageMatrix,
  buildFinalReviewedImportManifest,
  buildPerQuestionReviewManifest,
  buildProspectiveImportGroups,
  buildReviewReport,
  canonicalDifficultyAndLocation,
  stableQuestionFingerprint,
};
