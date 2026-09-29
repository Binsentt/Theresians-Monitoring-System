const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');
const { XMLParser } = require('fast-xml-parser');

const PDF_MIME_TYPE = 'application/pdf';
const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_LESSON_TEXT_CHARS = 24_000;
const MAX_PPTX_ENTRIES = 1_000;
const MAX_PPTX_EXPANDED_BYTES = 24 * 1024 * 1024;
const MAX_PPTX_ENTRY_BYTES = 8 * 1024 * 1024;

class LessonTextExtractionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LessonTextExtractionError';
    this.code = code;
  }
}

const asText = (value) => String(value || '');
const asArray = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

const hasUnambiguousExtension = (file, extension) => {
  const name = asText(file?.originalname).trim().toLowerCase();
  if (/\.(?:pdf|pptx|docx)\.(?:pdf|pptx|docx)$/i.test(name)) return false;
  return name.endsWith(extension);
};

const getLessonContentFormat = (content) => {
  if (!Buffer.isBuffer(content)) return null;
  if (content.subarray(0, 5).toString('utf8') === '%PDF-') return 'pdf';
  if (content.subarray(0, 4).toString('binary') === 'PK\x03\x04') return 'zip';
  return null;
};

const getLessonMimeFormat = (file) => {
  const mimetype = asText(file?.mimetype).trim().toLowerCase();
  if (mimetype === PDF_MIME_TYPE) return 'pdf';
  if (mimetype === PPTX_MIME_TYPE) return 'pptx';
  if (mimetype === DOCX_MIME_TYPE) return 'docx';
  return null;
};

const detectLessonFormat = (file, content) => {
  const contentFormat = getLessonContentFormat(content);
  const mimeFormat = getLessonMimeFormat(file);
  if (contentFormat === 'pdf' && mimeFormat === 'pdf' && hasUnambiguousExtension(file, '.pdf')) return 'pdf';
  if (contentFormat !== 'zip') return null;
  if (mimeFormat === 'pptx' && hasUnambiguousExtension(file, '.pptx')) return 'pptx';
  if (mimeFormat === 'docx' && hasUnambiguousExtension(file, '.docx')) return 'docx';
  return null;
};

const validateLessonUploadFile = (file, header = Buffer.alloc(0)) => {
  const contentFormat = getLessonContentFormat(header);
  const mimeFormat = getLessonMimeFormat(file);
  if (!contentFormat) return 'Lesson sources support valid PDF, PPTX, or DOCX files with the expected file signature.';
  if (!mimeFormat || (contentFormat === 'pdf' ? mimeFormat !== 'pdf' : !['pptx', 'docx'].includes(mimeFormat))) {
    return 'Lesson file MIME type does not match its document content.';
  }
  if (!detectLessonFormat(file, header)) return 'Lesson filename extension does not match its document content. Lesson sources support PDF, PPTX, or DOCX files only.';
  return '';
};

const cleanLessonText = (value, { maxChars = MAX_LESSON_TEXT_CHARS } = {}) => {
  const lines = asText(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim());
  const normalizedLines = [];
  let previousBlank = false;
  for (const line of lines) {
    if (!line) {
      if (!previousBlank && normalizedLines.length > 0) normalizedLines.push('');
      previousBlank = true;
      continue;
    }
    normalizedLines.push(line);
    previousBlank = false;
  }
  const text = normalizedLines.join('\n').trim();
  if (!text) throw new LessonTextExtractionError('LESSON_TEXT_EMPTY', 'No readable lesson text was found in this source.');
  if (text.length > maxChars) {
    throw new LessonTextExtractionError('LESSON_TEXT_TOO_LARGE', 'The readable lesson text exceeds the safe size limit. Shorten the lesson before generating questions.');
  }
  return text;
};

const getAttribute = (node, name) => node?.[`@_${name}`] || node?.[name] || '';

const parseXml = (xml, code = 'PPTX_STRUCTURE_INVALID') => {
  try {
    return new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      processEntities: false,
      trimValues: false,
    }).parse(asText(xml));
  } catch {
    const message = code === 'DOCX_STRUCTURE_INVALID'
      ? 'The uploaded DOCX document structure could not be read.'
      : 'The PPTX presentation structure could not be read.';
    throw new LessonTextExtractionError(code, message);
  }
};

