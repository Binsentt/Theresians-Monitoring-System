import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Folder, MoreVertical, Pencil, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import logoImage from '../assets/images/STS_Logo.png';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import { DataTable, TableFilters } from './layout/Table';
import { canAccessRole, normalizeRole } from './manageUsers.utils';
import {
  filterLearningFiles,
  formatLearningFileSize,
  getFolderContents,
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

const FILE_TYPES = [
  { value: 'lesson', label: 'Lesson' },
  { value: 'fixed_questions', label: 'Fixed Questions' },
];

const initialFormState = {
  grade_level: 'Grade 1',
  math_topic: 'Addition',
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
  const [showUploadForm, setShowUploadForm] = useState(true);
  const [openFileMenu, setOpenFileMenu] = useState(null);
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
  const filterTopicOptions = useMemo(
    () => (filters.grade_level ? getMathTopicsForGrade(filters.grade_level) : MATH_TOPICS),
    [filters.grade_level]
  );
  const editTopicOptions = useMemo(
    () => (editingFile ? getMathTopicsForGrade(editingFile.grade_level) : MATH_TOPICS),
    [editingFile]
  );
  const uploadType = inferLearningFileUploadType(form.file?.name);
  const selectedFolderFileCount = useMemo(() => {
    if (!filters.folder) return 0;
    const folderName = String(filters.folder).toLowerCase();
    return files.filter((file) => String(file.folder_name || '').toLowerCase() === folderName).length;
  }, [files, filters.folder]);
  const tableEmptyMessage = filters.folder && selectedFolderFileCount === 0
    ? `Folder "${filters.folder}" is empty.`
    : 'No math content found. Upload a new lesson or question set.';

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

  const handleFilterChange = (field, value) => {
    setFilters((prev) => {
      if (field === 'grade_level') {
        const shouldResetTopic = value && prev.math_topic && !isValidMathTopicForGrade(value, prev.math_topic);
        return { ...prev, grade_level: value, math_topic: shouldResetTopic ? '' : prev.math_topic };
      }
      return { ...prev, [field]: value };
    });
  };

  const resetForm = () => setForm(initialFormState);

  const handleUpload = async (event) => {
    event.preventDefault();
    if (!form.grade_level || !form.math_topic.trim() || !form.file) {
      showNotification('Choose a grade, topic, and file before uploading.', 'error');
      return;
    }
    if (!uploadType) {
      showNotification('Lessons must be PDF files. Fixed questions must be JSON or CSV.', 'error');
      return;
    }
    if (!isValidGradeLevel(form.grade_level) || !isValidMathTopicForGrade(form.grade_level, form.math_topic)) {
      showNotification('Invalid grade level or math topic. Use a supported Mathematics topic for this grade.', 'error');
      return;
    }
    if (uploadType === 'fixed_questions' && !String(form.expected_question_count || '').trim()) {
      showNotification('Enter the expected fixed questions count before uploading this file.', 'error');
      return;
    }

    const payload = new FormData();
    payload.append('title', deriveUploadTitle(form.file));
    payload.append('grade_level', form.grade_level);
    payload.append('math_topic', form.math_topic.trim());
    payload.append('file_type', uploadType);
    payload.append('folder_id', activeFolder?.id ? String(activeFolder.id) : '');
    payload.append('uploaded_by', user.id);
    if (uploadType === 'fixed_questions') {
      payload.append('expected_question_count', String(form.expected_question_count).trim());
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
      showNotification('Upload successful. Review and publish when ready.');
      resetForm();
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Upload failed.', 'error');
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
      showNotification('File restored.');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Restore failed.', 'error');
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

  const handlePublishToggle = async (fileId, publish) => {
    try {
      const endpoint = publish ? 'publish' : 'unpublish';
      const response = await fetch(apiUrl(`/api/questions/${endpoint}/${fileId}`), { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Publish action failed');
      setOpenFileMenu(null);
      showNotification(data.message || (publish ? 'Published to game.' : 'Removed from game.'));
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Publish action failed.', 'error');
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
      showNotification('Folder restored.');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Restore failed.', 'error');
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
            <span className="file-name-title">{row.title}</span>
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
              <button type="button" onClick={() => beginEditFile(row)}><Pencil size={16} />Rename</button>
              <button type="button" onClick={() => downloadFile(row)}><Download size={16} />Download</button>
              <button type="button" onClick={() => moveFileToTrash(row)}><Trash2 size={16} />Move to Bin</button>
              <button type="button" onClick={() => handlePublishToggle(row.id, !row.published)}>
                {row.published ? 'Remove from Game' : 'Publish to Game'}
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

            <ContentSection>
              <div className="drive-toolbar">
                <button type="button" className="drive-primary-action" onClick={() => setShowFolderForm((value) => !value)}>
                  <Plus size={20} />Create Folder
                </button>
                <button type="button" className="drive-primary-action drive-upload-action" onClick={() => setShowUploadForm((value) => !value)}>
                  <Upload size={20} />Upload Content
                </button>
              </div>

              {(showFolderForm || showUploadForm) && (
                <div className="drive-forms">
                  {showFolderForm && (
                    <form onSubmit={handleCreateFolder} className="drive-inline-form">
                      <label className="form-label" htmlFor="new-folder-name">Folder name</label>
                      <div className="drive-inline-controls">
                        <input
                          id="new-folder-name"
                          type="text"
                          className="input-field"
                          value={newFolderName}
                          onChange={(event) => setNewFolderName(event.target.value)}
                          placeholder="Example: Grade 2 Multiplication"
                        />
                        <button type="submit" className="btn btn-primary">Create</button>
                      </div>
                    </form>
                  )}

                  {showUploadForm && (
                    <form onSubmit={handleUpload} className="drive-upload-form">
                      <div className="form-group">
                        <label className="form-label required">Grade Level</label>
                        <select
                          className="select-field"
                          value={form.grade_level}
                          onChange={(event) => handleFormChange('grade_level', event.target.value)}
                        >
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
                      {uploadType === 'fixed_questions' && (
                        <div className="form-group">
                          <label className="form-label required">Fixed Questions Count</label>
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
                        <input type="file" accept=".pdf,.json,.csv" onChange={(event) => handleFormChange('file', event.target.files[0] || null)} />
                      </div>
                      <div className="upload-actions">
                        <button type="submit" className="btn btn-primary" disabled={uploading}>
                          {uploading ? 'Uploading...' : 'Upload Content'}
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={resetForm} disabled={uploading}>Reset</button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </ContentSection>

            <ContentSection title={activeFolder ? activeFolder.name : 'Folders'}>
              <div className="drive-folder-header">
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
                    <span>Open a folder to upload directly into it.</span>
                  )}
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

              {activeFolder ? (
                <DataTable columns={tableColumns} data={folderContents} emptyMessage="This folder is empty." className="drive-table" />
              ) : (
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
                      <div className="folder-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                        <button type="button" className="btn btn-secondary" onClick={() => handleOpenFolder(folder)}>Open</button>
                        <button type="button" className="icon-button" title="Rename folder" aria-label={`Rename ${folder.name}`} onClick={() => handleRenameFolder(folder)}>
                          <Pencil size={17} />
                        </button>
                        <button type="button" className="icon-button" title="Move folder to Bin" aria-label={`Move ${folder.name} to Bin`} onClick={() => moveFolderToTrash(folder)}>
                          <Trash2 size={17} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ContentSection>

            <ContentSection title="Uploaded Mathematics Content">
              <TableFilters className="manager-filters">
                <div className="filter-group">
                  <input
                    type="text"
                    className="input-field"
                    value={filters.search}
                    onChange={(event) => handleFilterChange('search', event.target.value)}
                    placeholder="Search content"
                  />
                  <select className="select-field" value={filters.folder} onChange={(event) => handleFilterChange('folder', event.target.value)}>
                    <option value="">All folders</option>
                    {folders.map((folder) => <option key={folder.id} value={folder.name}>{folder.name}</option>)}
                  </select>
                  <select className="select-field" value={filters.grade_level} onChange={(event) => handleFilterChange('grade_level', event.target.value)}>
                    <option value="">All grades</option>
                    {GRADE_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                  </select>
                  <select className="select-field" value={filters.math_topic} onChange={(event) => handleFilterChange('math_topic', event.target.value)}>
                    <option value="">All topics</option>
                    {filterTopicOptions.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                  </select>
                  <select className="select-field" value={filters.file_type} onChange={(event) => handleFilterChange('file_type', event.target.value)}>
                    <option value="">All types</option>
                    {FILE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                  </select>
                </div>
              </TableFilters>
              <DataTable columns={tableColumns} data={filteredFiles} emptyMessage={tableEmptyMessage} className="drive-table" />
            </ContentSection>

            <ContentSection title="Trash Bin">
              <div className="trash-grid">
                <section className="trash-panel">
                  <h3>Folders</h3>
                  {trashFolders.length === 0 ? <p className="empty-text">No folders in Trash.</p> : trashFolders.map((folder) => (
                    <div key={folder.id} className="trash-row">
                      <span><Folder size={18} />{folder.name}</span>
                      <div className="trash-actions">
                        <button type="button" className="btn btn-secondary" onClick={() => restoreFolder(folder)}><RotateCcw size={16} />Restore</button>
                        <button type="button" className="btn btn-tertiary" onClick={() => permanentDeleteFolder(folder)}><Trash2 size={16} />Delete</button>
                      </div>
                    </div>
                  ))}
                </section>
                <section className="trash-panel">
                  <h3>Files</h3>
                  {trashFiles.length === 0 ? <p className="empty-text">No files in Trash.</p> : trashFiles.map((file) => (
                    <div key={file.id} className="trash-row">
                      <span><FileText size={18} />{file.title}</span>
                      <div className="trash-actions">
                        <button type="button" className="btn btn-secondary" onClick={() => restoreFile(file)}><RotateCcw size={16} />Restore</button>
                        <button type="button" className="btn btn-tertiary" onClick={() => permanentDeleteFile(file)}><Trash2 size={16} />Delete</button>
                      </div>
                    </div>
                  ))}
                </section>
              </div>
            </ContentSection>

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
