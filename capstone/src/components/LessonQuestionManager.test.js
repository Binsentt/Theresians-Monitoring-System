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
      folders: [{ id: 17, name: 'Addition Folder' }],
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
          folder_id: 17,
          grade_level: 'Grade 1',
          difficulty: 'Normal',
          math_topic: 'Addition, Multiplication, and Word Problems',
          file_type: 'fixed_questions',
        }];
        return okJson({ success: true, learningFile: fixtures.files[0] });
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
    expect(container.textContent).toContain('Topic Name');
    expect(topicSelect.disabled).toBe(true);
    expect(topicSelect.textContent).toContain('Select grade and difficulty first');

    await act(async () => {
      setSelectValue(selects[0], 'Grade 3');
      setSelectValue(selects[1], 'Normal');
    });

    expect(topicSelect.disabled).toBe(false);
    expect(topicSelect.textContent).toContain('Multiplication, Division, and Fractions');
    expect(container.textContent).toContain('Average Round');
    expect(container.textContent).toContain('Select Folder');
    expect(container.textContent).toContain('Lesson File');
    expect(container.textContent).toContain('Fixed Question File');
  });

  test('restores a trashed file and reports the requested success message', async () => {
    await act(async () => {
      root.render(<LessonQuestionManager />);
    });

    await act(async () => {
      clickByText(container, 'Trash Bin');
    });

    const actionButton = container.querySelector('button[aria-label="Trash actions for Deleted Quiz"]');
    await act(async () => {
      actionButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
      setSelectValue(selects[1], 'Normal');
      setSelectValue(selects[3], '17');
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      container.querySelector('.drive-upload-modal').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('File uploaded successfully');
    expect(container.textContent).toContain('addition-quiz');
    expect(container.textContent).toContain('Normal');
    expect(container.querySelector('.drive-upload-modal')).toBeNull();
  });
});