const parseOrderedXml = (xml, code = 'PPTX_STRUCTURE_INVALID') => {
  try {
    return new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      processEntities: false,
      trimValues: false,
      preserveOrder: true,
    }).parse(asText(xml));
  } catch {
    throw new LessonTextExtractionError(code, 'The PPTX presentation structure could not be read.');
  }
};

const collectOrderedTextRuns = (node, text = []) => {
  if (node === undefined || node === null) return text;
  if (typeof node === 'string' || typeof node === 'number') {
    text.push(String(node));
    return text;
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => collectOrderedTextRuns(entry, text));
    return text;
  }
  Object.entries(node).forEach(([key, value]) => {
    if (key === '#text') text.push(asText(value));
    else if (key !== ':@') collectOrderedTextRuns(value, text);
  });
  return text;
};

const collectOrderedSlideParagraphs = (node, paragraphs = []) => {
  if (node === undefined || node === null) return paragraphs;
  if (Array.isArray(node)) {
    node.forEach((entry) => collectOrderedSlideParagraphs(entry, paragraphs));
    return paragraphs;
  }
  if (typeof node !== 'object') return paragraphs;
  Object.entries(node).forEach(([key, value]) => {
    if (key === 'a:p' || key === 'p') {
      const text = collectOrderedTextRuns(value).join('').replace(/\s+/g, ' ').trim();
      if (text) paragraphs.push(text);
    } else if (key !== ':@') {
      collectOrderedSlideParagraphs(value, paragraphs);
    }
  });
  return paragraphs;
};

const resolveSlideTarget = (target) => {
  const rawTarget = asText(target).replace(/\\/g, '/');
  const normalized = path.posix.normalize(path.posix.join('ppt', rawTarget));
  return /^ppt\/slides\/slide\d+\.xml$/i.test(normalized) ? normalized : null;
};

const getPart = (parts, name) => (parts instanceof Map ? parts.get(name) : parts?.[name]);

const extractPptxTextFromParts = (parts) => {
  const contentTypes = getPart(parts, '[Content_Types].xml');
  const presentationXml = getPart(parts, 'ppt/presentation.xml');
  const relationshipsXml = getPart(parts, 'ppt/_rels/presentation.xml.rels');
  if (!contentTypes || !presentationXml || !relationshipsXml) {
    throw new LessonTextExtractionError('PPTX_STRUCTURE_INVALID', 'The uploaded PPTX is missing required presentation parts.');
  }

  const presentationDocument = parseXml(presentationXml);
  const presentation = presentationDocument['p:presentation'] || presentationDocument.presentation;
  const slideIds = asArray(presentation?.['p:sldIdLst']?.['p:sldId'] || presentation?.sldIdLst?.sldId);
  const relationshipIds = slideIds.map((slide) => getAttribute(slide, 'r:id')).filter(Boolean);
  if (relationshipIds.length === 0) {
    throw new LessonTextExtractionError('PPTX_STRUCTURE_INVALID', 'The uploaded PPTX does not contain an ordered slide list.');
  }

  const relationshipsDocument = parseXml(relationshipsXml).Relationships;
  const relationships = asArray(relationshipsDocument?.Relationship);
  const slideTargets = new Map(relationships
    .filter((relationship) => /\/slide$/i.test(asText(getAttribute(relationship, 'Type'))))
    .map((relationship) => [getAttribute(relationship, 'Id'), resolveSlideTarget(getAttribute(relationship, 'Target'))]));

  const slides = relationshipIds.map((relationshipId, index) => {
    const target = slideTargets.get(relationshipId);
    const slideXml = target ? getPart(parts, target) : null;
    if (!target || !slideXml) {
      throw new LessonTextExtractionError('PPTX_STRUCTURE_INVALID', 'The uploaded PPTX contains an invalid slide relationship.');
    }
    const paragraphs = collectOrderedSlideParagraphs(parseOrderedXml(slideXml));
    return paragraphs.length ? `Slide ${index + 1}\n${paragraphs.join('\n')}` : '';
  }).filter(Boolean);

  if (slides.length === 0) {
    throw new LessonTextExtractionError('LESSON_TEXT_EMPTY', 'No readable lesson text was found in this presentation.');
  }
  return cleanLessonText(slides.join('\n\n'));
};

