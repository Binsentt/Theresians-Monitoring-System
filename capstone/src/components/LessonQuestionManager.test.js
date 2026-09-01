import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import LessonQuestionManager from './LessonQuestionManager';
import { clearPreparedReport, openPreparedReport } from './PrintReportPortal';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('./layout/AnalyticsSidebar', () => () => <div>Sidebar</div>);
jest.mock('../assets/images/STS_Logo.png', () => 'logo.png');

const okJson = (payload) => Promise.resolve({
  ok: true,
  json: async () => payload,
});

const errorJson = (payload, status = 409) => Promise.resolve({
  ok: false,
  status,
  json: async () => payload,
});

const clickByText = (container, label) => {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent.includes(label));
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

const setSelectValue = (field, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('change', { bubbles: true }));
};

const getUploadModal = () => document.body.querySelector('.drive-upload-modal');
const getUploadModalSelects = () => document.body.querySelectorAll('.drive-upload-modal select');
let previewObservers = [];

class MockIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observe = jest.fn((target) => {
      this.target = target;
    });
    this.disconnect = jest.fn();
    previewObservers.push(this);
  }
}

const markPreviewAsReviewed = async () => {
  const observer = previewObservers.at(-1);
  const sentinel = document.body.querySelector('[data-testid="final-question-review-sentinel"]');
  expect(observer).toBeTruthy();
  expect(sentinel).toBeTruthy();
  await act(async () => {
    observer.callback([{ target: sentinel, isIntersecting: true }]);
  });
};

const openQuestionFolder = async (container, gradeLevel, difficulty) => {
  await act(async () => {
    clickByText(container, gradeLevel);
  });
  await act(async () => {
    clickByText(container, difficulty);
  });
};

const buildReviewRequiredFile = (overrides = {}) => ({
  id: 91,
  title: 'review-required-addition.docx',
  file_name: 'review-required-addition.docx',
  file_url: '/uploads/review-required-addition.docx',
  grade_level: 'Grade 1',
  difficulty: 'Easy',
  math_topic: 'Basic Addition',
  document_topic: 'Basic Addition',
  file_type: 'fixed_questions',
  question_count: 5,
  published: false,
  approval_status: 'review_required',
  validation_summary: {
    is_valid: true,
    invalid_question_count: 0,
    review_eligibility: { eligible: true, code: 'ELIGIBLE', message: 'Ready for review approval.' },
    publication_eligibility: {
      eligible: false,
      code: 'REVIEW_APPROVAL_REQUIRED',
      message: 'Approve this reviewed question set before Push to Game.',
    },
  },
  ...overrides,
});

const curriculumRegistryFixture = {
  version: '2026-08-31',
  grades: ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'].map((value) => ({
    value,
    display_label: value,
    aliases: [],
  })),
  difficulties: ['Easy', 'Normal', 'Difficult'].map((value) => ({
    value,
    display_label: value,
    aliases: [],
  })),
  topics: [
    ['basic_addition', 'Basic Addition'], ['subtraction', 'Subtraction'], ['shapes', 'Shapes'], ['place_value', 'Place Value'],
    ['addition', 'Addition'], ['multiplication', 'Multiplication'], ['word_problems', 'Word Problems'], ['division', 'Division'],
    ['fractions', 'Fractions'], ['number_theory', 'Number Theory'], ['whole_numbers', 'Whole Numbers'], ['addition_of_money', 'Addition of Money'],
  ].map(([topic_id, display_label]) => ({ topic_id, display_label })),
  scopes: [
    { grade_level: 'Grade 1', difficulty: 'Easy', topic_ids: ['basic_addition', 'subtraction', 'shapes', 'place_value'] },
    { grade_level: 'Grade 1', difficulty: 'Normal', topic_ids: ['addition', 'multiplication', 'word_problems'] },
    { grade_level: 'Grade 2', difficulty: 'Easy', topic_ids: ['shapes'] },
    { grade_level: 'Grade 3', difficulty: 'Easy', topic_ids: ['addition_of_money', 'whole_numbers'] },
    { grade_level: 'Grade 3', difficulty: 'Normal', topic_ids: ['multiplication', 'division', 'fractions'] },
  ],
};

