import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FilePenLine, FileText, Folder, HardDrive, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import DashboardLoadingShell from './layout/DashboardLoadingShell';
import logoImage from '../assets/images/STS_Logo.png';
import { DashboardContainer, MainContent, TopBar, PageContent } from './layout/AppLayout';
import { DataTable } from './layout/Table';
import { canAccessRole, normalizeRole } from './manageUsers.utils';
import { buildAuthHeaders, getStoredUserSession } from './session.utils';
import {
  DIFFICULTY_LEVELS,
  formatLearningFileSize,
  getLargestLearningFiles,
  getMathTopicsForGradeDifficulty,
  getQuestionFolderView,
  getQuestionFolderPath,
  GRADE_LEVELS,
  isSupportedLearningUpload,
  isValidDifficulty,
  isValidGradeLevel,
  isValidMathTopicForGradeDifficulty,
  normalizeDifficultyValue,
  normalizeMathTopicForGradeDifficulty,
  QUESTION_FOLDER_STRUCTURE,
} from './lessonQuestionManager.utils';
import { apiUrl } from '../api';
import { TablePrintButton } from './TablePrintButton';
import { PrintableTableReport } from './PrintableTableReport';
import { formatReportContext, paginateTableRows } from './tableReporting.utils';
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
  status: '',
};

const MAX_LESSON_QUESTION_COUNT = 50;

const fetchLessonManagerApi = (url, options = {}) => fetch(url, {
  ...options,
  headers: {
    ...buildAuthHeaders(),
    ...(options.headers || {}),
  },
});