const isSafeZipPath = (name) => {
  const value = asText(name).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!value || value.startsWith('/') || value.includes('\u0000')) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
};

const isReadablePptxPart = (name) => (
  name === '[Content_Types].xml'
  || name === 'ppt/presentation.xml'
  || name === 'ppt/_rels/presentation.xml.rels'
  || /^ppt\/slides\/slide\d+\.xml$/i.test(name)
);

const readPptxParts = (filePath, { openZip = yauzl.open } = {}) => new Promise((resolve, reject) => {
  openZip(filePath, { lazyEntries: true, validateEntrySizes: true }, (openError, zipFile) => {
    if (openError || !zipFile) {
      reject(new LessonTextExtractionError('PPTX_STRUCTURE_INVALID', 'The uploaded PPTX could not be opened safely.'));
      return;
    }

    const parts = new Map();
    let entryCount = 0;
    let expandedBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { zipFile.close(); } catch {}
      reject(error instanceof LessonTextExtractionError
        ? error
        : new LessonTextExtractionError('PPTX_STRUCTURE_INVALID', 'The uploaded PPTX could not be read safely.'));
    };
    const next = () => {
      if (!settled) zipFile.readEntry();
    };

    zipFile.on('error', fail);
    zipFile.on('entry', (entry) => {
      if (settled) return;
      entryCount += 1;
      expandedBytes += Number(entry.uncompressedSize) || 0;
      if (entryCount > MAX_PPTX_ENTRIES || expandedBytes > MAX_PPTX_EXPANDED_BYTES || !isSafeZipPath(entry.fileName)) {
        fail(new LessonTextExtractionError('PPTX_STRUCTURE_INVALID', 'The uploaded PPTX exceeds safe package limits.'));
        return;
      }
      if (!isReadablePptxPart(entry.fileName)) {
        next();
        return;
      }
      if (Number(entry.uncompressedSize) > MAX_PPTX_ENTRY_BYTES) {
        fail(new LessonTextExtractionError('PPTX_STRUCTURE_INVALID', 'The uploaded PPTX contains an oversized presentation part.'));
        return;
      }
      zipFile.openReadStream(entry, (streamError, stream) => {
        if (streamError || !stream) {
          fail(new LessonTextExtractionError('PPTX_STRUCTURE_INVALID', 'The uploaded PPTX contains an unreadable presentation part.'));
          return;
        }
        const chunks = [];
        let bytes = 0;
        stream.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_PPTX_ENTRY_BYTES) {
            stream.destroy();
            fail(new LessonTextExtractionError('PPTX_STRUCTURE_INVALID', 'The uploaded PPTX contains an oversized presentation part.'));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('error', () => fail(new LessonTextExtractionError('PPTX_STRUCTURE_INVALID', 'The uploaded PPTX contains an unreadable presentation part.')));
        stream.on('end', () => {
          if (settled) return;
          parts.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
          next();
        });
      });
    });
    zipFile.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(parts);
      }
    });
    next();
  });
});

const isReadableDocxPart = (name) => (
  name === '[Content_Types].xml'
  || name === '_rels/.rels'
  || name === 'word/document.xml'
);

