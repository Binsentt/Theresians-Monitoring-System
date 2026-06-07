import React, { useEffect, useMemo, useState } from 'react';
import { Download, FilePenLine, FileText, Folder, HardDrive, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import { DashboardContainer, MainContent, TopBar, PageContent } from './layout/AppLayout';
import { DataTable } from './layout/Table';
import { canAccessRole, normalizeRole } from './manageUsers.utils';
import {
  calculateLearningStorage,
  countFixedQuestionRecords,
  DIFFICULTY_LEVELS,
  formatLearningPreviewText,
  formatLearningFileSize,
  getLargestLearningFiles,
  getLearningFilePreviewKind,
  getMathTopicsForGradeDifficulty,
  getQuestionFolderView,
  getQuestionFolderPath,
  GRADE_LEVELS,
  inferLearningFileUploadType,
  isValidDifficulty,
  isValidGradeLevel,
  isValidMathTopicForGradeDifficulty,
  normalizeMathTopicForGradeDifficulty,
} from './lessonQuestionManager.utils';
import { apiUrl } from '../api';
import '../styles/lessonQuestionManager.css';

const initialFormState = {
  grade_level: '',
  difficulty: '',
  math_topic: '',
  file_type: 'fixed_questions',
  expected_question_count: '',
  file: null,
};

const initialFilterState = {
  search: '',
  folder: '',
  grade_level: '',
  difficulty: '',
  math_topic: '',
  file_type: '',
};

function formatUploadDate(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function getPublicUrl(path) {
  if (!path) return null;
  return path.startsWith('http') ? path : apiUrl(path);
}

function deriveUploadTitle(file) {
  return String(file?.name || '').replace(/\.[^.]+$/, '').trim() || 'Uploaded mathematics content';
}

function formatDifficultyLabel(gradeLevel, difficulty) {
  return difficulty;
}

function buildNextTopicValue(gradeLevel, difficulty, currentTopic) {
  return normalizeMathTopicForGradeDifficulty(gradeLevel, difficulty, currentTopic);
}

export default function LessonQuestionManager() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [notification, setNotification] = useState(null);
  const [files, setFiles] = useState([]);
  const [trashFiles, setTrashFiles] = useState([]);
  const [form, setForm] = useState(initialFormState);
  const [editingFile, setEditingFile] = useState(null);
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [managerView, setManagerView] = useState('files');
  const [previewFile, setPreviewFile] = useState(null);
  const [previewContent, setPreviewContent] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState({ grade_level: '', difficulty: '' });
  const [renamingFile, setRenamingFile] = useState(null);
  const [filters, setFilters] = useState(initialFilterState);

  const showNotification = (message, type = 'success') => {
    setNotification({ message, type });
    window.setTimeout(() => setNotification(null), 5000);
  };

  const loadFilesAndFolders = async () => {
    try {
      setLoading(true);
      const [filesRes, trashFilesRes] = await Promise.all([
        fetch(apiUrl('/api/learning-files')),
        fetch(apiUrl('/api/learning-files/trash')),
      ]);
      if (!filesRes.ok) throw new Error('Failed to load files');
      if (!trashFilesRes.ok) throw new Error('Failed to load trashed files');
      setFiles(await filesRes.json());
      setTrashFiles(await trashFilesRes.json());
    } catch (error) {
      console.error(error);
      showNotification('Unable to load lesson manager data.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
    const role = normalizeRole(loggedInUser?.role);
    if (!loggedInUser || (!canAccessRole(role, 'teacher') && !canAccessRole(role, 'admin'))) {
      navigate('/login');
      return;
    }
    setUser({ ...loggedInUser, role });
    loadFilesAndFolders();
  }, [navigate]);

  const folderView = useMemo(() => getQuestionFolderView(files, {
    grade_level: selectedFolder.grade_level,
    difficulty: selectedFolder.difficulty,
    search: filters.search,
    math_topic: filters.math_topic,
    file_type: filters.file_type,
  }), [files, filters.file_type, filters.math_topic, filters.search, selectedFolder.difficulty, selectedFolder.grade_level]);
  const uploadTopicOptions = useMemo(
    () => getMathTopicsForGradeDifficulty(form.grade_level, form.difficulty),
    [form.difficulty, form.grade_level]
  );
  const editTopicOptions = useMemo(
    () => (editingFile ? getMathTopicsForGradeDifficulty(editingFile.grade_level, editingFile.difficulty) : []),
    [editingFile]
  );
  const filterTopicOptions = useMemo(
    () => getMathTopicsForGradeDifficulty(selectedFolder.grade_level, selectedFolder.difficulty),
    [selectedFolder.difficulty, selectedFolder.grade_level]
  );
  const inferredFileType = inferLearningFileUploadType(form.file?.name);
  const uploadType = form.file_type;
  const isDifficultyFolderOpen = Boolean(selectedFolder.grade_level && selectedFolder.difficulty);
  const displayedFiles = isDifficultyFolderOpen ? folderView.files : [];
  const tableEmptyMessage = isDifficultyFolderOpen
    ? 'No files in this folder yet. Upload a question file for this grade and difficulty.'
    : 'Open a difficulty folder to view uploaded files.';
  const storageSummary = useMemo(() => calculateLearningStorage(files), [files]);
  const largestFiles = useMemo(() => getLargestLearningFiles(files), [files]);
  const trashRows = useMemo(() => [
    ...trashFiles.map((file) => ({
      ...file,
      trashType: 'File',
      trashName: file.title,
    })),
  ].sort((left, right) => new Date(right.deleted_at || 0) - new Date(left.deleted_at || 0)), [trashFiles]);

  const handleFormChange = (field, value) => {
    setForm((prev) => {
      if (field === 'grade_level' || field === 'difficulty') {
        const gradeLevel = field === 'grade_level' ? value : prev.grade_level;
        const difficulty = field === 'difficulty' ? value : prev.difficulty;
        return {
          ...prev,
          grade_level: gradeLevel,
          difficulty,
          math_topic: buildNextTopicValue(gradeLevel, difficulty, prev.math_topic),
        };
      }
      return { ...prev, [field]: value };
    });
  };

  const handleFilterChange = (field, value) => {
    setFilters((prev) => {
      if (field === 'grade_level' || field === 'difficulty') {
        const gradeLevel = field === 'grade_level' ? value : prev.grade_level;
        const difficulty = field === 'difficulty' ? value : prev.difficulty;
        const nextTopicOptions = getMathTopicsForGradeDifficulty(gradeLevel, difficulty);
        return {
          ...prev,
          grade_level: gradeLevel,
          difficulty,
          math_topic: nextTopicOptions.includes(prev.math_topic) ? prev.math_topic : '',
        };
      }

      return { ...prev, [field]: value };
    });
  };

  const resetForm = () => setForm(initialFormState);

  const handleUpload = async (event) => {
    event.preventDefault();
    if (!form.grade_level || !form.difficulty || !form.math_topic.trim() || !form.file) {
      showNotification('Grade level, difficulty, topic, and file are required.', 'error');
      return;
    }
    if (!uploadType || inferredFileType !== uploadType) {
      showNotification('Lessons must be PDF files. Fixed questions must be JSON or CSV.', 'error');
      return;
    }
    if (
      !isValidGradeLevel(form.grade_level)
      || !isValidDifficulty(form.difficulty)
      || !isValidMathTopicForGradeDifficulty(form.grade_level, form.difficulty, form.math_topic)
    ) {
      showNotification('Invalid grade level, difficulty, or topic for this Mathematics content.', 'error');
      return;
    }
    const requestedCount = String(form.expected_question_count || '').trim();
    if (uploadType === 'fixed_questions' && requestedCount) {
      try {
        const actualCount = countFixedQuestionRecords(await form.file.text(), form.file.name);
        if (actualCount !== Number(requestedCount)) {
          showNotification(`File contains ${actualCount} questions but you specified ${requestedCount}. Please check your file.`, 'error');
          return;
        }
      } catch (error) {
        console.error(error);
        showNotification('Unable to read the question file for count validation.', 'error');
        return;
      }
    }

    const payload = new FormData();
    payload.append('title', deriveUploadTitle(form.file));
    payload.append('grade_level', form.grade_level);
    payload.append('difficulty', form.difficulty);
    payload.append('math_topic', form.math_topic.trim());
    payload.append('file_type', uploadType);
    payload.append('uploaded_by', user.id);
    if (uploadType === 'fixed_questions' && requestedCount) {
      payload.append('expected_question_count', requestedCount);
    }
    payload.append('file', form.file);

    try {
      setUploading(true);
      const response = await fetch(apiUrl('/api/learning-files/upload'), {
        method: 'POST',
        body: payload,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload failed.');
      const uploadedFile = {
        ...data.learningFile,
        folder_name: getQuestionFolderPath(data.learningFile?.grade_level || form.grade_level, data.learningFile?.difficulty || form.difficulty),
        uploaded_by_name: user?.name || user?.email || 'Unknown',
        difficulty: data.learningFile?.difficulty || form.difficulty,
        published: Boolean(data.learningFile?.published),
      };
      setFiles((current) => [uploadedFile, ...current.filter((file) => file.id !== uploadedFile.id)]);
      setSelectedFolder({ grade_level: uploadedFile.grade_level || form.grade_level, difficulty: uploadedFile.difficulty || form.difficulty });
      showNotification('File uploaded successfully');
      resetForm();
      setShowUploadForm(false);
    } catch (error) {
      console.error(error);
      showNotification('Upload failed. Please try again.', 'error');
    } finally {
      setUploading(false);
    }
  };

  const moveFileToTrash = async (file) => {
    const confirmMessage = file.published
      ? `Delete "${file.title}"? This file is active in the game and will be removed from the website storage.`
      : `Delete "${file.title}" from staged uploads?`;
    if (!window.confirm(confirmMessage)) return;
    try {
      const response = await fetch(apiUrl(`/api/learning-files/${file.id}`), { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Delete failed');
      setFiles((current) => current.filter((item) => item.id !== file.id));
      showNotification('File deleted.');
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Delete failed.', 'error');
    }
  };

  const restoreFile = async (file) => {
    try {
      const response = await fetch(apiUrl(`/api/learning-files/${file.id}/restore`), { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Restore failed');
      const restoredFile = data.learningFile || file;
      setTrashFiles((current) => current.filter((item) => item.id !== file.id));
      setFiles((current) => [{
        ...restoredFile,
        deleted_at: null,
        folder_name: restoredFile.folder_name || getQuestionFolderPath(restoredFile.grade_level, restoredFile.difficulty),
      }, ...current.filter((item) => item.id !== file.id)]);
      showNotification('File restored successfully');
    } catch (error) {
      console.error(error);
      showNotification('Failed to restore file. Please try again.', 'error');
    }
  };

  const permanentDeleteFile = async (file) => {
    if (!window.confirm(`Permanently delete "${file.title}"?`)) return;
    try {
      const response = await fetch(apiUrl(`/api/learning-files/${file.id}/permanent`), { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Permanent delete failed');
      showNotification('File permanently deleted.');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Permanent delete failed.', 'error');
    }
  };

  const downloadFile = (file) => {
    const url = getPublicUrl(file.file_url);
    if (!url) {
      showNotification('Download is not available for this file.', 'error');
      return;
    }
    const link = document.createElement('a');
    link.href = url;
    link.download = file.file_name || file.title || 'mathematics-content';
    link.target = '_blank';
    link.rel = 'noreferrer';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const closePreview = () => {
    setPreviewFile(null);
    setPreviewContent('');
    setPreviewLoading(false);
  };

  const previewLearningFile = async (file) => {
    const previewKind = getLearningFilePreviewKind(file);
    setPreviewContent('');
    setPreviewFile({ ...file, previewKind, publicUrl: getPublicUrl(file.file_url) });

    if (previewKind !== 'text') return;

    try {
      setPreviewLoading(true);
      const previewResponse = file.id ? await fetch(apiUrl(`/api/learning-files/${file.id}/preview`)) : null;
      if (previewResponse?.ok) {
        const previewData = await previewResponse.json();
        setPreviewContent(formatLearningPreviewText(previewData.content || '', file));
        return;
      }

      if (!file.file_url) return;
      const response = await fetch(getPublicUrl(file.file_url));
      if (!response.ok) throw new Error('Preview fetch failed');
      setPreviewContent(formatLearningPreviewText(await response.text(), file));
    } catch (error) {
      console.error(error);
      setPreviewContent('');
    } finally {
      setPreviewLoading(false);
    }
  };

  const saveFileDetails = async () => {
    if (!editingFile.title || !editingFile.grade_level || !editingFile.difficulty || !editingFile.math_topic) {
      showNotification('Complete the file details before saving.', 'error');
      return;
    }
    if (
      !isValidGradeLevel(editingFile.grade_level)
      || !isValidDifficulty(editingFile.difficulty)
      || !isValidMathTopicForGradeDifficulty(editingFile.grade_level, editingFile.difficulty, editingFile.math_topic)
    ) {
      showNotification('Invalid file details for this Mathematics grade and difficulty.', 'error');
      return;
    }
    try {
      const response = await fetch(apiUrl(`/api/learning-files/${editingFile.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editingFile.title,
          grade_level: editingFile.grade_level,
          difficulty: editingFile.difficulty,
          math_topic: editingFile.math_topic,
          file_type: editingFile.file_type,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Update failed');
      showNotification('File details updated.');
      setEditingFile(null);
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Update failed.', 'error');
    }
  };

  const handleEmptyTrash = async () => {
    if (trashRows.length === 0) return;
    if (!window.confirm('Permanently delete every file in Trash?')) return;

    try {
      await Promise.all(
        trashFiles.map(async (file) => {
          const response = await fetch(apiUrl(`/api/learning-files/${file.id}/permanent`), { method: 'DELETE' });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Permanent file delete failed');
        })
      );
      showNotification('Trash emptied.');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Unable to empty Trash.', 'error');
    }
  };

  const openUploadModal = () => {
    setShowNewMenu(false);
    const gradeLevel = selectedFolder.grade_level || '';
    const difficulty = selectedFolder.difficulty || '';
    setForm({
      ...initialFormState,
      grade_level: gradeLevel,
      difficulty,
      math_topic: buildNextTopicValue(gradeLevel, difficulty, ''),
    });
    setShowUploadForm(true);
  };

  const switchManagerView = (nextView) => {
    setManagerView(nextView);
    setShowNewMenu(false);
  };

  const pushFileToGame = async (file) => {
    try {
      const response = await fetch(apiUrl(`/api/questions/publish/${file.id}`), { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Push to Game failed');

      setFiles((current) => current.map((item) => {
        const sameDestination = item.grade_level === file.grade_level
          && item.difficulty === file.difficulty
          && item.math_topic === file.math_topic;
        if (item.id === file.id) return { ...item, published: true };
        if (sameDestination) return { ...item, published: false };
        return item;
      }));
      showNotification(data.message || 'Content pushed to game.');
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Push to Game failed.', 'error');
    }
  };

  const openFolder = (folder) => {
    if (folder.type === 'grade') {
      setSelectedFolder({ grade_level: folder.grade_level, difficulty: '' });
    } else if (folder.type === 'difficulty') {
      setSelectedFolder({ grade_level: folder.grade_level, difficulty: folder.difficulty });
    }
    setFilters((prev) => ({ ...prev, math_topic: '', file_type: '' }));
  };

  const goToBreadcrumb = (index) => {
    if (index === 0) {
      setSelectedFolder({ grade_level: '', difficulty: '' });
    } else if (index === 1) {
      setSelectedFolder((prev) => ({ grade_level: prev.grade_level, difficulty: '' }));
    }
    setFilters((prev) => ({ ...prev, math_topic: '', file_type: '' }));
  };

  const goBackFolder = () => {
    if (selectedFolder.difficulty) {
      setSelectedFolder((prev) => ({ grade_level: prev.grade_level, difficulty: '' }));
    } else {
      setSelectedFolder({ grade_level: '', difficulty: '' });
    }
    setFilters((prev) => ({ ...prev, math_topic: '', file_type: '' }));
  };

  const saveRenamedFile = async () => {
    const title = String(renamingFile?.title || '').trim();
    if (!title) {
      showNotification('File name is required.', 'error');
      return;
    }

    try {
      const response = await fetch(apiUrl(`/api/learning-files/${renamingFile.id}/rename`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Rename failed');
      const renamedFile = data.learningFile || data || { ...renamingFile, title };
      setFiles((current) => current.map((file) => (file.id === renamedFile.id ? { ...file, ...renamedFile } : file)));
      setRenamingFile(null);
      showNotification('File renamed successfully.');
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Rename failed.', 'error');
    }
  };

  const tableColumns = [
    {
      key: 'title',
      header: 'Name',
      render: (_, row) => (
        <div className="drive-file-name">
          <FileText size={18} aria-hidden="true" />
          <div className="file-name-cell">
            <button type="button" className="file-name-title file-preview-trigger" onClick={() => previewLearningFile(row)}>
              {row.title}
            </button>
            <span className="file-meta">
              {row.grade_level || 'Unknown grade'} | {row.difficulty || 'Unknown difficulty'}
            </span>
            <span className="file-meta">
              {getQuestionFolderPath(row.grade_level, row.difficulty)}
            </span>
          </div>
        </div>
      ),
    },
    { key: 'math_topic', header: 'Topic Identifier', render: (value) => value || 'Unknown topic' },
    {
      key: 'file_type',
      header: 'File Type',
      render: (value) => (value === 'lesson' ? 'Lesson File' : 'Fixed Question File'),
    },
    {
      key: 'published',
      header: 'Status',
      render: (value) => (
        <span className={`manager-status-pill ${value ? 'active' : 'staged'}`}>
          {value ? 'Active in Game' : 'Staged'}
        </span>
      ),
    },
    { key: 'uploaded_at', header: 'Date modified', render: (value) => formatUploadDate(value) },
    { key: 'file_size', header: 'File size', render: (value) => formatLearningFileSize(value) },
    {
      key: 'actions',
      header: '',
      className: 'drive-actions-cell',
      render: (_, row) => (
        <div className="drive-row-actions">
          <button type="button" className="drive-action-button" onClick={() => setRenamingFile(row)}><FilePenLine size={16} />Rename</button>
          <button type="button" className="drive-action-button" onClick={() => previewLearningFile(row)}><FileText size={16} />Preview</button>
          <button type="button" className="drive-action-button" onClick={() => moveFileToTrash(row)}><Trash2 size={16} />Delete</button>
          <button type="button" className="drive-action-button primary" onClick={() => pushFileToGame(row)}><Upload size={16} />Push to Game</button>
        </div>
      ),
    },
  ];

  const trashColumns = [
    {
      key: 'trashName',
      header: 'Name',
      render: (value, row) => (
        <div className="drive-file-name">
          <FileText size={18} aria-hidden="true" />
          <span className="file-name-title">{value}</span>
        </div>
      ),
    },
    { key: 'trashType', header: 'Type' },
    { key: 'deleted_at', header: 'Deleted date', render: (value) => formatUploadDate(value) },
    {
      key: 'actions',
      header: '',
      className: 'drive-actions-cell',
      render: (_, row) => (
        <div className="drive-row-actions">
          <button type="button" className="drive-action-button" onClick={() => restoreFile(row)}>
            <RotateCcw size={16} />Restore
          </button>
          <button type="button" className="drive-action-button" onClick={() => permanentDeleteFile(row)}>
            <Trash2 size={16} />Permanently Delete
          </button>
        </div>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Loading Lesson & Question Manager...</p>
      </div>
    );
  }

  return (
    <DashboardContainer
      sidebar={
        <AnalyticsSidebar
          role={normalizeRole(user?.role) === 'admin' ? 'admin' : normalizeRole(user?.role) === 'parent_teacher' ? 'parent_teacher' : 'teacher'}
          activeItem="lesson-question-manager"
          logoSrc={logoImage}
          portalLabel={normalizeRole(user?.role) === 'admin' ? 'Admin Portal' : 'Teacher Portal'}
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div className="manager-topbar">
              <div>
                <h1>Lesson & Question Manager</h1>
                <p>Organize uploaded Mathematics content for lessons and fixed questions.</p>
              </div>
            </div>
          </TopBar>

          <PageContent>
            {notification && (
              <div className={`manager-notification ${notification.type === 'error' ? 'notification-error' : 'notification-success'}`} role="status">
                {notification.message}
              </div>
            )}

            <div className="drive-workspace">
              <aside className="drive-manager-sidebar">
                <h2>Lesson &amp; Question Files</h2>
                <div className="drive-new-wrap">
                  <button type="button" className="drive-new-button" onClick={() => setShowNewMenu((value) => !value)}>
                    <Plus size={20} />New
                  </button>
                  {showNewMenu && (
                    <div className="drive-new-menu">
                      <button type="button" onClick={openUploadModal}><Upload size={18} />Upload File</button>
                    </div>
                  )}
                </div>
                <nav className="drive-manager-nav" aria-label="Lesson manager views">
                  <button type="button" className={managerView === 'files' ? 'active' : ''} onClick={() => switchManagerView('files')}>
                    <Folder size={18} />My Files
                  </button>
                  <button type="button" className={managerView === 'trash' ? 'active' : ''} onClick={() => switchManagerView('trash')}>
                    <Trash2 size={18} />Trash Bin
                  </button>
                  <button type="button" className={managerView === 'storage' ? 'active' : ''} onClick={() => switchManagerView('storage')}>
                    <HardDrive size={18} />Storage
                  </button>
                </nav>
                <div className="drive-sidebar-storage">
                  <div className="drive-storage-label">
                    <HardDrive size={16} />
                    <span>{formatLearningFileSize(storageSummary.usedBytes)} of 10 GB used</span>
                  </div>
                  <div className="drive-storage-track" aria-hidden="true">
                    <span style={{ width: `${Math.max(storageSummary.percentage, storageSummary.usedBytes ? 1 : 0)}%` }} />
                  </div>
                </div>
              </aside>

              <div className="drive-manager-surface">
                {managerView === 'files' && (
                  <section className="drive-panel question-folder-panel">
                    <div className="drive-panel-header">
                      <div>
                        <h2>{selectedFolder.difficulty || selectedFolder.grade_level || 'Questions'}</h2>
                        <div className="folder-breadcrumb" aria-label="Question folder path">
                          {folderView.path.map((part, index) => (
                            <React.Fragment key={`${part}-${index}`}>
                              {index > 0 && <span className="breadcrumb-separator"> &gt; </span>}
                              <button
                                type="button"
                                className="folder-breadcrumb-button"
                                onClick={() => goToBreadcrumb(index)}
                                disabled={index === folderView.path.length - 1}
                              >
                                {part}
                              </button>
                            </React.Fragment>
                          ))}
                        </div>
                        <p className="empty-text">
                          {isDifficultyFolderOpen
                            ? 'Uploaded files stay staged until Push to Game is clicked.'
                            : 'Open a folder to manage the same grade and difficulty structure used by the game.'}
                        </p>
                      </div>
                      {selectedFolder.grade_level && (
                        <button type="button" className="btn btn-secondary" onClick={goBackFolder}>
                          Back
                        </button>
                      )}
                    </div>

                    {!isDifficultyFolderOpen && (
                      <div className="drive-folder-grid fixed-question-grid">
                        {folderView.childFolders.map((folder) => (
                          <button
                            key={`${folder.type}-${folder.grade_level}-${folder.difficulty || ''}`}
                            type="button"
                            className="drive-folder-card fixed-question-folder"
                            onClick={() => openFolder(folder)}
                          >
                            <div className="drive-folder-card-main">
                              <Folder size={28} aria-hidden="true" />
                              <strong>{folder.label}</strong>
                            </div>
                            <span className="file-meta">
                              {folder.type === 'grade'
                                ? `Questions/${folder.label}/`
                                : getQuestionFolderPath(folder.grade_level, folder.difficulty)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}

                    {isDifficultyFolderOpen && (
                      <>
                        <div className="manager-modal-fields folder-file-filters">
                          <div className="form-group">
                            <label className="form-label">Search Files</label>
                            <input
                              type="text"
                              className="input-field"
                              value={filters.search}
                              onChange={(event) => handleFilterChange('search', event.target.value)}
                              placeholder="Search file name or metadata"
                            />
                          </div>
                          <div className="form-group">
                            <label className="form-label">Topic</label>
                            <select
                              className="select-field"
                              value={filters.math_topic}
                              onChange={(event) => handleFilterChange('math_topic', event.target.value)}
                            >
                              <option value="">All topics</option>
                              {filterTopicOptions.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                            </select>
                          </div>
                          <div className="form-group">
                            <label className="form-label">File Type</label>
                            <select className="select-field" value={filters.file_type} onChange={(event) => handleFilterChange('file_type', event.target.value)}>
                              <option value="">All file types</option>
                              <option value="lesson">Lesson File</option>
                              <option value="fixed_questions">Fixed Question File</option>
                            </select>
                          </div>
                        </div>
                        <DataTable columns={tableColumns} data={displayedFiles} emptyMessage={tableEmptyMessage} className="drive-table" />
                      </>
                    )}
                  </section>
                )}

                {managerView === 'trash' && (
                  <section className="drive-panel">
                    <div className="drive-panel-header">
                      <div>
                        <h2>Trash Bin</h2>
                        <p className="empty-text">Restore items or remove them permanently.</p>
                      </div>
                      <button type="button" className="btn btn-secondary" onClick={handleEmptyTrash} disabled={trashRows.length === 0}>
                        <Trash2 size={16} />Empty Trash
                      </button>
                    </div>
                    <DataTable columns={trashColumns} data={trashRows} emptyMessage="Trash is empty." className="drive-table" />
                  </section>
                )}

                {managerView === 'storage' && (
                  <section className="drive-panel drive-storage-view">
                    <div className="drive-panel-header">
                      <div>
                        <h2>Storage</h2>
                        <p className="empty-text">{formatLearningFileSize(storageSummary.usedBytes)} used of 10 GB maximum.</p>
                      </div>
                    </div>
                    <div className="storage-summary">
                      <div className="drive-storage-track" aria-label={`${storageSummary.percentage.toFixed(1)} percent of storage used`}>
                        <span style={{ width: `${Math.max(storageSummary.percentage, storageSummary.usedBytes ? 1 : 0)}%` }} />
                      </div>
                      <strong>{storageSummary.percentage.toFixed(1)}%</strong>
                    </div>
                    <div className="storage-file-list">
                      <h3>Largest files</h3>
                      {largestFiles.length === 0 ? (
                        <p className="empty-text">No files are using storage yet.</p>
                      ) : largestFiles.map((file) => (
                        <div key={file.id} className="storage-file-row">
                          <span><FileText size={18} />{file.title}</span>
                          <strong>{formatLearningFileSize(file.file_size)}</strong>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </div>

            {showUploadForm && (
              <div className="manager-modal-backdrop" role="presentation" onMouseDown={() => setShowUploadForm(false)}>
                <form className="manager-modal drive-upload-modal" onSubmit={handleUpload} role="dialog" aria-modal="true" aria-labelledby="upload-file-title" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="manager-modal-header">
                    <h2 id="upload-file-title">Upload File</h2>
                    <button type="button" className="icon-button" aria-label="Cancel upload" onClick={() => setShowUploadForm(false)}>x</button>
                  </div>
                  <div className="manager-modal-fields">
                    <div className="form-group">
                      <label className="form-label required">Grade Level</label>
                      <select className="select-field" value={form.grade_level} onChange={(event) => handleFormChange('grade_level', event.target.value)}>
                        <option value="">Select grade level</option>
                        {GRADE_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label required">Difficulty</label>
                      <select className="select-field" value={form.difficulty} onChange={(event) => handleFormChange('difficulty', event.target.value)}>
                        <option value="">Select difficulty</option>
                        {DIFFICULTY_LEVELS.map((difficulty) => (
                          <option key={difficulty} value={difficulty}>
                            {formatDifficultyLabel(form.grade_level, difficulty)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label required">Topic Identifier</label>
                      <select
                        className="select-field"
                        value={form.math_topic}
                        disabled={!form.grade_level || !form.difficulty}
                        onChange={(event) => handleFormChange('math_topic', event.target.value)}
                      >
                        {!form.grade_level || !form.difficulty ? (
                          <option value="">Select grade and difficulty first</option>
                        ) : (
                          uploadTopicOptions.map((topic) => <option key={topic} value={topic}>{topic}</option>)
                        )}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label required">File Type</label>
                      <select className="select-field" value={form.file_type} onChange={(event) => handleFormChange('file_type', event.target.value)}>
                        <option value="lesson">Lesson File</option>
                        <option value="fixed_questions">Fixed Question File</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Destination</label>
                      <div className="fixed-destination-display">
                        {getQuestionFolderPath(form.grade_level, form.difficulty)}
                      </div>
                    </div>
                    {form.file_type === 'fixed_questions' && (
                      <div className="form-group">
                        <label className="form-label">Fixed Questions Count</label>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          className="input-field"
                          value={form.expected_question_count}
                          onChange={(event) => handleFormChange('expected_question_count', event.target.value)}
                        />
                      </div>
                    )}
                    <div className="form-group">
                      <label className="form-label required">File</label>
                      <input
                        type="file"
                        accept={form.file_type === 'lesson' ? '.pdf,application/pdf' : '.json,.csv,application/json,text/csv'}
                        onChange={(event) => handleFormChange('file', event.target.files[0] || null)}
                      />
                    </div>
                  </div>
                  {uploading && (
                    <div className="upload-progress" role="status">
                      <span className="upload-progress-bar" aria-hidden="true" />
                      <strong>Uploading file...</strong>
                    </div>
                  )}
                  <div className="upload-actions">
                    <button type="submit" className="btn btn-primary" disabled={uploading}>
                      {uploading ? 'Uploading...' : 'Upload File'}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => { resetForm(); setShowUploadForm(false); }} disabled={uploading}>Cancel</button>
                  </div>
                </form>
              </div>
            )}

            {previewFile && (
              <div className="manager-modal-backdrop" role="presentation" onMouseDown={closePreview}>
                <div className="manager-modal file-preview-modal" role="dialog" aria-modal="true" aria-labelledby="preview-file-title" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="manager-modal-header">
                    <h2 id="preview-file-title">{previewFile.file_name || previewFile.title || 'File Preview'}</h2>
                    <button type="button" className="icon-button" aria-label="Close preview" onClick={closePreview}>x</button>
                  </div>
                  <div className="file-preview-body">
                    {previewFile.previewKind === 'pdf' && previewFile.publicUrl && (
                      <iframe title={`${previewFile.title || previewFile.file_name} preview`} src={previewFile.publicUrl} className="pdf-preview-frame" />
                    )}
                    {previewFile.previewKind === 'image' && previewFile.publicUrl && (
                      <img className="image-preview" src={previewFile.publicUrl} alt={previewFile.title || previewFile.file_name || 'Uploaded file preview'} />
                    )}
                    {previewFile.previewKind === 'text' && (
                      previewLoading ? (
                        <p className="empty-text">Loading preview...</p>
                      ) : previewContent ? (
                        <pre className="text-file-preview">{previewContent}</pre>
                      ) : (
                        <p className="empty-text">Preview not available for this file type. Use the Download button.</p>
                      )
                    )}
                    {(previewFile.previewKind === 'unsupported' || !previewFile.publicUrl) && (
                      <p className="empty-text">Preview not available for this file type. Use the Download button.</p>
                    )}
                  </div>
                  <div className="preview-actions">
                    <button type="button" className="btn btn-primary" onClick={() => downloadFile(previewFile)}>
                      <Download size={16} />Download
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={closePreview}>Close</button>
                  </div>
                </div>
              </div>
            )}

            {renamingFile && (
              <div className="manager-modal-backdrop" role="presentation" onMouseDown={() => setRenamingFile(null)}>
                <div className="manager-modal drive-create-folder-modal" role="dialog" aria-modal="true" aria-labelledby="rename-file-title" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="manager-modal-header">
                    <h2 id="rename-file-title">Rename File</h2>
                    <button type="button" className="icon-button" aria-label="Cancel rename" onClick={() => setRenamingFile(null)}>x</button>
                  </div>
                  <div className="form-group">
                    <label className="form-label required">File Name</label>
                    <input
                      type="text"
                      className="input-field"
                      value={renamingFile.title || ''}
                      onChange={(event) => setRenamingFile((prev) => ({ ...prev, title: event.target.value }))}
                    />
                  </div>
                  <p className="empty-text">
                    Folder metadata stays unchanged: {getQuestionFolderPath(renamingFile.grade_level, renamingFile.difficulty)}
                  </p>
                  <div className="edit-actions">
                    <button type="button" className="btn btn-primary" onClick={saveRenamedFile}>Save</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setRenamingFile(null)}>Cancel</button>
                  </div>
                </div>
              </div>
            )}

            {editingFile && (
              <div className="manager-modal-backdrop" role="presentation" onMouseDown={() => setEditingFile(null)}>
                <div className="manager-modal" role="dialog" aria-modal="true" aria-labelledby="edit-file-title" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="manager-modal-header">
                    <h2 id="edit-file-title">Edit Uploaded Content</h2>
                    <button type="button" className="icon-button" aria-label="Cancel edit" onClick={() => setEditingFile(null)}>x</button>
                  </div>
                  <div className="manager-modal-fields">
                    <div className="form-group">
                      <label className="form-label required">Name</label>
                      <input type="text" className="input-field" value={editingFile.title} onChange={(event) => setEditingFile((prev) => ({ ...prev, title: event.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label className="form-label required">Grade Level</label>
                      <select
                        className="select-field"
                        value={editingFile.grade_level}
                        onChange={(event) => {
                          const gradeLevel = event.target.value;
                          setEditingFile((prev) => ({
                            ...prev,
                            grade_level: gradeLevel,
                            math_topic: buildNextTopicValue(gradeLevel, prev.difficulty, prev.math_topic),
                          }));
                        }}
                      >
                        <option value="">Select grade level</option>
                        {GRADE_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label required">Difficulty</label>
                      <select
                        className="select-field"
                        value={editingFile.difficulty || ''}
                        onChange={(event) => {
                          const difficulty = event.target.value;
                          setEditingFile((prev) => ({
                            ...prev,
                            difficulty,
                            math_topic: buildNextTopicValue(prev.grade_level, difficulty, prev.math_topic),
                          }));
                        }}
                      >
                        <option value="">Select difficulty</option>
                        {DIFFICULTY_LEVELS.map((difficulty) => (
                          <option key={difficulty} value={difficulty}>
                            {formatDifficultyLabel(editingFile.grade_level, difficulty)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label required">Topic Identifier</label>
                      <select
                        className="select-field"
                        value={editingFile.grade_level && editingFile.difficulty ? editingFile.math_topic : ''}
                        disabled={!editingFile.grade_level || !editingFile.difficulty}
                        onChange={(event) => setEditingFile((prev) => ({ ...prev, math_topic: event.target.value }))}
                      >
                        {!editingFile.grade_level || !editingFile.difficulty ? (
                          <option value="">Select grade and difficulty first</option>
                        ) : (
                          editTopicOptions.map((topic) => <option key={topic} value={topic}>{topic}</option>)
                        )}
                      </select>
                    </div>
                  </div>
                  <div className="edit-actions">
                    <button type="button" className="btn btn-primary" onClick={saveFileDetails}>Save</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setEditingFile(null)}>Cancel</button>
                  </div>
                </div>
              </div>
            )}
          </PageContent>
        </MainContent>
      }
    />
  );
}