describe('LessonQuestionManager upload and trash controls', () => {
  let container;
  let root;
  let fixtures;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    previewObservers = [];
    global.IntersectionObserver = MockIntersectionObserver;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 8, role: 'teacher', name: 'Teacher User' }));
    localStorage.setItem('rememberToken', 'lesson-manager-token');
    fixtures = {
      files: [],
      lessonSources: [],
      folders: [],
      trashFiles: [{ id: 31, title: 'Deleted Quiz', file_name: 'deleted.csv', deleted_at: '2026-05-20T00:00:00.000Z' }],
      trashFolders: [],
      publishResponse: null,
      approvalResponse: null,
    };
    global.fetch = jest.fn((url, options = {}) => {
      const value = String(url);
      const scopedValue = value.replace(/\?scope=teacher$/, '');
      if (scopedValue.endsWith('/api/curriculum/registry')) return okJson(curriculumRegistryFixture);
      if (scopedValue.endsWith('/api/learning-files/storage-summary')) {
        return okJson({ used_bytes: 601, source_file_bytes: 480, question_content_bytes: 121 });
      }
      if (scopedValue.endsWith('/api/learning-files/lesson-sources')) return okJson(fixtures.lessonSources);
      const lessonSourceGenerationMatch = value.match(/\/api\/learning-files\/lesson-sources\/(\d+)\/generate/);
      if (lessonSourceGenerationMatch && options.method === 'POST') {
        const request = JSON.parse(options.body);
        const generated = {
          id: 801,
          title: 'Reusable lesson — Grade 1 / Easy / Basic Addition',
          file_name: 'reusable.pdf',
          file_url: '/uploads/reusable.pdf',
          grade_level: request.grade_level,
          difficulty: request.difficulty,
          math_topic: request.math_topic,
          file_type: 'lesson',
          source_learning_file_id: Number(lessonSourceGenerationMatch[1]),
          published: false,
        };
        fixtures.files = [generated, ...fixtures.files];
        return okJson({ success: true, learningFile: generated });
      }
      if (scopedValue.endsWith('/api/learning-files')) return okJson(fixtures.files);
      if (scopedValue.endsWith('/api/folders')) return okJson(fixtures.folders);
      if (scopedValue.endsWith('/api/learning-files/trash') && options.method === 'DELETE') {
        const ids = JSON.parse(options.body).file_ids;
        fixtures.trashFiles = fixtures.trashFiles.filter((file) => !ids.includes(file.id));
        return okJson({ success: true, deleted_file_ids: ids });
      }
      if (scopedValue.endsWith('/api/learning-files/trash')) return okJson(fixtures.trashFiles);
      if (scopedValue.endsWith('/api/folders/trash')) return okJson(fixtures.trashFolders);
      if (value.includes('/api/learning-files/31/restore') && options.method === 'POST') {
        fixtures.trashFiles = [];
        fixtures.files = [{ id: 31, title: 'Deleted Quiz', file_name: 'deleted.csv', folder_name: 'Addition Folder' }];
        return okJson({ success: true, learningFile: fixtures.files[0] });
      }
      if (value.endsWith('/api/learning-files/upload') && options.method === 'POST') {
        fixtures.files = [{
          id: 77,
          title: 'addition-quiz',
          file_name: 'addition-quiz.json',
          grade_level: 'Grade 1',
          difficulty: 'Medium',
          math_topic: 'Addition, Multiplication, and Word Problems',
          file_type: 'fixed_questions',
          published: false,
        }];
        return okJson({ success: true, learningFile: fixtures.files[0] });
      }
      if (value.includes('/api/questions/publish/77') && options.method === 'POST') {
        if (fixtures.publishResponse) return fixtures.publishResponse(options);
        fixtures.files = fixtures.files.map((file) => (
          file.id === 77 ? { ...file, published: true } : file
        ));
        return okJson({ success: true, message: 'Content pushed to game.', learningFile: fixtures.files[0] });
      }
      if (value.includes('/api/questions/unpublish/77') && options.method === 'POST') {
        fixtures.files = fixtures.files.map((file) => (
          file.id === 77
            ? {
              ...file,
              published: false,
              publish_status: 'staged',
              lifecycle: { label: 'Approved', tone: 'approved', publishLabel: 'Not in Game' },
            }
            : file
        ));
        return okJson({ success: true, message: 'Content removed from game.', learningFile: fixtures.files[0] });
      }
      const approvalMatch = value.match(/\/api\/learning-files\/(\d+)\/approve/);
      if (approvalMatch && options.method === 'POST') {
        if (fixtures.approvalResponse) return fixtures.approvalResponse(options);
        const approvedId = Number(approvalMatch[1]);
        fixtures.files = fixtures.files.map((file) => (
          file.id === approvedId
            ? {
              ...file,
              approval_status: 'approved',
              validation_summary: {
                ...file.validation_summary,
                publication_eligibility: { eligible: true, code: 'ELIGIBLE', message: 'Eligible for Game publication.' },
              },
            }
            : file
        ));
        const approvedFile = fixtures.files.find((file) => file.id === approvedId);
        return okJson({ success: true, learningFile: approvedFile, validation: approvedFile.validation_summary });
      }
      const questionPreviewMatch = value.match(/\/api\/learning-files\/(\d+)\/questions/);
      if (questionPreviewMatch) {
        const previewFileId = Number(questionPreviewMatch[1]);
        const currentFile = fixtures.files.find((file) => file.id === previewFileId);
        const isInvalid = currentFile?.validation_summary?.is_valid === false;
        return okJson({
          file: currentFile,
          validation: currentFile?.preview_validation || { is_valid: !isInvalid, invalid_question_count: isInvalid ? 1 : 0 },
          review_fingerprint: `review-${previewFileId}-${currentFile?.approval_status || 'pending'}`,
          questions: Array.from({ length: 5 }, (_, index) => ({
            id: (previewFileId * 10) + index,
            question: index === 0 ? 'What is 2 + 3?' : `Question ${index + 1} for preview ${previewFileId}`,
            options: isInvalid ? ['4', '5', '6'] : ['4', '5', '6', '7'],
            correct_answer: '5',
            published: false,
            is_valid: !isInvalid,
            validation_errors: isInvalid ? ['Exactly four answer choices are required.'] : [],
          })),
        });
      }
      if (value.includes('/api/learning-files/77') && options.method === 'DELETE') {
        fixtures.files = fixtures.files.filter((file) => file.id !== 77);
        return okJson({ success: true });
      }
      return okJson([]);
    });
  });

  afterEach(() => {
    act(() => clearPreparedReport());
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
    delete global.IntersectionObserver;
  });

  test('Fixed Question and Lesson uploads require Grade and Difficulty without a Topic selector', async () => {
    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await act(async () => {
      clickByText(container, 'New');
    });
    await act(async () => {
      clickByText(container, 'Upload File');
    });

    const selects = getUploadModalSelects();

    expect(document.body.textContent).toContain('Grade 1');
    expect(document.body.textContent).toContain('Grade 2');
    expect(document.body.textContent).toContain('Grade 6');
    expect(document.body.textContent).not.toContain('Grade 1-2');
    expect(document.body.textContent).toContain('Difficulty');
    expect(getUploadModal().textContent).not.toContain('Topic');
    expect(selects).toHaveLength(3);

    await act(async () => {
      setSelectValue(selects[0], 'Grade 3');
      setSelectValue(selects[1], 'Normal');
    });

    expect(document.body.textContent).toContain('Normal');
    expect(getUploadModal().querySelector('.fixed-destination-display').textContent.trim()).toBe('Questions/Grade 3/Normal');
    expect(document.body.textContent).not.toContain('Select Folder');
    expect(document.body.textContent).not.toContain('New Folder');
    expect(document.body.textContent).toContain('Lesson PDF or PPTX File');
    expect(document.body.textContent).toContain('Fixed Question File');
    await act(async () => {
      setSelectValue(getUploadModalSelects()[2], 'lesson');
    });

    expect(getUploadModal().textContent).not.toContain('Topic');
    expect(getUploadModalSelects()).toHaveLength(4);
  });

  test('renders the upload dialog in a viewport portal and removes it when cancelled', async () => {
    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await act(async () => {
      clickByText(container, 'New');
    });
    await act(async () => {
      clickByText(container, 'Upload File');
    });

    const backdrop = Array.from(document.body.children).find((element) => (
      element.classList.contains('manager-modal-backdrop')
    ));
    expect(backdrop).toBeTruthy();
    expect(backdrop.parentElement).toBe(document.body);
    expect(backdrop.querySelector('.drive-upload-modal')).toBeTruthy();

    await act(async () => {
      const cancelButton = Array.from(backdrop.querySelectorAll('button')).find((button) => button.textContent === 'Cancel');
      cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.querySelector('.manager-modal-backdrop')).toBeNull();
  });

  test('uses the existing session token for Lesson and Question Manager API requests', async () => {
    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/learning-files', {
      headers: { Authorization: 'Bearer lesson-manager-token' },
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/learning-files/trash', {
      headers: { Authorization: 'Bearer lesson-manager-token' },
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/learning-files/storage-summary', {
      headers: { Authorization: 'Bearer lesson-manager-token' },
    });
    expect(container.querySelector('.drive-manager-toolbar')).toBeTruthy();
    expect(container.querySelector('.drive-manager-sidebar')).toBeNull();
  });

  test('uses explicit Teacher scope for Parent/Teacher Lesson Manager API requests', async () => {
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 9, role: 'parent_teacher', name: 'Parent Teacher User' }));

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/learning-files?scope=teacher', {
      headers: { Authorization: 'Bearer lesson-manager-token' },
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/learning-files/trash?scope=teacher', {
      headers: { Authorization: 'Bearer lesson-manager-token' },
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/learning-files/storage-summary?scope=teacher', {
      headers: { Authorization: 'Bearer lesson-manager-token' },
    });
  });

  test('opens the same structured read-only question preview from a DOCX filename as from the Preview action', async () => {
    fixtures.files = [{
      id: 77,
      title: 'basic-addition.docx',
      file_name: 'basic-addition.docx',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Basic Addition',
      file_type: 'fixed_questions',
      published: false,
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await act(async () => {
      clickByText(container, 'basic-addition.docx');
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/learning-files/77/questions', {
      headers: { Authorization: 'Bearer lesson-manager-token' },
    });
    expect(global.fetch).not.toHaveBeenCalledWith('/api/learning-files/77/preview', expect.anything());
    expect(document.body.textContent).toContain('Question Review');
    expect(document.body.textContent).toContain('What is 2 + 3?');
    expect(document.body.textContent).toContain('Grade 1 · Easy');
    expect(document.body.textContent).not.toContain('Grade Grade 1');
  });

  test('requires a teacher to explicitly confirm server-reported same-scope Active replacement', async () => {
    fixtures.files = [{
      id: 77,
      title: 'replacement-addition.docx',
      file_name: 'replacement-addition.docx',
      grade_level: 'Grade 1',
      difficulty: 'Normal',
      math_topic: 'Addition',
      file_type: 'fixed_questions',
      published: false,
      validation_summary: {
        is_valid: true,
        invalid_question_count: 0,
        publication_eligibility: { eligible: true, code: 'ELIGIBLE', message: 'Eligible for Game publication.' },
      },
    }];
    fixtures.publishResponse = (options) => {
      if (options.body) return okJson({ success: true, message: 'Content pushed to game.' });
      return errorJson({
        code: 'ACTIVE_SET_REPLACEMENT_CONFIRMATION_REQUIRED',
        replacement: {
          current_active: { id: 8, title: 'Current Addition', grade_level: 'Grade 1', difficulty: 'Normal', math_topic: 'Addition', question_count: 5 },
          new_set: { id: 77, title: 'replacement-addition.docx', grade_level: 'Grade 1', difficulty: 'Normal', math_topic: 'Addition', question_count: 5 },
        },
      });
    };

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await act(async () => {
      clickByText(container, 'Push to Game');
    });

    expect(document.body.textContent).toContain('Replace Active Question Set?');
    expect(document.body.textContent).toContain('Current Addition');
    expect(document.body.textContent).toContain('replacement-addition.docx');
    expect(global.fetch).toHaveBeenCalledTimes(6);

    await act(async () => {
      clickByText(document.body, 'Cancel');
    });
    expect(global.fetch).toHaveBeenCalledTimes(6);

    await act(async () => {
      clickByText(container, 'Push to Game');
    });
    await act(async () => {
      clickByText(document.body, 'Replace & Push to Game');
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/questions/publish/77', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer lesson-manager-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ confirm_replacement: true }),
    });
  });

  test('Question Count is required only for Lesson PDF or PPTX uploads and is hidden for fixed question files', async () => {
    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await act(async () => {
      clickByText(container, 'New');
    });
    await act(async () => {
      clickByText(container, 'Upload File');
    });

    expect(getUploadModal().textContent).not.toContain('Question Count');
    const selects = getUploadModalSelects();
    await act(async () => {
      setSelectValue(selects[2], 'lesson');
    });

    const countField = document.body.querySelector('input[name="expected_question_count"]');
    expect(document.body.textContent).toContain('Question Count');
    expect(countField).toBeTruthy();
    expect(countField.required).toBe(true);
    expect(countField.min).toBe('1');
    expect(countField.max).toBe('50');

    await act(async () => {
      setSelectValue(selects[0], 'Grade 1');
      setSelectValue(selects[1], 'Easy');
      setSelectValue(getUploadModalSelects()[3], 'Basic Addition');
      const fileInput = document.body.querySelector('input[type="file"]');
      const file = new File(['%PDF-1.4 lesson'], 'addition-lesson.pdf', { type: 'application/pdf' });
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      getUploadModal().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(document.body.textContent).toContain('Question Count is required for Lesson PDF or PPTX files.');
    expect(global.fetch).not.toHaveBeenCalledWith('/api/learning-files/upload', expect.anything());
  });

  test('sends one stable idempotency key for a Lesson PDF submit and blocks a duplicate immediate submit', async () => {
    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await act(async () => {
      clickByText(container, 'New');
    });
    await act(async () => {
      clickByText(container, 'Upload File');
    });

    await act(async () => {
      setSelectValue(getUploadModalSelects()[2], 'lesson');
      const selects = getUploadModalSelects();
      setSelectValue(selects[0], 'Grade 1');
      setSelectValue(selects[1], 'Easy');
      setSelectValue(selects[3], 'Basic Addition');
      const countField = document.body.querySelector('input[name="expected_question_count"]');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(countField, '2');
      countField.dispatchEvent(new Event('change', { bubbles: true }));
      const fileInput = document.body.querySelector('input[type="file"]');
      const file = new File(['%PDF-1.4 lesson'], 'addition-lesson.pdf', { type: 'application/pdf' });
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      getUploadModal().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      getUploadModal().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const lessonRequests = global.fetch.mock.calls.filter(([url, options]) => (
      String(url).endsWith('/api/learning-files/upload') && options?.method === 'POST'
    ));
    expect(lessonRequests).toHaveLength(1);
    expect(lessonRequests[0][1].headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer lesson-manager-token',
      'Idempotency-Key': expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
    }));
  });

  test('reuses a Lesson PDF source to generate an independent exact-scope child set', async () => {
    fixtures.lessonSources = [{
      id: 701,
      title: 'Reusable arithmetic lesson',
      file_name: 'reusable.pdf',
      file_url: '/uploads/reusable.pdf',
      content_role: 'lesson_source',
      generated_child_count: 1,
    }];
    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await act(async () => {
      clickByText(container, 'New');
    });
    await act(async () => {
      clickByText(container, 'Upload File');
    });

    await act(async () => {
      setSelectValue(getUploadModalSelects()[2], 'lesson');
      setSelectValue(getUploadModalSelects()[0], 'Grade 1');
      setSelectValue(getUploadModalSelects()[1], 'Easy');
      setSelectValue(getUploadModalSelects()[3], '701');
      const countField = document.body.querySelector('input[name="expected_question_count"]');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(countField, '5');
      countField.dispatchEvent(new Event('change', { bubbles: true }));
      getUploadModal().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const generationRequest = global.fetch.mock.calls.find(([url, options]) => (
      String(url).includes('/api/learning-files/lesson-sources/701/generate') && options?.method === 'POST'
    ));
    expect(generationRequest).toBeTruthy();
    expect(JSON.parse(generationRequest[1].body)).toEqual({
      grade_level: 'Grade 1',
      difficulty: 'Easy',
        expected_question_count: '5',
    });
    expect(generationRequest[1].headers).toEqual(expect.objectContaining({
      'Idempotency-Key': expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
    }));
  });

  test('prioritizes DOCX and PDF documents for Teacher Fixed Questions uploads', async () => {
    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await act(async () => {
      clickByText(container, 'New');
    });
    await act(async () => {
      clickByText(container, 'Upload File');
    });

    const fileInput = document.body.querySelector('input[type="file"]');
    expect(fileInput.accept).toContain('.docx');
    expect(fileInput.accept).toContain('.pdf');
    expect(getUploadModal().textContent).toContain('Fixed Questions supported: DOCX, PDF');
  });

  test('restores a trashed file and reports the requested success message', async () => {
    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await act(async () => {
      clickByText(container, 'Trash Bin');
    });

    await act(async () => {
      clickByText(container, 'Restore');
    });

    expect(container.textContent).toContain('File restored successfully');
    expect(container.textContent).not.toContain('Deleted Quiz');
  });

  test('adds a successful upload to My Files immediately and closes the modal', async () => {
    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await act(async () => {
      clickByText(container, 'New');
    });
    await act(async () => {
      clickByText(container, 'Upload File');
    });

    const selects = getUploadModalSelects();
    const fileInput = document.body.querySelector('input[type="file"]');
    const file = new File([JSON.stringify([{ question: '1 + 1?', correct_answer: '2' }])], 'addition-quiz.json', {
      type: 'application/json',
    });

    await act(async () => {
      setSelectValue(selects[0], 'Grade 1');
      setSelectValue(selects[1], 'Normal');
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      getUploadModal().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('File uploaded successfully');
    expect(container.textContent).toContain('addition-quiz');
    expect(container.textContent).toContain('Normal');
    expect(container.textContent).toContain('Pending');
    expect(getUploadModal()).toBeNull();
    const uploadRequest = global.fetch.mock.calls.find(([url, options]) => (
      String(url).endsWith('/api/learning-files/upload') && options?.method === 'POST'
    ));
    expect(uploadRequest[1].body.get('math_topic')).toBeNull();
    expect(uploadRequest[1].body.get('topic_id')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/questions/publish/77'), expect.anything());
  });

  test('upload table hides Uploaded By and exposes Preview, Delete, and Push to Game actions', async () => {
    fixtures.files = [{
      id: 77,
      title: 'addition-quiz',
      file_name: 'addition-quiz.json',
      file_url: '/uploads/addition-quiz.json',
      grade_level: 'Grade 1',
      difficulty: 'Medium',
      math_topic: 'Addition',
      file_type: 'fixed_questions',
      published: false,
      uploaded_by_name: 'Teacher User',
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await openQuestionFolder(container, 'Grade 1', 'Normal');

    expect(container.textContent).not.toContain('Uploaded by');
    expect(container.textContent).not.toContain('Teacher User');
    expect(container.textContent).toContain('Preview');
    expect(container.textContent).toContain('Delete');
    expect(container.textContent).toContain('Push to Game');
  });

  test('keeps publication topics out of generic screen and printable table columns', async () => {
    fixtures.files = [
      {
        id: 77,
        title: 'grade-1-mixed-review.docx',
        file_name: 'grade-1-mixed-review.docx',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        document_topic: 'Basic Addition, Subtraction, Shapes, and Place Value',
        math_topic: null,
        file_type: 'fixed_questions',
        question_count: 5,
        published: false,
        validation_summary: { is_valid: true, invalid_question_count: 0 },
      },
      {
        id: 78,
        title: 'basic-addition-lesson.pdf',
        file_name: 'basic-addition-lesson.pdf',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
        file_type: 'lesson',
        question_count: 5,
        published: false,
      },
    ];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');

    expect(container.textContent).not.toContain('Game Publication Topic');
    expect(document.body.textContent).not.toContain('Topic Identifier');
    expect(container.textContent).toContain('Source topic metadata (optional): Basic Addition');
    expect(container.textContent).not.toContain('Unknown topic');
    expect(container.querySelectorAll('.drive-table .data-table-th')).toHaveLength(7);
  });

  test('shows authoritative source and game-fetch metadata for an active question set', async () => {
    fixtures.files = [{
      id: 77,
      title: 'addition-quiz',
      file_name: 'addition-quiz.json',
      grade_level: 'Grade 1',
      difficulty: 'Medium',
      math_topic: 'Addition',
      file_type: 'fixed_questions',
      published: true,
      lifecycle: { label: 'Active in Game', tone: 'active', publishLabel: 'Active in Game' },
      source_label: 'Client Provided',
      last_fetched_at: '2026-08-16T02:51:00.000Z',
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Normal');

    expect(container.textContent).toContain('Active in Game');
    expect(container.textContent).toContain('Client Provided');
    expect(container.textContent).toContain('Last Game Fetch:');
    const renameButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes('Rename'));
    expect(renameButton.disabled).toBe(true);
    expect(renameButton.title).toContain('Remove from Game before editing this question set');
    const deleteButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes('Delete'));
    expect(deleteButton.disabled).toBe(true);
    expect(deleteButton.title).toContain('Remove from Game before deleting this question set');
  });

  test('an active set can be removed from Game only through an explicit confirmation', async () => {
    fixtures.files = [{
      id: 77,
      title: 'approved-addition-set',
      file_name: 'approved-addition-set.json',
      grade_level: 'Grade 1',
      difficulty: 'Normal',
      file_type: 'fixed_questions',
      published: true,
      publish_status: 'active',
      approval_status: 'approved',
      lifecycle: { label: 'Active in Game', tone: 'active', publishLabel: 'Active in Game' },
      validation_summary: {
        is_valid: true,
        publication_eligibility: { eligible: true, code: 'ELIGIBLE', message: 'Eligible for Game publication.' },
      },
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Normal');

    const actionLabels = Array.from(container.querySelectorAll('.drive-row-actions button'))
      .map((button) => button.textContent.trim());
    expect(actionLabels).toContain('Remove from Game');
    expect(actionLabels).not.toContain('Push to Game');

    await act(async () => {
      clickByText(container, 'Remove from Game');
    });

    expect(document.body.textContent).toContain('Remove this question set from the game?');
    expect(document.body.textContent).toContain('Players will no longer receive questions from this set.');
    await act(async () => {
      clickByText(document.body, 'Confirm Remove from Game');
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/questions/unpublish/77', {
      method: 'POST',
      headers: { Authorization: 'Bearer lesson-manager-token' },
    });
    expect(container.textContent).toContain('Approved');
    expect(container.textContent).toContain('Not in Game');
    expect(container.textContent).toContain('Push to Game');
  });

  test('empty trash uses the single atomic bulk-delete contract', async () => {
    window.confirm = jest.fn(() => true);
    fixtures.trashFiles = [
      { id: 31, title: 'Deleted Quiz', file_name: 'deleted.csv', deleted_at: '2026-05-20T00:00:00.000Z' },
      { id: 32, title: 'Deleted Review', file_name: 'deleted.docx', deleted_at: '2026-05-20T00:00:00.000Z' },
    ];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await act(async () => {
      clickByText(container, 'Trash Bin');
    });
    await act(async () => {
      clickByText(container, 'Empty Trash');
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/learning-files/trash', {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer lesson-manager-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file_ids: [31, 32] }),
    });
  });

  test('Lesson PDF Preview shows staged generated questions before Push to Game', async () => {
    fixtures.files = [{
      id: 77,
      title: 'addition-lesson',
      file_name: 'addition-lesson.pdf',
      file_url: '/uploads/addition-lesson.pdf',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Basic Addition',
      file_type: 'lesson',
      question_count: 1,
      published: false,
      validation_summary: {
        is_valid: true,
        invalid_question_count: 0,
        publication_eligibility: { eligible: true, code: 'ELIGIBLE', message: 'Eligible for Game publication.' },
      },
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');

    await act(async () => {
      clickByText(container, 'Preview');
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/learning-files/77/questions', {
      headers: { Authorization: 'Bearer lesson-manager-token' },
    });
    expect(document.body.textContent).toContain('Question Review');
    expect(document.body.textContent).toContain('What is 2 + 3?');
    expect(document.body.textContent).toContain('5 (Correct)');
    expect(document.body.textContent).toContain('ready for manual Push to Game');
  });

  test('requires the final question sentinel in the inner Preview scroll container before Approve', async () => {
    fixtures.files = [buildReviewRequiredFile()];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');
    await act(async () => {
      clickByText(container, 'Preview');
    });

    const approveButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Approve');
    const previewBody = document.body.querySelector('.generated-questions-preview-body');
    const sentinel = document.body.querySelector('[data-testid="final-question-review-sentinel"]');
    expect(approveButton.disabled).toBe(true);
    expect(sentinel).toBeTruthy();
    expect(previewObservers).toHaveLength(1);
    expect(previewObservers[0].options.root).toBe(previewBody);
    expect(previewObservers[0].target).toBe(sentinel);
    expect(document.body.querySelector('input[type="checkbox"]')).toBeNull();

    await act(async () => {
      previewObservers[0].callback([{ target: sentinel, isIntersecting: true }]);
    });
    expect(approveButton.disabled).toBe(false);

    await act(async () => {
      clickByText(document.body, 'Close');
      clickByText(container, 'Preview');
    });
    const reopenedApproveButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Approve');
    expect(reopenedApproveButton.disabled).toBe(true);
  });

  test('shows structured fixed-question validation feedback and disables Push to Game for an invalid set', async () => {
    fixtures.files = [{
      id: 77,
      title: 'three-choice-fixed-document',
      file_name: 'three-choice-fixed-document.docx',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Basic Addition',
      file_type: 'fixed_questions',
      published: false,
      validation_summary: {
        is_valid: false,
        invalid_question_count: 1,
        publication_eligibility: { eligible: false, code: 'STRUCTURAL_VALIDATION_FAILED', message: 'Review and correct this question set before Push to Game.' },
      },
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');

    const pushButton = Array.from(container.querySelectorAll('button')).find((button) => (
      button.textContent.includes('Push to Game') || button.textContent.includes('Not Eligible for Game')
    ));
    expect(pushButton.disabled).toBe(true);

    await act(async () => {
      clickByText(container, 'Preview');
    });

    expect(document.body.textContent).toContain('Question Review');
    expect(document.body.textContent).toContain('Needs Correction');
    expect(document.body.textContent).toContain('Exactly four answer choices are required.');
  });

  test('does not turn legacy Topic scope diagnostics into Preview blockers', async () => {
    fixtures.files = [{
      id: 77,
      title: 'addition-with-subtraction.docx',
      file_name: 'addition-with-subtraction.docx',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Basic Addition',
      file_type: 'fixed_questions',
      published: false,
      validation_summary: {
        is_valid: true,
        invalid_question_count: 0,
        publication_eligibility: {
          eligible: false,
          code: 'QUESTION_TOPIC_MISMATCH',
          message: 'Question 2 conflicts with selected Topic: Basic Addition.',
        },
      },
      preview_validation: {
        is_valid: true,
        invalid_question_count: 0,
        scope_validation: {
          isValid: false,
          code: 'QUESTION_TOPIC_MISMATCH',
          question_errors: [{
            source_index: 2,
            code: 'QUESTION_TOPIC_MISMATCH',
            message: 'Question 2 conflicts with selected Topic: Basic Addition.',
          }],
        },
      },
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');
    await act(async () => {
      clickByText(container, 'Preview');
    });

    const previewCards = document.body.querySelectorAll('.generated-question-card');
    expect(previewCards[1].classList).toContain('valid');
    expect(previewCards[1].textContent).not.toContain('Question 2 conflicts with selected Topic: Basic Addition.');
  });

  test('keeps optional source metadata informational when a Fixed Question source has composite headings', async () => {
    fixtures.files = [{
      id: 77,
      title: 'grade-1-foundations.docx',
      file_name: 'grade-1-foundations.docx',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      document_topic: 'Basic Addition, Subtraction, Shapes, and Place Value',
      math_topic: 'Shapes',
      file_type: 'fixed_questions',
      published: false,
      validation_summary: {
        is_valid: true,
        invalid_question_count: 0,
        publication_eligibility: { eligible: true, code: 'ELIGIBLE', message: 'Eligible for Game publication.' },
      },
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');

    expect(container.textContent).not.toContain('Unknown topic');
    const pushButton = Array.from(container.querySelectorAll('button')).find((button) => (
      button.textContent.includes('Not Eligible for Game') || button.textContent.includes('Push to Game')
    ));
    expect(pushButton.disabled).toBe(false);
    expect(pushButton.textContent).toContain('Push to Game');

    await act(async () => {
      clickByText(container, 'Preview');
    });

    expect(document.body.textContent).toContain('Source topic metadata (optional): Shapes');
    expect(document.body.textContent).toContain('Source document topic (informational): Basic Addition, Subtraction, Shapes, and Place Value');
    expect(document.body.textContent).toContain('Game Publication: Eligible — Ready for Game');
    expect(document.body.textContent).not.toContain('Needs Correction');
    expect(document.body.textContent).toContain('ready for manual Push to Game');
    expect(document.body.querySelector('.generated-questions-preview-header')).toBeTruthy();
    expect(document.body.querySelector('.generated-questions-preview-body')).toBeTruthy();
    expect(document.body.querySelector('.generated-questions-preview-footer')).toBeTruthy();
    expect(document.body.querySelector('.generated-questions-preview-footer').textContent).toContain('Download Source');
    expect(document.body.querySelector('.generated-questions-preview-footer').textContent).toContain('Close');
  });

  test('does not expose a legacy deterministic Topic conflict as a publication blocker', async () => {
    fixtures.files = [{
      id: 77,
      title: 'uncontrolled-topic.docx',
      file_name: 'uncontrolled-topic.docx',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Basic Addition',
      file_type: 'fixed_questions',
      published: false,
      validation_summary: {
        is_valid: true,
        invalid_question_count: 0,
        publication_eligibility: {
          eligible: false,
          code: 'DETERMINISTIC_SCOPE_CONFLICT',
          message: 'Question 4 conflicts with selected Topic: Basic Addition.',
        },
      },
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');

    expect(container.textContent).not.toContain('Question 4 conflicts with selected Topic: Basic Addition.');
    const pushButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes('Push to Game'));
    expect(pushButton.disabled).toBe(false);
  });

  test('keeps Push to Game available for a valid single-topic Fixed Question document', async () => {
    fixtures.files = [{
      id: 77,
      title: 'basic-addition.docx',
      file_name: 'basic-addition.docx',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      document_topic: 'Basic Addition',
      math_topic: 'Basic Addition',
      file_type: 'fixed_questions',
      published: false,
      validation_summary: {
        is_valid: true,
        invalid_question_count: 0,
        publication_eligibility: { eligible: true, code: 'ELIGIBLE', message: 'Eligible for Game publication.' },
      },
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');

    const pushButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes('Push to Game'));
    expect(pushButton.disabled).toBe(false);

    await act(async () => {
      clickByText(container, 'Preview');
    });

    expect(document.body.textContent).toContain('Game Publication: Eligible — Ready for Game');
  });

  test('uses an explicit fixed-header, scrollable-body, fixed-footer Preview shell', async () => {
    fixtures.files = [{
      id: 77,
      title: 'preview-layout.docx',
      file_name: 'preview-layout.docx',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      document_topic: 'Basic Addition',
      math_topic: 'Basic Addition',
      file_type: 'fixed_questions',
      published: false,
      file_url: '/uploads/preview-layout.docx',
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');
    await act(async () => {
      clickByText(container, 'Preview');
    });

    const modal = document.body.querySelector('.generated-questions-preview-modal');
    expect(modal.querySelector('.generated-questions-preview-header')).toBeTruthy();
    expect(modal.querySelector('.generated-questions-preview-body')).toBeTruthy();
    expect(modal.querySelector('.generated-questions-preview-footer')).toBeTruthy();
    expect(modal.querySelector('.generated-questions-preview-footer').textContent).toContain('Download Source');
    expect(modal.querySelector('.generated-questions-preview-footer').textContent).toContain('Close');

    const downloadButton = Array.from(modal.querySelectorAll('button')).find((button) => button.textContent.includes('Download Source'));
    const closeButton = Array.from(modal.querySelectorAll('button')).find((button) => button.textContent === 'Close');
    expect(downloadButton.disabled).toBe(false);

    const anchorClick = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await act(async () => {
      downloadButton.click();
    });
    expect(anchorClick).toHaveBeenCalledTimes(1);
    anchorClick.mockRestore();

    await act(async () => {
      closeButton.click();
    });
    expect(document.body.querySelector('.generated-questions-preview-modal')).toBeNull();
  });

  test('ports Preview to the viewport and restores the dashboard scroll position after Close', async () => {
    fixtures.files = [{
      id: 77,
      title: 'viewport-preview.docx',
      file_name: 'viewport-preview.docx',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      document_topic: 'Basic Addition',
      math_topic: 'Basic Addition',
      file_type: 'fixed_questions',
      published: false,
      file_url: '/uploads/viewport-preview.docx',
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    const pageContent = container.querySelector('.page-content');
    pageContent.scrollTop = 215;
    await openQuestionFolder(container, 'Grade 1', 'Easy');

    await act(async () => {
      clickByText(container, 'Preview');
    });

    const previewBackdrop = document.body.querySelector('.generated-questions-preview-backdrop');
    const previewBody = document.body.querySelector('.generated-questions-preview-body');
    const firstQuestion = previewBody.querySelector('.generated-question-card');

    expect(previewBackdrop.parentElement).toBe(document.body);
    expect(document.body.classList.contains('lesson-preview-open')).toBe(true);
    expect(pageContent.classList.contains('lesson-preview-scroll-locked')).toBe(true);
    expect(pageContent.scrollTop).toBe(215);
    expect(previewBody.scrollTop).toBe(0);
    expect(firstQuestion.querySelector('strong').textContent).toBe('1. What is 2 + 3?');

    await act(async () => {
      Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Close').click();
    });

    expect(document.body.classList.contains('lesson-preview-open')).toBe(false);
    expect(pageContent.classList.contains('lesson-preview-scroll-locked')).toBe(false);
    expect(pageContent.scrollTop).toBe(215);
  });

  test('resets Preview body scroll position when reopening or switching files', async () => {
    fixtures.files = [
      {
        id: 77,
        title: 'preview-one.docx',
        file_name: 'preview-one.docx',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        document_topic: 'Basic Addition',
        math_topic: 'Basic Addition',
        file_type: 'fixed_questions',
        published: false,
        file_url: '/uploads/preview-one.docx',
      },
      {
        id: 78,
        title: 'preview-two.docx',
        file_name: 'preview-two.docx',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        document_topic: 'Basic Addition',
        math_topic: 'Basic Addition',
        file_type: 'fixed_questions',
        published: false,
        file_url: '/uploads/preview-two.docx',
      },
    ];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');

    const previewButtons = Array.from(container.querySelectorAll('button')).filter((button) => button.textContent.includes('Preview'));
    expect(previewButtons).toHaveLength(2);

    await act(async () => {
      previewButtons[0].click();
    });

    let previewBody = document.body.querySelector('.generated-questions-preview-body');
    expect(previewBody.scrollTop).toBe(0);
    expect(Array.from(previewBody.querySelectorAll('.generated-question-card strong')).map((heading) => heading.textContent)).toEqual([
      '1. What is 2 + 3?',
      '2. Question 2 for preview 77',
      '3. Question 3 for preview 77',
      '4. Question 4 for preview 77',
      '5. Question 5 for preview 77',
    ]);
    previewBody.scrollTop = 180;

    await act(async () => {
      Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Close').click();
    });
    expect(document.body.querySelector('.generated-questions-preview-modal')).toBeNull();

    await act(async () => {
      previewButtons[0].click();
    });
    previewBody = document.body.querySelector('.generated-questions-preview-body');
    expect(previewBody.scrollTop).toBe(0);
    expect(previewBody.querySelector('.generated-question-card strong').textContent).toBe('1. What is 2 + 3?');
    previewBody.scrollTop = 180;

    await act(async () => {
      Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Close').click();
    });
    expect(document.body.querySelector('.generated-questions-preview-modal')).toBeNull();

    await act(async () => {
      previewButtons[1].click();
    });
    expect(document.body.textContent).toContain('preview-two.docx');
    previewBody = document.body.querySelector('.generated-questions-preview-body');
    expect(previewBody.scrollTop).toBe(0);
    expect(previewBody.querySelector('.generated-question-card strong').textContent).toBe('1. What is 2 + 3?');
  });

  test('Push to Game activates the staged file only after the button is clicked', async () => {
    fixtures.files = [{
      id: 77,
      title: 'addition-quiz',
      file_name: 'addition-quiz.json',
      file_url: '/uploads/addition-quiz.json',
      grade_level: 'Grade 1',
      difficulty: 'Medium',
      math_topic: 'Addition',
      file_type: 'fixed_questions',
      published: false,
      validation_summary: {
        is_valid: true,
        invalid_question_count: 0,
        publication_eligibility: { eligible: true, code: 'ELIGIBLE', message: 'Eligible for Game publication.' },
      },
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await openQuestionFolder(container, 'Grade 1', 'Normal');

    expect(container.textContent).toContain('Pending');
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/questions/publish/77'), expect.anything());

    await act(async () => {
      clickByText(container, 'Push to Game');
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/questions/publish/77', {
      method: 'POST',
      headers: { Authorization: 'Bearer lesson-manager-token' },
    });
    expect(container.textContent).toContain('Active in Game');
  });

  test('shows persisted ready-for-review and publish lifecycle states without treating them as active', async () => {
    fixtures.files = [{
      id: 88,
      title: 'fractions-lesson',
      generated_question_set_name: 'fractions-lesson — Generated Questions',
      source_lesson: 'fractions.pdf',
      file_name: 'fractions.pdf',
      grade_level: 'Grade 3',
      difficulty: 'Medium',
      math_topic: 'Fractions',
      file_type: 'lesson',
      question_count: 3,
      generation_status: 'ready_for_review',
      publish_status: 'staged',
      lifecycle: { label: 'Ready for Review', tone: 'review', publishLabel: 'Staged' },
      published: false,
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    const gradeThreeCard = Array.from(container.querySelectorAll('.fixed-question-folder'))
      .find((card) => card.querySelector('.system-grade-button')?.textContent.includes('Grade 3'));
    await act(async () => {
      gradeThreeCard.querySelector('.system-grade-button').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      Array.from(gradeThreeCard.querySelectorAll('.system-difficulty-button'))
        .find((button) => button.textContent.trim() === 'Normal')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Ready for Review');
    expect(container.textContent).toContain('Pending');
    expect(container.textContent).not.toContain('Staged');
    expect(container.textContent).toContain('Source Lesson: fractions.pdf');
    expect(container.textContent).not.toContain('Active in Game');
  });

  test('Delete removes a staged upload from the table', async () => {
    window.confirm = jest.fn(() => true);
    fixtures.files = [{
      id: 77,
      title: 'addition-quiz',
      file_name: 'addition-quiz.json',
      file_url: '/uploads/addition-quiz.json',
      grade_level: 'Grade 1',
      difficulty: 'Medium',
      math_topic: 'Addition',
      file_type: 'fixed_questions',
      published: false,
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await openQuestionFolder(container, 'Grade 1', 'Normal');

    await act(async () => {
      clickByText(container, 'Delete');
    });

    expect(container.textContent).not.toContain('addition-quiz');
  });

  test('keeps the Lesson Manager mounted while a delete refreshes in place', async () => {
    window.confirm = jest.fn(() => true);
    fixtures.files = [{
      id: 77,
      title: 'addition-quiz',
      file_name: 'addition-quiz.json',
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Basic Addition',
      file_type: 'fixed_questions',
      published: false,
    }];
    const originalFetch = global.fetch;
    let learningFilesRequests = 0;
    let resolveRefresh;
    global.fetch = jest.fn((url, options = {}) => {
      if (String(url).endsWith('/api/learning-files') && !options.method) {
        learningFilesRequests += 1;
        if (learningFilesRequests === 2) {
          return new Promise((resolve) => {
            resolveRefresh = () => resolve(okJson([]));
          });
        }
      }
      return originalFetch(url, options);
    });

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');

    await act(async () => {
      clickByText(container, 'Delete');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolveRefresh).toBeDefined();
    expect(container.querySelector('.question-folder-panel')).toBeTruthy();
    expect(container.querySelector('.dashboard-inline-loading')).toBeNull();

    await act(async () => {
      resolveRefresh();
    });
  });

  test('shows a truthful empty state without static question rows', async () => {
    fixtures.files = [];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    expect(container.textContent).toContain('No question files available yet.');
    expect(container.querySelectorAll('.drive-table tbody tr')).toHaveLength(1);
    expect(container.textContent).not.toContain('addition-quiz');
  });

  test('fixed system folder cards filter files by grade and difficulty without leaving the structure', async () => {
    fixtures.files = [
      {
        id: 77,
        title: 'addition-quiz',
        file_name: 'addition-quiz.json',
        file_url: '/uploads/addition-quiz.json',
        grade_level: 'Grade 1',
        difficulty: 'Easy',
        math_topic: 'Basic Addition',
        file_type: 'fixed_questions',
        published: false,
        uploaded_at: '2026-06-01T00:00:00.000Z',
      },
      {
        id: 78,
        title: 'medium-quiz',
        file_name: 'medium-quiz.json',
        grade_level: 'Grade 1',
        difficulty: 'Medium',
        math_topic: 'Addition',
        file_type: 'fixed_questions',
        published: true,
      },
      {
        id: 79,
        title: 'grade-two-easy',
        file_name: 'grade-two-easy.json',
        grade_level: 'Grade 2',
        difficulty: 'Easy',
        math_topic: 'Shapes',
        file_type: 'fixed_questions',
        published: false,
      },
    ];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    expect(container.textContent).toContain('Questions');
    expect(container.textContent).toContain('Selected Folder: Questions');
    expect(container.textContent).toContain('Grade 1');
    expect(container.textContent).toContain('Grade 6');
    expect(container.textContent).not.toContain('Grade1');
    expect(container.textContent).toContain('addition-quiz');
    expect(container.textContent).toContain('medium-quiz');
    expect(container.textContent).toContain('grade-two-easy');

    await act(async () => {
      clickByText(container, 'Grade 1');
    });

    expect(container.textContent).toContain('Selected Folder: Questions / Grade 1');
    expect(container.textContent).toContain('Easy');
    expect(container.textContent).toContain('Normal');
    expect(container.textContent).toContain('Difficult');
    expect(container.textContent).toContain('Grade 6');
    expect(container.textContent).toContain('addition-quiz');
    expect(container.textContent).toContain('medium-quiz');
    expect(container.textContent).not.toContain('grade-two-easy');

    await act(async () => {
      clickByText(container, 'Easy');
    });

    expect(container.textContent).toContain('Selected Folder: Questions / Grade 1 / Easy');
    expect(container.textContent).toContain('Currently Viewing: Grade 1 - Easy');
    expect(container.textContent).toContain('Grade 6');
    expect(container.textContent).toContain('addition-quiz');
    expect(container.textContent).not.toContain('Topic Identifier');
    expect(container.textContent).toContain('Fixed Question File');
    expect(container.textContent).toContain('Pending');
    expect(container.textContent).not.toContain('medium-quiz');
    expect(container.textContent).not.toContain('grade-two-easy');
    expect(container.textContent).toContain('Rename');
    expect(container.textContent).toContain('Preview');
    expect(container.textContent).toContain('Delete');
    expect(container.textContent).toContain('Push to Game');

    await act(async () => {
      clickByText(container, 'Difficult');
    });

    expect(container.textContent).toContain('Selected Folder: Questions / Grade 1 / Difficult');
    expect(container.textContent).toContain('No files available in Grade 1 - Difficult.');
  });

  test('paginates the filtered Question Library and offers a print-safe report', async () => {
    fixtures.files = Array.from({ length: 11 }, (_, index) => ({
      id: index + 100,
      title: `grade-one-easy-${index + 1}`,
      grade_level: 'Grade 1',
      difficulty: 'Easy',
      math_topic: 'Basic Addition',
      file_type: 'fixed_questions',
      question_count: 5,
      published: false,
    }));

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await openQuestionFolder(container, 'Grade 1', 'Easy');

    expect(container.querySelectorAll('.drive-table tbody tr')).toHaveLength(10);
    expect(container.textContent).toContain('Page 1 of 2');
    expect(container.querySelector('button[aria-label="Print Report"]')).not.toBeNull();
    let opened = false;
    act(() => { opened = openPreparedReport(); });
    expect(opened).toBe(true);
    expect(document.querySelectorAll('#print-report-root .printable-table-report tbody tr')).toHaveLength(11);
  });

  test('paginates the Trash Bin without exposing a separate destructive-item print flow', async () => {
    fixtures.trashFiles = Array.from({ length: 11 }, (_, index) => ({
      id: index + 300,
      title: `deleted-question-set-${index + 1}`,
      deleted_at: '2026-05-20T00:00:00.000Z',
    }));

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await act(async () => {
      clickByText(container, 'Trash Bin');
    });

    expect(container.querySelectorAll('.drive-table tbody tr')).toHaveLength(10);
    expect(container.textContent).toContain('Page 1 of 2');
    expect(container.querySelector('button[aria-label="Print Question Library Trash"]')).toBeNull();
  });

  test('shows Approve to each authorized Teacher-scope role from the authoritative review status', async () => {
    const authorizedRoles = [
      { id: 1, role: 'admin', name: 'Admin User' },
      { id: 8, role: 'teacher', name: 'Teacher User' },
      { id: 9, role: 'parent_teacher', name: 'Parent Teacher User' },
    ];

    for (const [index, account] of authorizedRoles.entries()) {
      fixtures.files = [buildReviewRequiredFile({
        validation_summary: {
          ...buildReviewRequiredFile().validation_summary,
          publication_eligibility: {
            eligible: false,
            code: 'STALE_PUBLICATION_SUMMARY',
            message: 'Approval is still required before publication.',
          },
        },
      })];
      localStorage.setItem('loggedInUser', JSON.stringify(account));
      localStorage.setItem('rememberToken', 'lesson-manager-token');

      await act(async () => {
        root.render(<LessonQuestionManager />);
      });
      await openQuestionFolder(container, 'Grade 1', 'Easy');
      await act(async () => {
        clickByText(container, 'Preview');
      });

      const approveButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Approve');
      expect(approveButton).toBeTruthy();
      expect(approveButton.disabled).toBe(true);
      await markPreviewAsReviewed();
      expect(approveButton.disabled).toBe(false);

      if (account.role === 'parent_teacher') {
        expect(global.fetch).toHaveBeenCalledWith('/api/learning-files/91/questions?scope=teacher', {
          headers: { Authorization: 'Bearer lesson-manager-token' },
        });
      }

      await act(async () => {
        Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Close').click();
      });

      if (index < authorizedRoles.length - 1) {
        await act(async () => {
          root.unmount();
        });
        root = createRoot(container);
      }
    }
  });

  test('shows disabled Approve with structural errors and no reviewed-checkbox control', async () => {
    fixtures.files = [buildReviewRequiredFile({
      validation_summary: {
        is_valid: false,
        invalid_question_count: 1,
        review_eligibility: {
          eligible: false,
          code: 'STRUCTURAL_VALIDATION_FAILED',
          message: 'Review and correct the structural question errors before approval.',
        },
        publication_eligibility: {
          eligible: false,
          code: 'STRUCTURAL_VALIDATION_FAILED',
          message: 'Review and correct this question set before Push to Game.',
        },
      },
    })];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');
    await act(async () => {
      clickByText(container, 'Preview');
    });

    const approveButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Approve');
    expect(approveButton).toBeTruthy();
    expect(approveButton.disabled).toBe(true);
    expect(document.body.querySelector('.question-review-confirmation')).toBeNull();
    expect(document.body.textContent).toContain('Needs Correction');
  });

  test('denies Parent and Student roles before any approval UI can render', async () => {
    const deniedRoles = ['parent', 'student'];

    for (const [index, role] of deniedRoles.entries()) {
      mockNavigate.mockClear();
      localStorage.setItem('loggedInUser', JSON.stringify({ id: index + 20, role, name: `${role} user` }));
      localStorage.setItem('rememberToken', 'lesson-manager-token');

      await act(async () => {
        root.render(<LessonQuestionManager />);
      });

      expect(mockNavigate).toHaveBeenCalledWith('/login');
      expect(container.querySelector('.drive-manager-toolbar')).toBeNull();
      expect(document.body.querySelector('.generated-questions-preview-modal')).toBeNull();

      if (index < deniedRoles.length - 1) {
        await act(async () => {
          root.unmount();
        });
        root = createRoot(container);
      }
    }
  });

  test('requires an explicit review approval before a valid question set can be pushed to the game', async () => {
    fixtures.files = [buildReviewRequiredFile()];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');

    const pushButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes('Push to Game'));
    expect(pushButton.disabled).toBe(true);

    await act(async () => {
      clickByText(container, 'Preview');
    });

    expect(document.body.textContent).toContain('Review required before Push to Game.');
    const previewModal = document.body.querySelector('.generated-questions-preview-modal');
    const footerControls = Array.from(previewModal.querySelectorAll('.generated-questions-preview-footer button')).map((button) => button.textContent.trim());
    expect(footerControls).toEqual(['Download Source', 'Approve', 'Close']);
    expect(previewModal.querySelector('[aria-label="Close generated questions preview"]')).toBeNull();
    const approveButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Approve');
    expect(approveButton).toBeTruthy();
    expect(approveButton.disabled).toBe(true);
    await markPreviewAsReviewed();
    expect(approveButton.disabled).toBe(false);
    expect(document.body.querySelector('.question-review-confirmation')).toBeNull();
    await act(async () => {
      approveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/learning-files/91/approve', {
      method: 'POST',
      headers: { Authorization: 'Bearer lesson-manager-token' },
    });
    expect(document.body.textContent).toContain('Game Publication: Eligible — Ready for Game');
    expect(document.body.querySelector('.generated-questions-preview-footer').textContent).not.toContain('Approve');
    const refreshedPushButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes('Push to Game'));
    expect(refreshedPushButton.disabled).toBe(false);
  });

  test('keeps a composite source heading informational after approval of its declared scope', async () => {
    fixtures.files = [buildReviewRequiredFile()];
    fixtures.approvalResponse = () => {
      const approvedFile = buildReviewRequiredFile({
        approval_status: 'approved',
        document_topic: 'Basic Addition, Subtraction',
        validation_summary: {
          ...buildReviewRequiredFile().validation_summary,
          publication_eligibility: {
            eligible: true,
            code: 'ELIGIBLE',
            message: 'Eligible for Game publication.',
          },
        },
      });
      fixtures.files = [approvedFile];
      return okJson({ success: true, learningFile: approvedFile, validation: approvedFile.validation_summary });
    };

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');
    await act(async () => {
      clickByText(container, 'Preview');
    });

    await markPreviewAsReviewed();

    await act(async () => {
      Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Approve').click();
    });

    expect(document.body.textContent).toContain('Source document topic (informational): Basic Addition, Subtraction');
    expect(document.body.textContent).toContain('Game Publication: Eligible — Ready for Game');
    expect(document.body.querySelector('.generated-questions-preview-footer').textContent).not.toContain('Approve');
    const pushButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes('Push to Game'));
    expect(pushButton.disabled).toBe(false);
  });
});
