const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  getMathTopicsForGradeDifficulty,
  normalizeDifficultyValue,
} = require('./learningContentRules.utils');

const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

const compactText = (value) => String(value ?? '')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeChoice = (value) => compactText(value)
  .replace(/^[A-D][.)]\s*/i, '')
  .replace(/\s*\(\s*(?:correct|answer)\s*:[^)]*\)\s*/gi, ' ')
  .replace(/^\$([^$]+)\$$/, '$1')
  .trim();

const normalizeComparable = (value) => normalizeChoice(value)
  .replace(/\s+/g, ' ')
  .toLocaleLowerCase();

const parseGrade = (value) => {
  const match = String(value || '').match(/^grade\s*_?\s*([1-6])$/i);
  return match ? `Grade ${match[1]}` : null;
};

const parseDifficulty = (value) => {
  const normalized = normalizeDifficultyValue(value);
  return ['Easy', 'Normal', 'Difficult'].includes(normalized) ? normalized : null;
};

const metadataFromPath = (root, filePath) => {
  const relativePath = path.relative(root, filePath).split(path.sep).join('/');
  const parts = relativePath.split('/');
  let gradeLevel = null;
  let difficulty = null;

  for (const part of parts.slice(0, -1)) {
    gradeLevel = gradeLevel || parseGrade(part);
    difficulty = difficulty || parseDifficulty(part);
  }

  const filenameMatch = path.basename(filePath, path.extname(filePath))
    .match(/grade\s*_?\s*([1-6])[_\s-]*(easy|normal|average|medium|difficult|hard)/i);
  if (filenameMatch) {
    gradeLevel = gradeLevel || `Grade ${filenameMatch[1]}`;
    difficulty = difficulty || parseDifficulty(filenameMatch[2]);
  }
  difficulty = difficulty || parseDifficulty(path.basename(filePath, path.extname(filePath)));

  return {
    relativePath,
    metadata: gradeLevel && difficulty ? { grade_level: gradeLevel, difficulty } : null,
  };
};

const discoverQuestionSources = (root) => {
  const sources = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      const extension = path.extname(entry.name).toLocaleLowerCase();
      if (!['.docx', '.json'].includes(extension)) continue;
      const pathMetadata = metadataFromPath(root, entryPath);
      sources.push({
        path: entryPath,
        extension,
        ...pathMetadata,
      });
    }
  };

  walk(root);
  return sources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
};

const decodeXmlText = (value) => String(value || '')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)));

