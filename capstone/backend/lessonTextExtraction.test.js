const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  LessonTextExtractionError,
  cleanLessonText,
  extractLessonText,
  extractPptxTextFromParts,
  readPptxParts,
  validateLessonUploadFile,
  validateLessonDocumentStructure,
} = require('./lessonTextExtraction');
const { generateLessonQuestionsInBatches } = require('./lessonQuestionGeneration');

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const presentationXml = `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>`;
const relationshipsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/></Relationships>`;
const slideOneXml = `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>First slide</a:t></a:r></a:p><a:p><a:r><a:t>First paragraph</a:t></a:r><a:r><a:t> continued</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const slideTwoXml = `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const slideThreeXml = `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>3 + 2 = 5</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const docxContentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const docxRelationships = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const docxDocument = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX lesson text about adding counters.</w:t></w:r></w:p><w:p><w:r><w:t>Three plus two equals five.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
const createDocx = () => createZip([
  ['[Content_Types].xml', docxContentTypes],
  ['_rels/.rels', docxRelationships],
  ['word/document.xml', docxDocument],
]);

const crc32 = (buffer) => {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
};

const createZip = (entries) => {
  let offset = 0;
  const localParts = [];
  const centralParts = [];
  for (const [name, value] of entries) {
    const fileName = Buffer.from(name);
    const content = Buffer.from(value);
    const compressed = zlib.deflateRawSync(content);
    const checksum = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034B50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    localParts.push(localHeader, fileName, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014B50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, fileName);
    offset += localHeader.length + fileName.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

test('cleans readable lesson text without rewriting or silently truncating it', () => {
  assert.equal(cleanLessonText('  Learn\u0000\n\naddition\twith counters.  '), 'Learn\n\naddition with counters.');
  assert.throws(
    () => cleanLessonText('x'.repeat(24_001), { maxChars: 24_000 }),
    (error) => error instanceof LessonTextExtractionError && error.code === 'LESSON_TEXT_TOO_LARGE'
  );
});

test('accepts only a coherent PPTX upload signature and rejects legacy PPT', () => {
  assert.equal(validateLessonUploadFile({ originalname: 'lesson.pptx', mimetype: PPTX_MIME }, Buffer.from('PK\x03\x04ppt/presentation.xml')), '');
  assert.match(
    validateLessonUploadFile({ originalname: 'lesson.ppt', mimetype: 'application/vnd.ms-powerpoint' }, Buffer.from('D0CF11E0')),
    /PDF.*PPTX.*DOCX/i
  );
  assert.match(
    validateLessonUploadFile({ originalname: 'lesson.pptx', mimetype: PPTX_MIME }, Buffer.from('%PDF-1.7')),
    /MIME type.*content/i
  );
});

test('accepts DOCX only when extension, MIME type, and ZIP signature agree', () => {
  const docx = createDocx();
  assert.equal(validateLessonUploadFile({ originalname: 'lesson.docx', mimetype: DOCX_MIME }, docx), '');
  assert.match(validateLessonUploadFile({ originalname: 'lesson.docx', mimetype: 'application/zip' }, docx), /MIME type.*content/i);
  assert.match(validateLessonUploadFile({ originalname: 'lesson.pdf', mimetype: DOCX_MIME }, docx), /extension.*content/i);
  assert.match(validateLessonUploadFile({ originalname: 'lesson.docx', mimetype: DOCX_MIME }, Buffer.from('%PDF-1.7')), /signature|content/i);
});

test('rejects a ZIP that has a DOCX name and MIME type but lacks a valid DOCX package structure', async () => {
  await assert.rejects(
    () => validateLessonDocumentStructure({
      originalname: 'not-a-docx.docx',
      mimetype: DOCX_MIME,
      buffer: Buffer.from('PK\x03\x04not really a complete archive'),
    }),
    (error) => error instanceof LessonTextExtractionError && error.code === 'DOCX_STRUCTURE_INVALID'
  );
});

test('uses the same public extraction boundary for PDF text without sending the title as lesson text', async () => {
  const pdfBytes = Buffer.from('%PDF-1.7 readable lesson');
  let receivedBytes = null;
  const lessonText = await extractLessonText({
    originalname: 'addition.pdf',
    mimetype: 'application/pdf',
    buffer: pdfBytes,
  }, {
    extractPdfText: async (input) => {
      receivedBytes = input;
      return 'Adding means combining numbers.\n\n3 + 2 = 5';
    },
  });

  assert.equal(receivedBytes, pdfBytes);
  assert.equal(lessonText, 'Adding means combining numbers.\n\n3 + 2 = 5');
});

test('extracts readable text from a real text-based PDF through pdf-parse', async () => {
  const pdfPath = path.join(__dirname, 'test-fixtures', 'fixed-question-four-choice.pdf');
  const lessonText = await extractLessonText({
    path: pdfPath,
    originalname: 'lesson.pdf',
    mimetype: 'application/pdf',
  });

  assert.ok(lessonText.length > 0);
  assert.match(lessonText, /What is/i);
});

test('distinguishes a valid PDF with no readable text and returns the actionable message', async () => {
  await assert.rejects(
    () => extractLessonText({
      originalname: 'image-only.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7 valid-but-image-only'),
    }, { extractPdfText: async () => '' }),
    (error) => error instanceof LessonTextExtractionError
      && error.code === 'LESSON_PDF_NO_TEXT'
      && error.message === 'No readable text was found in this PDF. Use a text-based PDF, PPTX, or DOCX file.'
  );
});

test('distinguishes invalid PDFs from parser/extraction failures', async () => {
  await assert.rejects(
    () => extractLessonText({
      originalname: 'corrupt.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7 invalid'),
    }, { extractPdfText: async () => {
      const error = new Error('invalid document structure');
      error.name = 'InvalidPDFException';
      throw error;
    } }),
    (error) => error instanceof LessonTextExtractionError && error.code === 'LESSON_PDF_INVALID'
  );
  await assert.rejects(
    () => extractLessonText({
      originalname: 'parser-error.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7 readable'),
    }, { extractPdfText: async () => { throw new Error('internal extraction failure'); } }),
    (error) => error instanceof LessonTextExtractionError && error.code === 'LESSON_PDF_EXTRACTION_FAILED'
  );
  await assert.rejects(
    () => extractLessonText({
      originalname: 'actually-corrupt.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\nnot a real PDF'),
    }),
    (error) => error instanceof LessonTextExtractionError && error.code === 'LESSON_PDF_INVALID'
  );
  await assert.rejects(
    () => extractLessonText({
      originalname: 'page-extraction-error.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7 page extraction failure'),
    }, {
      pdfParseImpl: async (_input, options) => {
        await options.pagerender({ getTextContent: async () => { throw new Error('page text failed'); } });
        return { numpages: 1, text: '' };
      },
    }),
    (error) => error instanceof LessonTextExtractionError && error.code === 'LESSON_PDF_EXTRACTION_FAILED'
  );
});

