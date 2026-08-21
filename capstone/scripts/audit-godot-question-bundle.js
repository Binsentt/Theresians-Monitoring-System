#!/usr/bin/env node

// Read-only developer audit. This script never connects to PostgreSQL, writes
// files, or imports question content. It inventories a local Godot bundle so a
// future, explicitly approved import can be reviewed before it is performed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { getMathTopicsForGradeDifficulty } = require('../backend/learningContentRules.utils');

const SUPPORTED_EXTENSIONS = new Set(['.docx', '.json']);

const canonicalDifficulty = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'easy') return 'Easy';
  if (['normal', 'medium', 'average'].includes(normalized)) return 'Medium';
  if (['difficult', 'hard'].includes(normalized)) return 'Hard';
  return null;
};

const decodeXmlEntities = (value) => String(value || '')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");

const readDocxText = (filePath) => {
  const documentXml = execFileSync('tar', ['-xOf', filePath, 'word/document.xml'], {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });
  const paragraphs = documentXml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
  return paragraphs
    .map((paragraph) => Array.from(paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g))
      .map((match) => decodeXmlEntities(match[1]))
      .join(''))
    .map((line) => line.trim())
    .filter(Boolean);
};

const normalizeQuestionWithValidation = (candidate = {}) => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {
      question: null,
      reason: 'Question record must be an object.',
      raw_question_text: null,
      raw_choices: [],
      raw_correct_answer: null,
    };
  }
  const question = String(candidate.question || candidate.question_text || candidate.text || '').trim();
  const choices = Array.isArray(candidate.choices)
    ? candidate.choices
    : (Array.isArray(candidate.options) ? candidate.options : []);
  const rawAnswer = String(candidate.correct_answer || candidate.correct || candidate.answer || '').trim();
  const normalizedChoices = choices.map((choice) => String(choice || '').trim()).filter(Boolean);
  const optionIndex = rawAnswer.match(/^([A-D])(?:[.)]|$)/i)?.[1]?.toUpperCase();
  const answer = optionIndex
    ? normalizedChoices[optionIndex.charCodeAt(0) - 'A'.charCodeAt(0)]
    : rawAnswer.replace(/^[A-D][.)]\s*/i, '').trim();
  const malformed = (reason) => ({
    question: null,
    reason,
    raw_question_text: question || null,
    raw_choices: normalizedChoices,
    raw_correct_answer: rawAnswer || null,
  });
  if (!question) return malformed('Missing question text.');
  if (!Array.isArray(candidate.choices) && !Array.isArray(candidate.options)) {
    return malformed('Choices must be an array.');
  }
  if (normalizedChoices.length < 2) return malformed('At least two choices are required.');
  if (!rawAnswer || !answer) return malformed('Missing correct answer.');
  if (!normalizedChoices.some((choice) => choice.localeCompare(answer, undefined, { sensitivity: 'accent' }) === 0)) {
    return malformed('Correct answer is not present in the choices.');
  }
  return { question: {
    question,
    choices: normalizedChoices,
    answer,
    topic: String(candidate.topic || candidate.math_topic || '').trim() || null,
  } };
};

const normalizeQuestion = (candidate = {}) => normalizeQuestionWithValidation(candidate).question;

// Client DOCX files use both one-option-per-line and compact `?a. ...b. ...`
// layouts.  The first A marker must have a natural question boundary; after it
// is found, the ordered B-D markers may be adjacent to a preceding choice.
const findOptionMarkers = (line, canContinueChoices = false) => {
  const firstOptionMatch = /(^|[\s?!.:])([Aa])[.)]\s*/g.exec(line);
  if (firstOptionMatch) {
    const firstMarkerIndex = firstOptionMatch.index + firstOptionMatch[1].length;
    const markers = [{
      markerIndex: firstMarkerIndex,
      contentStart: firstOptionMatch.index + firstOptionMatch[0].length,
    }];
    const subsequentOptions = /([B-Db-d])[.)]\s*/g;
    subsequentOptions.lastIndex = markers[0].contentStart;
    let nextMatch;
    while ((nextMatch = subsequentOptions.exec(line))) {
      markers.push({
        markerIndex: nextMatch.index,
        contentStart: nextMatch.index + nextMatch[0].length,
      });
    }
    return markers;
  }

  if (canContinueChoices) {
    const continuation = line.match(/^([B-Db-d])[.)]\s*/);
    if (continuation) return [{ markerIndex: 0, contentStart: continuation[0].length }];
  }
  return [];
};

