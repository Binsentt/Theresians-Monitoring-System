import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import LessonQuestionManager from './LessonQuestionManager';

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

const clickByText = (container, label) => {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent.includes(label));
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

const setSelectValue = (field, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('change', { bubbles: true }));
};

const openQuestionFolder = async (container, gradeLevel, difficulty) => {
  await act(async () => {
    clickByText(container, gradeLevel);
  });
  await act(async () => {
    clickByText(container, difficulty);
  });
};

describe('LessonQuestionManager upload and trash controls', () => {
  let container;
  let root;
  let fixtures;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    localStorage.clear();
    localStorage.setItem('loggedInUser', JSON.stringify({ id: 8, role: 'teacher', name: 'Teacher User' }));
    fixtures = {
      files: [],
      folders: [],
      trashFiles: [{ id: 31, title: 'Deleted Quiz', file_name: 'deleted.csv', deleted_at: '2026-05-20T00:00:00.000Z' }],
      trashFolders: [],
    };
    global.fetch = jest.fn((url, options = {}) => {
      const value = String(url);
      if (value.endsWith('/api/learning-files')) return okJson(fixtures.files);
      if (value.endsWith('/api/folders')) return okJson(fixtures.folders);
      if (value.endsWith('/api/learning-files/trash')) return okJson(fixtures.trashFiles);
      if (value.endsWith('/api/folders/trash')) return okJson(fixtures.trashFolders);
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
        fixtures.files = fixtures.files.map((file) => (
          file.id === 77 ? { ...file, published: true } : file
        ));
        return okJson({ success: true, message: 'Content pushed to game.', learningFile: fixtures.files[0] });
      }
      if (value.includes('/api/learning-files/77/questions')) {
        return okJson({
          questions: [{
            id: 501,
            question: 'What is 2 + 3?',
            options: ['4', '5', '6'],
            correct_answer: '5',
            published: false,
          }],
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
    act(() => {
      root.unmount();
    });
    container.remove();
    delete global.fetch;
  });

  test('upload modal filters topic until grade and difficulty are selected', async () => {
    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await act(async () => {
      clickByText(container, 'New');
    });
    await act(async () => {
      clickByText(container, 'Upload File');
    });

    const selects = container.querySelectorAll('.drive-upload-modal select');
    const topicSelect = selects[2];

    expect(container.textContent).toContain('Grade 1');
    expect(container.textContent).toContain('Grade 2');
    expect(container.textContent).toContain('Grade 6');
    expect(container.textContent).not.toContain('Grade 1-2');
    expect(container.textContent).toContain('Difficulty');
    expect(container.textContent).toContain('Topic Identifier');
    expect(topicSelect.disabled).toBe(true);
    expect(topicSelect.textContent).toContain('Select grade and difficulty first');

    await act(async () => {
      setSelectValue(selects[0], 'Grade 3');
      setSelectValue(selects[1], 'Medium');
    });

    expect(topicSelect.disabled).toBe(false);
    expect(topicSelect.textContent).toContain('Multiplication');
    expect(topicSelect.textContent).toContain('Division');
    expect(topicSelect.textContent).toContain('Fractions');
    expect(container.textContent).toContain('Medium');
    expect(container.querySelector('.fixed-destination-display').textContent.trim()).toBe('Questions/Grade 3/Medium');
    expect(container.textContent).not.toContain('Select Folder');
    expect(container.textContent).not.toContain('New Folder');
    expect(container.textContent).toContain('Lesson PDF File');
    expect(container.textContent).toContain('Fixed Question File');
  });

  test('Question Count is required only for Lesson PDF File uploads and is hidden for fixed question files', async () => {
    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await act(async () => {
      clickByText(container, 'New');
    });
    await act(async () => {
      clickByText(container, 'Upload File');
    });

    expect(container.querySelector('.drive-upload-modal').textContent).not.toContain('Question Count');
    const selects = container.querySelectorAll('.drive-upload-modal select');
    await act(async () => {
      setSelectValue(selects[3], 'lesson');
    });

    const countField = container.querySelector('input[name="expected_question_count"]');
    expect(container.textContent).toContain('Question Count');
    expect(countField).toBeTruthy();
    expect(countField.required).toBe(true);
    expect(countField.min).toBe('1');
    expect(countField.max).toBe('50');

    await act(async () => {
      setSelectValue(selects[0], 'Grade 1');
      setSelectValue(selects[1], 'Easy');
      const fileInput = container.querySelector('input[type="file"]');
      const file = new File(['%PDF-1.4 lesson'], 'addition-lesson.pdf', { type: 'application/pdf' });
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      container.querySelector('.drive-upload-modal').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('Question Count is required for Lesson PDF files.');
    expect(global.fetch).not.toHaveBeenCalledWith('/api/learning-files/upload', expect.anything());
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

    const selects = container.querySelectorAll('.drive-upload-modal select');
    const fileInput = container.querySelector('input[type="file"]');
    const file = new File([JSON.stringify([{ question: '1 + 1?', correct_answer: '2' }])], 'addition-quiz.json', {
      type: 'application/json',
    });

    await act(async () => {
      setSelectValue(selects[0], 'Grade 1');
      setSelectValue(selects[1], 'Medium');
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      container.querySelector('.drive-upload-modal').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('File uploaded successfully');
    expect(container.textContent).toContain('addition-quiz');
    expect(container.textContent).toContain('Medium');
    expect(container.textContent).toContain('Staged');
    expect(container.querySelector('.drive-upload-modal')).toBeNull();
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

    await openQuestionFolder(container, 'Grade 1', 'Medium');

    expect(container.textContent).not.toContain('Uploaded by');
    expect(container.textContent).not.toContain('Teacher User');
    expect(container.textContent).toContain('Preview');
    expect(container.textContent).toContain('Delete');
    expect(container.textContent).toContain('Push to Game');
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
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });
    await openQuestionFolder(container, 'Grade 1', 'Easy');

    await act(async () => {
      clickByText(container, 'Preview');
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/learning-files/77/questions');
    expect(container.textContent).toContain('Generated Questions');
    expect(container.textContent).toContain('What is 2 + 3?');
    expect(container.textContent).toContain('5 (Correct)');
    expect(container.textContent).toContain('staged until Push to Game is clicked');
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
    }];

    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await openQuestionFolder(container, 'Grade 1', 'Medium');

    expect(container.textContent).toContain('Staged');
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/questions/publish/77'), expect.anything());

    await act(async () => {
      clickByText(container, 'Push to Game');
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/questions/publish/77', { method: 'POST' });
    expect(container.textContent).toContain('Active in Game');
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

    await openQuestionFolder(container, 'Grade 1', 'Medium');

    await act(async () => {
      clickByText(container, 'Delete');
    });

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
    expect(container.textContent).toContain('Medium');
    expect(container.textContent).toContain('Hard');
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
    expect(container.textContent).toContain('Basic Addition');
    expect(container.textContent).toContain('Fixed Question File');
    expect(container.textContent).toContain('Staged');
    expect(container.textContent).not.toContain('medium-quiz');
    expect(container.textContent).not.toContain('grade-two-easy');
    expect(container.textContent).toContain('Rename');
    expect(container.textContent).toContain('Preview');
    expect(container.textContent).toContain('Delete');
    expect(container.textContent).toContain('Push to Game');

    await act(async () => {
      clickByText(container, 'Hard');
    });

    expect(container.textContent).toContain('Selected Folder: Questions / Grade 1 / Hard');
    expect(container.textContent).toContain('No files available in Grade 1 - Hard.');
  });
});
