import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ModalPortal from './ModalPortal';
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
  formatLearningFileSize,
  getDifficultyLevels,
  getGradeLevels,
  getLargestLearningFiles,
  getQuestionFolderStructure,
  getQuestionFolderView,
  getQuestionFolderPath,
  getGenerationStatusView,
  getQuestionReviewActionClass,
  isSupportedLearningUpload,
  isValidDifficulty,
  isValidGradeLevel,
  normalizeDifficultyValue,
  validateManualQuestionDraft,
} from './lessonQuestionManager.utils';
import { apiUrl } from '../api';
import { fetchCurriculumRegistry } from '../curriculumRegistry';
import { TablePrintButton } from './TablePrintButton';
import { PrintableTableReport } from './PrintableTableReport';
import { formatReportContext, formatTableRange, matchesTableSearch, paginateTableRows } from './tableReporting.utils';
import '../styles/lessonQuestionManager.css';

const initialFormState = {
  grade_level: '',
  difficulty: '',
  file_type: 'fixed_questions',
  expected_question_count: '',
  file: null,
};

const initialFilterState = {
  search: '',
};

const MAX_LESSON_QUESTION_COUNT = 50;
const LESSON_GENERATION_IDEMPOTENCY_STORAGE_PREFIX = 'theresians.lesson-generation.';
const AI_PAUSED_MESSAGE = 'AI generation is temporarily paused. Recorded data and available questions remain accessible.';
const GENERATION_POLL_INTERVAL_MS = 1500;
const GENERATION_POLL_LIMIT = 120;
const GENERATION_READY_ACK_PREFIX = 'theresians.lesson-generation-ready.';

const fetchLessonManagerApi = (url, options = {}) => fetch(url, {
  ...options,
  headers: {
    ...buildAuthHeaders(),
    ...(options.headers || {}),
  },
});

