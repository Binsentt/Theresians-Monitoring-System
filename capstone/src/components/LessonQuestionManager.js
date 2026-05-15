import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AnalyticsSidebar from './layout/AnalyticsSidebar';
import { DashboardContainer, MainContent, TopBar, PageContent, ContentSection } from './layout/AppLayout';
import { DataTable, TableFilters } from './layout/Table';
import '../styles/lessonQuestionManager.css';

const MATH_TOPICS = [
  'Addition',
  'Subtraction',
  'Multiplication',
  'Division',
  'Fractions',
  'Decimals',
  'Geometry',
  'Basic Algebra',
  'Word Problems',
];

const GRADE_LEVELS = [
  'Grade 1',
  'Grade 2',
  'Grade 3',
  'Grade 4',
  'Grade 5',
  'Grade 6',
];

const FILE_TYPES = [
  { value: 'lesson', label: 'Lesson' },
  { value: 'fixed_questions', label: 'Fixed Questions' },
];

const initialFormState = {
  title: '',
  grade_level: 'Grade 1',
  math_topic: 'Addition',
  file_type: 'lesson',
  folder_id: '',
  file: null,
};

const isValidGradeLevel = (value) => GRADE_LEVELS.includes(String(value || '').trim());
const isValidMathTopic = (value) => MATH_TOPICS.includes(String(value || '').trim());