const readZipEntry = (buffer, entryName) => {
  const minimumEocdOffset = Math.max(0, buffer.length - 0xffff - 22);
  let eocdOffset = -1;
  for (let index = buffer.length - 22; index >= minimumEocdOffset; index -= 1) {
    if (buffer.readUInt32LE(index) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('DOCX ZIP directory is missing');

  const entries = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error('DOCX ZIP directory entry is invalid');
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (name === entryName) {
      if (buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
        throw new Error('DOCX ZIP local entry is invalid');
      }
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      if (compressionMethod === 0) return compressed;
      if (compressionMethod === 8) return zlib.inflateRawSync(compressed);
      throw new Error(`Unsupported DOCX ZIP compression method: ${compressionMethod}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`DOCX entry not found: ${entryName}`);
};

const extractDocxText = (buffer) => {
  const documentXml = readZipEntry(buffer, 'word/document.xml').toString('utf8');
  const text = documentXml
    .replace(/<w:tab\b[^>]*\/>/gi, '\t')
    .replace(/<w:br\b[^>]*\/>/gi, '\n')
    .replace(/<\/w:p>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeXmlText(text)
    .split(/\r?\n/)
    .map(compactText)
    .filter(Boolean)
    .join('\n');
};

const explicitTopic = (text, metadata) => {
  const allowedTopics = getMathTopicsForGradeDifficulty(metadata.grade_level, metadata.difficulty);
  const topicMatch = String(text || '').match(/(?:^|\n)\s*(?:[a-z]+\s+)?(?:lesson|topic)\s*:\s*([^\n]+)/i);
  if (!topicMatch) return null;
  const label = compactText(topicMatch[1]).replace(/[.:-]+$/, '');
  return allowedTopics.find((topic) => topic.localeCompare(label, undefined, { sensitivity: 'accent' }) === 0) || null;
};

const answerFromText = (answerText, options) => {
  const explicitLabel = compactText(answerText).match(/^([A-D])[.)]?(?:\s+|$)/i);
  if (explicitLabel) {
    const selected = options[explicitLabel[1].toUpperCase().charCodeAt(0) - 65];
    return selected || null;
  }
  const answer = normalizeComparable(answerText);
  return options.find((option) => normalizeComparable(option) === answer) || null;
};

const questionLinesFromBlock = (lines, optionStart) => lines.slice(0, optionStart)
  .filter((line) => !/^(?:grade\s*[1-6]|easy|normal|average|difficult|hard)(?:\s|$)/i.test(line))
  .filter((line) => !/^(?:lesson|topic)\s*:/i.test(line))
  .map((line) => line.replace(/^\d+[.)]\s*/, ''))
  .filter(Boolean);

const parseQuestionBlock = (blockLines, answerText, metadata, topic) => {
  const lines = blockLines.map(compactText).filter(Boolean);
  const labelledOptions = lines
    .map((line, index) => ({ index, match: line.match(/^([A-D])[.)]\s*(.+)$/i) }))
    .filter((entry) => entry.match);

  let question = '';
  let options = [];
  if (labelledOptions.length >= 2) {
    const firstOption = labelledOptions[0].index;
    question = compactText(questionLinesFromBlock(lines, firstOption).join(' '));
    options = labelledOptions.map((entry) => normalizeChoice(entry.match[2])).filter(Boolean);
  } else {
    const numberedIndex = lines.map((line, index) => ({ line, index }))
      .filter((entry) => /^\d+[.)]\s+/.test(entry.line))
      .at(-1)?.index;
    if (numberedIndex !== undefined) {
      question = compactText(lines[numberedIndex].replace(/^\d+[.)]\s*/, ''));
      options = lines.slice(numberedIndex + 1).map(normalizeChoice).filter(Boolean);
    }
  }

  const inlineCorrectOptions = labelledOptions
    .filter((entry) => /\(\s*(?:correct|answer)\s*:/i.test(entry.match[2]));
  let correctAnswer = answerFromText(answerText, options);
  if (correctAnswer == null && inlineCorrectOptions.length === 1) {
    correctAnswer = normalizeChoice(inlineCorrectOptions[0].match[2]);
  }
  if (!question || options.length < 2 || !correctAnswer) return null;
  return {
    question,
    options,
    correct_answer: correctAnswer,
    grade_level: metadata.grade_level,
    difficulty: metadata.difficulty,
    math_topic: topic,
  };
};

const parseQuestionText = (text, metadata) => {
  const lines = String(text || '')
    .replace(/(?<!\()((?:correct\s+)?answer)\s*:/gi, '\n$1:')
    .split(/\r?\n/)
    .map(compactText)
    .filter(Boolean);
  const topic = explicitTopic(lines.join('\n'), metadata);
  const questions = [];
  const skipped = [];
  let block = [];

  for (const line of lines) {
    const answerMatch = line.match(/^(?:correct\s+)?answer\s*:\s*(.+)$/i);
    if (!answerMatch) {
      block.push(line);
      continue;
    }
    const question = parseQuestionBlock(block, answerMatch[1], metadata, topic);
    if (question) questions.push(question);
    else skipped.push({ reason: 'missing_question_choices_or_matching_answer' });
    block = [];
  }

  if (block.length > 0) {
    const questionIndexes = block
      .map((line, index) => ({ line, index }))
      .filter((entry) => /^\d+[.)]\s+/.test(entry.line))
      .map((entry) => entry.index);
    if (questionIndexes.length > 0) {
      for (let index = 0; index < questionIndexes.length; index += 1) {
        const end = questionIndexes[index + 1] ?? block.length;
        const question = parseQuestionBlock(block.slice(questionIndexes[index], end), '', metadata, topic);
        if (question) questions.push(question);
        else skipped.push({ reason: 'missing_question_choices_or_matching_answer' });
      }
    } else if (block.some((line) => /^[A-D][.)]\s*/i.test(line))) {
      skipped.push({ reason: 'missing_explicit_answer' });
    }
  }
  return { questions, skipped };
};

const parseDocxBuffer = (buffer, metadata) => parseQuestionText(extractDocxText(buffer), metadata);

const correctAnswerFromRecord = (record, options) => {
  const raw = record.correct_answer ?? record.correct ?? record.answer;
  if (Number.isInteger(raw) && options[raw] !== undefined) return options[raw];
  return answerFromText(raw, options);
};

const parseLegacyJson = (payload, metadata) => {
  const entries = Array.isArray(payload) ? payload : payload?.questions;
  if (!Array.isArray(entries)) {
    return { questions: [], skipped: [{ reason: 'json_questions_array_missing' }] };
  }
  const questions = [];
  const skipped = [];
  for (const record of entries) {
    const question = compactText(record?.question ?? record?.question_text ?? record?.text);
    const options = (Array.isArray(record?.options) ? record.options : record?.choices)
      ?.map(normalizeChoice)
      .filter(Boolean) || [];
    const correctAnswer = correctAnswerFromRecord(record || {}, options);
    if (!question || options.length < 2 || !correctAnswer) {
      skipped.push({ reason: 'json_question_missing_text_choices_or_matching_answer' });
      continue;
    }
    questions.push({
      ...(record.question_id || record.id ? { source_question_id: String(record.question_id ?? record.id) } : {}),
      question,
      options,
      correct_answer: correctAnswer,
      grade_level: metadata.grade_level,
      difficulty: metadata.difficulty,
      math_topic: null,
    });
  }
  return { questions, skipped };
};

const sourceHash = (buffer, metadata, relativePath = '') => crypto.createHash('sha256')
  .update(buffer)
  .update('\n')
  .update(JSON.stringify(metadata))
  .update('\n')
  .update(relativePath)
  .digest('hex');

module.exports = {
  discoverQuestionSources,
  extractDocxText,
  parseDocxBuffer,
  parseLegacyJson,
  parseQuestionText,
  sourceHash,
};