const parseDocxQuestionLines = (lines) => {
  const parsed = [];
  let current = null;
  const finishCurrent = () => {
    if (!current) return;
    const result = normalizeQuestionWithValidation(current);
    parsed.push(result.question || {
      invalid: true,
      reason: result.reason,
      raw_question_text: result.raw_question_text,
      raw_choices: result.raw_choices,
      raw_correct_answer: result.raw_correct_answer,
    });
    current = null;
  };

  const isHeader = (line) => (
    /^(grade\s*\d+|easy\s*(round)?|normal|difficult|hard|medium|lesson\s*:|topic\s*:)/i.test(line)
    || /\b(easy|normal|difficult|hard|medium)\b.*\b(lesson|topic)\s*:/i.test(line)
  );
  const startQuestion = (question) => {
    const cleanQuestion = String(question || '').replace(/^\d+[.)]\s*/, '').trim();
    if (!cleanQuestion) return;
    if (current?.correct_answer) finishCurrent();
    if (!current) current = { question: cleanQuestion, choices: [], correct_answer: '' };
    else if (current.choices.length === 0) current.question = `${current.question} ${cleanQuestion}`.trim();
  };

  for (const originalLine of lines) {
    let line = originalLine.trim();
    const answerMatch = line.match(/(?:correct\s+)?answer\s*:\s*([A-D])(?:[.)]\s*)?(.+)?$/i);
    if (answerMatch) {
      if (!current) current = { question: '', choices: [], correct_answer: '' };
      current.correct_answer = answerMatch[1].toUpperCase();
      line = line.slice(0, answerMatch.index).trim();
    }

    const optionMarkers = findOptionMarkers(line, Boolean(current?.choices?.length));
    if (optionMarkers.length > 0) {
      const questionPrefix = line.slice(0, optionMarkers[0].markerIndex).trim();
      if (questionPrefix) startQuestion(questionPrefix);
      if (!current) current = { question: '', choices: [], correct_answer: '' };
      optionMarkers.forEach((marker, index) => {
        const optionEnd = index + 1 < optionMarkers.length ? optionMarkers[index + 1].markerIndex : line.length;
        const option = line.slice(marker.contentStart, optionEnd).trim();
        if (option) current.choices.push(option);
      });
      continue;
    }

    if (!line || isHeader(line)) continue;
    if (!current || current.correct_answer) startQuestion(line);
    else if (current.choices.length === 0) current.question = `${current.question} ${line}`.trim();
  }
  finishCurrent();
  return parsed;
};

const parseDocxQuestions = (filePath) => parseDocxQuestionLines(readDocxText(filePath));

const extractDocxTopicHeader = (lines) => {
  const headerLine = (lines || []).find((line) => /(?:lesson|topic)\s*:/i.test(String(line || '')));
  const match = String(headerLine || '').match(/(?:lesson|topic)\s*:\s*(.+)$/i);
  return match ? String(match[1]).trim() : null;
};

const parseJsonQuestions = (filePath) => {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const entries = Array.isArray(payload) ? payload : payload.questions;
  if (!Array.isArray(entries)) throw new Error('JSON must be an array or contain a questions array.');
  return entries.map((entry) => {
    const result = normalizeQuestionWithValidation(entry);
    return result.question || {
      invalid: true,
      reason: result.reason,
      raw_question_text: result.raw_question_text,
      raw_choices: result.raw_choices,
      raw_correct_answer: result.raw_correct_answer,
    };
  });
};

const discoverFiles = (rootPath) => {
  const discovered = [];
  const walk = (currentPath) => {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) discovered.push(fullPath);
    }
  };
  walk(rootPath);
  return discovered.sort((left, right) => left.localeCompare(right));
};

