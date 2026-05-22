import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Folder, HardDrive, MoreVertical, Pencil, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import { DashboardContainer, MainContent, TopBar, PageContent } from './layout/AppLayout';
import { DataTable } from './layout/Table';
import { canAccessRole, normalizeRole } from './manageUsers.utils';
import {
  calculateLearningStorage,
  countFixedQuestionRecords,
  filterLearningFiles,
  formatLearningPreviewText,
  formatLearningFileSize,
  getLargestLearningFiles,
  getFolderContents,
  getLearningFilePreviewKind,
  getMathTopicsForGrade,
  GRADE_LEVELS,
  inferLearningFileUploadType,
  isValidGradeLevel,
  isValidMathTopicForGrade,
  MATH_TOPICS,
  normalizeMathTopicForGrade,
} from './lessonQuestionManager.utils';
import { apiUrl } from '../api';
import '../styles/lessonQuestionManager.css';

const initialFormState = {
  grade_level: 'Grade 1',
  math_topic: 'Addition',
  folder_id: '',
  file_type: 'fixed_questions',
  expected_question_count: '',
  file: null,
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

export default function LessonQuestionManager() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [notification, setNotification] = useState(null);
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [trashFiles, setTrashFiles] = useState([]);
  const [trashFolders, setTrashFolders] = useState([]);
  const [form, setForm] = useState(initialFormState);
  const [editingFile, setEditingFile] = useState(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderSearch, setFolderSearch] = useState('');
  const [openedFolder, setOpenedFolder] = useState(null);
  const [showFolderForm, setShowFolderForm] = useState(false);
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [managerView, setManagerView] = useState('files');
  const [openFileMenu, setOpenFileMenu] = useState(null);
  const [openFolderMenu, setOpenFolderMenu] = useState(null);
  const [openTrashMenu, setOpenTrashMenu] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
  const [previewContent, setPreviewContent] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [filters, setFilters] = useState({ search: '', folder: '', grade_level: '', math_topic: '', file_type: '' });

  const showNotification = (message, type = 'success') => {
    setNotification({ message, type });
    window.setTimeout(() => setNotification(null), 5000);
  };

  const loadFilesAndFolders = async () => {
    try {
      setLoading(true);
      const [filesRes, foldersRes, trashFilesRes, trashFoldersRes] = await Promise.all([
        fetch(apiUrl('/api/learning-files')),
        fetch(apiUrl('/api/folders')),
        fetch(apiUrl('/api/learning-files/trash')),
        fetch(apiUrl('/api/folders/trash')),
      ]);
      if (!filesRes.ok) throw new Error('Failed to load files');
      if (!foldersRes.ok) throw new Error('Failed to load folders');
      if (!trashFilesRes.ok) throw new Error('Failed to load trashed files');
      if (!trashFoldersRes.ok) throw new Error('Failed to load trashed folders');
      setFiles(await filesRes.json());
      setFolders(await foldersRes.json());
      setTrashFiles(await trashFilesRes.json());
      setTrashFolders(await trashFoldersRes.json());
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

  const filteredFiles = useMemo(() => filterLearningFiles(files, filters), [files, filters]);
  const activeFolder = useMemo(() => {
    if (!openedFolder) return null;
    return folders.find((folder) => String(folder.id) === String(openedFolder.id)) || openedFolder;
  }, [folders, openedFolder]);
  const folderContents = useMemo(() => getFolderContents(files, activeFolder), [activeFolder, files]);
  const filteredFolders = useMemo(() => {
    const search = folderSearch.trim().toLowerCase();
    if (!search) return folders;
    return folders.filter((folder) => String(folder.name || '').toLowerCase().includes(search));
  }, [folders, folderSearch]);
  const editTopicOptions = useMemo(
    () => (editingFile ? getMathTopicsForGrade(editingFile.grade_level) : MATH_TOPICS),
    [editingFile]
  );
  const inferredFileType = inferLearningFileUploadType(form.file?.name);
  const uploadType = form.file_type;
  const displayedFiles = activeFolder ? folderContents : filteredFiles;
  const tableEmptyMessage = activeFolder
    ? `Folder "${activeFolder.name}" is empty.`
    : 'No math content found. Upload a question file to begin.';
  const storageSummary = useMemo(() => calculateLearningStorage(files), [files]);
  const largestFiles = useMemo(() => getLargestLearningFiles(files), [files]);
  const trashRows = useMemo(() => [
    ...trashFolders.map((folder) => ({
      ...folder,
      trashType: 'Folder',
      trashName: folder.name,
    })),
    ...trashFiles.map((file) => ({
      ...file,
      trashType: 'File',
      trashName: file.title,
    })),
  ].sort((left, right) => new Date(right.deleted_at || 0) - new Date(left.deleted_at || 0)), [trashFiles, trashFolders]);

  const handleFormChange = (field, value) => {
    setForm((prev) => {
      if (field === 'grade_level') {
        return {
          ...prev,
          grade_level: value,
          math_topic: normalizeMathTopicForGrade(value, prev.math_topic),
        };
      }
      return { ...prev, [field]: value };
    });
  };

  const resetForm = () => setForm(initialFormState);

  const handleUpload = async (event) => {
    event.preventDefault();
    if (!form.grade_level || !form.math_topic.trim() || !form.folder_id || !form.file) {
      showNotification('Grade level, topic, folder, and file are required.', 'error');
      return;
    }
    if (!uploadType || inferredFileType !== uploadType) {
      showNotification('Lessons must be PDF files. Fixed questions must be JSON or CSV.', 'error');
      return;
    }
    if (!isValidGradeLevel(form.grade_level) || !isValidMathTopicForGrade(form.grade_level, form.math_topic)) {
      showNotification('Invalid grade level or math topic. Use a supported Mathematics topic for this grade.', 'error');
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
    payload.append('math_topic', form.math_topic.trim());
    payload.append('file_type', uploadType);
    payload.append('folder_id', String(form.folder_id));
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
      const selectedFolder = folders.find((folder) => String(folder.id) === String(form.folder_id));
      const uploadedFile = {
        ...data.learningFile,
        folder_id: data.learningFile?.folder_id || form.folder_id,
        folder_name: selectedFolder?.name || activeFolder?.name || 'Unassigned',
        uploaded_by_name: user?.name || user?.email || 'Unknown',
      };
      setFiles((current) => [uploadedFile, ...current.filter((file) => file.id !== uploadedFile.id)]);
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
    if (!window.confirm(`Move "${file.title}" to Trash?`)) return;
    try {
      const response = await fetch(apiUrl(`/api/learning-files/${file.id}`), { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Move to Trash failed');
      setOpenFileMenu(null);
      showNotification('File moved to Trash.');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Move to Trash failed.', 'error');
    }
  };

  const restoreFile = async (file) => {
    try {
      const response = await fetch(apiUrl(`/api/learning-files/${file.id}/restore`), { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Restore failed');
      const restoredFile = data.learningFile || file;
      const restoredFolder = folders.find((folder) => String(folder.id) === String(restoredFile.folder_id || file.folder_id));
      setTrashFiles((current) => current.filter((item) => item.id !== file.id));
      setFiles((current) => [{
        ...restoredFile,
        deleted_at: null,
        folder_name: restoredFile.folder_name || restoredFolder?.name || 'Unassigned',
      }, ...current.filter((item) => item.id !== file.id)]);
      setOpenTrashMenu(null);
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
    setOpenFileMenu(null);
  };

  const closePreview = () => {
    setPreviewFile(null);
    setPreviewContent('');
    setPreviewLoading(false);
  };

  const previewLearningFile = async (file) => {
    const previewKind = getLearningFilePreviewKind(file);
    setOpenFileMenu(null);
    setPreviewContent('');
    setPreviewFile({ ...file, previewKind, publicUrl: getPublicUrl(file.file_url) });

    if (previewKind !== 'text' || !file.file_url) return;

    try {
      setPreviewLoading(true);
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

  const beginEditFile = (file) => {
    const gradeLevel = isValidGradeLevel(file.grade_level) ? file.grade_level : initialFormState.grade_level;
    setOpenFileMenu(null);
    setEditingFile({
      ...file,
      grade_level: gradeLevel,
      math_topic: normalizeMathTopicForGrade(gradeLevel, file.math_topic),
      folder_id: file.folder_id || '',
    });
  };

  const saveFileDetails = async () => {
    if (!editingFile.title || !editingFile.grade_level || !editingFile.math_topic) {
      showNotification('Complete the file details before saving.', 'error');
      return;
    }
    if (!isValidGradeLevel(editingFile.grade_level) || !isValidMathTopicForGrade(editingFile.grade_level, editingFile.math_topic)) {
      showNotification('Invalid file details for this Mathematics grade.', 'error');
      return;
    }
    try {
      const response = await fetch(apiUrl(`/api/learning-files/${editingFile.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editingFile.title,
          grade_level: editingFile.grade_level,
          math_topic: editingFile.math_topic,
          file_type: editingFile.file_type,
          folder_id: editingFile.folder_id || null,
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

  const handleCreateFolder = async (event) => {
    event.preventDefault();
    if (!newFolderName.trim()) {
      showNotification('Folder name is required.', 'error');
      return;
    }
    try {
      const response = await fetch(apiUrl('/api/folders/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newFolderName.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Folder create failed');
      showNotification('Folder created.');
      setNewFolderName('');
      setShowFolderForm(false);
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Folder create failed.', 'error');
    }
  };

  const handleRenameFolder = async (folder) => {
    const updatedName = window.prompt('Rename folder', folder.name);
    if (!updatedName || !updatedName.trim() || updatedName.trim() === folder.name) return;
    try {
      const response = await fetch(apiUrl(`/api/folders/${folder.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: updatedName.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Rename failed');
      setOpenFolderMenu(null);
      showNotification('Folder renamed.');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Rename failed.', 'error');
    }
  };

  const moveFolderToTrash = async (folder) => {
    if (!window.confirm(`Move "${folder.name}" and its contents to Trash?`)) return;
    try {
      const response = await fetch(apiUrl(`/api/folders/${folder.id}`), { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Move to Trash failed');
      if (activeFolder?.id === folder.id) setOpenedFolder(null);
      setOpenFolderMenu(null);
      showNotification('Folder moved to Trash.');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Move to Trash failed.', 'error');
    }
  };

  const restoreFolder = async (folder) => {
    try {
      const response = await fetch(apiUrl(`/api/folders/${folder.id}/restore`), { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Restore failed');
      const restoredFolder = data.folder || folder;
      setTrashFolders((current) => current.filter((item) => item.id !== folder.id));
      setFolders((current) => [{
        ...restoredFolder,
        deleted_at: null,
      }, ...current.filter((item) => item.id !== folder.id)]);
      setOpenTrashMenu(null);
      showNotification('File restored successfully');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification('Failed to restore file. Please try again.', 'error');
    }
  };

  const permanentDeleteFolder = async (folder) => {
    if (!window.confirm(`Permanently delete "${folder.name}" and its trashed contents?`)) return;
    try {
      const response = await fetch(apiUrl(`/api/folders/${folder.id}/permanent`), { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Permanent delete failed');
      showNotification('Folder permanently deleted.');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Permanent delete failed.', 'error');
    }
  };

  const handleEmptyTrash = async () => {
    if (trashRows.length === 0) return;
    if (!window.confirm('Permanently delete every file and folder in Trash?')) return;

    try {
      const trashedFolderIds = new Set(trashFolders.map((folder) => String(folder.id)));
      const standaloneFiles = trashFiles.filter((file) => !trashedFolderIds.has(String(file.folder_id || '')));

      await Promise.all(
        standaloneFiles.map(async (file) => {
          const response = await fetch(apiUrl(`/api/learning-files/${file.id}/permanent`), { method: 'DELETE' });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Permanent file delete failed');
        })
      );
      await Promise.all(
        trashFolders.map(async (folder) => {
          const response = await fetch(apiUrl(`/api/folders/${folder.id}/permanent`), { method: 'DELETE' });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Permanent folder delete failed');
        })
      );
      showNotification('Trash emptied.');
      setOpenTrashMenu(null);
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Unable to empty Trash.', 'error');
    }
  };

  const openCreateFolderModal = () => {
    setShowNewMenu(false);
    setShowFolderForm(true);
  };

  const openUploadModal = () => {
    setShowNewMenu(false);
    setForm((current) => ({
      ...current,
      folder_id: activeFolder?.id ? String(activeFolder.id) : current.folder_id,
    }));
    setShowUploadForm(true);
  };

  const switchManagerView = (nextView) => {
    setManagerView(nextView);
    setShowNewMenu(false);
    setOpenFileMenu(null);
    setOpenFolderMenu(null);
    setOpenTrashMenu(null);
  };

  const handleOpenFolder = (folder) => {
    setOpenedFolder(folder);
    setEditingFile(null);
    setFilters({ search: '', folder: '', grade_level: '', math_topic: '', file_type: '' });
  };

  const handleFolderKeyDown = (event, folder) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleOpenFolder(folder);
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
            <span className="file-meta">{row.grade_level} | {row.math_topic}</span>
          </div>
        </div>
      ),
    },
    { key: 'uploaded_by_name', header: 'Uploaded by', render: (value) => value || 'Unknown' },
    { key: 'uploaded_at', header: 'Date modified', render: (value) => formatUploadDate(value) },
    { key: 'file_size', header: 'File size', render: (value) => formatLearningFileSize(value) },
    {
      key: 'actions',
      header: '',
      className: 'drive-actions-cell',
      render: (_, row) => (
        <div className="drive-row-actions">
          <button
            type="button"
            className="icon-button"
            title={`Actions for ${row.title}`}
            aria-label={`Actions for ${row.title}`}
            onClick={() => setOpenFileMenu((current) => (current === row.id ? null : row.id))}
          >
            <MoreVertical size={18} />
          </button>
          {openFileMenu === row.id && (
            <div className="drive-row-menu">
              <button type="button" onClick={() => previewLearningFile(row)}><FileText size={16} />Preview</button>
              <button type="button" onClick={() => beginEditFile(row)}><Pencil size={16} />Rename</button>
              <button type="button" onClick={() => downloadFile(row)}><Download size={16} />Download</button>
              <button type="button" onClick={() => moveFileToTrash(row)}><Trash2 size={16} />Move to Bin</button>
            </div>
          )}
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
          {row.trashType === 'Folder' ? <Folder size={18} aria-hidden="true" /> : <FileText size={18} aria-hidden="true" />}
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
          <button
            type="button"
            className="icon-button"
            title={`Trash actions for ${row.trashName}`}
            aria-label={`Trash actions for ${row.trashName}`}
            onClick={() => setOpenTrashMenu((current) => (current === `${row.trashType}-${row.id}` ? null : `${row.trashType}-${row.id}`))}
          >
            <MoreVertical size={18} />
          </button>
          {openTrashMenu === `${row.trashType}-${row.id}` && (
            <div className="drive-row-menu">
              <button type="button" onClick={() => (row.trashType === 'Folder' ? restoreFolder(row) : restoreFile(row))}>
                <RotateCcw size={16} />Restore
              </button>
              <button type="button" onClick={() => (row.trashType === 'Folder' ? permanentDeleteFolder(row) : permanentDeleteFile(row))}>
                <Trash2 size={16} />Permanently Delete
              </button>
            </div>
          )}
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
                      <button type="button" onClick={openCreateFolderModal}><Folder size={18} />New Folder</button>
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
                  <>
                    <section className="drive-panel">
                      <div className="drive-panel-header">
                        <div>
                          <h2>{activeFolder ? activeFolder.name : 'My Files'}</h2>
                          <div className="folder-breadcrumb">
                            {activeFolder ? (
                              <>
                                <button type="button" className="folder-breadcrumb-button" onClick={() => setOpenedFolder(null)}>
                                  All folders
                                </button>
                                <span className="folder-breadcrumb-separator">/</span>
                                <span>{activeFolder.name}</span>
                              </>
                            ) : (
                              <span>Folders</span>
                            )}
                          </div>
                        </div>
                        {!activeFolder && (
                          <input
                            type="text"
                            className="input-field folder-search-field"
                            value={folderSearch}
                            onChange={(event) => setFolderSearch(event.target.value)}
                            placeholder="Search folders"
                          />
                        )}
                      </div>
                      {!activeFolder && (
                        <div className="drive-folder-grid">
                          {filteredFolders.length === 0 ? (
                            <p className="empty-text">No folders yet. Create one to organize files.</p>
                          ) : filteredFolders.map((folder) => (
                            <div
                              key={folder.id}
                              className="drive-folder-card"
                              role="button"
                              tabIndex={0}
                              onClick={() => handleOpenFolder(folder)}
                              onKeyDown={(event) => handleFolderKeyDown(event, folder)}
                            >
                              <div className="drive-folder-card-main">
                                <Folder size={28} aria-hidden="true" />
                                <strong>{folder.name}</strong>
                              </div>
                              <div className="drive-card-menu" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                                <button
                                  type="button"
                                  className="icon-button"
                                  title={`Actions for ${folder.name}`}
                                  aria-label={`Actions for ${folder.name}`}
                                  onClick={() => setOpenFolderMenu((current) => (current === folder.id ? null : folder.id))}
                                >
                                  <MoreVertical size={18} />
                                </button>
                                {openFolderMenu === folder.id && (
                                  <div className="drive-row-menu">
                                    <button type="button" onClick={() => handleRenameFolder(folder)}><Pencil size={16} />Rename</button>
                                    <button type="button" onClick={() => moveFolderToTrash(folder)}><Trash2 size={16} />Move to Bin</button>
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>

                    <section className="drive-panel">
                      <div className="drive-panel-header">
                        <div>
                          <h2>{activeFolder ? 'Files in Folder' : 'Files'}</h2>
                          <p className="empty-text">Uploaded Mathematics question files.</p>
                        </div>
                      </div>
                      <DataTable columns={tableColumns} data={displayedFiles} emptyMessage={tableEmptyMessage} className="drive-table" />
                    </section>
                  </>
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

            {showFolderForm && (
              <div className="manager-modal-backdrop" role="presentation" onMouseDown={() => setShowFolderForm(false)}>
                <form className="manager-modal drive-create-folder-modal" onSubmit={handleCreateFolder} role="dialog" aria-modal="true" aria-labelledby="create-folder-title" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="manager-modal-header">
                    <h2 id="create-folder-title">New Folder</h2>
                    <button type="button" className="icon-button" aria-label="Cancel folder creation" onClick={() => setShowFolderForm(false)}>x</button>
                  </div>
                  <div className="form-group">
                    <label className="form-label required" htmlFor="new-folder-name">Folder name</label>
                    <input
                      id="new-folder-name"
                      type="text"
                      className="input-field"
                      value={newFolderName}
                      onChange={(event) => setNewFolderName(event.target.value)}
                      placeholder="Grade 2 Multiplication"
                    />
                  </div>
                  <div className="upload-actions">
                    <button type="submit" className="btn btn-primary">Create</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setShowFolderForm(false)}>Cancel</button>
                  </div>
                </form>
              </div>
            )}

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
                        {GRADE_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label required">Topic Name</label>
                      <input
                        type="text"
                        className="input-field"
                        value={form.math_topic}
                        list="math-topic-options"
                        onChange={(event) => handleFormChange('math_topic', event.target.value)}
                        placeholder="Addition"
                      />
                      <datalist id="math-topic-options">
                        {getMathTopicsForGrade(form.grade_level).map((topic) => <option key={topic} value={topic} />)}
                      </datalist>
                    </div>
                    <div className="form-group">
                      <label className="form-label required">Select Folder</label>
                      <select className="select-field" value={form.folder_id} onChange={(event) => handleFormChange('folder_id', event.target.value)}>
                        <option value="">Choose a folder</option>
                        {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label required">File Type</label>
                      <select className="select-field" value={form.file_type} onChange={(event) => handleFormChange('file_type', event.target.value)}>
                        <option value="lesson">Lesson File</option>
                        <option value="fixed_questions">Fixed Question File</option>
                      </select>
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
                            math_topic: normalizeMathTopicForGrade(gradeLevel, prev.math_topic),
                          }));
                        }}
                      >
                        {GRADE_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label required">Topic Name</label>
                      <select className="select-field" value={editingFile.math_topic} onChange={(event) => setEditingFile((prev) => ({ ...prev, math_topic: event.target.value }))}>
                        {editTopicOptions.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Folder</label>
                      <select className="select-field" value={editingFile.folder_id || ''} onChange={(event) => setEditingFile((prev) => ({ ...prev, folder_id: event.target.value || null }))}>
                        <option value="">Unassigned</option>
                        {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
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