function formatUploadDate(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatGameFetchDate(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
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

function formatQuestionSetStatus(value) {
  if (value === 'Staged') return 'Pending';
  if (value === 'Superseded/Replaced') return 'Replaced';
  return value;
}

function normalizeManagedLearningFile(file = {}) {
  return {
    ...file,
    difficulty: normalizeDifficultyValue(file.difficulty),
  };
}

function getQuestionSetStatus(row) {
  const lifecycle = row?.lifecycle || {};
  return formatQuestionSetStatus(lifecycle.label || row?.status || (row?.published ? 'Active in Game' : 'Pending'));
}

function getPublicationEligibility(file = {}) {
  const gameTopic = String(file.math_topic || '').trim();
  if (file.file_type !== 'fixed_questions') {
    return {
      eligible: Boolean(gameTopic),
      label: gameTopic ? 'Eligible — ' + gameTopic : 'Not available',
      reason: '',
    };
  }
  if (gameTopic) {
    return {
      eligible: true,
      label: 'Eligible — ' + gameTopic,
      reason: '',
    };
  }

  const documentTopic = String(file.document_topic || '').trim();
  return {
    eligible: false,
    label: /[,;&]|\band\b/i.test(documentTopic)
      ? 'Not Eligible — Multi-topic document'
      : 'Not Eligible — Single-topic source required',
    reason: 'Game publication requires a single-topic Fixed Question document.',
  };
}

function getFixedQuestionPublicationBlockReason(file = {}) {
  const eligibility = getPublicationEligibility(file);
  return file.file_type === 'fixed_questions' && !eligibility.eligible
    ? eligibility.reason
    : '';
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
  const [storageSummary, setStorageSummary] = useState({ used_bytes: 0, source_file_bytes: 0, question_content_bytes: 0 });
  const [form, setForm] = useState(initialFormState);
  const [editingFile, setEditingFile] = useState(null);
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [managerView, setManagerView] = useState('files');
  const [questionPreviewFile, setQuestionPreviewFile] = useState(null);
  const [questionPreviewDetails, setQuestionPreviewDetails] = useState(null);
  const [previewQuestions, setPreviewQuestions] = useState([]);
  const [previewValidation, setPreviewValidation] = useState(null);
  const [previewQuestionsLoading, setPreviewQuestionsLoading] = useState(false);
  const previewBodyRef = useRef(null);
  const [fixedUploadValidation, setFixedUploadValidation] = useState(null);
  const [selectedFolder, setSelectedFolder] = useState({ grade_level: '', difficulty: '' });
  const [renamingFile, setRenamingFile] = useState(null);
  const [filters, setFilters] = useState(initialFilterState);
  const [page, setPage] = useState(1);
  const [trashPage, setTrashPage] = useState(1);
  const [formErrors, setFormErrors] = useState({});
  const [replacementConfirmation, setReplacementConfirmation] = useState(null);
  const pageSize = 10;

  const showNotification = (message, type = 'success') => {
    setNotification({ message, type });
    window.setTimeout(() => setNotification(null), 5000);
  };

  useLayoutEffect(() => {
    if (questionPreviewFile && previewBodyRef.current) {
      previewBodyRef.current.scrollTop = 0;
    }
  }, [questionPreviewFile?.id]);

  const loadFilesAndFolders = async ({ initial = false } = {}) => {
    try {
      if (initial) setLoading(true);
      const [filesRes, trashFilesRes, storageRes] = await Promise.all([
        fetchLessonManagerApi(apiUrl('/api/learning-files')),
        fetchLessonManagerApi(apiUrl('/api/learning-files/trash')),
        fetchLessonManagerApi(apiUrl('/api/learning-files/storage-summary')),
      ]);
      if (!filesRes.ok) throw new Error('Failed to load files');
      if (!trashFilesRes.ok) throw new Error('Failed to load trashed files');
      if (!storageRes.ok) throw new Error('Failed to load storage usage');
      setFiles((await filesRes.json()).map(normalizeManagedLearningFile));
      setTrashFiles((await trashFilesRes.json()).map(normalizeManagedLearningFile));
      setStorageSummary(await storageRes.json());
    } catch (error) {
      console.error(error);
      showNotification('Unable to load lesson manager data.', 'error');
    } finally {
      if (initial) setLoading(false);
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
    loadFilesAndFolders({ initial: true });
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
  const uploadType = form.file_type;
  const isFixedQuestionUpload = uploadType === 'fixed_questions';
  const isDifficultyFolderOpen = Boolean(selectedFolder.grade_level && selectedFolder.difficulty);
  const selectedFolderPath = selectedFolder.grade_level
    ? `Questions / ${selectedFolder.grade_level}${selectedFolder.difficulty ? ` / ${selectedFolder.difficulty}` : ''}`
    : 'Questions';
  const currentlyViewing = selectedFolder.grade_level
    ? `${selectedFolder.grade_level}${selectedFolder.difficulty ? ` - ${selectedFolder.difficulty}` : ''}`
    : 'All Question Files';
  const displayedFiles = useMemo(() => folderView.files.filter((file) => (
    !filters.status || getQuestionSetStatus(file) === filters.status
  )), [filters.status, folderView.files]);
  const paginatedFiles = paginateTableRows(displayedFiles, page, pageSize);
  const statusOptions = useMemo(() => Array.from(new Set(folderView.files.map(getQuestionSetStatus).filter(Boolean))).sort(), [folderView.files]);
  const previewFile = questionPreviewDetails || questionPreviewFile;
  const previewPublicationEligibility = getPublicationEligibility(previewFile || {});
  const previewIsReadyForGame = previewValidation?.is_valid !== false && previewPublicationEligibility.eligible;
  const reportColumns = [
    { header: 'No.', value: (_, index) => index + 1 },
    { header: 'File / Question Set Name', value: (row) => row.generated_question_set_name || row.title || row.file_name },
    { header: 'Grade', value: (row) => row.grade_level },
    { header: 'Difficulty', value: (row) => row.difficulty },
    { header: 'File Type / Source', value: (row) => row.source_label || (row.file_type === 'lesson' ? 'Lesson PDF File' : 'Fixed Question File') },
    { header: 'Question Count', value: (row) => Number.isInteger(Number(row.question_count)) ? Number(row.question_count) : (row.file_type === 'lesson' ? row.requested_question_count : null) },
    { header: 'Status', value: (row) => getQuestionSetStatus(row) },
    { header: 'Date Modified', value: (row) => formatUploadDate(row.published_at || row.generated_at || row.uploaded_at) },
    { header: 'File Size', value: (row) => formatLearningFileSize(row.file_size) },
  ];

  useEffect(() => {
    if (page !== paginatedFiles.currentPage) setPage(paginatedFiles.currentPage);
  }, [page, paginatedFiles.currentPage]);
  const tableEmptyMessage = selectedFolder.grade_level
    ? `No files available in ${selectedFolder.grade_level}${selectedFolder.difficulty ? ` - ${selectedFolder.difficulty}` : ''}.`
    : 'No question files available yet.';
  const managedStorageBytes = Number(storageSummary?.used_bytes) || 0;
  const largestFiles = useMemo(() => getLargestLearningFiles(files), [files]);
  const trashRows = useMemo(() => [
    ...trashFiles.map((file) => ({
      ...file,
      trashType: 'File',
      trashName: file.title,
    })),
  ].sort((left, right) => new Date(right.deleted_at || 0) - new Date(left.deleted_at || 0)), [trashFiles]);
  const paginatedTrashRows = paginateTableRows(trashRows, trashPage, pageSize);

  useEffect(() => {
    if (trashPage !== paginatedTrashRows.currentPage) setTrashPage(paginatedTrashRows.currentPage);
  }, [paginatedTrashRows.currentPage, trashPage]);

  const handleFormChange = (field, value) => {
    setFormErrors((current) => ({ ...current, [field]: '' }));
    if (field === 'file' || field === 'file_type') setFixedUploadValidation(null);
    setForm((prev) => {
      if (field === 'grade_level' || field === 'difficulty') {
        const gradeLevel = field === 'grade_level' ? value : prev.grade_level;
        const difficulty = field === 'difficulty' ? value : prev.difficulty;
        return {
          ...prev,
          grade_level: gradeLevel,
          difficulty,
          math_topic: prev.file_type === 'lesson' ? buildNextTopicValue(gradeLevel, difficulty, prev.math_topic) : '',
        };
      }
      if (field === 'file_type') {
        return {
          ...prev,
          file_type: value,
          math_topic: value === 'lesson' ? buildNextTopicValue(prev.grade_level, prev.difficulty, prev.math_topic) : '',
          expected_question_count: value === 'lesson' ? prev.expected_question_count : '',
        };
      }
      return { ...prev, [field]: value };
    });
  };

  const handleFilterChange = (field, value) => {
    setPage(1);
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

  const resetForm = () => {
    setForm(initialFormState);
    setFormErrors({});
    setFixedUploadValidation(null);
  };

  const handleUpload = async (event) => {
    event.preventDefault();
    if (!form.grade_level || !form.difficulty || !form.file) {
      showNotification('Grade level, difficulty, and file are required.', 'error');
      return;
    }
    if (uploadType === 'lesson' && !form.math_topic.trim()) {
      showNotification('Grade level, difficulty, topic, and file are required for Lesson PDF files.', 'error');
      return;
    }
    if (!uploadType || !isSupportedLearningUpload(form.file.name, uploadType)) {
      showNotification('Lesson files must be PDF. Fixed Questions support DOCX or PDF documents.', 'error');
      return;
    }
    if (
      !isValidGradeLevel(form.grade_level)
      || !isValidDifficulty(form.difficulty)
      || (uploadType === 'lesson' && !isValidMathTopicForGradeDifficulty(form.grade_level, form.difficulty, form.math_topic))
    ) {
      showNotification('Invalid grade level, difficulty, or topic for this Mathematics content.', 'error');
      return;
    }
    const requestedCount = String(form.expected_question_count || '').trim();
    if (uploadType === 'lesson' && (!/^\d+$/.test(requestedCount) || Number(requestedCount) < 1 || Number(requestedCount) > MAX_LESSON_QUESTION_COUNT)) {
      setFormErrors({ expected_question_count: `Question Count must be a whole number between 1 and ${MAX_LESSON_QUESTION_COUNT}.` });
      if (!requestedCount) {
        setFormErrors({ expected_question_count: 'Question Count is required for Lesson PDF files.' });
      }
      return;
    }

    const payload = new FormData();
    payload.append('title', deriveUploadTitle(form.file));
    payload.append('grade_level', form.grade_level);
    payload.append('difficulty', form.difficulty);
    if (uploadType === 'lesson') payload.append('math_topic', form.math_topic.trim());
    payload.append('file_type', uploadType);
    payload.append('uploaded_by', user.id);
    if (uploadType === 'lesson') {
      payload.append('expected_question_count', requestedCount);
    }
    payload.append('file', form.file);

    try {
      setUploading(true);
      const response = await fetchLessonManagerApi(apiUrl('/api/learning-files/upload'), {
        method: 'POST',
        body: payload,
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.code === 'FIXED_QUESTION_VALIDATION_FAILED') {
          setFixedUploadValidation({
            document_errors: Array.isArray(data.document_errors) ? data.document_errors : [],
            questions: Array.isArray(data.questions) ? data.questions : [],
          });
          return;
        }
        throw new Error(data.error || 'Upload failed.');
      }
      const uploadedFile = normalizeManagedLearningFile({
        ...data.learningFile,
        folder_name: getQuestionFolderPath(data.learningFile?.grade_level || form.grade_level, data.learningFile?.difficulty || form.difficulty),
        uploaded_by_name: user?.name || user?.email || 'Unknown',
        difficulty: data.learningFile?.difficulty || form.difficulty,
        published: Boolean(data.learningFile?.published),
      });
      setFiles((current) => [uploadedFile, ...current.filter((file) => file.id !== uploadedFile.id)]);
      setSelectedFolder({ grade_level: uploadedFile.grade_level || form.grade_level, difficulty: uploadedFile.difficulty || form.difficulty });
      await loadFilesAndFolders();
      showNotification(uploadType === 'lesson' ? 'Lesson questions are Ready for Review.' : 'File uploaded successfully');
      resetForm();
      setShowUploadForm(false);
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Upload failed. Please try again.', 'error');
    } finally {
      setUploading(false);
    }
  };

  const moveFileToTrash = async (file) => {
    if (file.published || file.publish_status === 'active') {
      showNotification('This question set is Active in Game. Publish a replacement before moving it to Trash.', 'error');
      return;
    }
    const confirmMessage = `Delete "${file.title}" from Pending question sets?`;
    if (!window.confirm(confirmMessage)) return;
    try {
      const response = await fetchLessonManagerApi(apiUrl(`/api/learning-files/${file.id}`), { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Delete failed');
      setFiles((current) => current.filter((item) => item.id !== file.id));
      await loadFilesAndFolders();
      showNotification('File deleted.');
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Delete failed.', 'error');
    }
  };

  const restoreFile = async (file) => {
    try {
      const response = await fetchLessonManagerApi(apiUrl(`/api/learning-files/${file.id}/restore`), { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Restore failed');
      const restoredFile = normalizeManagedLearningFile(data.learningFile || file);
      setTrashFiles((current) => current.filter((item) => item.id !== file.id));
      setFiles((current) => [{
        ...restoredFile,
        deleted_at: null,
        folder_name: restoredFile.folder_name || getQuestionFolderPath(restoredFile.grade_level, restoredFile.difficulty),
      }, ...current.filter((item) => item.id !== file.id)]);
      await loadFilesAndFolders();
      showNotification('File restored successfully');
    } catch (error) {
      console.error(error);
      showNotification('Failed to restore file. Please try again.', 'error');
    }
  };

  const permanentDeleteFile = async (file) => {
    if (!window.confirm(`Permanently delete "${file.title}"?`)) return;
    try {
      const response = await fetchLessonManagerApi(apiUrl(`/api/learning-files/${file.id}/permanent`), { method: 'DELETE' });
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

  const closeQuestionPreview = () => {
    setQuestionPreviewFile(null);
    setQuestionPreviewDetails(null);
    setPreviewQuestions([]);
    setPreviewValidation(null);
    setPreviewQuestionsLoading(false);
  };

  const openQuestionSetPreview = async (file) => {
    setQuestionPreviewFile(file);
    setQuestionPreviewDetails(null);
    setPreviewQuestions([]);
    setPreviewValidation(null);
    setPreviewQuestionsLoading(true);
    try {
      const response = await fetchLessonManagerApi(apiUrl(`/api/learning-files/${file.id}/questions`));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to preview generated questions.');
      setQuestionPreviewDetails(data.file || file);
      setPreviewQuestions(Array.isArray(data.questions) ? data.questions : []);
      setPreviewValidation(data.validation || null);
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Unable to preview generated questions.', 'error');
    } finally {
      setPreviewQuestionsLoading(false);
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
      const response = await fetchLessonManagerApi(apiUrl(`/api/learning-files/${editingFile.id}`), {
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
          const response = await fetchLessonManagerApi(apiUrl(`/api/learning-files/${file.id}/permanent`), { method: 'DELETE' });
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
      math_topic: '',
    });
    setShowUploadForm(true);
  };

  const switchManagerView = (nextView) => {
    setManagerView(nextView);
    setShowNewMenu(false);
  };

  const pushFileToGame = async (file, { confirmReplacement = false } = {}) => {
    try {
      const response = await fetchLessonManagerApi(apiUrl(`/api/questions/publish/${file.id}`), {
        method: 'POST',
        ...(confirmReplacement ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm_replacement: true }),
        } : {}),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.code === 'ACTIVE_SET_REPLACEMENT_CONFIRMATION_REQUIRED' && data.replacement) {
          setReplacementConfirmation({ file, replacement: data.replacement });
          return;
        }
        throw new Error(data.error || 'Push to Game failed');
      }

      await loadFilesAndFolders();
      setReplacementConfirmation(null);
      showNotification(data.message || 'Content pushed to game.');
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Push to Game failed.', 'error');
    }
  };

  const selectGradeFolder = (gradeLevel) => {
    setSelectedFolder({ grade_level: gradeLevel, difficulty: '' });
    setFilters((prev) => ({ ...prev, math_topic: '', file_type: '', status: '' }));
    setPage(1);
  };

  const selectDifficultyFolder = (gradeLevel, difficulty) => {
    setSelectedFolder({ grade_level: gradeLevel, difficulty });
    setFilters((prev) => ({ ...prev, math_topic: '', file_type: '', status: '' }));
    setPage(1);
  };

  const clearSelectedFolder = () => {
    setSelectedFolder({ grade_level: '', difficulty: '' });
    setFilters((prev) => ({ ...prev, math_topic: '', file_type: '', status: '' }));
    setPage(1);
  };

  const saveRenamedFile = async () => {
    const title = String(renamingFile?.title || '').trim();
    if (!title) {
      showNotification('File name is required.', 'error');
      return;
    }

    try {
      const response = await fetchLessonManagerApi(apiUrl(`/api/learning-files/${renamingFile.id}/rename`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Rename failed');
      const renamedFile = normalizeManagedLearningFile(data.learningFile || data || { ...renamingFile, title });
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
      className: 'drive-name-column',
      render: (_, row) => (
        <div className="drive-file-name">
          <FileText size={18} aria-hidden="true" />
          <div className="file-name-cell">
            <button type="button" className="file-name-title file-preview-trigger" onClick={() => openQuestionSetPreview(row)}>
              {row.generated_question_set_name || row.title}
            </button>
            <span className="file-meta">
              {row.grade_level || 'Unknown grade'} | {row.difficulty || 'Unknown difficulty'}
            </span>
            <span className="file-meta">
              {getQuestionFolderPath(row.grade_level, row.difficulty)}
            </span>
            {row.source_lesson && (
              <span className="file-meta">Source Lesson: {row.source_lesson}</span>
            )}
            {row.file_type === 'lesson' && String(row.math_topic || '').trim() && (
              <span className="file-meta">Topic: {row.math_topic}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'file_type',
      header: 'File Type',
      className: 'drive-type-column',
      render: (value) => (value === 'lesson' ? 'Lesson PDF File' : 'Fixed Question File'),
    },
    {
      key: 'question_count',
      header: 'Question Count',
      className: 'drive-count-column',
      render: (value, row) => Number.isInteger(Number(value)) ? Number(value) : (row.file_type === 'lesson' ? row.requested_question_count || '-' : '-'),
    },
    {
      key: 'status',
      header: 'Status',
      className: 'drive-status-column',
      render: (_, row) => {
        const lifecycle = row.lifecycle || {};
        const label = formatQuestionSetStatus(lifecycle.label || row.status || (row.published ? 'Active in Game' : 'Pending'));
        const tone = lifecycle.tone || (row.published ? 'active' : 'staged');
        const publishLabel = formatQuestionSetStatus(
          lifecycle.publishLabel || (row.publish_status === 'superseded' ? 'Replaced' : null)
        );
        const lastGameFetch = formatGameFetchDate(row.last_fetched_at);
        return (
          <div className="manager-status-stack">
            <span className={`manager-status-pill ${tone}`}>{label}</span>
            {publishLabel && publishLabel !== label && <span className="manager-status-detail">{publishLabel}</span>}
            {lastGameFetch && <span className="manager-status-detail">Last Game Fetch: {lastGameFetch}</span>}
          </div>
        );
      },
    },
    { key: 'uploaded_at', header: 'Date Modified', className: 'drive-date-column', render: (value, row) => formatUploadDate(row.published_at || row.generated_at || value) },
    { key: 'file_size', header: 'File Size', className: 'drive-size-column', render: (value) => formatLearningFileSize(value) },
    {
      key: 'actions',
      header: 'Actions',
      className: 'drive-actions-cell no-print',
      render: (_, row) => {
        const fixedQuestionPublicationBlockReason = getFixedQuestionPublicationBlockReason(row);
        const publicationEligibility = getPublicationEligibility(row);
        const fixedQuestionPublicationBlocked = row.file_type === 'fixed_questions' && !publicationEligibility.eligible;
        const pushDisabled = row.generation_status === 'generating'
          || row.generation_status === 'failed'
          || row.validation_summary?.is_valid === false
          || fixedQuestionPublicationBlocked;
        return (
          <div className="drive-row-actions">
          <button type="button" className="drive-action-button" onClick={() => setRenamingFile(row)}><FilePenLine size={16} />Rename</button>
          <button type="button" className="drive-action-button" onClick={() => openQuestionSetPreview(row)}><FileText size={16} />Preview</button>
          <button
            type="button"
            className="drive-action-button"
            onClick={() => moveFileToTrash(row)}
            disabled={row.published || row.lifecycle?.tone === 'active'}
            title={row.published || row.lifecycle?.tone === 'active' ? 'Active question sets cannot be deleted. Publish a confirmed replacement first.' : undefined}
          ><Trash2 size={16} />Delete</button>
          <button
            type="button"
            className="drive-action-button primary"
            onClick={() => pushFileToGame(row)}
            disabled={pushDisabled}
            title={fixedQuestionPublicationBlockReason || (row.validation_summary?.is_valid === false ? 'Review and correct this question set before Push to Game.' : undefined)}
          ><Upload size={16} />{fixedQuestionPublicationBlocked ? 'Not Eligible for Game' : 'Push to Game'}</button>
          {fixedQuestionPublicationBlocked && (
            <span className="manager-action-helper">{fixedQuestionPublicationBlockReason}</span>
          )}
        </div>
        );
      },
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
      className: 'drive-actions-cell no-print',
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
    const loadingRole = normalizeRole(getStoredUserSession()?.role);
    return (
      <DashboardLoadingShell
        role={loadingRole === 'admin' ? 'admin' : loadingRole === 'parent_teacher' ? 'parent_teacher' : 'teacher'}
        activeItem="lesson-question-manager"
        logoSrc={logoImage}
        portalLabel={loadingRole === 'admin' ? 'Admin Portal' : 'Teacher Portal'}
        heading="Lesson & Question Manager"
        subheading="Organize uploaded Mathematics content for lessons and fixed questions."
      />
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
              <div className="drive-manager-toolbar" aria-label="Lesson manager actions">
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
                    <span>{formatLearningFileSize(managedStorageBytes)} used</span>
                  </div>
                </div>
              </div>

              <div className="drive-manager-surface">
                {managerView === 'files' && (
                  <section className="drive-panel question-folder-panel">
                    <div className="drive-panel-header">
                      <div>
                        <h2>Questions</h2>
                        <div className="selected-folder-summary" aria-label="Selected question folder">
                          <strong>Selected Folder: </strong>
                          <span>{selectedFolderPath}</span>
                        </div>
                        <p className="empty-text">
                          Select a grade or difficulty to filter the uploaded question files below.
                        </p>
                      </div>
                      {selectedFolder.grade_level && (
                        <button type="button" className="btn btn-secondary" onClick={clearSelectedFolder}>
                          Show All
                        </button>
                      )}
                    </div>

                    <div className="drive-folder-grid fixed-question-grid">
                      {QUESTION_FOLDER_STRUCTURE.map((gradeFolder) => {
                        const gradeSelected = selectedFolder.grade_level === gradeFolder.grade;
                        return (
                          <div
                            key={gradeFolder.grade}
                            className={`drive-folder-card fixed-question-folder ${gradeSelected ? 'selected' : ''}`}
                          >
                            <button
                              type="button"
                              className="drive-folder-card-main system-grade-button"
                              onClick={() => selectGradeFolder(gradeFolder.grade)}
                            >
                              <Folder size={28} aria-hidden="true" />
                              <strong>{gradeFolder.folderName}</strong>
                            </button>
                            <span className="file-meta">
                              Questions/{gradeFolder.folderName}/
                            </span>
                            <div className="fixed-difficulty-list" aria-label={`${gradeFolder.folderName} difficulty folders`}>
                              {gradeFolder.difficulties.map((difficulty) => {
                                const difficultySelected = gradeSelected && selectedFolder.difficulty === difficulty;
                                return (
                                  <button
                                    key={`${gradeFolder.grade}-${difficulty}`}
                                    type="button"
                                    className={`drive-action-button system-difficulty-button ${difficultySelected ? 'selected' : ''}`}
                                    onClick={() => selectDifficultyFolder(gradeFolder.grade, difficulty)}
                                  >
                                    {difficulty}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="question-folder-table-header">
                      <div>
                        <h3>Currently Viewing: {currentlyViewing}</h3>
                        <p className="empty-text">Uploaded files remain Pending until Push to Game is clicked.</p>
                      </div>
                    </div>

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
                          disabled={!isDifficultyFolderOpen}
                          onChange={(event) => handleFilterChange('math_topic', event.target.value)}
                        >
                          {!isDifficultyFolderOpen ? (
                            <option value="">Select a difficulty first</option>
                          ) : (
                            <>
                              <option value="">All topics</option>
                              {filterTopicOptions.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                            </>
                          )}
                        </select>
                      </div>
                      <div className="form-group">
                        <label className="form-label">File Type</label>
                        <select className="select-field" value={filters.file_type} onChange={(event) => handleFilterChange('file_type', event.target.value)}>
                          <option value="">All file types</option>
                          <option value="lesson">Lesson PDF File</option>
                          <option value="fixed_questions">Fixed Question File</option>
                        </select>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Status</label>
                        <select className="select-field" value={filters.status} onChange={(event) => handleFilterChange('status', event.target.value)}>
                          <option value="">All statuses</option>
                          {statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
                        </select>
                      </div>
                      {(filters.search || filters.math_topic || filters.file_type || filters.status) && (
                        <div className="form-group folder-filter-action">
                          <button type="button" className="btn btn-secondary" onClick={() => {
                            setFilters((current) => ({ ...current, search: '', math_topic: '', file_type: '', status: '' }));
                            setPage(1);
                          }}>
                            Clear Filters
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="table-report-controls">
                      <TablePrintButton
                        reportTitle="Lesson & Question Files Report"
                        reportContext={formatReportContext({ scope: selectedFolderPath, recordCount: displayedFiles.length })}
                        label="Print Report"
                        showPrintHeading={false}
                        disabled={!displayedFiles.length}
                      />
                    </div>
                    <DataTable columns={tableColumns} data={paginatedFiles.rows} emptyMessage={tableEmptyMessage} className="drive-table" />
                    {paginatedFiles.totalPages > 1 && (
                      <div className="pagination-row no-print">
                        <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={paginatedFiles.currentPage === 1}>Previous</button>
                        <span>Page {paginatedFiles.currentPage} of {paginatedFiles.totalPages}</span>
                        <button type="button" onClick={() => setPage((current) => Math.min(paginatedFiles.totalPages, current + 1))} disabled={paginatedFiles.currentPage === paginatedFiles.totalPages}>Next</button>
                      </div>
                    )}
                    <PrintableTableReport
                      title="Lesson & Question Files Report"
                      context={selectedFolderPath}
                      rows={displayedFiles}
                      columns={reportColumns}
                    />
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
                    <DataTable columns={trashColumns} data={paginatedTrashRows.rows} emptyMessage="Trash is empty." className="drive-table" />
                    {paginatedTrashRows.totalPages > 1 && (
                      <div className="pagination-row no-print">
                        <button type="button" onClick={() => setTrashPage((current) => Math.max(1, current - 1))} disabled={paginatedTrashRows.currentPage === 1}>Previous</button>
                        <span>Page {paginatedTrashRows.currentPage} of {paginatedTrashRows.totalPages}</span>
                        <button type="button" onClick={() => setTrashPage((current) => Math.min(paginatedTrashRows.totalPages, current + 1))} disabled={paginatedTrashRows.currentPage === paginatedTrashRows.totalPages}>Next</button>
                      </div>
                    )}
                  </section>
                )}

                {managerView === 'storage' && (
                  <section className="drive-panel drive-storage-view">
                    <div className="drive-panel-header">
                      <div>
                        <h2>Storage</h2>
                        <p className="empty-text">{formatLearningFileSize(managedStorageBytes)} used by managed question content.</p>
                      </div>
                    </div>
                    <div className="storage-summary">
                      <div>
                        <strong>{formatLearningFileSize(managedStorageBytes)}</strong>
                        <p className="empty-text">
                          {formatLearningFileSize(storageSummary?.source_file_bytes || 0)} source files + {formatLearningFileSize(storageSummary?.question_content_bytes || 0)} question content
                        </p>
                      </div>
                    </div>
                    <div className="storage-file-list">
                      <h3>Largest uploaded source files</h3>
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

            {showUploadForm && createPortal(
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
                      <label className="form-label required">File Type</label>
                      <select className="select-field" value={form.file_type} onChange={(event) => handleFormChange('file_type', event.target.value)}>
                        <option value="lesson">Lesson PDF File</option>
                        <option value="fixed_questions">Fixed Question File</option>
                      </select>
                    </div>
                    {!isFixedQuestionUpload && (
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
                    )}
                    <div className="form-group">
                      <label className="form-label">Destination</label>
                      <div className="fixed-destination-display">
                        {getQuestionFolderPath(form.grade_level, form.difficulty)}
                      </div>
                    </div>
                    {form.file_type === 'lesson' && (
                      <div className="form-group">
                        <label className="form-label required" htmlFor="expected-question-count">Question Count</label>
                        <input
                          id="expected-question-count"
                          name="expected_question_count"
                          type="number"
                          min="1"
                          max={MAX_LESSON_QUESTION_COUNT}
                          step="1"
                          required
                          aria-invalid={Boolean(formErrors.expected_question_count)}
                          className={`input-field ${formErrors.expected_question_count ? 'input-error' : ''}`}
                          value={form.expected_question_count}
                          onChange={(event) => handleFormChange('expected_question_count', event.target.value)}
                        />
                        {formErrors.expected_question_count && <p className="manager-inline-error" role="alert">{formErrors.expected_question_count}</p>}
                      </div>
                    )}
                    <div className="form-group">
                      <label className="form-label required">File</label>
                      <input
                        type="file"
                        accept={form.file_type === 'lesson'
                          ? '.pdf,application/pdf'
                          : '.docx,.pdf,.json,.csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,application/json,text/csv'}
                        onChange={(event) => handleFormChange('file', event.target.files[0] || null)}
                      />
                      {form.file_type === 'fixed_questions' && (
                        <p className="fixed-question-upload-help">Fixed Questions supported: DOCX, PDF. JSON/CSV remain available for developer compatibility.</p>
                      )}
                    </div>
                  </div>
                  {fixedUploadValidation && (
                    <section className="fixed-question-validation-review" aria-live="polite">
                      <h3>Needs Correction</h3>
                      <p>Correct the source document and re-upload it. Invalid question sets are not saved or publishable.</p>
                      {(fixedUploadValidation.document_errors || []).map((error) => <p key={error} className="manager-inline-error" role="alert">{error}</p>)}
                      {(fixedUploadValidation.questions || []).map((question, index) => (
                        <article key={`${question.source_index || index}-${question.question}`} className="generated-question-card invalid">
                          <strong>Question {question.source_index || index + 1}: {question.question || 'Missing question text'}</strong>
                          <ol type="A">
                            {(question.options || []).map((option, optionIndex) => <li key={`${option}-${optionIndex}`}>{option || 'Missing choice'}</li>)}
                          </ol>
                          <p>Correct answer: {question.correct_answer || 'Missing'}</p>
                          {(question.validation_errors || []).map((error) => <p key={error} className="manager-inline-error" role="alert">{error}</p>)}
                        </article>
                      ))}
                    </section>
                  )}
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
              </div>,
              document.body,
            )}

            {questionPreviewFile && (
              <div className="manager-modal-backdrop generated-questions-preview-backdrop" role="presentation" onMouseDown={closeQuestionPreview}>
                <div className="manager-modal generated-questions-preview-modal" role="dialog" aria-modal="true" aria-labelledby="generated-questions-preview-title" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="manager-modal-header generated-questions-preview-header">
                    <div>
                      <h2 id="generated-questions-preview-title">Question Review</h2>
                      <p className="question-review-metadata">File Name: {previewFile.title || previewFile.file_name}</p>
                      <p className="question-review-metadata">File Type: {previewFile.file_type === 'lesson' ? 'Lesson PDF File' : 'Fixed Question File'}</p>
                      <p className="question-review-metadata">Grade: {previewFile.grade_level} · Difficulty: {previewFile.difficulty}</p>
                      {previewFile.file_type === 'fixed_questions' && (
                        <p className="question-review-metadata">Document Lesson/Topic: {previewFile.document_topic || 'Not provided'}</p>
                      )}
                      <p className="question-review-metadata">Game Publication: {previewPublicationEligibility.label}</p>
                      {getFixedQuestionPublicationBlockReason(previewFile) && (
                        <p className="manager-inline-error" role="alert">{getFixedQuestionPublicationBlockReason(previewFile)}</p>
                      )}
                    </div>
                    <button type="button" className="icon-button" aria-label="Close generated questions preview" onClick={closeQuestionPreview}>x</button>
                  </div>
                  <div className="generated-questions-preview-body" ref={previewBodyRef}>
                    <div className="generated-questions-list">
                    {previewQuestionsLoading ? (
                      <p className="empty-text">Loading questions...</p>
                    ) : previewQuestions.length === 0 ? (
                      <>
                        {previewValidation?.is_valid === false && <p className="manager-inline-error" role="alert">Needs Correction — review the validation details before this set can be pushed to the game.</p>}
                        <p className="empty-text">No questions are available for review yet.</p>
                      </>
                    ) : (
                      <>
                        <p className="question-review-metadata">Requested: {previewFile.requested_question_count ?? 'Not specified'} · Available: {previewQuestions.length}</p>
                        {previewValidation?.is_valid === false && <p className="manager-inline-error" role="alert">Needs Correction — every question must have four distinct choices, a mapped correct answer, and matching metadata.</p>}
                        {previewValidation?.is_valid !== false && previewIsReadyForGame && <p className="question-validation-valid">Valid — this question set is ready for manual Push to Game.</p>}
                        {previewQuestions.map((question, index) => (
                          <article key={question.id || `${question.question}-${index}`} className={`generated-question-card ${question.is_valid === false ? 'invalid' : 'valid'}`}>
                            <strong>{index + 1}. {question.question}</strong>
                            <ol type="A">
                          {(question.options || []).map((option, optionIndex) => (
                            <li key={`${option}-${optionIndex}`} className={option === question.correct_answer ? 'correct-option' : ''}>
                              {option}{option === question.correct_answer ? ' (Correct)' : ''}
                            </li>
                          ))}
                            </ol>
                            <p className="question-review-metadata">Grade {question.grade_level || previewFile.grade_level} · {question.difficulty || previewFile.difficulty}</p>
                            {question.is_valid === false ? (question.validation_errors || []).map((error) => <p key={error} className="manager-inline-error" role="alert">{error}</p>) : <p className="question-validation-valid">Valid</p>}
                          </article>
                        ))}
                      </>
                    )}
                    </div>
                  </div>
                  <div className="preview-actions generated-questions-preview-footer">
                    <button type="button" className="btn btn-primary" onClick={() => downloadFile(previewFile)} disabled={!previewFile.file_url}>
                      <Download size={16} />Download Source
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={closeQuestionPreview}>Close</button>
                  </div>
                </div>
              </div>
            )}

            {replacementConfirmation && (
              <div className="manager-modal-backdrop" role="presentation" onMouseDown={() => setReplacementConfirmation(null)}>
                <div className="manager-modal replacement-confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="replace-active-question-set-title" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="manager-modal-header">
                    <div>
                      <h2 id="replace-active-question-set-title">Replace Active Question Set?</h2>
                      <p className="empty-text">This scope already has an Active question set. Replacing it supersedes the current set while preserving its history.</p>
                    </div>
                    <button type="button" className="icon-button" aria-label="Cancel replacement" onClick={() => setReplacementConfirmation(null)}>x</button>
                  </div>
                  <div className="replacement-summary-grid">
                    {[
                      ['Current Active', replacementConfirmation.replacement.current_active],
                      ['New Set', replacementConfirmation.replacement.new_set],
                    ].map(([label, set]) => (
                      <section key={label} className="replacement-summary-card">
                        <h3>{label}</h3>
                        <p><strong>{set.title}</strong></p>
                        <p className="question-review-metadata">Grade {set.grade_level} · {set.difficulty} · {set.math_topic}</p>
                        <p className="question-review-metadata">Questions: {set.question_count ?? 'Not available'}</p>
                      </section>
                    ))}
                  </div>
                  <div className="preview-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => setReplacementConfirmation(null)}>Cancel</button>
                    <button type="button" className="btn btn-primary" onClick={() => pushFileToGame(replacementConfirmation.file, { confirmReplacement: true })}>Replace &amp; Push to Game</button>
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