test('extracts raw readable text from a valid DOCX with Mammoth', async () => {
  const lessonText = await extractLessonText({
    originalname: 'lesson.docx',
    mimetype: DOCX_MIME,
    buffer: createDocx(),
  });

  assert.equal(lessonText, 'DOCX lesson text about adding counters.\n\nThree plus two equals five.');
});

test('extracts lesson text from an existing real DOCX document package', async () => {
  const docxPath = path.join(__dirname, '../docs/teacher-fixed-question-documents/grade1-easy-basic-addition-set-b.docx');
  const lessonText = await extractLessonText({
    path: docxPath,
    originalname: 'addition-lesson.docx',
    mimetype: DOCX_MIME,
  });

  assert.ok(lessonText.length > 0);
  assert.match(lessonText, /addition|number/i);
});

test('PDF, PPTX, and DOCX extraction share the same dynamic-count generation pipeline', async () => {
  const pptxParts = new Map([
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/presentation.xml', presentationXml],
    ['ppt/_rels/presentation.xml.rels', relationshipsXml],
    ['ppt/slides/slide1.xml', slideOneXml],
    ['ppt/slides/slide2.xml', slideTwoXml],
    ['ppt/slides/slide3.xml', slideThreeXml],
  ]);
  const sources = [
    {
      file: { originalname: 'lesson.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.7 text') },
      options: { extractPdfText: async () => 'PDF lesson about adding counters.' },
    },
    {
      file: { originalname: 'lesson.pptx', mimetype: PPTX_MIME, buffer: Buffer.from('PK\x03\x04ppt') },
      options: { pptxParts },
    },
    {
      file: { originalname: 'lesson.docx', mimetype: DOCX_MIME, buffer: createDocx() },
      options: {},
    },
  ];

  for (const { file, options } of sources) {
    const lessonText = await extractLessonText(file, options);
    const calls = [];
    const questions = await generateLessonQuestionsInBatches({
      lessonText,
      title: 'Addition lesson',
      gradeLevel: 'Grade 1',
      difficulty: 'Easy',
      questionCount: 7,
      batchSize: 5,
      generateBatch: async ({ questionCount }) => {
        calls.push(questionCount);
        return Array.from({ length: questionCount }, (_, index) => ({
          question: `${file.originalname} question ${calls.reduce((sum, count) => sum + count, 0) - questionCount + index + 1}`,
          options: ['1', '2', '3', '4'],
          correct_answer: '1',
        }));
      },
    });

    assert.deepEqual(calls, [5, 2]);
    assert.equal(questions.length, 7);
  }
});

