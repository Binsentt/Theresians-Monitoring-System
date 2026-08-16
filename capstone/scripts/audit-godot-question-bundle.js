#!/usr/bin/env node

// Read-only developer audit. This script never connects to PostgreSQL, writes
// files, or imports question content. It inventories a local Godot bundle so a
// future, explicitly approved import can be reviewed before it is performed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

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

const normalizeQuestion = (candidate = {}) => {
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
  if (!question || normalizedChoices.length < 2 || !answer) return null;
  return {
    question,
    choices: normalizedChoices,
    answer,
    topic: String(candidate.topic || candidate.math_topic || '').trim() || null,
  };
};

const parseDocxQuestions = (filePath) => {
  const lines = readDocxText(filePath);
  const parsed = [];
  let current = null;
  const finishCurrent = () => {
    if (!current) return;
    const normalized = normalizeQuestion(current);
    parsed.push(normalized || { invalid: true });
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

    const optionMatches = Array.from(line.matchAll(/([A-Da-d])[.)]\s*/g));
    if (optionMatches.length > 0) {
      const questionPrefix = line.slice(0, optionMatches[0].index).trim();
      if (questionPrefix) startQuestion(questionPrefix);
      if (!current) current = { question: '', choices: [], correct_answer: '' };
      optionMatches.forEach((match, index) => {
        const optionStart = match.index + match[0].length;
        const optionEnd = index + 1 < optionMatches.length ? optionMatches[index + 1].index : line.length;
        const option = line.slice(optionStart, optionEnd).trim();
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

const parseJsonQuestions = (filePath) => {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const entries = Array.isArray(payload) ? payload : payload.questions;
  if (!Array.isArray(entries)) throw new Error('JSON must be an array or contain a questions array.');
  return entries.map((entry) => normalizeQuestion(entry) || { invalid: true });
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
  const gradeMatch = normalized.match(/grade[ _]?([1-6])\b/);
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

const classifyRecord = ({ extension, parseError, validQuestions, invalidQuestions, duplicateCount, metadata, topic }) => {
  if (!SUPPORTED_EXTENSIONS.has(extension)) return 'UNSUPPORTED FORMAT';
  if (parseError || validQuestions.length === 0 || invalidQuestions > 0) return 'MALFORMED';
  if (duplicateCount > 0) return 'DUPLICATE';
  if (!metadata.grade) return 'MISSING GRADE';
  if (!metadata.difficulty) return 'MISSING DIFFICULTY';
  if (!topic) {
    const uniqueTopics = new Set(validQuestions.map((question) => question.topic).filter(Boolean));
    return uniqueTopics.size > 1 ? 'NEEDS MANUAL REVIEW' : 'MISSING TOPIC';
  }
  return 'READY TO IMPORT';
};

const auditGodotQuestionBundle = (rootPath) => {
  const files = discoverFiles(rootPath);
  const gradeDistribution = {};
  const difficultyDistribution = {};
  const topicDistribution = {};
  const classificationDistribution = {};
  const signatures = new Set();
  let validQuestionCount = 0;
  let duplicateQuestionCount = 0;
  let malformedQuestionCount = 0;
  let malformedFileCount = 0;
  let metadataIncompleteFileCount = 0;

  const records = files.map((filePath) => {
    const metadata = inferMetadata(rootPath, filePath);
    const extension = path.extname(filePath).toLowerCase();
    let questions = [];
    let parseError = null;
    if (SUPPORTED_EXTENSIONS.has(extension)) {
      try {
        questions = extension === '.docx' ? parseDocxQuestions(filePath) : parseJsonQuestions(filePath);
      } catch (error) {
        parseError = error.message;
      }
    }
    const validQuestions = questions.filter((question) => !question.invalid);
    const invalidQuestions = questions.length - validQuestions.length;
    let duplicateCount = 0;
    for (const question of validQuestions) {
      const signature = questionSignature(question);
      if (signatures.has(signature)) duplicateCount += 1;
      else signatures.add(signature);
    }
    const topic = resolveTopic(validQuestions);
    const classification = classifyRecord({
      extension,
      parseError,
      validQuestions,
      invalidQuestions,
      duplicateCount,
      metadata,
      topic,
    });
    if (parseError || validQuestions.length === 0 || invalidQuestions > 0) malformedFileCount += 1;
    if (!metadata.grade || !metadata.difficulty || !topic) metadataIncompleteFileCount += 1;
    increment(gradeDistribution, metadata.grade || 'Unclassified');
    increment(difficultyDistribution, metadata.difficulty || 'Unclassified');
    validQuestions.forEach((question) => increment(topicDistribution, question.topic || 'Missing'));
    increment(classificationDistribution, classification);
    validQuestionCount += validQuestions.length;
    malformedQuestionCount += invalidQuestions;
    duplicateQuestionCount += duplicateCount;
    const record = {
      path: metadata.relativePath,
      file_name: path.basename(filePath),
      title: path.basename(filePath, extension),
      grade: metadata.grade,
      difficulty: metadata.difficulty,
      legacy_difficulty: metadata.legacyDifficulty,
      topic_identifier: topic,
      format: extension.slice(1),
      valid_question_count: validQuestions.length,
      malformed_question_count: invalidQuestions,
      duplicate_question_count: duplicateCount,
      parse_error: parseError,
      parse_status: parseError ? 'PARSE ERROR' : (invalidQuestions > 0 ? 'PARTIALLY MALFORMED' : 'VALID'),
      metadata_complete: Boolean(metadata.grade && metadata.difficulty && topic),
      source_size_bytes: fs.statSync(filePath).size,
      content_fingerprint: fingerprint({
        grade: metadata.grade,
        difficulty: metadata.difficulty,
        topic,
        questions: validQuestions.map((question) => questionSignature(question)).sort(),
      }),
      classification,
      proposed_source_label: 'Client Provided',
    };
    Object.defineProperty(record, 'questions', { value: validQuestions, enumerable: false });
    Object.defineProperty(record, 'source_file_bytes', { value: fs.readFileSync(filePath), enumerable: false });
    Object.defineProperty(record, 'source_file_mime_type', { value: mimeTypeForExtension(extension), enumerable: false });
    return record;
  });

  const proposedRecords = records.filter((record) => record.classification === 'READY TO IMPORT');

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
    proposed_import_question_count: proposedRecords
      .reduce((count, record) => count + record.valid_question_count, 0),
    files,
    records,
  };
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
  auditGodotQuestionBundle,
  canonicalDifficulty,
  inferMetadata,
  normalizeQuestion,
  parseDocxQuestions,
  parseJsonQuestions,
  readDocxText,
};