const readDocxParts = (source, { openZip = yauzl.open, openZipFromBuffer = yauzl.fromBuffer } = {}) => new Promise((resolve, reject) => {
  const options = { lazyEntries: true, validateEntrySizes: true, strictFileNames: true };
  const onOpen = (openError, zipFile) => {
    if (openError || !zipFile) {
      reject(new LessonTextExtractionError('DOCX_STRUCTURE_INVALID', 'The uploaded DOCX package could not be opened safely.'));
      return;
    }

    const parts = new Map();
    const seenParts = new Set();
    let entryCount = 0;
    let expandedBytes = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      try { zipFile.close(); } catch {}
      reject(new LessonTextExtractionError('DOCX_STRUCTURE_INVALID', 'The uploaded DOCX package is invalid or exceeds safe package limits.'));
    };
    const next = () => {
      if (!settled) zipFile.readEntry();
    };

    zipFile.on('error', fail);
    zipFile.on('entry', (entry) => {
      if (settled) return;
      entryCount += 1;
      expandedBytes += Number(entry.uncompressedSize) || 0;
      if (entryCount > MAX_PPTX_ENTRIES || expandedBytes > MAX_PPTX_EXPANDED_BYTES || !isSafeZipPath(entry.fileName)) {
        fail();
        return;
      }
      if (!isReadableDocxPart(entry.fileName)) {
        next();
        return;
      }
      if (seenParts.has(entry.fileName) || Number(entry.uncompressedSize) > MAX_PPTX_ENTRY_BYTES) {
        fail();
        return;
      }
      seenParts.add(entry.fileName);
      zipFile.openReadStream(entry, (streamError, stream) => {
        if (streamError || !stream) {
          fail();
          return;
        }
        const chunks = [];
        let bytes = 0;
        stream.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_PPTX_ENTRY_BYTES) {
            stream.destroy();
            fail();
            return;
          }
          chunks.push(chunk);
        });
        stream.on('error', fail);
        stream.on('end', () => {
          if (settled) return;
          parts.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
          next();
        });
      });
    });
    zipFile.on('end', () => {
      if (settled) return;
      settled = true;
      try { zipFile.close(); } catch {}
      resolve(parts);
    });
    next();
  };

  if (Buffer.isBuffer(source)) openZipFromBuffer(source, options, onOpen);
  else openZip(source, options, onOpen);
});