test('extracts only ordered rendered PPTX slide text and excludes package junk', () => {
  const lessonText = extractPptxTextFromParts(new Map([
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/presentation.xml', presentationXml],
    ['ppt/_rels/presentation.xml.rels', relationshipsXml],
    ['ppt/slides/slide1.xml', slideOneXml],
    ['ppt/slides/slide2.xml', slideTwoXml],
    ['ppt/slides/slide3.xml', slideThreeXml],
    ['ppt/theme/theme1.xml', '<a:theme xmlns:a="a"><a:t>Never include this theme text</a:t></a:theme>'],
    ['docProps/core.xml', '<cp:coreProperties><dc:title>Never include this title</dc:title></cp:coreProperties>'],
  ]));

  assert.equal(lessonText, 'Slide 1\nFirst slide\nFirst paragraph continued\n\nSlide 2\nSecond slide\n\nSlide 3\n3 + 2 = 5');
  assert.doesNotMatch(lessonText, /Never include|rIdTheme|theme1/i);
});

test('reads a real bounded PPTX archive with directory entries through yauzl', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-lesson-text-test-'));
  const pptxPath = path.join(tempDir, 'lesson.pptx');
  fs.writeFileSync(pptxPath, createZip([
    ['ppt/', ''],
    ['ppt/slides/', ''],
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/presentation.xml', presentationXml],
    ['ppt/_rels/presentation.xml.rels', relationshipsXml],
    ['ppt/slides/slide1.xml', slideOneXml],
    ['ppt/slides/slide2.xml', slideTwoXml],
    ['ppt/slides/slide3.xml', slideThreeXml],
    ['ppt/theme/theme1.xml', '<a:theme xmlns:a="a"><a:t>ignored package text</a:t></a:theme>'],
  ]));
  t.after(() => {
    if (fs.existsSync(pptxPath)) fs.unlinkSync(pptxPath);
    if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
  });

  const lessonText = await extractLessonText({
    path: pptxPath,
    originalname: 'lesson.pptx',
    mimetype: PPTX_MIME,
  });

  assert.match(lessonText, /Slide 1\nFirst slide/);
  assert.match(lessonText, /Slide 2\nSecond slide/);
  assert.match(lessonText, /Slide 3\n3 \+ 2 = 5/);
  assert.doesNotMatch(lessonText, /ignored package text/i);
});

test('rejects PPTX path traversal and oversized expanded slide entries before extraction', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-lesson-safety-test-'));
  const traversalPath = path.join(tempDir, 'traversal.pptx');
  const oversizedPath = path.join(tempDir, 'oversized.pptx');
  fs.writeFileSync(traversalPath, createZip([['../outside.xml', '<outside/>']]));
  fs.writeFileSync(oversizedPath, createZip([['ppt/slides/slide1.xml', 'x'.repeat((8 * 1024 * 1024) + 1)]]));
  t.after(() => {
    for (const filePath of [traversalPath, oversizedPath]) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
  });

  await assert.rejects(
    () => readPptxParts(traversalPath),
    (error) => error instanceof LessonTextExtractionError && error.code === 'PPTX_STRUCTURE_INVALID'
  );
  await assert.rejects(
    () => readPptxParts(oversizedPath),
    (error) => error instanceof LessonTextExtractionError && error.code === 'PPTX_STRUCTURE_INVALID'
  );
});

test('rejects image-only or malformed presentation structures before any provider use', () => {
  assert.throws(
    () => extractPptxTextFromParts(new Map([
      ['[Content_Types].xml', '<Types/>'],
      ['ppt/presentation.xml', presentationXml],
      ['ppt/_rels/presentation.xml.rels', relationshipsXml],
      ['ppt/slides/slide1.xml', '<p:sld xmlns:p="p"/>'],
      ['ppt/slides/slide2.xml', '<p:sld xmlns:p="p"/>'],
      ['ppt/slides/slide3.xml', '<p:sld xmlns:p="p"/>'],
    ])),
    (error) => error instanceof LessonTextExtractionError && error.code === 'LESSON_TEXT_EMPTY'
  );
  assert.throws(
    () => extractPptxTextFromParts(new Map([
      ['[Content_Types].xml', '<Types/>'],
      ['ppt/presentation.xml', presentationXml],
    ])),
    (error) => error instanceof LessonTextExtractionError && error.code === 'PPTX_STRUCTURE_INVALID'
  );
});