const inferMetadata = (rootPath, filePath) => {
  const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
  const normalized = relativePath.toLowerCase();
  const gradeMatch = normalized.match(/(?:^|[\\/_ -])grade[ _-]?([1-6])(?=$|[\\/_ .-])/);
  const difficultySegment = relativePath.split('/').find((segment) => canonicalDifficulty(segment));
  const baseDifficulty = path.basename(normalized, path.extname(normalized)).match(/(?:^|[_ -])(easy|normal|medium|difficult|hard)(?:$|[_ -])/i);
  const rawDifficulty = difficultySegment || baseDifficulty?.[1] || null;
  const difficulty = canonicalDifficulty(rawDifficulty);
  return {
    relativePath,
    grade: gradeMatch ? `Grade ${gradeMatch[1]}` : null,
    difficulty,
    legacyDifficulty: rawDifficulty && ['normal', 'difficult'].includes(String(rawDifficulty).toLowerCase())
      ? String(rawDifficulty)
      : null,
  };
};

const questionSignature = (question) => [
  question.question.toLowerCase().replace(/\s+/g, ' ').trim(),
  question.choices.map((choice) => choice.toLowerCase().replace(/\s+/g, ' ').trim()).join('|'),
  question.answer.toLowerCase().replace(/\s+/g, ' ').trim(),
].join('::');

const increment = (target, key) => {
  if (!key) return;
  target[key] = (target[key] || 0) + 1;
};

const fingerprint = (value) => crypto.createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');