const waitForLessonGeneration = async (learningFileId, { signal, onProgress } = {}) => {
  for (let attempt = 0; attempt < GENERATION_POLL_LIMIT; attempt += 1) {
    if (signal?.aborted) throw new Error('Question generation status polling was cancelled.');
    const response = await fetchLessonManagerApi(lessonManagerApiUrl(`/api/learning-files/${learningFileId}/generation-status`), { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to read question generation status.');
    const learningFile = data.learningFile || {};
    if (typeof onProgress === 'function') onProgress(learningFile);
    if (learningFile.generation_status === 'ready_for_review') return learningFile;
    if (learningFile.generation_status === 'failed') throw new Error('Question generation failed. Review the generation status and try again.');
    await new Promise((resolve) => setTimeout(resolve, GENERATION_POLL_INTERVAL_MS));
  }
  throw new Error('Question generation is still running. Return to this page to continue monitoring it.');
};

const withLessonManagerScope = (url, role) => {
  if (normalizeRole(role) !== 'parent_teacher') return url;
  return `${url}${url.includes('?') ? '&' : '?'}scope=teacher`;
};

const buildLessonGenerationStorageKey = ({ file, gradeLevel, difficulty, questionCount }) => (
  `${LESSON_GENERATION_IDEMPOTENCY_STORAGE_PREFIX}${JSON.stringify({
    name: file?.name || '',
    size: Number(file?.size) || 0,
    last_modified: Number(file?.lastModified) || 0,
    grade_level: gradeLevel,
    difficulty,
    question_count: questionCount,
  })}`
);

const buildLessonSourceGenerationStorageKey = ({ sourceId, gradeLevel, difficulty, questionCount }) => (
  `${LESSON_GENERATION_IDEMPOTENCY_STORAGE_PREFIX}${JSON.stringify({
    source_learning_file_id: Number(sourceId),
    grade_level: gradeLevel,
    difficulty,
    question_count: questionCount,
  })}`
);

const createLessonGenerationIdempotencyKey = () => (
  globalThis.crypto?.randomUUID?.()
  || `lesson-${Date.now()}-${Math.random().toString(36).slice(2).padEnd(16, '0')}`
);

const getOrCreateLessonGenerationIdempotencyKey = (storageKey) => {
  const existingKey = window.sessionStorage?.getItem(storageKey);
  if (existingKey) return existingKey;
  const idempotencyKey = createLessonGenerationIdempotencyKey();
  window.sessionStorage?.setItem(storageKey, idempotencyKey);
  return idempotencyKey;
};

const clearLessonGenerationIdempotencyKey = (storageKey) => {
  if (storageKey) window.sessionStorage?.removeItem(storageKey);
};

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

function formatQuestionGradeLabel(value) {
  const grade = String(value || '').trim();
  if (!grade) return '';
  if (/^Grade\s+/i.test(grade)) return grade.replace(/^Grade\s+(?:Grade\s+)?/i, 'Grade ');
  return `Grade ${grade}`;
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
  const generationStatus = String(row?.generation_status || '').trim().toLowerCase();
  if (['queued', 'extracting', 'generating', 'validating', 'saving'].includes(generationStatus)) return 'Generating';
  if (generationStatus === 'failed') return 'Generation Failed';
  if (generationStatus === 'ready_for_review') return 'Ready for Review';
  return formatQuestionSetStatus(lifecycle.label || row?.status || (row?.published ? 'Active in Game' : 'Pending'));
}

function getPublicationEligibility(file = {}) {
  const serverEligibility = file?.validation_summary?.publication_eligibility;
  if (serverEligibility && typeof serverEligibility === 'object') {
    const code = String(serverEligibility.code || '').trim();
    const isLegacyTopicGate = /topic|scope_conflict/i.test(code);
    return {
      eligible: isLegacyTopicGate || Boolean(serverEligibility.eligible),
      label: (isLegacyTopicGate || serverEligibility.eligible)
        ? 'Eligible — Ready for Game'
        : 'Not Eligible for Game',
      reason: isLegacyTopicGate ? '' : String(serverEligibility.message || '').trim(),
      code,
    };
  }
  return {
    eligible: false,
    label: 'Eligibility unavailable',
    reason: 'Publication eligibility has not been loaded for this question set.',
  };
}

function getReviewEligibility(file = {}) {
  const serverEligibility = file?.validation_summary?.review_eligibility;
  if (serverEligibility && typeof serverEligibility === 'object') {
    return {
      eligible: Boolean(serverEligibility.eligible),
      reason: String(serverEligibility.message || '').trim(),
      code: String(serverEligibility.code || '').trim(),
    };
  }
  return getPublicationEligibility(file);
}

function getFixedQuestionPublicationBlockReason(file = {}) {
  const eligibility = getPublicationEligibility(file);
  return file.file_type === 'fixed_questions' && !eligibility.eligible
    ? eligibility.reason
    : '';
}

function getPreviewQuestionValidationErrors(question = {}) {
  const structuralErrors = Array.isArray(question.validation_errors) ? question.validation_errors : [];
  return [...new Set(structuralErrors)];
}

export default function LessonQuestionManager() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [notification, setNotification] = useState(null);
  const [curriculumRegistry, setCurriculumRegistry] = useState(null);
  const [files, setFiles] = useState([]);
  const [lessonSources, setLessonSources] = useState([]);
  const [aiRuntimeState, setAiRuntimeState] = useState({
    enabled: false,
    status: 'paused',
    code: 'AI_PAUSED',
    message: AI_PAUSED_MESSAGE,
  });
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
  const [editingPreviewQuestionId, setEditingPreviewQuestionId] = useState(null);
  const [addingPreviewQuestion, setAddingPreviewQuestion] = useState(false);
  const [previewQuestionDraft, setPreviewQuestionDraft] = useState(null);
  const [previewQuestionErrors, setPreviewQuestionErrors] = useState([]);
  const [previewQuestionSaving, setPreviewQuestionSaving] = useState(false);
  const [previewQuestionDirty, setPreviewQuestionDirty] = useState(false);
  const [approvingPreview, setApprovingPreview] = useState(false);
  const [reviewComplete, setReviewComplete] = useState(false);
  const [reviewSnapshotKey, setReviewSnapshotKey] = useState('');
  const previewBodyRef = useRef(null);
  const finalQuestionCardRef = useRef(null);
  const uploadInFlightRef = useRef(false);
  const [fixedUploadValidation, setFixedUploadValidation] = useState(null);
  const [selectedFolder, setSelectedFolder] = useState({ grade_level: '', difficulty: '' });
  const [renamingFile, setRenamingFile] = useState(null);
  const [filters, setFilters] = useState(initialFilterState);
  const [page, setPage] = useState(1);
  const [trashPage, setTrashPage] = useState(1);
  const [trashSearch, setTrashSearch] = useState('');
  const [formErrors, setFormErrors] = useState({});
  const [replacementConfirmation, setReplacementConfirmation] = useState(null);
  const [removalConfirmation, setRemovalConfirmation] = useState(null);
  const [pendingDeletion, setPendingDeletion] = useState(null);
  const [deletionReason, setDeletionReason] = useState('');
  const [deletionError, setDeletionError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [selectedLessonSourceId, setSelectedLessonSourceId] = useState('');
  const [savingLessonSource, setSavingLessonSource] = useState(false);
  const pageSize = 10;

  const showNotification = (message, type = 'success') => {
    setNotification({ message, type });
    window.setTimeout(() => setNotification(null), 5000);
  };

  useLayoutEffect(() => {
    if (questionPreviewFile && previewBodyRef.current) {
      previewBodyRef.current.scrollTop = 0;
    }
  }, [questionPreviewFile?.id, reviewSnapshotKey]);

  useLayoutEffect(() => {
    if (
      !questionPreviewFile
      || previewQuestionsLoading
      || previewQuestions.length === 0
      || !reviewSnapshotKey
      || !previewBodyRef.current
      || !finalQuestionCardRef.current
      || typeof IntersectionObserver !== 'function'
    ) {
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.target === finalQuestionCardRef.current && entry.isIntersecting)) {
        setReviewComplete(true);
      }
    }, {
      root: previewBodyRef.current,
      threshold: 0.01,
    });
    observer.observe(finalQuestionCardRef.current);
    return () => observer.disconnect();
  }, [questionPreviewFile?.id, previewQuestions.length, previewQuestionsLoading, reviewSnapshotKey]);

  const lessonManagerApiUrl = (path, role = user?.role) => withLessonManagerScope(apiUrl(path), role);

  const loadCurriculumRegistry = async ({ role } = {}) => {
    try {
      const registry = await fetchCurriculumRegistry((url, options) => (
        fetchLessonManagerApi(withLessonManagerScope(url, role), options)
      ));
      setCurriculumRegistry(registry);
    } catch (error) {
      console.error(error);
      setCurriculumRegistry(null);
      showNotification('Unable to load the curriculum registry. Grade and Difficulty selection is unavailable.', 'error');
    }
  };

  const loadFilesAndFolders = async ({ initial = false, role } = {}) => {
    try {
      if (initial) setLoading(true);
      const [filesRes, trashFilesRes, storageRes] = await Promise.all([
        fetchLessonManagerApi(lessonManagerApiUrl('/api/learning-files', role)),
        fetchLessonManagerApi(lessonManagerApiUrl('/api/learning-files/trash', role)),
        fetchLessonManagerApi(lessonManagerApiUrl('/api/learning-files/storage-summary', role)),
      ]);
      if (!filesRes.ok) throw new Error('Failed to load files');
      if (!trashFilesRes.ok) throw new Error('Failed to load trashed files');
      if (!storageRes.ok) throw new Error('Failed to load storage usage');
      const nextFiles = (await filesRes.json()).map(normalizeManagedLearningFile);
      setFiles(nextFiles);
      const newlyReady = nextFiles.find((file) => {
        if (file.generation_status !== 'ready_for_review' || !file.generated_at) return false;
        const key = `${GENERATION_READY_ACK_PREFIX}${file.id}:${file.generated_at}`;
        return !window.sessionStorage?.getItem(key);
      });
      if (newlyReady) {
        const key = `${GENERATION_READY_ACK_PREFIX}${newlyReady.id}:${newlyReady.generated_at}`;
        window.sessionStorage?.setItem(key, 'acknowledged');
        const count = Number(newlyReady.question_count ?? newlyReady.generation_completed_count);
        showNotification(`Question generation complete. ${Number.isFinite(count) ? count : 'The'} question${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} ready for review.`);
      }
      setTrashFiles((await trashFilesRes.json()).map(normalizeManagedLearningFile));
      setStorageSummary(await storageRes.json());
    } catch (error) {
      console.error(error);
      showNotification('Unable to load lesson manager data.', 'error');
    } finally {
      if (initial) setLoading(false);
    }
  };

  const loadLessonSources = async ({ role } = {}) => {
    try {
      const response = await fetchLessonManagerApi(lessonManagerApiUrl('/api/learning-files/lesson-sources', role));
      if (!response.ok) throw new Error('Failed to load lesson sources');
      const sources = await response.json();
      setLessonSources(Array.isArray(sources) ? sources.map(normalizeManagedLearningFile) : []);
    } catch (error) {
      console.error(error);
      setLessonSources([]);
    }
  };

  const loadAiRuntimeState = async ({ role } = {}) => {
    try {
      const response = await fetchLessonManagerApi(lessonManagerApiUrl('/api/learning-files/ai-status', role));
      if (!response.ok) throw new Error('Failed to load AI runtime status');
      const state = await response.json();
      setAiRuntimeState(state?.enabled === true
        ? { enabled: true, status: 'enabled' }
        : {
          enabled: false,
          status: 'paused',
          code: 'AI_PAUSED',
          message: state?.message || AI_PAUSED_MESSAGE,
        });
    } catch (error) {
      console.error(error);
      setAiRuntimeState({
        enabled: false,
        status: 'paused',
        code: 'AI_PAUSED',
        message: AI_PAUSED_MESSAGE,
      });
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
    loadCurriculumRegistry({ role });
    loadFilesAndFolders({ initial: true, role });
    loadLessonSources({ role });
    loadAiRuntimeState({ role });
  }, [navigate]);

  const folderView = useMemo(() => getQuestionFolderView(files, {
    grade_level: selectedFolder.grade_level,
    difficulty: selectedFolder.difficulty,
  }, curriculumRegistry), [curriculumRegistry, files, selectedFolder.difficulty, selectedFolder.grade_level]);
  const gradeLevels = useMemo(() => getGradeLevels(curriculumRegistry), [curriculumRegistry]);
  const difficultyLevels = useMemo(() => getDifficultyLevels(curriculumRegistry), [curriculumRegistry]);
  const questionFolderStructure = useMemo(() => getQuestionFolderStructure(curriculumRegistry), [curriculumRegistry]);
  const uploadType = form.file_type;
  const aiGenerationPaused = aiRuntimeState.enabled !== true;
  const selectedFolderPath = selectedFolder.grade_level
    ? `Questions / ${selectedFolder.grade_level}${selectedFolder.difficulty ? ` / ${selectedFolder.difficulty}` : ''}`
    : 'Questions';
  const currentlyViewing = selectedFolder.grade_level
    ? `${selectedFolder.grade_level}${selectedFolder.difficulty ? ` - ${selectedFolder.difficulty}` : ''}`
    : 'All Question Files';
  const displayedFiles = useMemo(() => folderView.files.filter((file) => matchesTableSearch({
    ...file,
    source_label: file.source_label || (file.file_type === 'lesson' ? 'Lesson PDF or PPTX File' : 'Fixed Question File'),
    lifecycle_status: getQuestionSetStatus(file),
    modified_date: formatUploadDate(file.published_at || file.generated_at || file.uploaded_at),
  }, filters.search, [
    'title',
    'file_name',
    'grade_level',
    'difficulty',
    'math_topic',
    'document_topic',
    'folder_name',
    'file_type',
    'source_label',
    'lifecycle_status',
    'modified_date',
  ])), [filters.search, folderView.files]);
  const paginatedFiles = paginateTableRows(displayedFiles, page, pageSize);
  const previewFile = questionPreviewDetails || questionPreviewFile;
  const previewGenerationStatus = getGenerationStatusView(previewFile || {});
  const previewPublicationEligibility = getPublicationEligibility(previewFile || {});
  const previewReviewEligibility = getReviewEligibility(previewFile || {});
  const previewApprovalRequired = previewFile?.approval_status === 'review_required';
  const previewCanShowApprove = ['admin', 'teacher', 'parent_teacher'].includes(normalizeRole(user?.role))
    && previewApprovalRequired;
  const previewCanApprove = previewCanShowApprove
    && previewReviewEligibility.eligible
    && reviewComplete
    && !approvingPreview;
  const previewIsReadyForGame = previewValidation?.is_valid !== false && previewPublicationEligibility.eligible;
  const reportColumns = [
    { header: 'No.', value: (_, index) => index + 1 },
    { header: 'File / Question Set Name', value: (row) => row.generated_question_set_name || row.title || row.file_name },
    { header: 'Grade', value: (row) => row.grade_level },
    { header: 'Difficulty', value: (row) => row.difficulty },
    { header: 'File Type / Source', value: (row) => row.source_label || (row.file_type === 'lesson' ? 'Lesson PDF or PPTX File' : 'Fixed Question File') },
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
  ].sort((left, right) => new Date(right.deleted_at || 0) - new Date(left.deleted_at || 0))
    .filter((row) => matchesTableSearch(row, trashSearch, [
      'trashName', 'title', 'file_name', 'grade_level', 'difficulty', 'math_topic', 'file_type', 'deleted_at',
    ])), [trashFiles, trashSearch]);
  const paginatedTrashRows = paginateTableRows(trashRows, trashPage, pageSize);

  useEffect(() => {
    if (trashPage !== paginatedTrashRows.currentPage) setTrashPage(paginatedTrashRows.currentPage);
  }, [paginatedTrashRows.currentPage, trashPage]);

  useEffect(() => {
    setTrashPage(1);
  }, [trashSearch]);

  const handleFormChange = (field, value) => {
    setUploadError('');
    setFormErrors((current) => ({ ...current, [field]: '' }));
    if (field === 'file' || field === 'file_type') setFixedUploadValidation(null);
    if (field === 'file_type' && value !== 'lesson') setSelectedLessonSourceId('');
    setForm((prev) => {
      if (field === 'grade_level' || field === 'difficulty') {
        const gradeLevel = field === 'grade_level' ? value : prev.grade_level;
        const difficulty = field === 'difficulty' ? value : prev.difficulty;
        return {
          ...prev,
          grade_level: gradeLevel,
          difficulty,
        };
      }
      if (field === 'file_type') {
        return {
          ...prev,
          file_type: value,
          expected_question_count: value === 'lesson' ? prev.expected_question_count : '',
        };
      }
      return { ...prev, [field]: value };
    });
  };

  const handleFilterChange = (field, value) => {
    setPage(1);
    setFilters((prev) => {
      return { ...prev, [field]: value };
    });
  };

  const resetForm = () => {
    setForm(initialFormState);
    setSelectedLessonSourceId('');
    setFormErrors({});
    setFixedUploadValidation(null);
    setUploadError('');
  };

  const saveLessonSource = async () => {
    if (uploading || savingLessonSource || uploadInFlightRef.current) return;
    if (uploadType !== 'lesson' || !form.file) {
      showNotification('Choose a Lesson PDF or PPTX before saving a reusable source.', 'error');
      return;
    }
    if (!isSupportedLearningUpload(form.file.name, 'lesson')) {
      showNotification('Lesson sources must be PDF or PPTX files.', 'error');
      return;
    }
    const payload = new FormData();
    payload.append('title', deriveUploadTitle(form.file));
    payload.append('uploaded_by', user.id);
    payload.append('file', form.file);
    try {
      setSavingLessonSource(true);
      const response = await fetchLessonManagerApi(lessonManagerApiUrl('/api/learning-files/lesson-sources'), {
        method: 'POST',
        body: payload,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save the Lesson source.');
      const source = normalizeManagedLearningFile(data.lessonSource || {});
      setLessonSources((current) => [source, ...current.filter((item) => item.id !== source.id)]);
      setSelectedLessonSourceId(String(source.id));
      showNotification(aiGenerationPaused
        ? 'Lesson source saved. AI generation is paused; no question set was created.'
        : 'Lesson source saved. Select its Grade, Difficulty, and Question Count to generate a child set.');
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Unable to save the Lesson source.', 'error');
    } finally {
      setSavingLessonSource(false);
    }
  };

  const generateQuestionSetFromLessonSource = async (requestedCount) => {
    const sourceId = Number(selectedLessonSourceId);
    if (!Number.isSafeInteger(sourceId) || sourceId < 1) {
      showNotification('Select a reusable Lesson PDF or PPTX source first.', 'error');
      return;
    }
    const storageKey = buildLessonSourceGenerationStorageKey({
      sourceId,
      gradeLevel: form.grade_level,
      difficulty: form.difficulty,
      questionCount: requestedCount,
    });
    const idempotencyKey = getOrCreateLessonGenerationIdempotencyKey(storageKey);
    try {
      setUploadError('');
      uploadInFlightRef.current = true;
      setUploading(true);
      const response = await fetchLessonManagerApi(
        lessonManagerApiUrl(`/api/learning-files/lesson-sources/${sourceId}/generate`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({
            grade_level: form.grade_level,
            difficulty: form.difficulty,
            expected_question_count: requestedCount,
          }),
        }
      );
      const data = await response.json();
      if (!response.ok) {
        if (data.code !== 'AI_GENERATION_IN_PROGRESS') clearLessonGenerationIdempotencyKey(storageKey);
        throw new Error(data.error || 'Question generation failed.');
      }
      if (data.code === 'AI_GENERATION_QUEUED' || data.code === 'AI_GENERATION_IN_PROGRESS') {
        showNotification('Question generation is in progress. This page will update when it is ready.', 'info');
        await waitForLessonGeneration(data.learningFile?.id, {
          onProgress: (learningFile) => {
            const completed = Number(learningFile.generation_completed_count || 0);
            const total = Number(learningFile.requested_question_count || requestedCount);
            const stage = learningFile.generation_stage === 'saving' ? 'Saving draft questions' : 'Generating questions';
            showNotification(`${stage} ${Math.min(completed, total)} / ${total}`, 'info');
          },
        });
      }
      await loadFilesAndFolders();
      if (data.code === 'AI_GENERATION_IN_PROGRESS') {
        showNotification('Question generation is already in progress for this Lesson source.', 'info');
        return;
      }
      clearLessonGenerationIdempotencyKey(storageKey);
      showNotification('Generated question set is Ready for Review.');
      resetForm();
      setShowUploadForm(false);
    } catch (error) {
      console.error(error);
      const message = error.message || 'Question generation failed. Please try again.';
      setUploadError(message);
      showNotification(message, 'error');
    } finally {
      uploadInFlightRef.current = false;
      setUploading(false);
    }
  };

  const handleUpload = async (event) => {
    event.preventDefault();
    if (uploading || uploadInFlightRef.current) return;
    const usingReusableLessonSource = uploadType === 'lesson' && Boolean(selectedLessonSourceId);
    if (!form.grade_level || !form.difficulty || (!usingReusableLessonSource && !form.file)) {
      showNotification(usingReusableLessonSource
        ? 'Grade level and difficulty are required.'
        : 'Grade level, difficulty, and file are required.', 'error');
      return;
    }
    if (!curriculumRegistry) {
      showNotification('The curriculum registry is still loading. Try again in a moment.', 'error');
      return;
    }
    if (!uploadType || (!usingReusableLessonSource && !isSupportedLearningUpload(form.file.name, uploadType))) {
      showNotification('Lesson files must be PDF or PPTX. Fixed Questions support DOCX or PDF documents.', 'error');
      return;
    }
    if (
      !isValidGradeLevel(form.grade_level, curriculumRegistry)
      || !isValidDifficulty(form.difficulty, curriculumRegistry)
    ) {
      showNotification('Invalid grade level or difficulty for this Mathematics content.', 'error');
      return;
    }
    if (uploadType === 'lesson' && aiGenerationPaused) {
      if (usingReusableLessonSource) {
        setUploadError(aiRuntimeState.message || AI_PAUSED_MESSAGE);
        return;
      }
      await saveLessonSource();
      return;
    }
    const requestedCount = String(form.expected_question_count || '').trim();
    if (uploadType === 'lesson' && (!/^\d+$/.test(requestedCount) || Number(requestedCount) < 1 || Number(requestedCount) > MAX_LESSON_QUESTION_COUNT)) {
      setFormErrors({ expected_question_count: `Question Count must be a whole number between 1 and ${MAX_LESSON_QUESTION_COUNT}.` });
      if (!requestedCount) {
        setFormErrors({ expected_question_count: 'Question Count is required for Lesson PDF or PPTX files.' });
      }
      return;
    }
    if (usingReusableLessonSource) {
      await generateQuestionSetFromLessonSource(requestedCount);
      return;
    }

    const payload = new FormData();
    payload.append('title', deriveUploadTitle(form.file));
    payload.append('grade_level', form.grade_level);
    payload.append('difficulty', form.difficulty);
    payload.append('file_type', uploadType);
    payload.append('uploaded_by', user.id);
    if (uploadType === 'lesson') {
      payload.append('expected_question_count', requestedCount);
    }
    payload.append('file', form.file);

    const lessonGenerationStorageKey = uploadType === 'lesson'
      ? buildLessonGenerationStorageKey({
        file: form.file,
        gradeLevel: form.grade_level,
        difficulty: form.difficulty,
        questionCount: requestedCount,
      })
      : null;
    const lessonGenerationIdempotencyKey = lessonGenerationStorageKey
      ? getOrCreateLessonGenerationIdempotencyKey(lessonGenerationStorageKey)
      : null;

    try {
      setUploadError('');
      uploadInFlightRef.current = true;
      setUploading(true);
      const response = await fetchLessonManagerApi(lessonManagerApiUrl('/api/learning-files/upload'), {
        method: 'POST',
        body: payload,
        ...(lessonGenerationIdempotencyKey ? {
          headers: { 'Idempotency-Key': lessonGenerationIdempotencyKey },
        } : {}),
      });
      const data = await response.json();
      if (!response.ok) {
        if (lessonGenerationStorageKey && data.code !== 'AI_GENERATION_IN_PROGRESS') {
          clearLessonGenerationIdempotencyKey(lessonGenerationStorageKey);
        }
        if (data.code === 'FIXED_QUESTION_VALIDATION_FAILED') {
          setFixedUploadValidation({
            document_errors: Array.isArray(data.document_errors) ? data.document_errors : [],
            questions: Array.isArray(data.questions) ? data.questions : [],
          });
          return;
        }
        throw new Error(data.error || 'Upload failed.');
      }
      if (data.code === 'AI_GENERATION_IN_PROGRESS') {
        await loadFilesAndFolders();
        showNotification('Question generation is already in progress for this lesson.', 'info');
        return;
      }
      if (data.code === 'AI_GENERATION_QUEUED') {
        await loadFilesAndFolders();
        showNotification('Lesson uploaded. Question generation is in progress and can be monitored after refresh.', 'info');
        clearLessonGenerationIdempotencyKey(lessonGenerationStorageKey);
        resetForm();
        setShowUploadForm(false);
        return;
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
      clearLessonGenerationIdempotencyKey(lessonGenerationStorageKey);
      resetForm();
      setShowUploadForm(false);
    } catch (error) {
      console.error(error);
      const message = error.message || 'Upload failed. Please try again.';
      setUploadError(message);
      showNotification(message, 'error');
    } finally {
      uploadInFlightRef.current = false;
      setUploading(false);
    }
  };

  const closeDeletionDialog = () => {
    if (deleting) return;
    setPendingDeletion(null);
    setDeletionReason('');
    setDeletionError('');
  };

  const openDeletionDialog = (request) => {
    setPendingDeletion(request);
    setDeletionReason('');
    setDeletionError('');
  };

  const confirmDeletion = async () => {
    if (!pendingDeletion || deleting) return;
    const reason = String(deletionReason || '').trim();
    if (!reason) {
      setDeletionError('A deletion reason is required.');
      return;
    }

    setDeleting(true);
    try {
      let response;
      let data;
      if (pendingDeletion.kind === 'file-trash') {
        response = await fetchLessonManagerApi(lessonManagerApiUrl(`/api/learning-files/${pendingDeletion.file.id}`), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Delete failed');
        setFiles((current) => current.filter((item) => item.id !== pendingDeletion.file.id));
        await loadFilesAndFolders();
        showNotification('File deleted.');
      } else if (pendingDeletion.kind === 'file-permanent') {
        response = await fetchLessonManagerApi(lessonManagerApiUrl(`/api/learning-files/${pendingDeletion.file.id}/permanent`), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Permanent delete failed');
        showNotification('File permanently deleted.');
        await loadFilesAndFolders();
      } else if (pendingDeletion.kind === 'question') {
        response = await fetchLessonManagerApi(lessonManagerApiUrl(`/api/learning-files/${pendingDeletion.file.id}/questions/${pendingDeletion.question.id}`), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to delete this question.');
        setPreviewQuestions((current) => current.filter((item) => item.id !== pendingDeletion.question.id));
        if (data.file) setQuestionPreviewDetails(normalizeManagedLearningFile(data.file));
        if (data.validation) setPreviewValidation(data.validation);
        if (data.review_fingerprint) setReviewSnapshotKey(String(data.review_fingerprint));
        setReviewComplete(false);
        showNotification('Question deleted. Review approval is required again before Push to Game.');
      } else if (pendingDeletion.kind === 'trash-bulk') {
        response = await fetchLessonManagerApi(lessonManagerApiUrl('/api/learning-files/trash'), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_ids: pendingDeletion.fileIds, reason }),
        });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to empty Trash.');
        showNotification('Trash emptied.');
        await loadFilesAndFolders();
      }
      setPendingDeletion(null);
      setDeletionReason('');
      setDeletionError('');
    } catch (error) {
      console.error(error);
      setDeletionError(error.message || 'Deletion failed.');
    } finally {
      setDeleting(false);
    }
  };

  const moveFileToTrash = (file) => {
    if (file.published || file.publish_status === 'active') {
      showNotification('This question set is Active in Game. Remove from Game before deleting this question set.', 'error');
      return;
    }
    openDeletionDialog({
      kind: 'file-trash',
      file,
      title: `Delete "${file.title}" from Pending question sets?`,
      scope: 'Pending question set and its managed source records',
      actionLabel: 'Delete Question Set',
    });
  };

  const restoreFile = async (file) => {
    try {
      const response = await fetchLessonManagerApi(lessonManagerApiUrl(`/api/learning-files/${file.id}/restore`), { method: 'POST' });
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

  const permanentDeleteFile = (file) => {
    openDeletionDialog({
      kind: 'file-permanent',
      file,
      title: `Permanently delete "${file.title}"?`,
      scope: 'Trashed question set and all dependent managed question records',
      actionLabel: 'Delete Permanently',
      irreversible: true,
    });
  };

  const removeFileFromGame = async (file) => {
    try {
      const response = await fetchLessonManagerApi(lessonManagerApiUrl(`/api/questions/unpublish/${file.id}`), {
        method: 'POST',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Remove from Game failed');
      const removedFile = normalizeManagedLearningFile(data.learningFile || {
        ...file,
        published: false,
        publish_status: 'staged',
      });
      setFiles((current) => current.map((item) => (item.id === removedFile.id ? removedFile : item)));
      if (questionPreviewDetails?.id === removedFile.id) setQuestionPreviewDetails(removedFile);
      setRemovalConfirmation(null);
      await loadFilesAndFolders();
      showNotification(data.message || 'Question set removed from Game.');
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Remove from Game failed.', 'error');
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
    if (previewQuestionDirty && !window.confirm('Discard unsaved question changes?')) return;
    setQuestionPreviewFile(null);
    setQuestionPreviewDetails(null);
    setPreviewQuestions([]);
    setPreviewValidation(null);
    setPreviewQuestionsLoading(false);
    setApprovingPreview(false);
    setReviewComplete(false);
    setReviewSnapshotKey('');
    setEditingPreviewQuestionId(null);
    setAddingPreviewQuestion(false);
    setPreviewQuestionDraft(null);
    setPreviewQuestionErrors([]);
    setPreviewQuestionSaving(false);
    setPreviewQuestionDirty(false);
  };

  const openQuestionSetPreview = async (file) => {
    setQuestionPreviewFile(file);
    setQuestionPreviewDetails(null);
    setPreviewQuestions([]);
    setPreviewValidation(null);
    setPreviewQuestionsLoading(true);
    setApprovingPreview(false);
    setReviewComplete(false);
    setReviewSnapshotKey('');
    setEditingPreviewQuestionId(null);
    setAddingPreviewQuestion(false);
    setPreviewQuestionDraft(null);
    setPreviewQuestionErrors([]);
    setPreviewQuestionDirty(false);
    try {
      const response = await fetchLessonManagerApi(lessonManagerApiUrl(`/api/learning-files/${file.id}/questions`));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to preview generated questions.');
      setQuestionPreviewDetails(data.file || file);
      setPreviewQuestions(Array.isArray(data.questions) ? data.questions : []);
      setPreviewValidation(data.validation || null);
      setReviewSnapshotKey(String(data.review_fingerprint || `${file.id}:${(data.questions || []).map((question) => question.id || question.question || '').join('|')}`));
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Unable to preview generated questions.', 'error');
    } finally {
      setPreviewQuestionsLoading(false);
    }
  };

  const beginPreviewQuestionEdit = (question) => {
    const options = Array.isArray(question.options) ? question.options.slice(0, 4) : [];
    while (options.length < 4) options.push('');
    setEditingPreviewQuestionId(question.id);
    setAddingPreviewQuestion(false);
    setPreviewQuestionDraft({
      question: String(question.question || ''),
      options,
      correct_answer: String(question.correct_answer || ''),
      math_topic: String(question.math_topic || previewFile?.math_topic || ''),
      topic_id: question.topic_id || previewFile?.topic_id || null,
    });
    setPreviewQuestionErrors([]);
    setPreviewQuestionDirty(false);
  };

  const beginPreviewQuestionAdd = () => {
    if (!previewFile || previewQuestionsLoading || previewGenerationStatus.inProgress || previewFile.published || previewFile.publish_status === 'active') return;
    setEditingPreviewQuestionId(null);
    setAddingPreviewQuestion(true);
    setPreviewQuestionDraft({
      question: '',
      options: ['', '', '', ''],
      correct_answer: '',
      math_topic: String(previewFile.math_topic || ''),
      topic_id: previewFile.topic_id || null,
    });
    setPreviewQuestionErrors([]);
    setPreviewQuestionDirty(false);
  };

  const updatePreviewQuestionDraft = (field, value) => {
    setPreviewQuestionDraft((current) => ({ ...current, [field]: value }));
    setPreviewQuestionDirty(true);
    setPreviewQuestionErrors([]);
  };

  const updatePreviewQuestionOption = (optionIndex, value) => {
    setPreviewQuestionDraft((current) => {
      const options = [...current.options];
      const priorValue = options[optionIndex];
      options[optionIndex] = value;
      return {
        ...current,
        options,
        correct_answer: current.correct_answer === priorValue ? value : current.correct_answer,
      };
    });
    setPreviewQuestionDirty(true);
    setPreviewQuestionErrors([]);
  };

  const validatePreviewQuestionDraft = (draft) => validateManualQuestionDraft(draft);

  const savePreviewQuestion = async () => {
    if (!previewFile || (!editingPreviewQuestionId && !addingPreviewQuestion) || previewQuestionSaving) return;
    const errors = validatePreviewQuestionDraft(previewQuestionDraft);
    if (errors.length > 0) {
      setPreviewQuestionErrors(errors);
      return;
    }
    setPreviewQuestionSaving(true);
    try {
      const payload = {
        question: previewQuestionDraft.question.trim(),
        options: previewQuestionDraft.options.map((option) => option.trim()),
        correct_answer: previewQuestionDraft.correct_answer.trim(),
        math_topic: previewQuestionDraft.math_topic.trim() || null,
        topic_id: previewQuestionDraft.topic_id || null,
      };
      const endpoint = editingPreviewQuestionId
        ? `/api/learning-files/${previewFile.id}/questions/${editingPreviewQuestionId}`
        : `/api/learning-files/${previewFile.id}/questions`;
      const response = await fetchLessonManagerApi(lessonManagerApiUrl(endpoint), {
        method: editingPreviewQuestionId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save this question.');
      setPreviewQuestions((current) => editingPreviewQuestionId
        ? current.map((question) => (question.id === editingPreviewQuestionId ? { ...question, ...data.question } : question))
        : [...current, data.question]);
      if (data.file) setQuestionPreviewDetails(normalizeManagedLearningFile(data.file));
      if (data.validation) setPreviewValidation(data.validation);
      if (data.review_fingerprint) setReviewSnapshotKey(String(data.review_fingerprint));
      setReviewComplete(false);
      setEditingPreviewQuestionId(null);
      setAddingPreviewQuestion(false);
      setPreviewQuestionDraft(null);
      setPreviewQuestionDirty(false);
      showNotification(`${editingPreviewQuestionId ? 'Question saved' : 'Question added'}. Review approval is required again before Push to Game.`);
    } catch (error) {
      setPreviewQuestionErrors([error.message || 'Unable to save this question.']);
    } finally {
      setPreviewQuestionSaving(false);
    }
  };

  const deletePreviewQuestion = (question, index) => {
    if (!previewFile || previewFile.published || previewFile.publish_status === 'active') return;
    openDeletionDialog({
      kind: 'question',
      file: previewFile,
      question,
      title: `Delete Question ${index + 1} from this pending question set?`,
      scope: `${previewFile.title || previewFile.file_name} · pending question set`,
      target: question.question,
      actionLabel: 'Delete Question',
    });
  };

  const approvePreviewQuestionSet = async () => {
    if (!previewFile || !previewCanApprove) return;
    try {
      setApprovingPreview(true);
      const response = await fetchLessonManagerApi(lessonManagerApiUrl(`/api/learning-files/${previewFile.id}/approve`), {
        method: 'POST',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to approve this question set.');
      const responseFile = data.learningFile && typeof data.learningFile === 'object' ? data.learningFile : {};
      const responseValidation = data.validation || responseFile.validation_summary || previewFile.validation_summary;
      const approvedFile = normalizeManagedLearningFile({
        ...previewFile,
        ...responseFile,
        ...(responseValidation ? { validation_summary: responseValidation } : {}),
      });
      setFiles((current) => current.map((file) => (file.id === approvedFile.id ? approvedFile : file)));
      setQuestionPreviewDetails(approvedFile);
      setPreviewValidation(responseValidation || previewValidation);
      await loadFilesAndFolders();
      showNotification('Question set approved. Push to Game remains a separate action.');
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Unable to approve this question set.', 'error');
    } finally {
      setApprovingPreview(false);
    }
  };

  const saveFileDetails = async () => {
    if (!editingFile.title || !editingFile.grade_level || !editingFile.difficulty) {
      showNotification('Complete the file details before saving.', 'error');
      return;
    }
    if (
      !isValidGradeLevel(editingFile.grade_level, curriculumRegistry)
      || !isValidDifficulty(editingFile.difficulty, curriculumRegistry)
    ) {
      showNotification('Invalid file details for this Mathematics grade and difficulty.', 'error');
      return;
    }
    try {
      const response = await fetchLessonManagerApi(lessonManagerApiUrl(`/api/learning-files/${editingFile.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editingFile.title,
          grade_level: editingFile.grade_level,
          difficulty: editingFile.difficulty,
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

  const handleEmptyTrash = () => {
    if (trashRows.length === 0) return;
    openDeletionDialog({
      kind: 'trash-bulk',
      fileIds: trashFiles.map((file) => file.id),
      title: 'Permanently delete every file in Trash?',
      scope: `${trashFiles.length} trashed question sets and their dependent managed records`,
      actionLabel: 'Delete All Trash',
      irreversible: true,
    });
  };

  const openUploadModal = () => {
    setShowNewMenu(false);
    const gradeLevel = selectedFolder.grade_level || '';
    const difficulty = selectedFolder.difficulty || '';
    setForm({
      ...initialFormState,
      grade_level: gradeLevel,
      difficulty,
    });
    setSelectedLessonSourceId('');
    setUploadError('');
    setShowUploadForm(true);
  };

  const switchManagerView = (nextView) => {
    setManagerView(nextView);
    setShowNewMenu(false);
  };

  const pushFileToGame = async (file, { confirmReplacement = false } = {}) => {
    try {
      const response = await fetchLessonManagerApi(lessonManagerApiUrl(`/api/questions/publish/${file.id}`), {
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
    setPage(1);
  };

  const selectDifficultyFolder = (gradeLevel, difficulty) => {
    setSelectedFolder({ grade_level: gradeLevel, difficulty });
    setPage(1);
  };

  const clearSelectedFolder = () => {
    setSelectedFolder({ grade_level: '', difficulty: '' });
    setPage(1);
  };

  const saveRenamedFile = async () => {
    const title = String(renamingFile?.title || '').trim();
    if (!title) {
      showNotification('File name is required.', 'error');
      return;
    }

    try {
      const response = await fetchLessonManagerApi(lessonManagerApiUrl(`/api/learning-files/${renamingFile.id}/rename`), {
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
              <span className="file-meta">Source topic metadata (optional): {row.math_topic}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'file_type',
      header: 'File Type',
      className: 'drive-type-column',
      render: (value, row) => (
        <div className="manager-file-type-cell">
          <span>{value === 'lesson' ? 'Lesson PDF or PPTX File' : 'Fixed Question File'}</span>
          {row.source_label && <span className="file-meta">{row.source_label}</span>}
        </div>
      ),
    },
    {
      key: 'question_count',
      header: 'Question Count',
      className: 'drive-count-column',
      render: (value, row) => {
        const generation = getGenerationStatusView(row);
        if (generation.inProgress && generation.progressLabel) return `— (${generation.progressLabel})`;
        return Number.isInteger(Number(value)) ? Number(value) : (row.file_type === 'lesson' ? row.requested_question_count || '-' : '-');
      },
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
        const failureLabel = String(lifecycle.failureLabel || '').trim();
        const lastGameFetch = formatGameFetchDate(row.last_fetched_at);
        return (
          <div className="manager-status-stack">
            <span className={`manager-status-pill ${tone}`}>{label}</span>
            {publishLabel && publishLabel !== label && <span className="manager-status-detail">{publishLabel}</span>}
            {failureLabel && <span className="manager-status-detail">{failureLabel}</span>}
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
        const isActiveQuestionSet = row.published
          || row.publish_status === 'active'
          || row.lifecycle?.code === 'active'
          || row.lifecycle?.tone === 'active';
        const fixedQuestionPublicationBlockReason = getFixedQuestionPublicationBlockReason(row);
        const publicationEligibility = getPublicationEligibility(row);
        const fixedQuestionPublicationBlocked = row.file_type === 'fixed_questions' && !publicationEligibility.eligible;
        const generationStatus = getGenerationStatusView(row);
        const pushDisabled = isActiveQuestionSet
          || generationStatus.inProgress
          || generationStatus.failed
          || row.validation_summary?.is_valid === false
          || !publicationEligibility.eligible;
        return (
          <div className="drive-row-actions">
          <button
            type="button"
            className="drive-action-button"
            onClick={() => setRenamingFile(row)}
            disabled={isActiveQuestionSet}
            title={isActiveQuestionSet ? 'Remove from Game before editing this question set.' : undefined}
          ><FilePenLine size={16} />Rename</button>
          <button type="button" className="drive-action-button" onClick={() => openQuestionSetPreview(row)}><FileText size={16} />Preview</button>
          <button
            type="button"
            className="drive-action-button danger"
            onClick={() => moveFileToTrash(row)}
            disabled={isActiveQuestionSet}
            title={isActiveQuestionSet ? 'Remove from Game before deleting this question set.' : undefined}
          ><Trash2 size={16} />Delete</button>
          {isActiveQuestionSet ? (
            <button
              type="button"
              className="drive-action-button warning"
              onClick={() => setRemovalConfirmation(row)}
          ><Upload size={16} />Remove from Game</button>
          ) : (
            <button
              type="button"
              className="drive-action-button primary"
              onClick={() => pushFileToGame(row)}
              disabled={pushDisabled}
              title={fixedQuestionPublicationBlockReason || (row.validation_summary?.is_valid === false ? 'Review and correct this question set before Push to Game.' : undefined)}
            ><Upload size={16} />{fixedQuestionPublicationBlocked && publicationEligibility.code !== 'REVIEW_APPROVAL_REQUIRED' ? 'Not Eligible for Game' : 'Push to Game'}</button>
          )}
          {!isActiveQuestionSet && !publicationEligibility.eligible && (
            <span className="manager-action-helper">{publicationEligibility.reason || fixedQuestionPublicationBlockReason}</span>
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
          <button type="button" className="drive-action-button danger" onClick={() => permanentDeleteFile(row)}>
            <Trash2 size={16} />Permanently Delete
          </button>
        </div>
      ),
    },
  ];

  const trashReportColumns = [
    { header: 'No.', value: (_, index) => index + 1 },
    { header: 'Name', value: (row) => row.trashName || row.title || row.file_name },
    { header: 'Type', value: (row) => row.trashType || 'File' },
    { header: 'Grade', value: (row) => row.grade_level || '-' },
    { header: 'Difficulty', value: (row) => row.difficulty || '-' },
    { header: 'Deleted date', value: (row) => formatUploadDate(row.deleted_at) },
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
            {aiGenerationPaused && (
              <div className="manager-ai-pause-banner" role="status">
                {aiRuntimeState.message || AI_PAUSED_MESSAGE}
              </div>
            )}
            {notification && (
              <div className={`manager-notification ${notification.type === 'error' ? 'notification-error' : 'notification-success'}`} role="status">
                {notification.message}
              </div>
            )}

            {pendingDeletion && (
              <ModalPortal onClose={closeDeletionDialog}>
                <div className="manager-modal-backdrop" role="presentation" onMouseDown={closeDeletionDialog}>
                  <div className="manager-modal question-manager-deletion-dialog" role="dialog" aria-modal="true" aria-labelledby="question-manager-deletion-title" onMouseDown={(event) => event.stopPropagation()}>
                    <div className="manager-modal-header">
                      <div>
                        <h2 id="question-manager-deletion-title">{pendingDeletion.title}</h2>
                        {pendingDeletion.target && <p><strong>Target:</strong> {pendingDeletion.target}</p>}
                        <p><strong>Scope:</strong> {pendingDeletion.scope}</p>
                        {pendingDeletion.irreversible && <p className="manager-inline-error">This action is irreversible.</p>}
                      </div>
                      <button type="button" className="icon-button" aria-label="Cancel deletion" onClick={closeDeletionDialog} disabled={deleting}>x</button>
                    </div>
                    <label className="form-label" htmlFor="question-manager-deletion-reason">Reason for deletion <span aria-hidden="true">*</span></label>
                    <textarea
                      id="question-manager-deletion-reason"
                      name="deletion-reason"
                      className={deletionError ? 'input-field error' : 'input-field'}
                      value={deletionReason}
                      onChange={(event) => {
                        setDeletionReason(event.target.value.slice(0, 1000));
                        if (deletionError) setDeletionError('');
                      }}
                      maxLength={1000}
                      rows={4}
                      aria-invalid={Boolean(deletionError)}
                      disabled={deleting}
                    />
                    {deletionError && <p className="manager-inline-error" role="alert">{deletionError}</p>}
                    <div className="preview-actions">
                      <button type="button" className="btn btn-secondary" onClick={closeDeletionDialog} disabled={deleting}>Cancel</button>
                      <button type="button" className="btn btn-danger" onClick={confirmDeletion} disabled={deleting}>
                        {deleting ? 'Deleting...' : pendingDeletion.actionLabel}
                      </button>
                    </div>
                  </div>
                </div>
              </ModalPortal>
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
                      {questionFolderStructure.map((gradeFolder) => {
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
                        <label className="form-label" htmlFor="question-library-search">Search Files</label>
                        <input
                          id="question-library-search"
                          type="text"
                          className="input-field"
                          value={filters.search}
                          onChange={(event) => handleFilterChange('search', event.target.value)}
                          placeholder="Search name, grade, difficulty, type, status, topic, or date"
                        />
                      </div>
                      {filters.search && (
                        <div className="form-group folder-filter-action">
                          <button type="button" className="btn btn-secondary" onClick={() => {
                            setFilters({ search: '' });
                            setPage(1);
                          }}>
                            Clear Search
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
                      />
                    </div>
                    <DataTable columns={tableColumns} data={paginatedFiles.rows} emptyMessage={tableEmptyMessage} className="drive-table" />
                    <div className="pagination-row no-print">
                      <span>{formatTableRange(paginatedFiles)}</span>
                      <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={paginatedFiles.currentPage === 1}>Previous</button>
                      <span>Page {paginatedFiles.currentPage} of {paginatedFiles.totalPages}</span>
                      <button type="button" onClick={() => setPage((current) => Math.min(paginatedFiles.totalPages, current + 1))} disabled={paginatedFiles.currentPage === paginatedFiles.totalPages}>Next</button>
                    </div>
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
                      <button type="button" className="btn btn-danger" onClick={handleEmptyTrash} disabled={trashRows.length === 0}>
                        <Trash2 size={16} />Empty Trash
                      </button>
                    </div>
                    <div className="manager-modal-fields trash-file-filters">
                      <div className="form-group">
                        <label className="form-label" htmlFor="question-trash-search">Search Trash</label>
                        <input
                          id="question-trash-search"
                          type="text"
                          className="input-field"
                          value={trashSearch}
                          onChange={(event) => setTrashSearch(event.target.value)}
                          placeholder="Search name, grade, difficulty, type, topic, or deleted date"
                        />
                      </div>
                    </div>
                    <div className="table-report-controls">
                      <TablePrintButton
                        reportTitle="Question Library Trash Report"
                        reportContext={formatReportContext({ scope: 'Trash Bin', recordCount: trashRows.length })}
                        label="Print Report"
                        showPrintHeading={false}
                      />
                    </div>
                    <DataTable columns={trashColumns} data={paginatedTrashRows.rows} emptyMessage="Trash is empty." className="drive-table" />
                    <div className="pagination-row no-print">
                      <span>{formatTableRange(paginatedTrashRows)}</span>
                      <button type="button" onClick={() => setTrashPage((current) => Math.max(1, current - 1))} disabled={paginatedTrashRows.currentPage === 1}>Previous</button>
                      <span>Page {paginatedTrashRows.currentPage} of {paginatedTrashRows.totalPages}</span>
                      <button type="button" onClick={() => setTrashPage((current) => Math.min(paginatedTrashRows.totalPages, current + 1))} disabled={paginatedTrashRows.currentPage === paginatedTrashRows.totalPages}>Next</button>
                    </div>
                    <PrintableTableReport
                      title="Question Library Trash Report"
                      context="Trash Bin"
                      rows={trashRows}
                      columns={trashReportColumns}
                    />
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

            {showUploadForm && (
              <ModalPortal onClose={() => setShowUploadForm(false)}>
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
                        {gradeLevels.map((level) => <option key={level} value={level}>{level}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label required">Difficulty</label>
                      <select className="select-field" value={form.difficulty} onChange={(event) => handleFormChange('difficulty', event.target.value)}>
                        <option value="">Select difficulty</option>
                        {difficultyLevels.map((difficulty) => (
                          <option key={difficulty} value={difficulty}>
                            {formatDifficultyLabel(form.grade_level, difficulty)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label required">File Type</label>
                      <select className="select-field" value={form.file_type} onChange={(event) => handleFormChange('file_type', event.target.value)}>
                        <option value="lesson">Lesson PDF or PPTX File</option>
                        <option value="fixed_questions">Fixed Question File</option>
                      </select>
                    </div>
                    {form.file_type === 'lesson' && (
                      <div className="form-group">
                        <label className="form-label">Reusable Lesson PDF or PPTX Source</label>
                        <select
                          className="select-field"
                          value={selectedLessonSourceId}
                          onChange={(event) => setSelectedLessonSourceId(event.target.value)}
                        >
                          <option value="">Upload a Lesson PDF or PPTX for this generation</option>
                          {lessonSources.map((source) => (
                            <option key={source.id} value={source.id}>
                              {source.title}{source.generated_child_count ? ` (${source.generated_child_count} generated sets)` : ''}
                            </option>
                          ))}
                        </select>
                        {selectedLessonSourceId && (
                          <p className="fixed-question-upload-help">The selected source will be reused; the Grade, Difficulty, and Question Count create the new child set.</p>
                        )}
                      </div>
                    )}
                    <div className="form-group">
                      <label className="form-label">Destination</label>
                      <div className="fixed-destination-display">
                        {getQuestionFolderPath(form.grade_level, form.difficulty)}
                      </div>
                    </div>
                    {form.file_type === 'lesson' && !aiGenerationPaused && (
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
                      <label className={`form-label ${selectedLessonSourceId ? '' : 'required'}`}>File</label>
                      {!selectedLessonSourceId && (
                        <input
                          type="file"
                          accept={form.file_type === 'lesson'
                            ? '.pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation'
                            : '.docx,.pdf,.json,.csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,application/json,text/csv'}
                          onChange={(event) => handleFormChange('file', event.target.files[0] || null)}
                        />
                      )}
                      {form.file_type === 'lesson' && !aiGenerationPaused && !selectedLessonSourceId && form.file && (
                        <button type="button" className="secondary-button" onClick={saveLessonSource} disabled={savingLessonSource || uploading}>
                          {savingLessonSource ? 'Saving Lesson Source...' : 'Save as Reusable Lesson Source'}
                        </button>
                      )}
                      {form.file_type === 'fixed_questions' && (
                        <p className="fixed-question-upload-help">Fixed Questions supported: DOCX, PDF. JSON/CSV remain available for developer compatibility.</p>
                      )}
                    </div>
                    {form.file_type === 'lesson' && aiGenerationPaused && (
                      <p className="fixed-question-upload-help" role="status">
                        Status: Paused / Not Generated. The lesson source can still be saved for later generation.
                      </p>
                    )}
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
                  {uploadError && <p className="manager-inline-error" role="alert">{uploadError}</p>}
                  <div className="upload-actions">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={uploading || (form.file_type === 'lesson' && aiGenerationPaused && Boolean(selectedLessonSourceId))}
                    >
                      {uploading
                        ? 'Uploading...'
                        : form.file_type === 'lesson' && aiGenerationPaused
                          ? selectedLessonSourceId ? 'AI Generation Paused' : 'Save Lesson Source'
                          : selectedLessonSourceId ? 'Generate Question Set' : 'Upload File'}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => { resetForm(); setShowUploadForm(false); }} disabled={uploading}>Cancel</button>
                  </div>
                </form>
              </div>
              </ModalPortal>
            )}

            {questionPreviewFile && (
              <ModalPortal onClose={closeQuestionPreview}>
              <div className="manager-modal-backdrop generated-questions-preview-backdrop" role="presentation" onMouseDown={closeQuestionPreview}>
                <div className="manager-modal generated-questions-preview-modal" role="dialog" aria-modal="true" aria-labelledby="generated-questions-preview-title" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="manager-modal-header generated-questions-preview-header">
                    <div>
                      <h2 id="generated-questions-preview-title">Question Review</h2>
                      <p className="question-review-metadata">File Name: {previewFile.title || previewFile.file_name}</p>
                      <p className="question-review-metadata">File Type: {previewFile.file_type === 'lesson' ? 'Lesson PDF or PPTX File' : 'Fixed Question File'}</p>
                      <p className="question-review-metadata">Grade: {previewFile.grade_level} · Difficulty: {previewFile.difficulty}</p>
                      <p className="question-review-metadata">Destination: {getQuestionFolderPath(previewFile.grade_level, previewFile.difficulty)}</p>
                      <p className="question-review-metadata">Parent set: {previewFile.source_learning_file_id ? `Source set #${previewFile.source_learning_file_id}` : (previewFile.title || previewFile.file_name)}</p>
                      <p className="question-review-metadata">Game Publication: {previewPublicationEligibility.label}</p>
                      {!previewReviewEligibility.eligible && previewReviewEligibility.reason && (
                        <p className="manager-inline-error" role="alert">{previewReviewEligibility.reason}</p>
                      )}
                      {previewApprovalRequired && (
                        <p className="question-review-metadata">Review required before Push to Game.</p>
                      )}
                      {getFixedQuestionPublicationBlockReason(previewFile) && (
                        <p className="manager-inline-error" role="alert">{getFixedQuestionPublicationBlockReason(previewFile)}</p>
                      )}
                    </div>
                  </div>
                  <div className="generated-questions-preview-body" ref={previewBodyRef} tabIndex={0} role="region" aria-label="Questions to review">
                    <div className="generated-questions-list">
                    {!previewQuestionsLoading && !previewGenerationStatus.inProgress && !previewGenerationStatus.failed && !(previewFile.published || previewFile.publish_status === 'active') && (
                      <div className="question-review-toolbar">
                        <button type="button" className={getQuestionReviewActionClass('add')} onClick={beginPreviewQuestionAdd} disabled={previewQuestionSaving}>
                          <Plus size={16} /> Add Question
                        </button>
                      </div>
                    )}
                    {addingPreviewQuestion && previewQuestionDraft && (
                      <div className="question-preview-editor question-preview-add-editor" aria-label="Add question form">
                        <h3>Add Question</h3>
                        <p className="question-review-metadata">Grade: {previewFile.grade_level} · Difficulty: {previewFile.difficulty}</p>
                        <p className="question-review-metadata">Destination: {getQuestionFolderPath(previewFile.grade_level, previewFile.difficulty)} · Parent set: {previewFile.source_learning_file_id ? `Source set #${previewFile.source_learning_file_id}` : (previewFile.title || previewFile.file_name)}</p>
                        <p className="question-review-metadata">Topic: {previewFile.math_topic || 'Inherited from question set'}</p>
                        <label className="question-editor-field question-editor-question-field">
                          Question text
                          <textarea className="question-editor-textarea" aria-label="New question text" value={previewQuestionDraft.question} onChange={(event) => updatePreviewQuestionDraft('question', event.target.value)} />
                        </label>
                        <div className="question-editor-choice-grid" aria-label="New answer choices">
                          {previewQuestionDraft.options.map((option, optionIndex) => (
                            <label key={optionIndex} className="question-editor-field">
                              <span>Choice {String.fromCharCode(65 + optionIndex)}</span>
                              <input aria-label={`New question choice ${String.fromCharCode(65 + optionIndex)}`} value={option} onChange={(event) => updatePreviewQuestionOption(optionIndex, event.target.value)} />
                            </label>
                          ))}
                        </div>
                        <label className="question-editor-field question-editor-correct-field">
                          Correct answer
                          <select aria-label="New question correct answer" value={previewQuestionDraft.correct_answer} onChange={(event) => updatePreviewQuestionDraft('correct_answer', event.target.value)}>
                            <option value="">Select the correct answer</option>
                            {previewQuestionDraft.options.map((option, optionIndex) => <option key={optionIndex} value={option}>{option || `Choice ${String.fromCharCode(65 + optionIndex)}`}</option>)}
                          </select>
                        </label>
                        {previewQuestionErrors.map((error) => <p key={error} className="manager-inline-error" role="alert">{error}</p>)}
                        <div className="edit-actions">
                          <button type="button" className={getQuestionReviewActionClass('add')} onClick={savePreviewQuestion} disabled={previewQuestionSaving}>{previewQuestionSaving ? 'Adding...' : 'Add Question'}</button>
                          <button type="button" className={getQuestionReviewActionClass('close')} onClick={() => { setAddingPreviewQuestion(false); setPreviewQuestionDraft(null); setPreviewQuestionErrors([]); setPreviewQuestionDirty(false); }} disabled={previewQuestionSaving}>Cancel</button>
                        </div>
                      </div>
                    )}
                    {previewQuestionsLoading ? (
                      <p className="empty-text">Loading questions...</p>
                    ) : previewGenerationStatus.inProgress ? (
                      <section className="generation-status-view" role="status" aria-live="polite">
                        <strong>{previewGenerationStatus.label}...</strong>
                        {previewGenerationStatus.progressLabel && <p className="question-review-metadata">{previewGenerationStatus.progressLabel}</p>}
                        <p className="question-review-metadata">Current stage: {previewGenerationStatus.stage || 'queued'}</p>
                        <p className="empty-text">Please wait. Questions will become available for review when generation finishes.</p>
                      </section>
                    ) : previewGenerationStatus.failed ? (
                      <section className="generation-status-view" role="alert">
                        <strong>Question generation failed</strong>
                        <p className="manager-inline-error">{previewFile.generation_error_message || previewFile.generation_error_code || 'The question set could not be generated.'}</p>
                        <button type="button" className="btn btn-secondary" onClick={() => { closeQuestionPreview(); setSelectedLessonSourceId(String(previewFile.source_learning_file_id || previewFile.id || '')); setShowUploadForm(true); }}>Retry</button>
                      </section>
                    ) : previewQuestions.length === 0 ? (
                      <>
                        <p className="question-review-metadata">Requested: {previewFile.requested_question_count ?? 'Not specified'} · Available: 0</p>
                        {previewValidation?.is_valid === false && <p className="manager-inline-error" role="alert">Needs Correction — review the validation details before this set can be pushed to the game.</p>}
                        <p className="empty-text">No questions are available for review yet.</p>
                      </>
                    ) : (
                      <>
                        <p className="question-review-metadata">Requested: {previewFile.requested_question_count ?? 'Not specified'} · Available: {previewQuestions.length}</p>
                        {previewValidation?.is_valid === false && <p className="manager-inline-error" role="alert">Needs Correction — every question must have four distinct choices and a mapped correct answer.</p>}
                        {previewValidation?.is_valid !== false && previewIsReadyForGame && <p className="question-validation-valid">Valid — this question set is ready for manual Push to Game.</p>}
                        {previewValidation?.is_valid !== false && previewApprovalRequired && <p className="question-review-metadata">Approve this structurally valid set before Push to Game.</p>}
                        {previewQuestions.map((question, index) => {
                          const questionErrors = getPreviewQuestionValidationErrors(question);
                          const questionIsValid = question.is_valid !== false && questionErrors.length === 0;
                          return (
                            <React.Fragment key={question.id || `${question.question}-${index}`}>
                              <article
                                ref={index === previewQuestions.length - 1 ? finalQuestionCardRef : null}
                                className={`generated-question-card ${questionIsValid ? 'valid' : 'invalid'}`}
                              >
                                {editingPreviewQuestionId === question.id ? (
                                  <div className="question-preview-editor" aria-label={`Edit question ${index + 1} form`}>
                                    <label className="question-editor-field question-editor-question-field">
                                      Question text
                                      <textarea className="question-editor-textarea" aria-label={`Question ${index + 1} text`} value={previewQuestionDraft.question} onChange={(event) => updatePreviewQuestionDraft('question', event.target.value)} />
                                    </label>
                                    <div className="question-editor-choice-grid" aria-label="Answer choices">
                                      {previewQuestionDraft.options.map((option, optionIndex) => (
                                        <label key={optionIndex} className="question-editor-field">
                                          <span>Choice {String.fromCharCode(65 + optionIndex)}</span>
                                          <input aria-label={`Question ${index + 1} choice ${String.fromCharCode(65 + optionIndex)}`} value={option} onChange={(event) => updatePreviewQuestionOption(optionIndex, event.target.value)} />
                                        </label>
                                      ))}
                                    </div>
                                    <label className="question-editor-field question-editor-correct-field">
                                      Correct answer
                                      <select aria-label={`Question ${index + 1} correct answer`} value={previewQuestionDraft.correct_answer} onChange={(event) => updatePreviewQuestionDraft('correct_answer', event.target.value)}>
                                        <option value="">Select the correct answer</option>
                                        {previewQuestionDraft.options.map((option, optionIndex) => <option key={optionIndex} value={option}>{option || `Choice ${String.fromCharCode(65 + optionIndex)}`}</option>)}
                                      </select>
                                    </label>
                                    {previewQuestionErrors.map((error) => <p key={error} className="manager-inline-error" role="alert">{error}</p>)}
                                    <div className="edit-actions">
                                      <button type="button" className="btn btn-primary" aria-label={`Save question ${index + 1}`} onClick={savePreviewQuestion} disabled={previewQuestionSaving}>{previewQuestionSaving ? 'Saving...' : 'Save'}</button>
                                      <button type="button" className="btn btn-secondary" onClick={() => { setEditingPreviewQuestionId(null); setPreviewQuestionDraft(null); setPreviewQuestionErrors([]); setPreviewQuestionDirty(false); }} disabled={previewQuestionSaving}>Cancel</button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <strong>{index + 1}. {question.question}</strong>
                                    <ol type="A">
                                      {(question.options || []).map((option, optionIndex) => (
                                        <li key={`${option}-${optionIndex}`} className={option === question.correct_answer ? 'correct-option' : ''}>
                                          {option}{option === question.correct_answer ? ' (Correct)' : ''}
                                        </li>
                                      ))}
                                    </ol>
                                    <p className="question-review-metadata">{formatQuestionGradeLabel(question.grade_level || previewFile.grade_level)} · {question.difficulty || previewFile.difficulty}</p>
                                    {questionIsValid ? <p className="question-validation-valid">Valid</p> : questionErrors.map((error) => <p key={error} className="manager-inline-error" role="alert">{error}</p>)}
                                    {!(previewFile.published || previewFile.publish_status === 'active') && (
                                      <div className="edit-actions">
                                        <button type="button" className={getQuestionReviewActionClass('edit')} aria-label={`Edit question ${index + 1}`} onClick={() => beginPreviewQuestionEdit(question)}>Edit</button>
                                        <button type="button" className={getQuestionReviewActionClass('delete')} aria-label={`Delete question ${index + 1}`} onClick={() => deletePreviewQuestion(question, index)}>Delete Question</button>
                                      </div>
                                    )}
                                  </>
                                )}
                              </article>
                            </React.Fragment>
                          );
                        })}
                      </>
                    )}
                    </div>
                  </div>
                  <div className="preview-actions generated-questions-preview-footer">
                    <button type="button" className={getQuestionReviewActionClass('download')} onClick={() => downloadFile(previewFile)} disabled={!previewFile.file_url}>
                      <Download size={16} />Download Source
                    </button>
                    {previewCanShowApprove && (
                      <button type="button" className={getQuestionReviewActionClass('approve')} onClick={approvePreviewQuestionSet} disabled={!previewCanApprove}>
                        Approve
                      </button>
                    )}
                    <button type="button" className={getQuestionReviewActionClass('close')} onClick={closeQuestionPreview}>Close</button>
                  </div>
                </div>
              </div>
              </ModalPortal>
            )}

            {removalConfirmation && (
              <ModalPortal onClose={() => setRemovalConfirmation(null)}>
              <div className="manager-modal-backdrop" role="presentation" onMouseDown={() => setRemovalConfirmation(null)}>
                <div className="manager-modal replacement-confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="remove-active-question-set-title" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="manager-modal-header">
                    <div>
                      <h2 id="remove-active-question-set-title">Remove this question set from the game?</h2>
                      <p className="empty-text">Players will no longer receive questions from this set. The uploaded source, questions, approval, and historical results will not be deleted.</p>
                    </div>
                    <button type="button" className="icon-button" aria-label="Cancel removal" onClick={() => setRemovalConfirmation(null)}>x</button>
                  </div>
                  <div className="replacement-summary-grid">
                    <section className="replacement-summary-card">
                      <h3>Active Set</h3>
                      <p><strong>{removalConfirmation.generated_question_set_name || removalConfirmation.title || removalConfirmation.file_name}</strong></p>
                      <p className="question-review-metadata">{removalConfirmation.grade_level} · {removalConfirmation.difficulty}</p>
                    </section>
                  </div>
                  <div className="preview-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => setRemovalConfirmation(null)}>Cancel</button>
                    <button type="button" className="btn btn-primary" onClick={() => removeFileFromGame(removalConfirmation)}>Confirm Remove from Game</button>
                  </div>
                </div>
              </div>
              </ModalPortal>
            )}

            {replacementConfirmation && (
              <ModalPortal onClose={() => setReplacementConfirmation(null)}>
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
                        <p className="question-review-metadata">Grade {set.grade_level} · {set.difficulty}</p>
                        {set.math_topic && <p className="question-review-metadata">Source topic metadata (optional): {set.math_topic}</p>}
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
              </ModalPortal>
            )}

            {renamingFile && (
              <ModalPortal onClose={() => setRenamingFile(null)}>
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
              </ModalPortal>
            )}

            {editingFile && (
              <ModalPortal onClose={() => setEditingFile(null)}>
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
                          }));
                        }}
                      >
                        <option value="">Select grade level</option>
                        {gradeLevels.map((level) => <option key={level} value={level}>{level}</option>)}
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
                          }));
                        }}
                      >
                        <option value="">Select difficulty</option>
                        {difficultyLevels.map((difficulty) => (
                          <option key={difficulty} value={difficulty}>
                            {formatDifficultyLabel(editingFile.grade_level, difficulty)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <p className="question-review-metadata">Source topic metadata (optional, read-only): {editingFile.math_topic || 'Not provided'}</p>
                  </div>
                  <div className="edit-actions">
                    <button type="button" className="btn btn-primary" onClick={saveFileDetails}>Save</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setEditingFile(null)}>Cancel</button>
                  </div>
                </div>
              </div>
              </ModalPortal>
            )}
          </PageContent>
        </MainContent>
      }
    />
  );
}