const validateDocxParts = (parts) => {
  const contentTypesXml = getPart(parts, '[Content_Types].xml');
  const relationshipsXml = getPart(parts, '_rels/.rels');
  const documentXml = getPart(parts, 'word/document.xml');
  if (!contentTypesXml || !relationshipsXml || !documentXml) {
    throw new LessonTextExtractionError('DOCX_STRUCTURE_INVALID', 'The uploaded DOCX is missing required document parts.');
  }

  const contentTypes = parseXml(contentTypesXml, 'DOCX_STRUCTURE_INVALID').Types;
  const overrides = asArray(contentTypes?.Override);
  const hasDocumentContentType = overrides.some((entry) => (
    getAttribute(entry, 'PartName') === '/word/document.xml'
    && getAttribute(entry, 'ContentType') === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
  ));
  const rootRelationships = parseXml(relationshipsXml, 'DOCX_STRUCTURE_INVALID').Relationships;
  const relationships = asArray(rootRelationships?.Relationship);
  const hasDocumentRelationship = relationships.some((entry) => (
    /\/officeDocument$/i.test(asText(getAttribute(entry, 'Type')))
    && asText(getAttribute(entry, 'Target')).replace(/^\//, '') === 'word/document.xml'
  ));
  const document = parseXml(documentXml, 'DOCX_STRUCTURE_INVALID');
  const root = document['w:document'] || document.document;
  const namespace = asText(getAttribute(root, 'xmlns:w'));
  const hasWordDocumentRoot = Boolean(root)
    && [
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'http://purl.oclc.org/ooxml/wordprocessingml/main',
    ].includes(namespace)
    && Boolean(root['w:body'] || root.body);
  if (!hasDocumentContentType || !hasDocumentRelationship || !hasWordDocumentRoot) {
    throw new LessonTextExtractionError('DOCX_STRUCTURE_INVALID', 'The uploaded ZIP does not contain a valid DOCX document structure.');
  }
};

const validateLessonDocumentStructure = async (file, providedContent = null, options = {}) => {
  const content = Buffer.isBuffer(providedContent)
    ? providedContent
    : Buffer.isBuffer(file?.buffer)
      ? file.buffer
      : fs.readFileSync(file.path);
  if (detectLessonFormat(file, content) !== 'docx') return;
  validateDocxParts(await readDocxParts(content, options));
};

const PDF_NO_TEXT_MESSAGE = 'No readable text was found in this PDF. Use a text-based PDF, PPTX, or DOCX file.';

const isInvalidPdfError = (error) => (
  ['InvalidPDFException', 'MissingPDFException', 'FormatError'].includes(asText(error?.name))
  || ['InvalidPDFException', 'MissingPDFException', 'FormatError'].includes(asText(error?.code))
  || /invalid pdf|corrupt pdf|pdf header|xref (?:table|stream)|unexpected eof/i.test(asText(error?.message))
);

const extractPdfTextWithParse = async (input, pdfParse) => {
  let renderedPages = 0;
  let pageExtractionFailed = false;
  const parsed = await pdfParse(input, {
    pagerender: async (pageData) => {
      renderedPages += 1;
      try {
        const textContent = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
        let lastY;
        let text = '';
        for (const item of textContent.items) {
          if (lastY === item.transform[5] || !lastY) text += item.str;
          else text += `\n${item.str}`;
          lastY = item.transform[5];
        }
        return text;
      } catch {
        pageExtractionFailed = true;
        return '';
      }
    },
  });
  if (pageExtractionFailed || (Number(parsed?.numpages) > 0 && renderedPages < Number(parsed.numpages))) {
    throw new LessonTextExtractionError('LESSON_PDF_EXTRACTION_FAILED', 'PDF text extraction failed. Re-export as a text-based PDF or use a PPTX or DOCX file.');
  }
  return parsed?.text;
};

const extractLessonText = async (file, { extractPdfText, extractDocxText, pdfParseImpl, pptxParts, openZip, openZipFromBuffer } = {}) => {
  const content = Buffer.isBuffer(file?.buffer) ? file.buffer : fs.readFileSync(file.path);
  const validationError = validateLessonUploadFile(file, content);
  if (validationError) throw new LessonTextExtractionError('LESSON_FILE_INVALID', validationError);
  const format = detectLessonFormat(file, content);
  if (format === 'pdf') {
    try {
      const extract = extractPdfText || (async (input) => {
        return extractPdfTextWithParse(input, pdfParseImpl || require('pdf-parse'));
      });
      const extractedText = await extract(content);
      try {
        return cleanLessonText(extractedText);
      } catch (error) {
        if (error instanceof LessonTextExtractionError && error.code === 'LESSON_TEXT_EMPTY') {
          throw new LessonTextExtractionError('LESSON_PDF_NO_TEXT', PDF_NO_TEXT_MESSAGE);
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof LessonTextExtractionError) throw error;
      if (isInvalidPdfError(error)) {
        throw new LessonTextExtractionError('LESSON_PDF_INVALID', 'The uploaded PDF is invalid or corrupted. Use a valid text-based PDF, PPTX, or DOCX file.');
      }
      throw new LessonTextExtractionError('LESSON_PDF_EXTRACTION_FAILED', 'PDF text extraction failed. Re-export as a text-based PDF or use a PPTX or DOCX file.');
    }
  }
  if (format === 'docx') {
    try {
      const parts = await readDocxParts(content, { openZipFromBuffer });
      validateDocxParts(parts);
      const extract = extractDocxText || ((buffer) => require('mammoth').extractRawText({ buffer }));
      const result = await extract(content);
      try {
        return cleanLessonText(typeof result === 'string' ? result : result?.value);
      } catch (error) {
        if (error instanceof LessonTextExtractionError && error.code === 'LESSON_TEXT_EMPTY') {
          throw new LessonTextExtractionError('LESSON_DOCX_NO_TEXT', 'No readable text was found in this DOCX file.');
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof LessonTextExtractionError) throw error;
      throw new LessonTextExtractionError('LESSON_DOCX_EXTRACTION_FAILED', 'DOCX text extraction failed. Check the document or save it as a new DOCX file.');
    }
  }
  const parts = pptxParts || await readPptxParts(file.path, { openZip });
  return extractPptxTextFromParts(parts);
};

module.exports = {
  MAX_LESSON_TEXT_CHARS,
  DOCX_MIME_TYPE,
  PPTX_MIME_TYPE,
  LessonTextExtractionError,
  cleanLessonText,
  detectLessonFormat,
  extractLessonText,
  extractPptxTextFromParts,
  readDocxParts,
  readPptxParts,
  validateLessonDocumentStructure,
  validateLessonSourceFile: validateLessonUploadFile,
  validateLessonUploadFile,
};