const mimeTypeForExtension = (extension) => {
  if (extension === '.json') return 'application/json';
  if (extension === '.docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return 'application/octet-stream';
};

const resolveTopic = (questions) => {
  const topics = [...new Set(questions.map((question) => question.topic).filter(Boolean))];
  if (topics.length === 1 && questions.every((question) => question.topic === topics[0])) return topics[0];
  return null;
};

const assessTopic = (metadata, validQuestions, sourceMetadata = {}) => {
  const explicitTopic = resolveTopic(validQuestions);
  const explicitTopics = [...new Set(validQuestions.map((question) => question.topic).filter(Boolean))];
  const topicOptions = metadata.grade && metadata.difficulty
    ? getMathTopicsForGradeDifficulty(metadata.grade, metadata.difficulty)
    : [];
  const headerTopic = String(sourceMetadata.source_topic_header || '').trim();
  if (headerTopic) {
    if (topicOptions.includes(headerTopic)) {
      return {
        topic: headerTopic,
        detectedTopic: headerTopic,
        topicOptions,
        source: 'Explicit client header metadata',
        classification: 'AUTHORITATIVE',
        reason: null,
      };
    }
    return {
      topic: null,
      detectedTopic: headerTopic,
      topicOptions,
      source: 'Explicit client header metadata',
      classification: /,|\band\b/i.test(headerTopic) ? 'AMBIGUOUS' : 'MISSING — NEEDS USER REVIEW',
      reason: `Explicit header topic "${headerTopic}" is not one controlled topic for the inferred grade and difficulty.`,
    };
  }
  if (explicitTopics.length > 1) {
    return {
      topic: null,
      detectedTopic: null,
      topicOptions,
      source: 'Conflicting explicit client metadata',
      classification: 'AMBIGUOUS',
      reason: 'The source contains more than one explicit topic identifier.',
    };
  }
  if (explicitTopic) {
    if (topicOptions.includes(explicitTopic)) {
      return {
        topic: explicitTopic,
        detectedTopic: explicitTopic,
        topicOptions,
        source: 'Explicit client metadata',
        classification: 'AUTHORITATIVE',
        reason: null,
      };
    }
    return {
      topic: null,
      detectedTopic: explicitTopic,
      topicOptions,
      source: 'Explicit client metadata (not in controlled vocabulary)',
      classification: 'MISSING — NEEDS USER REVIEW',
      reason: `Explicit topic "${explicitTopic}" is not valid for the inferred grade and difficulty.`,
    };
  }
  if (topicOptions.length === 1) {
    return {
      topic: topicOptions[0],
      detectedTopic: null,
      topicOptions,
      source: 'Existing grade/topic mapping',
      classification: 'DERIVABLE WITH HIGH CONFIDENCE',
      reason: 'One controlled topic exists for this grade and difficulty; an authorized reviewer must still confirm it.',
    };
  }
  if (topicOptions.length > 1) {
    return {
      topic: null,
      detectedTopic: null,
      topicOptions,
      source: 'Existing grade/topic mapping',
      classification: 'AMBIGUOUS',
      reason: 'Multiple controlled topics exist for this grade and difficulty.',
    };
  }
  return {
    topic: null,
    detectedTopic: null,
    topicOptions,
    source: 'No authoritative topic evidence found',
    classification: 'MISSING — NEEDS USER REVIEW',
    reason: 'No controlled topic mapping exists for the inferred grade and difficulty.',
  };
};

const resolveImportEligibility = ({ extension, parseError, validQuestions, invalidQuestions, duplicateCount, metadata, topicAssessment }) => {
  if (!SUPPORTED_EXTENSIONS.has(extension)) return { value: 'UNSUPPORTED', classification: 'UNSUPPORTED FORMAT', reason: 'Unsupported source format.' };
  if (parseError || validQuestions.length === 0 || invalidQuestions > 0) {
    return { value: 'NEEDS MANUAL QUESTION REPAIR', classification: 'MALFORMED', reason: parseError || 'One or more question records failed validation.' };
  }
  if (duplicateCount >= validQuestions.length) return { value: 'DUPLICATE ONLY', classification: 'DUPLICATE', reason: 'Every valid question is already represented by an earlier canonical source.' };
  if (duplicateCount > 0) return { value: 'NEEDS MANUAL QUESTION REPAIR', classification: 'DUPLICATE', reason: 'The source mixes duplicate and unique questions and requires manual review.' };
  if (!metadata.grade || !metadata.difficulty) return { value: 'UNCLASSIFIED', classification: 'UNCLASSIFIED', reason: 'Grade and/or difficulty could not be inferred from explicit client structure.' };
  if (topicAssessment.classification === 'AUTHORITATIVE') return { value: 'READY FOR IMPORT', classification: 'READY TO IMPORT', reason: null };
  return { value: 'READY AFTER USER CONFIRMATION', classification: 'NEEDS MANUAL REVIEW', reason: topicAssessment.reason };
};

const recordFingerprint = (record) => fingerprint({
  grade: record.grade,
  difficulty: record.difficulty,
  topic: record.topic_identifier,
  questions: (record.questions || []).map((question) => questionSignature(question)).sort(),
});

const attachPrivateSource = (record, sourceRecord) => {
  Object.defineProperty(record, 'questions', { value: sourceRecord.questions, enumerable: false });
  Object.defineProperty(record, 'source_file_bytes', { value: sourceRecord.source_file_bytes, enumerable: false });
  Object.defineProperty(record, 'source_file_mime_type', { value: sourceRecord.source_file_mime_type, enumerable: false });
  return record;
};

const summarizeAudit = (records, files) => {
  const gradeDistribution = {};
  const difficultyDistribution = {};
  const topicDistribution = {};
  const classificationDistribution = {};
  let validQuestionCount = 0;
  let duplicateQuestionCount = 0;
  let malformedQuestionCount = 0;
  let malformedFileCount = 0;
  let metadataIncompleteFileCount = 0;
  records.forEach((record) => {
    increment(gradeDistribution, record.grade || 'Unclassified');
    increment(difficultyDistribution, record.difficulty || 'Unclassified');
    Object.entries(record.detected_topic_distribution || { Missing: record.valid_question_count })
      .forEach(([topic, count]) => {
        topicDistribution[topic || 'Missing'] = (topicDistribution[topic || 'Missing'] || 0) + count;
      });
    increment(classificationDistribution, record.classification);
    validQuestionCount += record.valid_question_count;
    duplicateQuestionCount += record.duplicate_question_count;
    malformedQuestionCount += record.malformed_question_count;
    if (record.parse_error || record.malformed_question_count > 0 || record.valid_question_count === 0) malformedFileCount += 1;
    if (!record.metadata_complete) metadataIncompleteFileCount += 1;
  });
  const proposedRecords = records.filter((record) => record.import_eligibility === 'READY FOR IMPORT');
  return {
    mode: 'dry-run-only',
    production_import_performed: false,
    files_discovered: records.length,
    grade_distribution: gradeDistribution,
    difficulty_distribution: difficultyDistribution,
    topic_distribution: topicDistribution,
    classification_distribution: classificationDistribution,
    valid_question_count: validQuestionCount,
    duplicate_question_count: duplicateQuestionCount,
    malformed_question_count: malformedQuestionCount,
    malformed_file_count: malformedFileCount,
    metadata_incomplete_file_count: metadataIncompleteFileCount,
    proposed_import_count: proposedRecords.length,
    proposed_import_question_count: proposedRecords.reduce((count, record) => count + record.valid_question_count, 0),
    files,
    records,
  };
};

const auditGodotQuestionBundle = (rootPath) => {
  const files = discoverFiles(rootPath);
  const canonicalQuestions = new Map();

  const records = files.map((filePath) => {
    const metadata = inferMetadata(rootPath, filePath);
    const extension = path.extname(filePath).toLowerCase();
    let questions = [];
    let parseError = null;
    let sourceTopicHeader = null;
    if (SUPPORTED_EXTENSIONS.has(extension)) {
      try {
        if (extension === '.docx') {
          const lines = readDocxText(filePath);
          sourceTopicHeader = extractDocxTopicHeader(lines);
          questions = parseDocxQuestionLines(lines);
        } else {
          questions = parseJsonQuestions(filePath);
        }
      } catch (error) {
        parseError = error.message;
      }
    }
    const sourceQuestions = questions.map((question, index) => ({ ...question, source_index: index + 1 }));
    const validQuestions = sourceQuestions.filter((question) => !question.invalid);
    const malformedDetails = sourceQuestions
      .map((question, index) => (question.invalid ? {
        question_index: question.source_index || index + 1,
        reason: question.reason || 'Question could not be normalized.',
        raw_question_text: question.raw_question_text || null,
        raw_choices: question.raw_choices || [],
        raw_correct_answer: question.raw_correct_answer || null,
      } : null))
      .filter(Boolean);
    const invalidQuestions = malformedDetails.length;
    let duplicateCount = 0;
    const duplicateDetails = [];
    validQuestions.forEach((question, index) => {
      const signature = questionSignature(question);
      const questionFingerprint = fingerprint({ signature });
      const canonical = canonicalQuestions.get(signature);
      if (canonical) {
        duplicateCount += 1;
        duplicateDetails.push({
          question_index: question.source_index || index + 1,
          question_fingerprint: questionFingerprint,
          canonical_source_path: canonical.path,
          canonical_question_index: canonical.questionIndex,
        });
      } else {
        canonicalQuestions.set(signature, { path: metadata.relativePath, questionIndex: index + 1 });
      }
    });
    const topicAssessment = assessTopic(metadata, validQuestions, { source_topic_header: sourceTopicHeader });
    const eligibility = resolveImportEligibility({
      extension,
      parseError,
      validQuestions,
      invalidQuestions,
      duplicateCount,
      metadata,
      topicAssessment,
    });
    const record = {
      path: metadata.relativePath,
      file_name: path.basename(filePath),
      title: path.basename(filePath, extension),
      grade: metadata.grade,
      difficulty: metadata.difficulty,
      legacy_difficulty: metadata.legacyDifficulty,
      topic_identifier: topicAssessment.topic,
      detected_topic_identifier: topicAssessment.detectedTopic,
      source_topic_header: sourceTopicHeader,
      detected_topic_identifiers: [...new Set(validQuestions.map((question) => question.topic).filter(Boolean))],
      detected_topic_distribution: validQuestions.reduce((distribution, question) => {
        increment(distribution, question.topic || 'Missing');
        return distribution;
      }, {}),
      topic_options: topicAssessment.topicOptions,
      topic_source: topicAssessment.source,
      topic_classification: topicAssessment.classification,
      format: extension.slice(1),
      valid_question_count: validQuestions.length,
      malformed_question_count: invalidQuestions,
      malformed_details: malformedDetails,
      duplicate_question_count: duplicateCount,
      duplicate_details: duplicateDetails,
      parse_error: parseError,
      parse_status: parseError ? 'PARSE ERROR' : (invalidQuestions > 0 ? 'PARTIALLY MALFORMED' : 'VALID'),
      metadata_complete: Boolean(metadata.grade && metadata.difficulty && topicAssessment.classification === 'AUTHORITATIVE'),
      source_size_bytes: fs.statSync(filePath).size,
      import_eligibility: eligibility.value,
      ineligibility_reason: eligibility.reason,
      classification: eligibility.classification,
      proposed_source_label: 'Client Provided',
    };
    Object.defineProperty(record, 'questions', { value: validQuestions, enumerable: false });
    Object.defineProperty(record, 'source_questions', { value: sourceQuestions, enumerable: false });
    Object.defineProperty(record, 'source_file_bytes', { value: fs.readFileSync(filePath), enumerable: false });
    Object.defineProperty(record, 'source_file_mime_type', { value: mimeTypeForExtension(extension), enumerable: false });
    record.content_fingerprint = recordFingerprint(record);
    return record;
  });

  return summarizeAudit(records, files);
};

const applyTopicOverrides = (audit, overrides = {}) => {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Topic overrides must be an object keyed by manifest source path.');
  }
  const recordsByPath = new Map((audit.records || []).map((record) => [record.path, record]));
  Object.keys(overrides).forEach((sourcePath) => {
    if (!recordsByPath.has(sourcePath)) throw new Error(`Topic override does not match a manifest source path: ${sourcePath}`);
  });
  const records = (audit.records || []).map((originalRecord) => {
    const selectedTopic = overrides[originalRecord.path];
    if (selectedTopic === undefined) return originalRecord;
    const record = { ...originalRecord };
    attachPrivateSource(record, originalRecord);
    const normalizedTopic = String(selectedTopic || '').trim();
    if (!record.topic_options.includes(normalizedTopic)) {
      record.review_error = 'Selected topic must be one of the manifest controlled topic options.';
      return record;
    }
    if (record.import_eligibility === 'NEEDS MANUAL QUESTION REPAIR' || record.import_eligibility === 'UNSUPPORTED' || record.import_eligibility === 'UNCLASSIFIED' || record.import_eligibility === 'DUPLICATE ONLY') {
      record.review_error = 'Topic confirmation cannot make an otherwise ineligible source importable.';
      return record;
    }
    record.topic_identifier = normalizedTopic;
    record.topic_source = 'User-confirmed controlled topic';
    record.topic_classification = 'USER CONFIRMED';
    record.metadata_complete = Boolean(record.grade && record.difficulty);
    record.import_eligibility = 'READY FOR IMPORT';
    record.ineligibility_reason = null;
    record.classification = 'READY TO IMPORT';
    record.content_fingerprint = recordFingerprint(record);
    return record;
  });
  return summarizeAudit(records, audit.files || []);
};

if (require.main === module) {
  const rootPath = process.argv[2];
  if (!rootPath || !fs.existsSync(rootPath)) {
    console.error('Usage: node scripts/audit-godot-question-bundle.js <path-to-Godot-Questions>');
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(auditGodotQuestionBundle(path.resolve(rootPath)), null, 2));
  }
}

module.exports = {
  applyTopicOverrides,
  assessTopic,
  auditGodotQuestionBundle,
  canonicalDifficulty,
  inferMetadata,
  normalizeQuestion,
  normalizeQuestionWithValidation,
  parseDocxQuestions,
  parseDocxQuestionLines,
  extractDocxTopicHeader,
  parseJsonQuestions,
  readDocxText,
};