function formatUploadDate(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function getPublicUrl(path) {
  if (!path) return null;
  return path.startsWith('http') ? path : `${window.location.origin}${path}`;
}

function buildQueryString(params) {
  const keys = Object.keys(params).filter((key) => params[key]);
  return keys.length ? `?${keys.map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`).join('&')}` : '';
}

export default function LessonQuestionManager() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [notification, setNotification] = useState(null);
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [form, setForm] = useState(initialFormState);
  const [editingFile, setEditingFile] = useState(null);
  const [editingFolder, setEditingFolder] = useState(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [filters, setFilters] = useState({ search: '', folder: '', grade_level: '', math_topic: '' });

  const showNotification = (message, type = 'success') => {
    setNotification({ message, type });
    window.setTimeout(() => setNotification(null), 5000);
  };

  const loadFilesAndFolders = async () => {
    try {
      setLoading(true);
      const [filesRes, foldersRes] = await Promise.all([
        fetch('http://localhost:5000/api/learning-files'),
        fetch('http://localhost:5000/api/folders'),
      ]);
      if (!filesRes.ok) throw new Error('Failed to load files');
      if (!foldersRes.ok) throw new Error('Failed to load folders');
      const filesData = await filesRes.json();
      const foldersData = await foldersRes.json();
      setFiles(filesData);
      setFolders(foldersData);
    } catch (error) {
      console.error(error);
      showNotification('Unable to load lesson manager data.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
    if (!loggedInUser || !['teacher', 'admin'].includes((loggedInUser.role || '').toLowerCase())) {
      navigate('/login');
      return;
    }
    setUser(loggedInUser);
    loadFilesAndFolders();
  }, [navigate]);

  const filteredFiles = useMemo(() => {
    return files.filter((file) => {
      const folderMatch = filters.folder ? String(file.folder_name || '').toLowerCase() === String(filters.folder).toLowerCase() : true;
      const gradeMatch = filters.grade_level ? file.grade_level === filters.grade_level : true;
      const topicMatch = filters.math_topic ? file.math_topic === filters.math_topic : true;
      const searchMatch = filters.search
        ? [file.title, file.file_name, file.math_topic, file.grade_level, file.folder_name]
            .join(' ')
            .toLowerCase()
            .includes(filters.search.toLowerCase())
        : true;
      return folderMatch && gradeMatch && topicMatch && searchMatch;
    });
  }, [files, filters]);

  const handleFormChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    handleFormChange('file', file || null);
  };

  const resetForm = () => {
    setForm(initialFormState);
  };

  const handleUpload = async (event) => {
    event.preventDefault();
    if (!form.title || !form.grade_level || !form.math_topic || !form.file_type || !form.file) {
      showNotification('Please fill out all upload fields and select a file.', 'error');
      return;
    }

    if (!isValidGradeLevel(form.grade_level) || !isValidMathTopic(form.math_topic)) {
      showNotification('Invalid grade level or math topic. Only Grade 1–6 mathematics content is supported.', 'error');
      return;
    }

    const allowedLesson = form.file_type === 'lesson' && form.file.name.toLowerCase().endsWith('.pdf');
    const allowedQuestions = form.file_type === 'fixed_questions' && /\.(json|csv)$/i.test(form.file.name);
    if (!allowedLesson && !allowedQuestions) {
      showNotification('Invalid file type. Lessons must be PDF. Questions must be JSON or CSV.', 'error');
      return;
    }

    const payload = new FormData();
    payload.append('title', form.title.trim());
    payload.append('grade_level', form.grade_level);
    payload.append('math_topic', form.math_topic);
    payload.append('file_type', form.file_type);
    payload.append('folder_id', form.folder_id || '');
    payload.append('uploaded_by', user.id);
    payload.append('file', form.file);

    try {
      setUploading(true);
      const response = await fetch('http://localhost:5000/api/learning-files/upload', {
        method: 'POST',
        body: payload,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Upload failed.');
      }
      showNotification('Upload successful. Review and publish when ready.', 'success');
      resetForm();
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Upload failed.', 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (fileId) => {
    if (!window.confirm('Delete this file and all imported questions?')) return;
    try {
      const response = await fetch(`http://localhost:5000/api/learning-files/${fileId}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Delete failed');
      showNotification('File deleted successfully.', 'success');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Delete failed.', 'error');
    }
  };

  const handlePublishToggle = async (fileId, publish) => {
    try {
      const endpoint = publish ? 'publish' : 'unpublish';
      const response = await fetch(`http://localhost:5000/api/questions/${endpoint}/${fileId}`, {
        method: 'POST',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Publish action failed');
      showNotification(data.message || (publish ? 'Published to game.' : 'Removed from game.'), 'success');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Publish action failed.', 'error');
    }
  };

  const handlePreview = (file) => {
    if (!file.file_url) {
      showNotification('File preview is not available for this record.', 'error');
      return;
    }
    const url = getPublicUrl(file.file_url);
    window.open(url, '_blank');
  };

  const beginEditFile = (file) => {
    setEditingFile({ ...file });
  };

  const cancelEditFile = () => {
    setEditingFile(null);
  };

  const saveFileDetails = async () => {
    if (!editingFile.title || !editingFile.grade_level || !editingFile.math_topic) {
      showNotification('Complete all required file metadata fields before saving.', 'error');
      return;
    }
    if (!isValidGradeLevel(editingFile.grade_level) || !isValidMathTopic(editingFile.math_topic)) {
      showNotification('Invalid metadata. Only Grade 1–6 mathematics topics are supported.', 'error');
      return;
    }
    try {
      const response = await fetch(`http://localhost:5000/api/learning-files/${editingFile.id}`, {
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
      showNotification('File details updated successfully.', 'success');
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
      setNotification({ message: 'Folder name is required.', type: 'error' });
      return;
    }
    try {
      const response = await fetch('http://localhost:5000/api/folders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newFolderName.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Folder create failed');
      showNotification('Folder created successfully.', 'success');
      setNewFolderName('');
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
      const response = await fetch(`http://localhost:5000/api/folders/${folder.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: updatedName.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Rename failed');
      showNotification('Folder renamed successfully.', 'success');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Rename failed.', 'error');
    }
  };

  const handleDeleteFolder = async (folder) => {
    if (!window.confirm(`Delete folder "${folder.name}"? Files will remain unassigned.`)) return;
    try {
      const response = await fetch(`http://localhost:5000/api/folders/${folder.id}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Delete failed');
      showNotification('Folder deleted successfully.', 'success');
      loadFilesAndFolders();
    } catch (error) {
      console.error(error);
      showNotification(error.message || 'Delete failed.', 'error');
    }
  };

  const tableColumns = [
    {
      key: 'title',
      header: 'File Name',
      render: (_, row) => (
        <div className="file-name-cell">
          <span className="file-name-title">{row.title}</span>
          <span className="file-meta">{row.file_name}</span>
        </div>
      ),
    },
    { key: 'folder_name', header: 'Folder' },
    { key: 'grade_level', header: 'Grade Level' },
    { key: 'math_topic', header: 'Math Topic' },
    { key: 'file_type', header: 'File Type' },
    { key: 'uploaded_at', header: 'Upload Date', render: (value) => formatUploadDate(value) },
    {
      key: 'actions',
      header: 'Actions',
      className: 'table-actions-cell',
      render: (_, row) => (
        <div className="action-buttons-row">
          <button type="button" className="btn btn-outline" onClick={() => beginEditFile(row)}>Edit</button>
          <button type="button" className="btn btn-secondary" onClick={() => handlePreview(row)}>Preview</button>
          {!row.published ? (
            <button type="button" className="btn btn-primary" onClick={() => handlePublishToggle(row.id, true)}>Publish to Game</button>
          ) : (
            <button type="button" className="btn btn-outline" onClick={() => handlePublishToggle(row.id, false)}>Remove from Game</button>
          )}
          <button type="button" className="btn btn-tertiary" onClick={() => handleDelete(row.id)}>Delete</button>
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
          role={user?.role === 'teacher' ? 'teacher' : 'admin'}
          activeItem="lesson-question-manager"
          portalLabel={user?.role === 'teacher' ? 'Teacher Portal' : 'Admin Portal'}
        />
      }
      main={
        <MainContent>
          <TopBar>
            <div className="manager-topbar">
              <div>
                <h1>Lesson & Question Manager</h1>
                <p>Upload, review, and publish Mathematics lessons and questions for the Godot game.</p>
              </div>
            </div>
          </TopBar>

          <PageContent>
            {notification && (
              <div className={`manager-notification ${notification.type === 'error' ? 'notification-error' : 'notification-success'}`}>
                {notification.message}
              </div>
            )}

            <ContentSection>
              <div className="manager-grid">
                <div className="upload-panel card card-hover">
                  <h2>Upload Math Content</h2>
                  <form onSubmit={handleUpload} className="upload-form">
                    <div className="form-group">
                      <label className="form-label required">Title</label>
                      <input
                        type="text"
                        className="input-field"
                        value={form.title}
                        onChange={(e) => handleFormChange('title', e.target.value)}
                        placeholder="Math Lesson or Question set title"
                        required
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label required">Grade Level</label>
                      <select
                        className="select-field"
                        value={form.grade_level}
                        onChange={(e) => handleFormChange('grade_level', e.target.value)}
                      >
                        {GRADE_LEVELS.map((level) => (
                          <option key={level} value={level}>{level}</option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label className="form-label required">Math Topic</label>
                      <select
                        className="select-field"
                        value={form.math_topic}
                        onChange={(e) => handleFormChange('math_topic', e.target.value)}
                      >
                        {MATH_TOPICS.map((topic) => (
                          <option key={topic} value={topic}>{topic}</option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label className="form-label required">File Type</label>
                      <select
                        className="select-field"
                        value={form.file_type}
                        onChange={(e) => handleFormChange('file_type', e.target.value)}
                      >
                        {FILE_TYPES.map((type) => (
                          <option key={type.value} value={type.value}>{type.label}</option>
                        ))}
                      </select>
                      <div className="field-helper">Lessons accept PDF; fixed questions accept JSON or CSV.</div>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Folder</label>
                      <select
                        className="select-field"
                        value={form.folder_id}
                        onChange={(e) => handleFormChange('folder_id', e.target.value)}
                      >
                        <option value="">Unassigned</option>
                        {folders.map((folder) => (
                          <option key={folder.id} value={folder.id}>{folder.name}</option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label className="form-label required">File</label>
                      <input type="file" accept=".pdf,.json,.csv" onChange={handleFileSelect} />
                    </div>

                    <div className="upload-actions">
                      <button type="submit" className="btn btn-primary" disabled={uploading}>
                        {uploading ? 'Uploading...' : 'Upload Content'}
                      </button>
                      <button type="button" className="btn btn-secondary" onClick={resetForm} disabled={uploading}>
                        Reset
                      </button>
                    </div>
                  </form>
                </div>

                <div className="folder-panel card card-hover">
                  <h2>Folder System</h2>
                  <form onSubmit={handleCreateFolder} className="folder-form">
                    <div className="form-group">
                      <label className="form-label">New Folder Name</label>
                      <input
                        type="text"
                        className="input-field"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        placeholder="Example: Grade 2 Multiplication"
                      />
                    </div>
                    <button type="submit" className="btn btn-primary">Create Folder</button>
                  </form>

                  <div className="folder-list">
                    {folders.length === 0 ? (
                      <p className="empty-text">No folders yet. Create one to organize files.</p>
                    ) : (
                      folders.map((folder) => (
                        <div key={folder.id} className="folder-item">
                          <span>{folder.name}</span>
                          <div className="folder-actions">
                            <button type="button" className="btn btn-outline" onClick={() => handleRenameFolder(folder)}>Rename</button>
                            <button type="button" className="btn btn-tertiary" onClick={() => handleDeleteFolder(folder)}>Delete</button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </ContentSection>

            <ContentSection title="Uploaded Mathematics Content">
              <TableFilters className="manager-filters">
                <div className="filter-group">
                  <input
                    type="text"
                    className="input-field"
                    value={filters.search}
                    onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
                    placeholder="Search files, topics, grades, folders"
                  />
                  <select
                    className="select-field"
                    value={filters.folder}
                    onChange={(e) => setFilters((prev) => ({ ...prev, folder: e.target.value }))}
                  >
                    <option value="">All folders</option>
                    {folders.map((folder) => (
                      <option key={folder.id} value={folder.name}>{folder.name}</option>
                    ))}
                  </select>
                  <select
                    className="select-field"
                    value={filters.grade_level}
                    onChange={(e) => setFilters((prev) => ({ ...prev, grade_level: e.target.value }))}
                  >
                    <option value="">All grades</option>
                    {GRADE_LEVELS.map((level) => (
                      <option key={level} value={level}>{level}</option>
                    ))}
                  </select>
                  <select
                    className="select-field"
                    value={filters.math_topic}
                    onChange={(e) => setFilters((prev) => ({ ...prev, math_topic: e.target.value }))}
                  >
                    <option value="">All topics</option>
                    {MATH_TOPICS.map((topic) => (
                      <option key={topic} value={topic}>{topic}</option>
                    ))}
                  </select>
                </div>
              </TableFilters>

              <DataTable
                columns={tableColumns}
                data={filteredFiles}
                emptyMessage="No math content found. Upload a new lesson or question set."
              />
            </ContentSection>

            {editingFile && (
              <ContentSection title="Edit File Details">
                <div className="edit-panel card card-hover">
                  <div className="form-group">
                    <label className="form-label required">Title</label>
                    <input
                      type="text"
                      className="input-field"
                      value={editingFile.title}
                      onChange={(e) => setEditingFile((prev) => ({ ...prev, title: e.target.value }))}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label required">Grade Level</label>
                    <select
                      className="select-field"
                      value={editingFile.grade_level}
                      onChange={(e) => setEditingFile((prev) => ({ ...prev, grade_level: e.target.value }))}
                    >
                      {GRADE_LEVELS.map((level) => (
                        <option key={level} value={level}>{level}</option>
                      ))}
                      {!GRADE_LEVELS.includes(editingFile.grade_level) && editingFile.grade_level ? (
                        <option value={editingFile.grade_level}>{editingFile.grade_level} (Legacy)</option>
                      ) : null}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label required">Math Topic</label>
                    <select
                      className="select-field"
                      value={editingFile.math_topic}
                      onChange={(e) => setEditingFile((prev) => ({ ...prev, math_topic: e.target.value }))}
                    >
                      {MATH_TOPICS.map((topic) => (
                        <option key={topic} value={topic}>{topic}</option>
                      ))}
                      {!MATH_TOPICS.includes(editingFile.math_topic) && editingFile.math_topic ? (
                        <option value={editingFile.math_topic}>{editingFile.math_topic} (Legacy)</option>
                      ) : null}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Folder</label>
                    <select
                      className="select-field"
                      value={editingFile.folder_id || ''}
                      onChange={(e) => setEditingFile((prev) => ({ ...prev, folder_id: e.target.value || null }))}
                    >
                      <option value="">Unassigned</option>
                      {folders.map((folder) => (
                        <option key={folder.id} value={folder.id}>{folder.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="edit-actions">
                    <button type="button" className="btn btn-primary" onClick={saveFileDetails}>Save Changes</button>
                    <button type="button" className="btn btn-secondary" onClick={cancelEditFile}>Cancel</button>
                  </div>
                </div>
              </ContentSection>
            )}
          </PageContent>
        </MainContent>
      }
    />
  );
}
