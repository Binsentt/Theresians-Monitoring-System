const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const path = require('path');
const dns = require('dns');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');

dns.setDefaultResultOrder('ipv4first');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const pool = require('./database/db');

const app = express();
const port = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';

app.use(cors());
app.use(express.json());

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const upload = multer({ dest: uploadsDir, limits: { fileSize: 30 * 1024 * 1024 } });

const MY_GMAIL = process.env.EMAIL_USER || 'vincenttafalla2@gmail.com';
const MY_APP_PASS = process.env.EMAIL_PASS || 'cuij whit wnoc gqcq';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: MY_GMAIL,
    pass: MY_APP_PASS,
  },
});

transporter.verify(err => {
  if (err) console.error('❌ Email Error:', err.message);
  else console.log('✅ Email server ready');
});

const ensureSchema = async () => {
  try {
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50)');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS accounts_employee_id_key ON public.accounts(employee_id)');
    await pool.query(`CREATE TABLE IF NOT EXISTS public.student_game_progress (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
      student_name VARCHAR(100) NOT NULL,
      grade_level VARCHAR(20),
      current_quest VARCHAR(100),
      score INTEGER DEFAULT 0,
      correct_answers INTEGER DEFAULT 0,
      total_questions INTEGER DEFAULT 0,
      accuracy_rate DECIMAL(5, 2) DEFAULT 0.00,
      progress_percentage DECIMAL(5, 2) DEFAULT 0.00,
      last_played TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('ALTER TABLE public.student_game_progress ADD COLUMN IF NOT EXISTS section CHARACTER VARYING(50)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_student_game_progress_student_id ON public.student_game_progress(student_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_student_game_progress_score ON public.student_game_progress(score DESC)');
    await pool.query(`CREATE TABLE IF NOT EXISTS public.teacher_student_relationships (
      id SERIAL PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
      relationship_type VARCHAR(50) NOT NULL DEFAULT 'Parent',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT teacher_student_relationships_unique UNIQUE (teacher_id, student_id, relationship_type)
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS public.activity_logs (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES public.accounts(id) ON DELETE CASCADE,
      student_name VARCHAR(255) NOT NULL,
      grade_level VARCHAR(50),
      section VARCHAR(50),
      current_quest VARCHAR(255),
      save_status VARCHAR(50) DEFAULT 'pending',
      total_play_time INTEGER DEFAULT 0,
      last_played TIMESTAMPTZ,
      quest_progress INTEGER DEFAULT 0,
      difficulty_level VARCHAR(50) DEFAULT 'Normal',
      login_time TIMESTAMPTZ,
      logout_time TIMESTAMPTZ,
      session_date DATE,
      activity_timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      activity_description TEXT,
      role VARCHAR(50),
      status VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON public.activity_logs(activity_timestamp DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_student_name ON public.activity_logs(student_name)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_grade_section ON public.activity_logs(grade_level, section)');

    await pool.query(`CREATE TABLE IF NOT EXISTS public.folders (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS public.learning_files (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      grade_level VARCHAR(50) NOT NULL,
      math_topic VARCHAR(100) NOT NULL,
      file_type VARCHAR(50) NOT NULL,
      subject VARCHAR(50) NOT NULL DEFAULT 'Mathematics',
      folder_id INTEGER REFERENCES public.folders(id) ON DELETE SET NULL,
      published BOOLEAN DEFAULT false,
      source VARCHAR(50) NOT NULL,
      uploaded_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL,
      uploaded_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS public.questions (
      id SERIAL PRIMARY KEY,
      learning_file_id INTEGER REFERENCES public.learning_files(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      options JSONB,
      correct_answer TEXT NOT NULL,
      grade_level VARCHAR(50),
      math_topic VARCHAR(100),
      source VARCHAR(50) NOT NULL,
      published BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_learning_files_published ON public.learning_files(published)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_questions_published ON public.questions(published)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_learning_files_grade_topic ON public.learning_files(grade_level, math_topic)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_questions_grade_topic ON public.questions(grade_level, math_topic)');
  } catch (err) {
    console.error('Schema initialization failed:', err.message);
  }
};

ensureSchema();

const generateRandomPassword = () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';
  let value = '';
  value += letters[Math.floor(Math.random() * letters.length)];
  value += letters.toLowerCase()[Math.floor(Math.random() * letters.length)];
  value += digits[Math.floor(Math.random() * digits.length)];
  value += symbols[Math.floor(Math.random() * symbols.length)];
  const poolChars = letters + letters.toLowerCase() + digits + symbols;
  while (value.length < 14) {
    value += poolChars[Math.floor(Math.random() * poolChars.length)];
  }
  return value;
};

const createRememberToken = (user) => {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
};

const SALT_ROUNDS = 10;
const hashPassword = async (plainPassword) => {
  return await bcrypt.hash(plainPassword, SALT_ROUNDS);
};

const comparePassword = async (plainPassword, hashedPassword) => {
  if (!plainPassword || !hashedPassword) return false;
  const isBcryptHash = typeof hashedPassword === 'string' && hashedPassword.startsWith('$2');
  if (isBcryptHash) {
    return await bcrypt.compare(plainPassword, hashedPassword);
  }
  return plainPassword === hashedPassword;
};

const generateDefaultEmail = (name) => {
  const cleaned = (name || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  const suffix = Math.floor(100 + Math.random() * 900);
  return `${cleaned || 'user'}${suffix}@gmail.com`;
};

const generateCredentialsEmail = async (email, password, role) => {
  const appUrl = process.env.APP_URL || 'http://localhost:3000/login';
  try {
    await transporter.sendMail({
      from: `"Saint Therese School" <${MY_GMAIL}>`,
      to: email,
      subject: 'Your STS Portal Account Credentials',
      html: `<div style="font-family: Arial, sans-serif; border: 1px solid #ddd; padding: 20px; border-radius: 10px; background: #f8f9fa;">
              <h2 style="color: #0b2447;">Welcome to STS Portal</h2>
              <p>Your account has been created with the following credentials:</p>
              <ul style="color: #333;">
                <li><strong>Email:</strong> ${email}</li>
                <li><strong>Role:</strong> ${role}</li>
                <li><strong>Password:</strong> ${password}</li>
              </ul>
              <p>Please log in using the link below and change your password immediately.</p>
              <p><a href="${appUrl}" style="display: inline-block; padding: 10px 16px; background: #2563eb; color: white; border-radius: 6px; text-decoration: none;">Login to STS Portal</a></p>
              <p style="color: #777; font-size: 13px;">If you did not request this account, please contact your administrator.</p>
            </div>`
    });
    return true;
  } catch (err) {
    console.error('❌ Credential Email Send Error:', err.message);
    return false;
  }
};

const verifyRememberToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
};

const sendOtpEmail = async (email, otp, subject = 'Login Verification Code') => {
  try {
    await transporter.sendMail({
      from: `"Saint Therese School" <${MY_GMAIL}>`,
      to: email,
      subject,
      html: `<div style="font-family: Arial, sans-serif; border: 1px solid #ddd; padding: 20px; border-radius: 10px; background: #f8f9fa;">
              <h2 style="color: #0b2447;">Security Verification</h2>
              <p>Your verification code is:</p>
              <p style="font-size: 32px; font-weight: 700; letter-spacing: 6px; margin: 12px 0;">${otp}</p>
              <p style="color: #444;">This code expires in 3 minutes.</p>
            </div>`
    });
  } catch (mailErr) {
    console.error('❌ Email Send Error:', mailErr.message);
  }
};

const calculateAge = (birthday) => {
  if (!birthday) return 0;
  const birthDate = new Date(birthday);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age -= 1;
  }
  return age;
};

const normalizeAccountRole = (role) => String(role || '').trim().toLowerCase();

const serializeUser = (user) => {
  if (!user) return null;
  const { password, otp_code, otp_expires_at, is_archived, must_change_password, ...rest } = user;
  return {
    ...rest,
    mustChangePassword: !!must_change_password,
    isArchived: !!is_archived,
  };
};

const getDefaultSection = (gradeLevel, studentId) => {
  const letters = ['A', 'B', 'C'];
  const gradeKey = String(gradeLevel || '').trim().toLowerCase();
  if (!gradeKey) return 'Section A';
  const index = studentId ? studentId % letters.length : 0;
  return `Section ${letters[index]}`;
};

const normalizeStudentProgressRow = (row) => {
  const incorrectAnswers = Number(row.total_questions || 0) - Number(row.correct_answers || 0);
  return {
    ...row,
    section: row.section || getDefaultSection(row.grade_level, row.student_id),
    incorrect_answers: incorrectAnswers < 0 ? 0 : incorrectAnswers,
  };
};

const resolveScopeId = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? NaN : parsed;
};

const resolveParentScopeId = (value) => resolveScopeId(value);

const resolveTeacherScopeId = (value) => resolveScopeId(value);

const appendTeacherScopeFilter = ({ teacherId, params, studentColumn }) => {
  if (!teacherId) return '';
  params.push(teacherId);
  return `
    AND ${studentColumn} IN (
      SELECT tsr.student_id
      FROM public.teacher_student_relationships tsr
      WHERE tsr.teacher_id = $${params.length}
    )
  `;
};

const appendParentScopeFilter = ({ parentId, params, studentColumn, relationshipType = 'parent' }) => {
  if (!parentId) return '';
  params.push(parentId);
  return `
    AND ${studentColumn} IN (
      SELECT tsr.student_id
      FROM public.teacher_student_relationships tsr
      WHERE tsr.teacher_id = $${params.length}
        AND LOWER(tsr.relationship_type) = '${relationshipType}'
    )
  `;
};

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const shuffleArray = (array) => array.sort(() => Math.random() - 0.5);
const normalizeTopic = (topic) => String(topic || '').toLowerCase();

const ALLOWED_GRADE_LEVELS = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'];
const ALLOWED_MATH_TOPICS = ['Addition', 'Subtraction', 'Multiplication', 'Division', 'Fractions', 'Decimals', 'Geometry', 'Basic Algebra', 'Word Problems'];
const ALLOWED_FILE_TYPES = ['lesson', 'fixed_questions'];

const isValidGradeLevel = (value) => ALLOWED_GRADE_LEVELS.includes(String(value || '').trim());
const isValidMathTopic = (value) => ALLOWED_MATH_TOPICS.includes(String(value || '').trim());
const isValidFileType = (value) => ALLOWED_FILE_TYPES.includes(String(value || '').trim().toLowerCase());
const gradeNumber = (gradeLevel) => {
  const match = String(gradeLevel || '').trim().match(/^Grade\s*(\d+)$/i);
  return match ? Number(match[1]) : null;
};

const buildMathQuestionTemplates = (grade_level, math_topic) => {
  const topic = normalizeTopic(math_topic);
  const gradeNum = gradeNumber(grade_level) || 1;
  const templates = [];

  const pushQuestion = (question, correct, options) => {
    const set = new Set([correct, ...(options || [])]);
    const choices = Array.from(set).slice(0, 4);
    return {
      question,
      options: shuffleArray(choices),
      correct_answer: String(correct),
      grade_level,
      math_topic,
      source: 'ai',
    };
  };

  if (topic.includes('addition')) {
    const maxAdd = gradeNum <= 2 ? 10 : gradeNum <= 4 ? 20 : 30;
    for (let i = 0; i < 5; i += 1) {
      const a = randomInt(1, maxAdd);
      const b = randomInt(1, maxAdd);
      const correct = a + b;
      templates.push(pushQuestion(`What is ${a} + ${b}?`, correct, [correct + 2, Math.max(0, correct - 1), correct + 5]));
    }
  } else if (topic.includes('subtraction')) {
    const maxSub = gradeNum <= 2 ? 10 : gradeNum <= 4 ? 20 : 30;
    for (let i = 0; i < 5; i += 1) {
      const a = randomInt(1, maxSub);
      const b = randomInt(1, Math.min(a, 10));
      const correct = a - b;
      templates.push(pushQuestion(`What is ${a} - ${b}?`, correct, [Math.max(0, correct + 1), Math.max(0, correct - 2), correct + 5]));
    }
  } else if (topic.includes('multiplication')) {
    const maxMul = gradeNum <= 3 ? 6 : gradeNum <= 5 ? 10 : 12;
    for (let i = 0; i < 5; i += 1) {
      const a = randomInt(2, maxMul);
      const b = randomInt(2, maxMul);
      const correct = a * b;
      templates.push(pushQuestion(`What is ${a} × ${b}?`, correct, [correct + a, Math.max(0, correct - b), correct + 4]));
    }
  } else if (topic.includes('division')) {
    const maxDiv = gradeNum <= 3 ? 6 : gradeNum <= 5 ? 10 : 12;
    for (let i = 0; i < 5; i += 1) {
      const b = randomInt(2, maxDiv);
      const correct = randomInt(2, 10);
      const a = correct * b;
      templates.push(pushQuestion(`What is ${a} ÷ ${b}?`, correct, [correct + 1, Math.max(0, correct - 1), correct + 2]));
    }
  } else if (topic.includes('fractions')) {
    templates.push(pushQuestion('Which of these fractions is equal to 1/2?', '2/4', ['1/3', '3/4', '2/3']));
    templates.push(pushQuestion('What is 1/4 + 1/4?', '1/2', ['1/4', '3/4', '2/3']));
    templates.push(pushQuestion('Which fraction is greater: 3/5 or 4/7?', '3/5', ['4/7', '2/5', '1/2']));
  } else if (topic.includes('decimals')) {
    templates.push(pushQuestion('What is 0.5 + 0.25?', '0.75', ['0.65', '0.85', '1.25']));
    templates.push(pushQuestion('Which decimal is largest?', '0.9', ['0.7', '0.65', '0.8']));
    templates.push(pushQuestion('What is 0.2 + 0.3?', '0.5', ['0.4', '0.6', '0.7']));
  } else if (topic.includes('geometry')) {
    templates.push(pushQuestion('How many sides does a rectangle have?', '4', ['3', '5', '6']));
    templates.push(pushQuestion('What is the area formula for a rectangle?', 'length × width', ['2 × width', 'base × height', 'side + side']));
    templates.push(pushQuestion('How many corners does a triangle have?', '3', ['4', '2', '5']));
  } else if (topic.includes('algebra')) {
    templates.push(pushQuestion('Solve for x: x + 5 = 9', '4', ['3', '5', '6']));
    templates.push(pushQuestion('If x = 3 and y = 4, what is x + y?', '7', ['6', '8', '5']));
    templates.push(pushQuestion('What is the value of x if 2x = 10?', '5', ['4', '6', '7']));
  } else if (topic.includes('word') || topic.includes('problem')) {
    const a = randomInt(1, 10);
    const b = randomInt(1, 10);
    templates.push(pushQuestion(`Mia has ${a} apples and buys ${b} more. How many apples does she have now?`, `${a + b}`, [`${a + b + 1}`, `${Math.max(0, a + b - 1)}`, `${a + b + 2}`]));
    templates.push(pushQuestion(`John has ${a + b} toy cars and gives ${b} to his friend. How many cars does he have left?`, `${a}`, [`${a + 1}`, `${Math.max(0, a - 1)}`, `${a + 2}`]));
    templates.push(pushQuestion(`A box contains ${a} red balls and ${b} blue balls. How many balls are there in total?`, `${a + b}`, [`${a + b - 1}`, `${a + b + 1}`, `${a + b + 2}`]));
  } else {
    const a = randomInt(1, 10);
    const b = randomInt(1, 10);
    const c = a + b;
    templates.push(pushQuestion(`What is ${a} + ${b}?`, `${c}`, [`${c + 1}`, `${Math.max(0, c - 1)}`, `${c + 2}`]));
    templates.push(pushQuestion(`What is ${c} - ${a}?`, `${b}`, [`${Math.max(0, b - 1)}`, `${b + 1}`, `${b + 2}`]));
    templates.push(pushQuestion(`What is ${a} × ${b}?`, `${a * b}`, [`${a * b + 2}`, `${Math.max(0, a * b - 1)}`, `${a * b + 3}`]));
  }

  return shuffleArray(templates).slice(0, 6);
};

const saveQuestionsForFile = async (learningFileId, questions) => {
  if (!Array.isArray(questions) || questions.length === 0) return;
  const insertPromises = questions.map((item) => pool.query(
    `INSERT INTO public.questions (learning_file_id, question, options, correct_answer, grade_level, math_topic, source, published)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [learningFileId, item.question, JSON.stringify(item.options || []), item.correct_answer, item.grade_level, item.math_topic, item.source || 'ai', false]
  ));
  await Promise.all(insertPromises);
};

const parseFixedQuestionsFile = async (file) => {
  const buffer = fs.readFileSync(file.path);
  const content = buffer.toString('utf8');
  const lowerName = String(file.originalname).toLowerCase();
  if (lowerName.endsWith('.json')) {
    const payload = JSON.parse(content);
    if (!Array.isArray(payload)) throw new Error('JSON must contain an array of questions');
    return payload.map((item) => ({
      question: String(item.question || '').trim(),
      options: Array.isArray(item.options) ? item.options : [],
      correct_answer: String(item.correct_answer || item.answer || '').trim(),
      grade_level: String(item.grade_level || '').trim(),
      math_topic: String(item.math_topic || '').trim(),
      source: 'fixed',
    })).filter((item) => item.question && item.correct_answer);
  }
  if (lowerName.endsWith('.csv')) {
    const rows = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return rows.map((line) => {
      const [question, ...rest] = line.split(',').map((cell) => cell.trim());
      const options = rest.slice(0, 4).filter(Boolean);
      return {
        question,
        options,
        correct_answer: options[0] || '',
        grade_level: '',
        math_topic: '',
        source: 'fixed',
      };
    }).filter((item) => item.question && item.correct_answer);
  }
  throw new Error('Unsupported fixed question file format');
};

const removeFileFromDisk = (fileUrl) => {
  if (!fileUrl) return;
  const filePath = fileUrl.startsWith('http') ? null : path.join(__dirname, fileUrl.replace('/uploads/', 'uploads/'));
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      console.warn('Failed to delete file from disk:', error.message);
    }
  }
};

const buildLearningFileResponse = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const generateUploadFileName = (originalName) => {
  const timestamp = Date.now();
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${timestamp}_${safeName}`;
};

const buildFileUrl = (fileName) => `/uploads/${fileName}`;

const generateQuestionTextFromLesson = async (filePath, title, grade_level, math_topic) => {
  const buffer = fs.readFileSync(filePath);
  const pdfData = await pdfParse(buffer).catch(() => ({ text: '' }));
  const text = String(pdfData.text || title || '').trim();
  return buildMathQuestionTemplates(grade_level, math_topic || text);
};

const saveUploadedLearningFile = async ({ title, grade_level, math_topic, file_type, folder_id, uploaded_by, file }) => {
  const fileName = generateUploadFileName(file.originalname);
  const destinationPath = path.join(uploadsDir, fileName);
  fs.renameSync(file.path, destinationPath);
  const fileUrl = buildFileUrl(fileName);
  const source = file_type === 'lesson' ? 'lesson' : 'fixed';

  const result = await pool.query(
    `INSERT INTO public.learning_files (title, file_name, file_url, grade_level, math_topic, file_type, subject, folder_id, published, source, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'Mathematics', $7, false, $8, $9)
     RETURNING *`,
    [title, file.originalname, fileUrl, grade_level, math_topic, file_type, folder_id || null, source, uploaded_by || null]
  );

  return result.rows[0];
};

const publishLearningFile = async (fileId) => {
  await pool.query('UPDATE public.learning_files SET published = true WHERE id = $1', [fileId]);
  await pool.query('UPDATE public.questions SET published = true WHERE learning_file_id = $1', [fileId]);
};

const unpublishLearningFile = async (fileId) => {
  await pool.query('UPDATE public.learning_files SET published = false WHERE id = $1', [fileId]);
  await pool.query('UPDATE public.questions SET published = false WHERE learning_file_id = $1', [fileId]);
};

const buildPublishedQueryClause = (params, { grade_level, math_topic }) => {
  let clause = ' WHERE lf.subject = $1 AND lf.published = true';
  params.push('Mathematics');
  if (grade_level) {
    params.push(grade_level);
    clause += ` AND lf.grade_level = $${params.length}`;
  }
  if (math_topic) {
    params.push(math_topic);
    clause += ` AND lf.math_topic = $${params.length}`;
  }
  return clause;
};

const buildFolderResponse = (row) => row;

const buildLearningFileResponseFromRow = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const buildQuestionResponseByRow = (row) => ({
  id: row.id,
  learning_file_id: row.learning_file_id,
  question: row.question,
  options: row.options,
  correct_answer: row.correct_answer,
  grade_level: row.grade_level,
  math_topic: row.math_topic,
  source: row.source,
  published: row.published,
});

const buildFileRecord = (row) => ({
  ...row,
  file_url: row.file_url,
  folder_name: row.folder_name || 'Unassigned',
});

const updateLearningFileMetadata = async ({ id, title, grade_level, math_topic, file_type, folder_id }) => {
  const result = await pool.query(
    `UPDATE public.learning_files
     SET title = $1,
         grade_level = $2,
         math_topic = $3,
         file_type = $4,
         folder_id = $5
     WHERE id = $6
     RETURNING *`,
    [title, grade_level, math_topic, file_type, folder_id || null, id]
  );
  return result.rows[0];
};

const generateQuestionsForLearningFile = async (learningFile) => {
  const fileRecord = learningFile;
  let questions = [];
  if (fileRecord.file_type === 'lesson') {
    questions = await generateQuestionTextFromLesson(path.join(uploadsDir, fileRecord.file_name), fileRecord.title, fileRecord.grade_level, fileRecord.math_topic);
  } else {
    questions = await parseFixedQuestionsFile({ path: path.join(uploadsDir, fileRecord.file_name), originalname: fileRecord.file_name });
  }
  await saveQuestionsForFile(fileRecord.id, questions.map((question) => ({
    ...question,
    grade_level: fileRecord.grade_level,
    math_topic: fileRecord.math_topic,
    source: fileRecord.source === 'fixed' ? 'fixed' : 'ai',
  })));
};

const upsertFixedQuestionsBundle = async (learningFile, questions) => {
  await saveQuestionsForFile(learningFile.id, questions.map((item) => ({
    ...item,
    grade_level: learningFile.grade_level,
    math_topic: learningFile.math_topic,
    source: 'fixed',
  })));
};

const cleanTemporaryUpload = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('Failed to remove temporary upload file:', err.message);
    }
  }
};

const buildLearningFilesList = (rows) => rows.map((row) => buildFileRecord(row));

const getUploadedFileRecord = async (fileId) => {
  const result = await pool.query(
    `SELECT lf.*, f.name AS folder_name
     FROM public.learning_files lf
     LEFT JOIN public.folders f ON lf.folder_id = f.id
     WHERE lf.id = $1`,
    [fileId]
  );
  return result.rows[0] ? buildFileRecord(result.rows[0]) : null;
};

const generateFilePayload = async ({ title, grade_level, math_topic, file_type, folder_id, uploaded_by, file }) => {
  const fileRecord = await saveUploadedLearningFile({ title, grade_level, math_topic, file_type, folder_id, uploaded_by, file });
  if (file_type === 'lesson') {
    await generateQuestionsForLearningFile(fileRecord);
  } else {
    const fixedQuestions = await parseFixedQuestionsFile(file);
    await upsertFixedQuestionsBundle(fileRecord, fixedQuestions);
  }
  return fileRecord;
};

const finalizeUploadedFile = async (learningFileId) => {
  const fileRecord = await getUploadedFileRecord(learningFileId);
  if (!fileRecord) throw new Error('File record not found');
  return fileRecord;
};

const getPublishedGameData = async ({ grade_level, math_topic }) => {
  const params = [];
  const clause = buildPublishedQueryClause(params, { grade_level, math_topic });
  const filesResult = await pool.query(
    `SELECT lf.*, f.name as folder_name
     FROM public.learning_files lf
     LEFT JOIN public.folders f ON lf.folder_id = f.id
     ${clause}
     ORDER BY lf.uploaded_at DESC`,
    params
  );

  const questionsResult = await pool.query(
    `SELECT q.* FROM public.questions q
     JOIN public.learning_files lf ON q.learning_file_id = lf.id
     WHERE q.published = true
       AND lf.subject = 'Mathematics'
       ${grade_level ? `AND q.grade_level = ${params.length + 1}` : ''}
       ${math_topic ? `AND q.math_topic = ${params.length + (grade_level ? 2 : 1)}` : ''}
     ORDER BY q.created_at DESC`
  );

  return {
    learning_files: buildLearningFilesList(filesResult.rows),
    questions: questionsResult.rows.map(buildQuestionResponseByRow),
  };
};

const parseGameQuery = (query) => ({
  grade_level: query.grade_level,
  math_topic: query.math_topic,
});

const validateLearningFileId = async (id) => {
  const file = await getUploadedFileRecord(id);
  if (!file) throw new Error('Uploaded file not found');
  return file;
};

const safeDeleteFolder = async (folderId) => {
  await pool.query('UPDATE public.learning_files SET folder_id = NULL WHERE folder_id = $1', [folderId]);
  await pool.query('DELETE FROM public.folders WHERE id = $1', [folderId]);
};

const createLearningFolder = async (name) => {
  const result = await pool.query(
    `INSERT INTO public.folders (name)
     VALUES ($1)
     RETURNING *`,
    [name]
  );
  return result.rows[0];
};

const editLearningFolder = async (id, name) => {
  const result = await pool.query(
    `UPDATE public.folders
     SET name = $1
     WHERE id = $2
     RETURNING *`,
    [name, id]
  );
  return result.rows[0];
};

const getLearningFolders = async () => {
  const result = await pool.query('SELECT * FROM public.folders ORDER BY name');
  return result.rows.map(buildFolderResponse);
};

const getLearningFiles = async () => {
  const result = await pool.query(
    `SELECT lf.*, f.name as folder_name
     FROM public.learning_files lf
     LEFT JOIN public.folders f ON lf.folder_id = f.id
     ORDER BY lf.uploaded_at DESC`
  );
  return result.rows.map(buildFileRecord);
};

const getGameQuestions = async ({ grade_level, math_topic }) => {
  const params = ['Mathematics'];
  let clause = 'WHERE lf.subject = $1 AND lf.published = true';
  if (grade_level) {
    params.push(grade_level);
    clause += ` AND lf.grade_level = $${params.length}`;
  }
  if (math_topic) {
    params.push(math_topic);
    clause += ` AND lf.math_topic = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT q.* FROM public.questions q
     JOIN public.learning_files lf ON lf.id = q.learning_file_id
     ${clause}
     AND q.published = true
     ORDER BY q.created_at DESC`,
    params
  );
  return result.rows.map((row) => ({
    id: row.id,
    learning_file_id: row.learning_file_id,
    question: row.question,
    options: row.options,
    correct_answer: row.correct_answer,
    grade_level: row.grade_level,
    math_topic: row.math_topic,
    source: row.source,
  }));
};

const finalizeFileUploadRecord = async (fileId) => {
  const record = await getUploadedFileRecord(fileId);
  return record;
};

const buildFileUrlPath = (fileName) => `/uploads/${fileName}`;

const getLearningFileById = async (id) => {
  const result = await pool.query(`SELECT * FROM public.learning_files WHERE id = $1`, [id]);
  return result.rows[0] || null;
};

const getLearningFileQuestions = async (id) => {
  const result = await pool.query('SELECT * FROM public.questions WHERE learning_file_id = $1', [id]);
  return result.rows;
};

const removeLearningFileAndQuestions = async (id) => {
  const file = await getLearningFileById(id);
  await pool.query('DELETE FROM public.questions WHERE learning_file_id = $1', [id]);
  await pool.query('DELETE FROM public.learning_files WHERE id = $1', [id]);
  if (file) removeFileFromDisk(file.file_url);
};

const buildLearningFileMetadataResponse = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const needQuestionParser = async (fileType, file) => {
  if (fileType === 'fixed_questions') {
    return await parseFixedQuestionsFile(file);
  }
  return [];
};

const getGameFiles = async ({ grade_level, math_topic }) => {
  const params = ['Mathematics'];
  let clause = 'WHERE subject = $1 AND published = true';
  if (grade_level) {
    params.push(grade_level);
    clause += ` AND grade_level = $${params.length}`;
  }
  if (math_topic) {
    params.push(math_topic);
    clause += ` AND math_topic = $${params.length}`;
  }
  const result = await pool.query(`SELECT * FROM public.learning_files ${clause} ORDER BY uploaded_at DESC`, params);
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    file_url: row.file_url,
    grade_level: row.grade_level,
    math_topic: row.math_topic,
    file_type: row.file_type,
    published: row.published,
  }));
};

const getPublishedLearningData = async (query) => ({
  learning_files: await getGameFiles(query),
  questions: await getGameQuestions(query),
});

const buildLearningFileView = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const buildQuestionView = (row) => ({
  id: row.id,
  question: row.question,
  options: row.options,
  correct_answer: row.correct_answer,
  grade_level: row.grade_level,
  math_topic: row.math_topic,
  published: row.published,
});

const fetchFolders = async () => {
  const result = await pool.query('SELECT * FROM public.folders ORDER BY name ASC');
  return result.rows;
};

const fetchLearningFiles = async () => {
  const result = await pool.query(
    `SELECT lf.*, f.name AS folder_name
     FROM public.learning_files lf
     LEFT JOIN public.folders f ON lf.folder_id = f.id
     ORDER BY lf.uploaded_at DESC`
  );
  return result.rows.map((row) => buildLearningFileView(row));
};

const fetchPublishedGameData = async ({ grade_level, math_topic }) => {
  const files = await getGameFiles({ grade_level, math_topic });
  const questions = await getGameQuestions({ grade_level, math_topic });
  return { learning_files: files, questions };
};

const safeString = (value) => String(value || '').trim();

const readJsonFile = (pathInput) => JSON.parse(fs.readFileSync(pathInput, 'utf8'));

// Keep existing helper definitions after this point.

const buildPublishedGameQuery = ({ grade_level, math_topic }) => {
  const params = ['Mathematics'];
  let clause = 'lf.subject = $1 AND lf.published = true';
  if (grade_level) {
    params.push(grade_level);
    clause += ` AND lf.grade_level = $${params.length}`;
  }
  if (math_topic) {
    params.push(math_topic);
    clause += ` AND lf.math_topic = $${params.length}`;
  }
  return { clause, params };
};

const getGameQuestionsByQuery = async ({ grade_level, math_topic }) => {
  const { clause, params } = buildPublishedGameQuery({ grade_level, math_topic });
  const query = `
    SELECT q.*
    FROM public.questions q
    JOIN public.learning_files lf ON q.learning_file_id = lf.id
    WHERE q.published = true
      AND ${clause}
    ORDER BY q.created_at DESC
  `;
  const result = await pool.query(query, params);
  return result.rows.map(buildQuestionView);
};

const getGameLearningFilesByQuery = async ({ grade_level, math_topic }) => {
  const { clause, params } = buildPublishedGameQuery({ grade_level, math_topic });
  const result = await pool.query(`
    SELECT lf.*, f.name AS folder_name
    FROM public.learning_files lf
    LEFT JOIN public.folders f ON lf.folder_id = f.id
    WHERE ${clause}
    ORDER BY lf.uploaded_at DESC
  `, params);
  return result.rows.map(buildLearningFileView);
};

const getGameDataByQuery = async (query) => ({
  learning_files: await getGameLearningFilesByQuery(query),
  questions: await getGameQuestionsByQuery(query),
});

const tryParseJson = (value) => {
  try { return JSON.parse(value); } catch { return null; }
};

const removeTempFile = (pathToRemove) => {
  if (!pathToRemove) return;
  try { fs.unlinkSync(pathToRemove); } catch (err) { /* ignore */ }
};

const mapFileRowToResult = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const mapFolderRowToResult = (row) => ({ id: row.id, name: row.name, created_at: row.created_at });

const mapQuestionRowToResult = (row) => ({
  id: row.id,
  learning_file_id: row.learning_file_id,
  question: row.question,
  options: row.options,
  correct_answer: row.correct_answer,
  grade_level: row.grade_level,
  math_topic: row.math_topic,
  source: row.source,
  published: row.published,
});

const buildFileResponseStatement = (row) => ({ ...row, folder_name: row.folder_name || 'Unassigned' });

const throwNotFound = (message) => { throw new Error(message || 'Not found'); };

const normalizeBoolean = (value) => String(value).toLowerCase() === 'true';

const signalFileNotFound = (id) => `Learning file ${id} does not exist`;

const getGameQueryParams = (req) => ({ grade_level: req.query.grade_level, math_topic: req.query.math_topic });

const confirmFileExists = async (id) => {
  const result = await pool.query('SELECT id FROM public.learning_files WHERE id = $1', [id]);
  if (result.rows.length === 0) throw new Error('Learning file not found');
};

const createUploadRecord = async (form) => {
  const result = await pool.query(
    `INSERT INTO public.learning_files (title, file_name, file_url, grade_level, math_topic, file_type, subject, folder_id, published, source, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'Mathematics', $7, false, $8, $9) RETURNING *`,
    [form.title, form.file_name, form.file_url, form.grade_level, form.math_topic, form.file_type, form.folder_id || null, form.source, form.uploaded_by || null]
  );
  return result.rows[0];
};

const getFileMetadata = async (id) => {
  const result = await pool.query(`SELECT lf.*, f.name as folder_name
    FROM public.learning_files lf
    LEFT JOIN public.folders f ON lf.folder_id = f.id
    WHERE lf.id = $1`, [id]);
  return result.rows[0];
};

const buildPublishedLearningFilesQuery = ({ grade_level, math_topic }) => {
  const params = ['Mathematics'];
  let clause = 'WHERE lf.subject = $1 AND lf.published = true';
  if (grade_level) {
    params.push(grade_level);
    clause += ` AND lf.grade_level = $${params.length}`;
  }
  if (math_topic) {
    params.push(math_topic);
    clause += ` AND lf.math_topic = $${params.length}`;
  }
  return { clause, params };
};

const buildQuestionQuery = ({ grade_level, math_topic }) => {
  const { clause, params } = buildPublishedLearningFilesQuery({ grade_level, math_topic });
  return {
    text: `SELECT q.* FROM public.questions q JOIN public.learning_files lf ON q.learning_file_id = lf.id WHERE q.published = true AND ${clause} ORDER BY q.created_at DESC`,
    params,
  };
};

const buildLearningFileQuery = ({ grade_level, math_topic }) => {
  const { clause, params } = buildPublishedLearningFilesQuery({ grade_level, math_topic });
  return {
    text: `SELECT lf.*, f.name as folder_name FROM public.learning_files lf LEFT JOIN public.folders f ON lf.folder_id = f.id ${clause} ORDER BY lf.uploaded_at DESC`,
    params,
  };
};

const parseLearningFileUpload = (body) => ({
  title: body.title,
  grade_level: body.grade_level,
  math_topic: body.math_topic,
  file_type: body.file_type,
  folder_id: body.folder_id ? parseInt(body.folder_id, 10) : null,
  uploaded_by: body.uploaded_by ? parseInt(body.uploaded_by, 10) : null,
});

const getPostgresSafeId = (value) => {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error('Invalid id');
  return parsed;
};

const buildQuestionsPublishQuery = (learningFileId) => ({
  text: 'UPDATE public.questions SET published = true WHERE learning_file_id = $1',
  params: [learningFileId],
});

const buildQuestionsUnpublishQuery = (learningFileId) => ({
  text: 'UPDATE public.questions SET published = false WHERE learning_file_id = $1',
  params: [learningFileId],
});

const buildLearningFileMetadataUpdate = ({ id, title, grade_level, math_topic, file_type, folder_id }) => ({
  text: `UPDATE public.learning_files SET title = $1, grade_level = $2, math_topic = $3, file_type = $4, folder_id = $5 WHERE id = $6 RETURNING *`,
  params: [title, grade_level, math_topic, file_type, folder_id || null, id],
});

const createLearningFileFolder = ({ name }) => ({
  text: 'INSERT INTO public.folders (name) VALUES ($1) RETURNING *',
  params: [name],
});

const renameLearningFileFolder = ({ id, name }) => ({
  text: 'UPDATE public.folders SET name = $1 WHERE id = $2 RETURNING *',
  params: [name, id],
});

const purgeLearningFileFolder = ({ id }) => ({
  text: 'DELETE FROM public.folders WHERE id = $1',
  params: [id],
});

const clearFolderAssignments = ({ id }) => ({
  text: 'UPDATE public.learning_files SET folder_id = NULL WHERE folder_id = $1',
  params: [id],
});

const getPublishedQuestionsForGame = async ({ grade_level, math_topic }) => {
  const { text, params } = buildQuestionQuery({ grade_level, math_topic });
  const result = await pool.query(text, params);
  return result.rows;
};

const getPublishedLearningFilesForGame = async ({ grade_level, math_topic }) => {
  const { text, params } = buildLearningFileQuery({ grade_level, math_topic });
  const result = await pool.query(text, params);
  return result.rows;
};

const getGameResponse = async (query) => ({
  learning_files: await getPublishedLearningFilesForGame(query),
  questions: await getPublishedQuestionsForGame(query),
});

const buildLearningFileResult = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const buildGameQuestionResult = (row) => ({
  ...row,
  options: row.options || [],
});

const getLearningFileResults = async () => {
  const result = await pool.query(`
    SELECT lf.*, f.name AS folder_name
    FROM public.learning_files lf
    LEFT JOIN public.folders f ON lf.folder_id = f.id
    ORDER BY lf.uploaded_at DESC
  `);
  return result.rows.map(buildLearningFileResult);
};

const getFolderResults = async () => {
  const result = await pool.query('SELECT * FROM public.folders ORDER BY name ASC');
  return result.rows;
};

const ensureFileExists = async (id) => {
  const file = await getLearningFileById(id);
  if (!file) throw new Error('Learning file not found');
  return file;
};

// End of helper chain.

const parseUploadPayload = (req) => ({
  title: req.body.title || '',
  grade_level: req.body.grade_level || 'Grade 1',
  math_topic: req.body.math_topic || 'Addition',
  file_type: req.body.file_type || 'lesson',
  folder_id: req.body.folder_id ? parseInt(req.body.folder_id, 10) : null,
  uploaded_by: req.body.uploaded_by ? parseInt(req.body.uploaded_by, 10) : null,
  file: req.file,
});

const buildQuestionResponse = (row) => ({
  ...row,
  options: row.options || [],
});

const buildLearningFileResponseSimple = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const cleanOldTempFile = (pathToClean) => {
  if (pathToClean && fs.existsSync(pathToClean)) {
    try { fs.unlinkSync(pathToClean); } catch (err) { }
  }
};

const runLearningFileInsert = async ({ title, grade_level, math_topic, file_type, folder_id, uploaded_by, file_url, file_name, source }) => {
  const result = await pool.query(
    `INSERT INTO public.learning_files (title, file_name, file_url, grade_level, math_topic, file_type, subject, folder_id, published, source, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,'Mathematics',$7,false,$8,$9) RETURNING *`,
    [title, file_name, file_url, grade_level, math_topic, file_type, folder_id || null, source, uploaded_by || null]
  );
  return result.rows[0];
};

const updateLearningFileRow = async (id, title, grade_level, math_topic, file_type, folder_id) => {
  const result = await pool.query(
    `UPDATE public.learning_files set title=$1, grade_level=$2, math_topic=$3, file_type=$4, folder_id=$5 WHERE id=$6 RETURNING *`,
    [title, grade_level, math_topic, file_type, folder_id || null, id]
  );
  return result.rows[0];
};

const transformFolder = (row) => ({ id: row.id, name: row.name, created_at: row.created_at });

const setLearningFilePublishedFlag = async (id, published) => {
  await pool.query('UPDATE public.learning_files SET published=$1 WHERE id=$2', [published, id]);
};

const setLearningFileQuestionsPublishedFlag = async (id, published) => {
  await pool.query('UPDATE public.questions SET published=$1 WHERE learning_file_id=$2', [published, id]);
};

const getPublishedGameContent = async (query) => {
  const files = await getGameLearningFilesByQuery(query);
  const questions = await getGameQuestionsByQuery(query);
  return { learning_files: files, questions };
};

const getLearningFileJsonRows = async (id) => {
  const result = await pool.query('SELECT * FROM public.questions WHERE learning_file_id = $1', [id]);
  return result.rows;
};

const buildFileView = (row) => ({ ...row, folder_name: row.folder_name || 'Unassigned' });

const transformQuestionRow = (row) => ({
  id: row.id,
  learning_file_id: row.learning_file_id,
  question: row.question,
  options: row.options || [],
  correct_answer: row.correct_answer,
  grade_level: row.grade_level,
  math_topic: row.math_topic,
  source: row.source,
  published: row.published,
});

const getFilePathFromUrl = (url) => (url ? path.join(__dirname, url.replace('/uploads/', 'uploads/')) : null);

const createLearningFileRecord = async ({ title, file_name, file_url, grade_level, math_topic, file_type, folder_id, source, uploaded_by }) => {
  const result = await pool.query(
    `INSERT INTO public.learning_files (title, file_name, file_url, grade_level, math_topic, file_type, subject, folder_id, published, source, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,'Mathematics',$7,false,$8,$9) RETURNING *`,
    [title, file_name, file_url, grade_level, math_topic, file_type, folder_id || null, source, uploaded_by || null]
  );
  return result.rows[0];
};

const storeQuestionsForFile = async (learning_file_id, questions) => {
  const inserts = questions.map((question) => pool.query(
    `INSERT INTO public.questions (learning_file_id, question, options, correct_answer, grade_level, math_topic, source, published) VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
    [learning_file_id, question.question, JSON.stringify(question.options || []), question.correct_answer, question.grade_level, question.math_topic, question.source]
  ));
  await Promise.all(inserts);
};

const parseUploadedQuestions = async (file) => {
  const buffer = fs.readFileSync(file.path);
  const text = buffer.toString('utf8');
  if (file.originalname.toLowerCase().endsWith('.json')) {
    const payload = JSON.parse(text);
    if (!Array.isArray(payload)) throw new Error('JSON must contain an array of questions');
    return payload.map((row) => ({
      question: String(row.question || '').trim(),
      options: Array.isArray(row.options) ? row.options : [],
      correct_answer: String(row.correct_answer || row.answer || '').trim(),
      grade_level: String(row.grade_level || '').trim(),
      math_topic: String(row.math_topic || '').trim(),
      source: 'fixed',
    })).filter((item) => item.question && item.correct_answer);
  }
  if (file.originalname.toLowerCase().endsWith('.csv')) {
    const rows = text.split(/\r?\n/).filter(Boolean);
    return rows.map((row) => {
      const [question, ...cells] = row.split(',').map((value) => value.trim());
      return {
        question,
        options: cells.slice(0, 4).filter(Boolean),
        correct_answer: cells[0] || '',
        grade_level: '',
        math_topic: '',
        source: 'fixed',
      };
    }).filter((item) => item.question && item.correct_answer);
  }
  throw new Error('Unsupported fixed questions file type');
};

const buildGradeSummary = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const grouped = rows.reduce((acc, item) => {
    const grade = item.grade_level || 'Unknown';
    if (!acc[grade]) acc[grade] = [];
    acc[grade].push(item);
    return acc;
  }, {});

  return Object.entries(grouped).map(([grade, items]) => {
    const avgAccuracy = items.length
      ? Math.round(items.reduce((sum, s) => sum + Number(s.accuracy_rate || 0), 0) / items.length)
      : 0;
    const avgProgress = items.length
      ? Math.round(items.reduce((sum, s) => sum + Number(s.progress_percentage || 0), 0) / items.length)
      : 0;
    const easyAvg = items.length
      ? Math.round(items.reduce((sum, s) => sum + (s.analysis?.difficultyBreakdown?.easy || 0), 0) / items.length)
      : 0;
    const mediumAvg = items.length
      ? Math.round(items.reduce((sum, s) => sum + (s.analysis?.difficultyBreakdown?.medium || 0), 0) / items.length)
      : 0;
    const hardAvg = items.length
      ? Math.round(items.reduce((sum, s) => sum + (s.analysis?.difficultyBreakdown?.hard || 0), 0) / items.length)
      : 0;

    return {
      grade,
      studentCount: items.length,
      averageAccuracy: avgAccuracy,
      averageProgress: avgProgress,
      difficultyAverage: { easy: easyAvg, medium: mediumAvg, hard: hardAvg },
      students: items.map((item) => ({ id: item.student_id, name: item.student_name, accuracy: item.accuracy_rate })),
    };
  });
};

const buildAIRecommendations = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const recommendations = [];
  const gradeSummary = buildGradeSummary(rows);
  const overallAccuracy = rows.length
    ? Math.round(rows.reduce((sum, item) => sum + Number(item.accuracy_rate || 0), 0) / rows.length)
    : 0;
  const overallProgress = rows.length
    ? Math.round(rows.reduce((sum, item) => sum + Number(item.progress_percentage || 0), 0) / rows.length)
    : 0;

  if (overallAccuracy < 75) {
    recommendations.push('Many students are showing below-target accuracy; reinforce key concepts with short review sessions.');
  }
  if (overallProgress < 70) {
    recommendations.push('Overall quest progress is moderate; encourage consistent game practice and daily learning goals.');
  }

  gradeSummary.forEach((grade) => {
    if (grade.averageAccuracy < 70) {
      recommendations.push(`Students in ${grade.grade} need more accuracy-focused practice. Use simpler review activities before moving to harder challenges.`);
    }
    if (grade.difficultyAverage.hard > grade.difficultyAverage.easy) {
      recommendations.push(`Students in ${grade.grade} struggle more with hard difficulty items; add extra medium-level reinforcement before hard challenges.`);
    }
  });

  if (recommendations.length === 0) {
    recommendations.push('Student performance is stable. Keep reinforcing current routines and continue tracking progress weekly.');
  }

  return recommendations;
};

const generateStudentAnalysis = (record) => {
  const correct = record.correct_answers || 0;
  const total = record.total_questions || 0;
  const incorrect = Math.max(0, total - correct);
  const accuracy = total ? Math.round((correct / total) * 100) : 0;
  const progress = record.progress_percentage || 0;

  const easy = Math.min(100, Math.max(0, Math.round(progress * 0.55 + accuracy * 0.15)));
  const medium = Math.min(100, Math.max(0, Math.round(progress * 0.25 + accuracy * 0.20)));
  const hard = Math.max(0, 100 - easy - medium);

  const strengths = [];
  const weaknesses = [];
  const recommendations = [];

  if (accuracy >= 90) strengths.push('Strong accuracy across current quests.');
  else if (accuracy >= 75) strengths.push('Good understanding of the majority of problems.');
  else strengths.push('Shows effort and can improve through guided practice.');

  if (progress >= 80) strengths.push('Good quest completion consistency.');
  if (record.score >= 90) strengths.push('Excellent scoring pace during gameplay.');

  if (accuracy < 70) weaknesses.push('Needs more practice to improve accuracy.');
  if (incorrect > correct) weaknesses.push('Many questions are answered incorrectly; review fundamentals.');
  if (hard >= 40) weaknesses.push('Higher difficulty problems are still challenging.');

  if (accuracy >= 85 && progress >= 80) {
    recommendations.push('Maintain current practice routine and add occasional challenge problems.');
  } else {
    recommendations.push('Revisit recent quests and focus on areas with lower accuracy.');
  }
  recommendations.push('Use targeted review sessions for harder concepts and track progress over time.');

  return {
    totalCorrectAnswers: correct,
    totalIncorrectAnswers: incorrect,
    currentQuest: record.current_quest || 'N/A',
    difficultyBreakdown: { easy, medium, hard },
    strengths,
    weaknesses,
    recommendations,
  };
};



app.get('/api/test', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM accounts');
    res.json({ 
      status: 'Connected', 
      accounts: result.rows,
      total: result.rows.length 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password, rememberToken } = req.body;
  const email = (username || '').toLowerCase().trim();

  try {
    const result = await pool.query('SELECT * FROM accounts WHERE LOWER(email) = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Email not found' });

    const user = result.rows[0];
    if (user.is_archived) return res.status(403).json({ error: 'Account archived. Restore before signing in.' });
    const passwordMatches = await comparePassword(password, user.password);
    if (!passwordMatches) return res.status(401).json({ error: 'Incorrect password' });

    if (rememberToken) {
      const decoded = verifyRememberToken(rememberToken);
      if (decoded && decoded.userId === user.id && decoded.email === user.email) {
        await pool.query('UPDATE accounts SET status = $1 WHERE id = $2', ['Active', user.id]);
        return res.json({ success: true, user: serializeUser(user), rememberToken });
      }
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000);
    await pool.query('UPDATE accounts SET otp_code = $1, otp_expires_at = $2 WHERE id = $3', [otp, expiresAt, user.id]);
    await sendOtpEmail(user.email, otp);

    return res.json({ success: true, step: 2, userId: user.id, email: user.email, otpExpiresAt: expiresAt });
  } catch (err) {
    console.error('Login failed:', err.message);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/login/resend-otp', async (req, res) => {
  const { userId, email } = req.body;
  try {
    let query;
    if (userId) {
      query = await pool.query('SELECT * FROM accounts WHERE id = $1', [userId]);
    } else if (email) {
      query = await pool.query('SELECT * FROM accounts WHERE LOWER(email) = $1', [email.toLowerCase().trim()]);
    } else {
      return res.status(400).json({ error: 'Missing user identifier' });
    }

    if (query.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = query.rows[0];
    if (user.is_archived) return res.status(403).json({ error: 'Account archived' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000);
    await pool.query('UPDATE accounts SET otp_code = $1, otp_expires_at = $2 WHERE id = $3', [otp, expiresAt, user.id]);
    await sendOtpEmail(user.email, otp, 'Your new verification code');

    return res.json({ success: true, otpExpiresAt: expiresAt });
  } catch (err) {
    console.error('Resend OTP failed:', err.message);
    return res.status(500).json({ error: 'Failed to resend OTP' });
  }
});

app.post('/api/login/verify-otp', async (req, res) => {
  const { userId, otp, email } = req.body;
  try {
    let result;
    if (userId) {
      result = await pool.query('SELECT * FROM accounts WHERE id = $1 AND otp_code = $2', [userId, otp]);
    } else if (email) {
      result = await pool.query('SELECT * FROM accounts WHERE LOWER(email) = $1 AND otp_code = $2', [email.toLowerCase().trim(), otp]);
    } else {
      return res.status(400).json({ error: 'Missing info' });
    }

    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid or expired OTP' });
    const user = result.rows[0];
    if (user.otp_expires_at && new Date(user.otp_expires_at) < new Date()) {
      return res.status(401).json({ error: 'OTP expired' });
    }

    const rememberToken = createRememberToken(user);
    await pool.query('UPDATE accounts SET otp_code = NULL, otp_expires_at = NULL, status = $1 WHERE id = $2', ['Active', user.id]);

    res.json({
      success: true,
      user: serializeUser({ ...user, status: 'Active' }),
      rememberToken,
    });
  } catch (err) {
    console.error('OTP verification failed:', err.message);
    res.status(500).json({ error: 'OTP verification failed' });
  }
});

app.post('/api/logout-status', async (req, res) => {
  const { userId } = req.body;
  try {
    await pool.query('UPDATE accounts SET status = $1 WHERE id = $2', ['Offline', userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

app.post('/api/accounts', async (req, res) => {
  const { name, email, password, role, mobile_number, address, birthday, gender, employee_id } = req.body;
  try {
    const finalName = (name || '').trim();
    const normalizedEmail = (email || '').toLowerCase().trim() || generateDefaultEmail(finalName);
    if (!finalName || !normalizedEmail) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    const finalRole = (role || 'Parent').toLowerCase();
    const age = calculateAge(birthday);
    if (age < 18) {
      return res.status(400).json({ error: 'Users must be at least 18 years old' });
    }

    if (finalRole === 'teacher' && !employee_id) {
      return res.status(400).json({ error: 'Employee ID is required for teachers' });
    }

    const generatedPassword = (!password || password.trim() === '') ? generateRandomPassword() : password;
    const hashedPassword = await hashPassword(generatedPassword);
    const mustChangePassword = !password || password.trim() === '';

    const result = await pool.query(
      `INSERT INTO accounts (name, email, password, role, mobile_number, address, birthday, gender, employee_id, status, is_archived, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11)
       RETURNING *`,
      [finalName, normalizedEmail, hashedPassword, finalRole, mobile_number, address, birthday, gender, employee_id, 'Offline', mustChangePassword]
    );

    const created = serializeUser(result.rows[0]);
    const emailSent = await generateCredentialsEmail(normalizedEmail, generatedPassword, finalRole);
    const responsePayload = { user: created };
    if (!emailSent) {
      responsePayload.warning = 'Credentials email could not be sent. Please verify email settings.';
    }
    if (!password || password.trim() === '') {
      responsePayload.tempPassword = generatedPassword;
    }

    res.status(201).json(responsePayload);
  } catch (err) {
    console.error('Create account failed:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Employee ID or email already exists' });
    }
    res.status(500).json({ error: 'Create account failed' });
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    const archived = String(req.query.archived).toLowerCase() === 'true';
    const roleFilter = req.query.role ? req.query.role.toLowerCase().trim() : null;
    let queryString;
    let queryParams = [];

    if (roleFilter) {
      queryString = archived
        ? 'SELECT * FROM accounts WHERE is_archived = true AND LOWER(role) = $1 ORDER BY id'
        : 'SELECT * FROM accounts WHERE is_archived = false AND LOWER(role) = $1 ORDER BY id';
      queryParams.push(roleFilter);
    } else {
      queryString = archived
        ? 'SELECT * FROM accounts WHERE is_archived = true ORDER BY id'
        : 'SELECT * FROM accounts WHERE is_archived = false ORDER BY id';
    }

    const result = await pool.query(queryString, queryParams);
    res.json(result.rows.map(serializeUser));
  } catch (err) {
    console.error('Fetch accounts failed:', err.message);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// --- UPDATED PUT ROUTE (FIXED: Properly handles all fields, includes comprehensive logging) ---
app.put('/api/accounts/:id', async (req, res) => {
  const { id } = req.params;
  const { name, email, role, password, mobile_number, address, birthday, gender, status, employee_id, is_archived } = req.body;

  try {
    const currentData = await pool.query('SELECT * FROM accounts WHERE id = $1', [id]);
    if (currentData.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const old = currentData.rows[0];
    const finalEmail = email && email.trim() !== '' ? email.toLowerCase().trim() : old.email;
    const finalBirthday = birthday && birthday.trim() !== '' ? birthday : old.birthday;
    const oldRole = normalizeAccountRole(old.role);
    const finalRole = normalizeAccountRole(role || old.role);
    const finalEmployeeId = employee_id !== undefined ? employee_id : old.employee_id;
    const finalStatus = status || old.status || 'Active';
    const finalArchived = typeof is_archived === 'boolean' ? is_archived : old.is_archived;

    if (calculateAge(finalBirthday) < 18) {
      return res.status(400).json({ error: 'Users must be at least 18 years old' });
    }

    if (finalRole === 'teacher' && !finalEmployeeId) {
      return res.status(400).json({ error: 'Employee ID is required for teachers' });
    }

    if ((oldRole === 'teacher' || oldRole === 'parent') && finalRole !== 'teacher' && finalRole !== 'parent') {
      const relations = await pool.query(
        'SELECT * FROM public.teacher_student_relationships WHERE teacher_id = $1',
        [id]
      );
      if (relations.rows.length > 0) {
        return res.status(400).json({ error: 'Cannot change an account with linked students to this role. Remove relationships first.' });
      }
    }

    let hashedPassword = old.password;
    if (password && password.trim() !== '') {
      hashedPassword = await hashPassword(password);
    }

    const updateResult = await pool.query(
      `UPDATE accounts
       SET name=$1, email=$2, role=$3, password=$4, mobile_number=$5, address=$6,
           birthday=$7, gender=$8, status=$9, employee_id=$10, is_archived=$11
       WHERE id=$12
       RETURNING *`,
      [
        name || old.name,
        finalEmail,
        finalRole,
        hashedPassword,
        mobile_number !== undefined ? mobile_number : old.mobile_number,
        address !== undefined ? address : old.address,
        finalBirthday,
        gender !== undefined ? gender : old.gender,
        finalStatus,
        finalEmployeeId,
        finalArchived,
        id,
      ]
    );

    if (updateResult.rows.length === 0) {
      return res.status(500).json({ error: 'Failed to update account' });
    }

    const updatedUser = serializeUser(updateResult.rows[0]);
    res.json({ success: true, message: 'Profile updated successfully', user: updatedUser });
  } catch (err) {
    console.error('Update Error:', err.message);
    res.status(500).json({ error: 'Update failed: ' + err.message });
  }
});

app.get('/api/teacher-student-relationships', async (req, res) => {
  try {
    const teacherId = parseInt(req.query.teacherId, 10);
    if (Number.isNaN(teacherId)) return res.status(400).json({ error: 'Invalid teacher ID' });

    const result = await pool.query(
      `SELECT r.id, r.relationship_type, r.created_at, s.id AS student_id, s.name AS student_name, s.email AS student_email
       FROM public.teacher_student_relationships r
       JOIN public.accounts s ON s.id = r.student_id
       WHERE r.teacher_id = $1`,
      [teacherId]
    );

    res.json({ relationships: result.rows });
  } catch (err) {
    console.error('Fetch teacher relationships failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch relationships' });
  }
});

app.post('/api/teacher-student-relationships', async (req, res) => {
  const { teacherId, studentEmail, relationship_type } = req.body;
  try {
    const resultTeacher = await pool.query('SELECT * FROM accounts WHERE id = $1', [teacherId]);
    if (resultTeacher.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const teacher = resultTeacher.rows[0];
    const ownerRole = normalizeAccountRole(teacher.role);
    if (ownerRole !== 'teacher' && ownerRole !== 'parent') {
      return res.status(400).json({ error: 'Selected user must be a teacher or parent' });
    }

    const resultStudent = await pool.query('SELECT * FROM accounts WHERE LOWER(email) = $1', [studentEmail.toLowerCase().trim()]);
    if (resultStudent.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const student = resultStudent.rows[0];
    if (normalizeAccountRole(student.role) !== 'student') return res.status(400).json({ error: 'Selected account must be a student role' });

    const existing = await pool.query(
      'SELECT * FROM public.teacher_student_relationships WHERE teacher_id = $1 AND student_id = $2 AND relationship_type = $3',
      [teacherId, student.id, relationship_type || 'Parent']
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Relationship already exists' });
    }

    const insertResult = await pool.query(
      `INSERT INTO public.teacher_student_relationships (teacher_id, student_id, relationship_type)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [teacherId, student.id, relationship_type || 'Parent']
    );

    res.json({ success: true, relationship: insertResult.rows[0] });
  } catch (err) {
    console.error('Create teacher-student relationship failed:', err.message);
    res.status(500).json({ error: 'Failed to create relationship' });
  }
});

app.delete('/api/teacher-student-relationships/:id', async (req, res) => {
  try {
    const relationId = parseInt(req.params.id, 10);
    if (Number.isNaN(relationId)) return res.status(400).json({ error: 'Invalid relationship ID' });

    await pool.query('DELETE FROM public.teacher_student_relationships WHERE id = $1', [relationId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete relationship failed:', err.message);
    res.status(500).json({ error: 'Failed to delete relationship' });
  }
});

app.get('/api/folders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM public.folders ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch folders failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch folders' });
  }
});

app.post('/api/folders/create', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Folder name is required' });
    }
    const result = await pool.query(
      'INSERT INTO public.folders (name) VALUES ($1) RETURNING *',
      [String(name).trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create folder failed:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A folder with this name already exists.' });
    }
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

app.put('/api/folders/:id', async (req, res) => {
  try {
    const folderId = parseInt(req.params.id, 10);
    const { name } = req.body;
    if (Number.isNaN(folderId)) return res.status(400).json({ error: 'Invalid folder ID' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Folder name is required' });

    const result = await pool.query(
      'UPDATE public.folders SET name = $1 WHERE id = $2 RETURNING *',
      [String(name).trim(), folderId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Folder not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Rename folder failed:', err.message);
    res.status(500).json({ error: 'Failed to rename folder' });
  }
});

app.delete('/api/folders/:id', async (req, res) => {
  try {
    const folderId = parseInt(req.params.id, 10);
    if (Number.isNaN(folderId)) return res.status(400).json({ error: 'Invalid folder ID' });
    await pool.query('UPDATE public.learning_files SET folder_id = NULL WHERE folder_id = $1', [folderId]);
    await pool.query('DELETE FROM public.folders WHERE id = $1', [folderId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete folder failed:', err.message);
    res.status(500).json({ error: 'Failed to delete folder' });
  }
});

app.post('/api/learning-files/upload', upload.single('file'), async (req, res) => {
  try {
    const { title, grade_level, math_topic, file_type, folder_id, uploaded_by } = req.body;
    if (!req.file) return res.status(400).json({ error: 'File is required' });
    if (!title || !grade_level || !math_topic || !file_type) {
      return res.status(400).json({ error: 'Missing required metadata' });
    }

    const normalizedGrade = String(grade_level).trim();
    const normalizedTopic = String(math_topic).trim();
    const normalizedType = String(file_type).trim().toLowerCase();

    if (!isValidGradeLevel(normalizedGrade) || !isValidMathTopic(normalizedTopic)) {
      cleanTemporaryUpload(req.file.path);
      return res.status(400).json({ error: 'Invalid grade level or math topic. Only Grade 1–6 mathematics content is supported.' });
    }
    if (!isValidFileType(normalizedType)) {
      cleanTemporaryUpload(req.file.path);
      return res.status(400).json({ error: 'Invalid file type.' });
    }

    const allowedLesson = normalizedType === 'lesson' && req.file.originalname.toLowerCase().endsWith('.pdf');
    const allowedQuestions = normalizedType === 'fixed_questions' && /\.(json|csv)$/i.test(req.file.originalname);
    if (!allowedLesson && !allowedQuestions) {
      cleanTemporaryUpload(req.file.path);
      return res.status(400).json({ error: 'Invalid file type for the selected upload type' });
    }

    const fileName = generateUploadFileName(req.file.originalname);
    const destinationPath = path.join(uploadsDir, fileName);
    fs.renameSync(req.file.path, destinationPath);
    const fileUrl = buildFileUrl(fileName);

    const insertResult = await pool.query(
      `INSERT INTO public.learning_files (title, file_name, file_url, grade_level, math_topic, file_type, subject, folder_id, published, source, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'Mathematics', $7, false, $8, $9)
       RETURNING *`,
      [
        String(title).trim(),
        req.file.originalname,
        fileUrl,
        String(grade_level).trim(),
        String(math_topic).trim(),
        normalizedType,
        folder_id ? parseInt(folder_id, 10) : null,
        allowedLesson ? 'lesson' : 'fixed',
        uploaded_by ? parseInt(uploaded_by, 10) : null,
      ]
    );

    const learningFile = insertResult.rows[0];
    if (normalizedType === 'lesson') {
      const questions = await generateQuestionTextFromLesson(destinationPath, learningFile.title, learningFile.grade_level, learningFile.math_topic);
      await saveQuestionsForFile(learningFile.id, questions.map((question) => ({
        ...question,
        grade_level: learningFile.grade_level,
        math_topic: learningFile.math_topic,
        source: 'ai',
      })));
    } else {
      const questions = await parseFixedQuestionsFile({ path: destinationPath, originalname: req.file.originalname });
      await saveQuestionsForFile(learningFile.id, questions.map((question) => ({
        ...question,
        grade_level: learningFile.grade_level,
        math_topic: learningFile.math_topic,
        source: 'fixed',
      })));
    }

    res.status(201).json({ success: true, learningFile });
  } catch (err) {
    console.error('Upload failed:', err.message);
    if (req.file && req.file.path) cleanTemporaryUpload(req.file.path);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/learning-files', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT lf.*, f.name AS folder_name
       FROM public.learning_files lf
       LEFT JOIN public.folders f ON lf.folder_id = f.id
       ORDER BY lf.uploaded_at DESC`
    );
    res.json(result.rows.map((row) => ({ ...row, folder_name: row.folder_name || 'Unassigned' })));
  } catch (err) {
    console.error('Fetch learning files failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

app.put('/api/learning-files/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    const { title, grade_level, math_topic, file_type, folder_id } = req.body;
    if (!title || !grade_level || !math_topic || !file_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const normalizedGrade = String(grade_level).trim();
    const normalizedTopic = String(math_topic).trim();
    const normalizedType = String(file_type).trim().toLowerCase();
    if (!isValidGradeLevel(normalizedGrade) || !isValidMathTopic(normalizedTopic)) {
      return res.status(400).json({ error: 'Invalid grade level or math topic. Only Grade 1–6 mathematics content is supported.' });
    }
    if (!isValidFileType(normalizedType)) {
      return res.status(400).json({ error: 'Invalid file type.' });
    }

    const result = await pool.query(
      `UPDATE public.learning_files
       SET title = $1,
           grade_level = $2,
           math_topic = $3,
           file_type = $4,
           folder_id = $5
       WHERE id = $6
       RETURNING *`,
      [String(title).trim(), String(grade_level).trim(), String(math_topic).trim(), String(file_type).trim(), folder_id ? parseInt(folder_id, 10) : null, fileId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update learning file failed:', err.message);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

app.delete('/api/learning-files/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    const fileResult = await pool.query('SELECT * FROM public.learning_files WHERE id = $1', [fileId]);
    if (fileResult.rows.length === 0) return res.status(404).json({ error: 'File not found' });
    const file = fileResult.rows[0];
    await pool.query('DELETE FROM public.questions WHERE learning_file_id = $1', [fileId]);
    await pool.query('DELETE FROM public.learning_files WHERE id = $1', [fileId]);
    removeFileFromDisk(file.file_url);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete learning file failed:', err.message);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

app.post('/api/questions/publish/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    await publishLearningFile(fileId);
    res.json({ success: true, message: 'Content published to game.' });
  } catch (err) {
    console.error('Publish failed:', err.message);
    res.status(500).json({ error: 'Failed to publish content' });
  }
});

app.post('/api/questions/unpublish/:id', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    await unpublishLearningFile(fileId);
    res.json({ success: true, message: 'Content removed from game.' });
  } catch (err) {
    console.error('Unpublish failed:', err.message);
    res.status(500).json({ error: 'Failed to remove content from game' });
  }
});

app.get('/api/game/questions', async (req, res) => {
  try {
    const grade_level = req.query.grade_level || null;
    const math_topic = req.query.math_topic || null;
    const learningFiles = await getGameFiles({ grade_level, math_topic });
    const gameQuestions = await getGameQuestions({ grade_level, math_topic });
    res.json({ learning_files: learningFiles, questions: gameQuestions });
  } catch (err) {
    console.error('Fetch game questions failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch game content' });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const permanent = String(req.query.permanent).toLowerCase() === 'true';
    if (permanent) {
      await pool.query('DELETE FROM accounts WHERE id = $1', [id]);
      return res.json({ success: true, message: 'Account permanently deleted' });
    }

    await pool.query('UPDATE accounts SET is_archived = true WHERE id = $1', [id]);
    res.json({ success: true, message: 'Account archived' });
  } catch (err) {
    console.error('Delete/archive failed:', err.message);
    res.status(500).json({ error: 'Delete/archive failed' });
  }
});

app.post('/api/accounts/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('UPDATE accounts SET is_archived = false WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    res.json({ success: true, message: 'Account restored', user: serializeUser(result.rows[0]) });
  } catch (err) {
    console.error('Restore failed:', err.message);
    res.status(500).json({ error: 'Restore failed' });
  }
});

app.post('/api/reset-password/send-code', async (req, res) => {
  const email = req.body.email.toLowerCase().trim();
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE LOWER(email)=$1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Email not found' });
    await pool.query('UPDATE accounts SET otp_code=$1, otp_expires_at=$2 WHERE LOWER(email)=$3', [otp, expiresAt, email]);
    await transporter.sendMail({
      from: `"STS Support" <${MY_GMAIL}>`,
      to: email,
      subject: 'Password Reset Code',
      html: `<p>Your code is: <b>${otp}</b></p><p>This code expires in 10 minutes.</p>`
    });
    res.json({ success: true, expiresAt });
  } catch (err) { console.error('Reset password code failed:', err.message); res.status(500).json({ error: 'Reset failed' }); }
});

app.post('/api/reset-password/verify', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE LOWER(email)=$1 AND otp_code=$2', [email.toLowerCase().trim(), otp]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid code' });

    const user = result.rows[0];
    if (user.otp_expires_at && new Date(user.otp_expires_at) < new Date()) {
      return res.status(401).json({ error: 'OTP expired' });
    }

    const hashedPassword = await hashPassword(newPassword);
    await pool.query('UPDATE accounts SET password=$1, otp_code=NULL, otp_expires_at=NULL WHERE LOWER(email)=$2', [hashedPassword, email.toLowerCase().trim()]);
    res.json({ success: true });
  } catch (err) { console.error('Reset password verify failed:', err.message); res.status(500).json({ error: 'Update failed' }); }
});

// --- NEW: Change Password with OTP (Step 1: Request OTP) ---
app.post('/api/request-password-change-otp', async (req, res) => {
  const { userId, email } = req.body;
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE id=$1', [userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query('UPDATE accounts SET otp_code=$1, otp_expires_at=$2 WHERE id=$3', [otp, expiresAt, userId]);

    try {
      await transporter.sendMail({
        from: `"Saint Therese School" <${MY_GMAIL}>`,
        to: email,
        subject: 'Password Change Verification Code',
        html: `<div style="font-family: Arial; border: 1px solid #ddd; padding: 20px;">
                <h2>Password Change Verification</h2>
                <p>Your verification code is: <h1 style="color: #3498db;">${otp}</h1></p>
                <p style="color: #888; font-size: 12px;">This code will expire in 10 minutes.</p>
               </div>`
      });
    } catch (mailErr) { console.error('❌ Email Send Error:', mailErr.message); }

    return res.json({ success: true, message: 'OTP sent to email', expiresAt });
  } catch (err) {
    console.error('Request password change OTP failed:', err.message);
    return res.status(500).json({ error: 'Request failed' });
  }
});

// --- NEW: Change Password with OTP (Step 2: Verify OTP and Update Password) ---
app.post('/api/verify-password-change-otp', async (req, res) => {
  const { userId, otp, newPassword } = req.body;
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE id=$1 AND otp_code=$2', [userId, otp]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid or expired OTP' });

    const user = result.rows[0];
    if (user.otp_expires_at && new Date(user.otp_expires_at) < new Date()) {
      return res.status(401).json({ error: 'OTP expired' });
    }

    const hashedPassword = await hashPassword(newPassword);
    await pool.query('UPDATE accounts SET password=$1, otp_code=NULL, otp_expires_at=NULL WHERE id=$2', [hashedPassword, userId]);

    res.json({
      success: true,
      message: 'Password changed successfully!'
    });
  } catch (err) {
    console.error('Password change OTP verification failed:', err.message);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// --- NEW: Get User Profile (fetch from database) ---
app.get('/api/user/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    const userData = serializeUser(result.rows[0]);
    res.json(userData);
  } catch (err) {
    console.error('Fetch user failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// --- NEW: Get Top Achievers (game progress data) ---
app.get('/api/top-achievers', async (req, res) => {
  try {
    const parentId = resolveParentScopeId(req.query.parent_id);
    const teacherId = resolveTeacherScopeId(req.query.teacher_id);

    // Validate scope IDs if provided
    if ((parentId && Number.isNaN(parentId)) || (teacherId && Number.isNaN(teacherId))) {
      return res.status(400).json({ error: 'Invalid scope ID' });
    }

    const params = [];
    let query = `
      SELECT p.*, a.name AS student_name, a.email AS student_email
      FROM public.student_game_progress p
      LEFT JOIN accounts a ON a.id = p.student_id
      WHERE 1=1
    `;

    // Apply scope filtering only if scope IDs are provided
    if (parentId) {
      query += appendParentScopeFilter({ parentId, params, studentColumn: 'p.student_id' });
    } else if (teacherId) {
      query += appendTeacherScopeFilter({ teacherId, params, studentColumn: 'p.student_id' });
    }
    // If neither parentId nor teacherId is provided, show all (admin access)

    query += ' ORDER BY p.score DESC, p.accuracy_rate DESC LIMIT 50';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch top achievers' });
  }
});

// --- ENHANCED: Get Recent Activity Logs with Filtering & Role-Based Access ---
app.get('/api/activity-logs', async (req, res) => {
  try {
    const {
      limit = 50,
      offset = 0,
      teacher_id = null,
      parent_id = null,
      grade_level = null,
      section = null,
      search = null,
      sort_by = 'activity_timestamp',
      sort_order = 'DESC'
    } = req.query;

    // Validate and sanitize parameters
    const queryLimit = Math.min(parseInt(limit) || 50, 500);
    const queryOffset = Math.max(parseInt(offset) || 0, 0);
    const searchTerm = search ? `%${search.toLowerCase()}%` : null;
    const parentId = resolveParentScopeId(parent_id);
    if (Number.isNaN(parentId)) return res.status(400).json({ error: 'Invalid parent ID' });

    let query = `
      SELECT 
        al.id,
        al.student_id,
        al.student_name,
        al.grade_level,
        al.section,
        al.current_quest,
        al.save_status,
        al.total_play_time,
        al.last_played,
        al.quest_progress,
        al.difficulty_level,
        al.login_time,
        al.logout_time,
        al.session_date,
        al.activity_timestamp,
        al.activity_description,
        al.role,
        al.status,
        al.created_at
      FROM public.activity_logs al
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    // Teacher-based filtering: only show their assigned students
    if (teacher_id) {
      query += `
        AND al.student_id IN (
          SELECT tsr.student_id 
          FROM public.teacher_student_relationships tsr 
          WHERE tsr.teacher_id = $${paramIndex}
        )
      `;
      params.push(teacher_id);
      paramIndex++;
    }

    if (parentId) {
      query += `
        AND al.student_id IN (
          SELECT tsr.student_id
          FROM public.teacher_student_relationships tsr
          WHERE tsr.teacher_id = $${paramIndex}
            AND LOWER(tsr.relationship_type) = 'parent'
        )
      `;
      params.push(parentId);
      paramIndex++;
    }

    // Grade level filter
    if (grade_level && grade_level !== 'All Grades') {
      query += ` AND al.grade_level = $${paramIndex}`;
      params.push(grade_level);
      paramIndex++;
    }

    // Section filter
    if (section && section !== 'All Sections') {
      query += ` AND al.section = $${paramIndex}`;
      params.push(section);
      paramIndex++;
    }

    // Search by student name
    if (searchTerm) {
      query += ` AND LOWER(al.student_name) LIKE $${paramIndex}`;
      params.push(searchTerm);
      paramIndex++;
    }

    // Sorting
    const allowedSortFields = [
      'student_name',
      'grade_level',
      'section',
      'current_quest',
      'quest_progress',
      'total_play_time',
      'last_played',
      'activity_timestamp',
      'save_status'
    ];
    const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'activity_timestamp';
    const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    query += ` ORDER BY al.${sortField} ${sortDirection}`;

    // Pagination
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(queryLimit, queryOffset);

    // Execute query
    const result = await pool.query(query, params);

    // Get total count for pagination metadata
    let countQuery = `SELECT COUNT(*) as total FROM public.activity_logs al WHERE 1=1`;
    let countParams = [];
    let countParamIndex = 1;

    if (teacher_id) {
      countQuery += `
        AND al.student_id IN (
          SELECT tsr.student_id 
          FROM public.teacher_student_relationships tsr 
          WHERE tsr.teacher_id = $${countParamIndex}
        )
      `;
      countParams.push(teacher_id);
      countParamIndex++;
    }

    if (parentId) {
      countQuery += `
        AND al.student_id IN (
          SELECT tsr.student_id
          FROM public.teacher_student_relationships tsr
          WHERE tsr.teacher_id = $${countParamIndex}
            AND LOWER(tsr.relationship_type) = 'parent'
        )
      `;
      countParams.push(parentId);
      countParamIndex++;
    }

    if (grade_level && grade_level !== 'All Grades') {
      countQuery += ` AND al.grade_level = $${countParamIndex}`;
      countParams.push(grade_level);
      countParamIndex++;
    }

    if (section && section !== 'All Sections') {
      countQuery += ` AND al.section = $${countParamIndex}`;
      countParams.push(section);
      countParamIndex++;
    }

    if (searchTerm) {
      countQuery += ` AND LOWER(al.student_name) LIKE $${countParamIndex}`;
      countParams.push(searchTerm);
    }

    const countResult = await pool.query(countQuery, countParams);
    const totalRecords = parseInt(countResult.rows[0].total);

    res.json({
      data: result.rows,
      pagination: {
        total: totalRecords,
        limit: queryLimit,
        offset: queryOffset,
        pages: Math.max(1, Math.ceil(totalRecords / queryLimit)),
        current_page: Math.floor(queryOffset / queryLimit) + 1
      }
    });
  } catch (err) {
    console.error('Error fetching activity logs:', err.message);
    res.status(500).json({ error: 'Failed to fetch activity logs', details: err.message });
  }
});

// --- ENHANCED: Create Activity Log Entry with Gameplay Tracking ---
app.post('/api/activity-logs', async (req, res) => {
  const {
    student_id,
    student_name,
    grade_level,
    section,
    current_quest,
    save_status = 'pending',
    total_play_time = 0,
    quest_progress = 0,
    difficulty_level = 'Normal',
    role = 'Student',
    status = 'Online',
    activity_description = 'Gameplay Session'
  } = req.body;

  try {
    if (!student_id || !student_name) {
      return res.status(400).json({ error: 'student_id and student_name are required' });
    }

    const result = await pool.query(
      `INSERT INTO public.activity_logs (
        student_id, student_name, grade_level, section, current_quest,
        save_status, total_play_time, last_played, quest_progress,
        difficulty_level, role, status, activity_description,
        login_time, session_date, activity_timestamp, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11, $12, NOW(), CURRENT_DATE, NOW(), NOW()
      ) RETURNING *`,
      [
        student_id,
        student_name,
        grade_level || null,
        section || null,
        current_quest || null,
        save_status,
        total_play_time,
        quest_progress,
        difficulty_level,
        role,
        status,
        activity_description
      ]
    );

    res.status(201).json({
      message: 'Activity log created successfully',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Create activity log failed:', err.message);
    res.status(500).json({ error: 'Failed to create activity log', details: err.message });
  }
});

app.get('/api/students', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.name, a.email, a.role, a.mobile_number, a.address, a.birthday, a.gender, a.status,
              p.score, p.correct_answers, p.total_questions, p.accuracy_rate, p.progress_percentage, p.current_quest
       FROM accounts a
       LEFT JOIN public.student_game_progress p ON a.id = p.student_id
       WHERE LOWER(a.role) = 'student' AND a.is_archived = false
       ORDER BY a.name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch students failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

app.get('/api/students/progress', async (req, res) => {
  try {
    const teacherId = resolveTeacherScopeId(req.query.teacher_id);
    if (Number.isNaN(teacherId)) return res.status(400).json({ error: 'Invalid teacher ID' });
    const parentId = resolveParentScopeId(req.query.parent_id);
    if (Number.isNaN(parentId)) return res.status(400).json({ error: 'Invalid parent ID' });

    const params = [];
    let query = `
      SELECT p.*, a.name AS student_name, a.email AS student_email, a.role AS student_role
      FROM public.student_game_progress p
      LEFT JOIN accounts a ON a.id = p.student_id
      WHERE 1=1
    `;
    query += appendTeacherScopeFilter({ teacherId, params, studentColumn: 'p.student_id' });
    query += appendParentScopeFilter({ parentId, params, studentColumn: 'p.student_id' });
    query += ' ORDER BY p.score DESC, p.accuracy_rate DESC';

    const result = await pool.query(query, params);
    const rows = result.rows.map(normalizeStudentProgressRow).map((row) => ({
      ...row,
      performance_percentage: row.accuracy_rate || row.progress_percentage || 0,
      difficultyBreakdown: generateStudentAnalysis(row).difficultyBreakdown,
    }));
    res.json(rows);
  } catch (err) {
    console.error('Fetch students progress failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch student progress' });
  }
});

app.get('/api/analytics/overview', async (req, res) => {
  try {
    const teacherId = resolveTeacherScopeId(req.query.teacher_id);
    if (Number.isNaN(teacherId)) return res.status(400).json({ error: 'Invalid teacher ID' });
    const parentId = resolveParentScopeId(req.query.parent_id);
    if (Number.isNaN(parentId)) return res.status(400).json({ error: 'Invalid parent ID' });

    const params = [];
    let query = `
      SELECT p.*, a.name AS student_name, a.email AS student_email, a.role AS student_role
      FROM public.student_game_progress p
      LEFT JOIN accounts a ON a.id = p.student_id
      WHERE 1=1
    `;
    query += appendTeacherScopeFilter({ teacherId, params, studentColumn: 'p.student_id' });
    query += appendParentScopeFilter({ parentId, params, studentColumn: 'p.student_id' });

    const result = await pool.query(query, params);
    const rows = result.rows.map(normalizeStudentProgressRow).map((row) => ({
      ...row,
      analysis: generateStudentAnalysis(row),
    }));

    const gradeSummary = buildGradeSummary(rows);
    const averageAccuracy = rows.length
      ? Math.round(rows.reduce((sum, item) => sum + Number(item.accuracy_rate || 0), 0) / rows.length)
      : 0;
    const averageProgress = rows.length
      ? Math.round(rows.reduce((sum, item) => sum + Number(item.progress_percentage || 0), 0) / rows.length)
      : 0;
    const studentCount = rows.length;

    res.json({
      studentCount,
      averageAccuracy,
      averageProgress,
      gradeSummary,
      sections: Array.from(new Set(rows.map((row) => row.section || getDefaultSection(row.grade_level, row.student_id)))).sort(),
    });
  } catch (err) {
    console.error('Fetch analytics overview failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch analytics overview' });
  }
});

app.get('/api/analytics/recommendations', async (req, res) => {
  try {
    const teacherId = resolveTeacherScopeId(req.query.teacher_id);
    if (Number.isNaN(teacherId)) return res.status(400).json({ error: 'Invalid teacher ID' });
    const parentId = resolveParentScopeId(req.query.parent_id);
    if (Number.isNaN(parentId)) return res.status(400).json({ error: 'Invalid parent ID' });

    const params = [];
    let query = `
      SELECT p.*, a.name AS student_name, a.email AS student_email, a.role AS student_role
      FROM public.student_game_progress p
      LEFT JOIN accounts a ON a.id = p.student_id
      WHERE 1=1
    `;
    query += appendTeacherScopeFilter({ teacherId, params, studentColumn: 'p.student_id' });
    query += appendParentScopeFilter({ parentId, params, studentColumn: 'p.student_id' });

    const result = await pool.query(query, params);
    const rows = result.rows.map(normalizeStudentProgressRow).map((row) => ({
      ...row,
      analysis: generateStudentAnalysis(row),
    }));

    const recommendations = buildAIRecommendations(rows);
    res.json({ recommendations });
  } catch (err) {
    console.error('Fetch analytics recommendations failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch AI recommendations' });
  }
});

app.get('/api/students/progress-analysis', async (req, res) => {
  try {
    const minScore = parseInt(req.query.minScore, 10);
    const minAccuracy = parseInt(req.query.minAccuracy, 10);

    let baseQuery = `SELECT p.*, a.name AS student_name, a.email AS student_email, a.role AS student_role
                   FROM public.student_game_progress p
                   LEFT JOIN accounts a ON a.id = p.student_id`;
    const params = [];
    const filters = [];

    if (!Number.isNaN(minScore)) {
      params.push(minScore);
      filters.push(`p.score >= $${params.length}`);
    }
    if (!Number.isNaN(minAccuracy)) {
      params.push(minAccuracy);
      filters.push(`p.accuracy_rate >= $${params.length}`);
    }
    if (filters.length > 0) {
      baseQuery += ` WHERE ${filters.join(' AND ')}`;
    }
    baseQuery += ' ORDER BY p.score DESC, p.accuracy_rate DESC';

    const result = await pool.query(baseQuery, params);
    const studentAnalyses = result.rows.map((row) => ({
      ...row,
      analysis: generateStudentAnalysis(row)
    }));

    const averageScore = studentAnalyses.length
      ? Math.round(studentAnalyses.reduce((sum, item) => sum + (item.score || 0), 0) / studentAnalyses.length)
      : 0;
    const averageAccuracy = studentAnalyses.length
      ? Math.round(studentAnalyses.reduce((sum, item) => sum + (item.accuracy_rate || 0), 0) / studentAnalyses.length)
      : 0;
    const totalStudents = studentAnalyses.length;
    const topStudents = studentAnalyses.slice(0, 5).map((item) => ({
      student_id: item.student_id,
      student_name: item.student_name,
      score: item.score,
      accuracy_rate: item.accuracy_rate,
      progress_percentage: item.progress_percentage,
    }));
    const actionItems = [];

    if (averageAccuracy < 75) actionItems.push('Review classroom accuracy trends and assign targeted practice sessions.');
    if (averageScore < 70) actionItems.push('Plan checkpoint quizzes to help students increase overall scores.');
    if (studentAnalyses.some((item) => item.progress_percentage < 50)) actionItems.push('Reach out to students with low progress percentages for additional support.');
    if (actionItems.length === 0) actionItems.push('Class performance is strong; keep reinforcing current progress routines.');

    res.json({ summary: { averageScore, averageAccuracy, totalStudents, topStudents, actionItems }, studentAnalyses });
  } catch (err) {
    console.error('Fetch students progress analysis failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch progress analysis' });
  }
});

app.get('/api/student-progress/:studentId', async (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId, 10);
    if (Number.isNaN(studentId)) return res.status(400).json({ error: 'Invalid student ID' });
    const teacherId = resolveTeacherScopeId(req.query.teacher_id);
    if (Number.isNaN(teacherId)) return res.status(400).json({ error: 'Invalid teacher ID' });
    const parentId = resolveParentScopeId(req.query.parent_id);
    if (Number.isNaN(parentId)) return res.status(400).json({ error: 'Invalid parent ID' });

    const params = [studentId];
    let query = `
      SELECT p.*, a.email AS student_email, a.name AS student_name
      FROM public.student_game_progress p
      LEFT JOIN accounts a ON a.id = p.student_id
      WHERE p.student_id = $1
    `;
    query += appendTeacherScopeFilter({ teacherId, params, studentColumn: 'p.student_id' });
    query += appendParentScopeFilter({ parentId, params, studentColumn: 'p.student_id' });
    query += ' ORDER BY p.last_played DESC LIMIT 1';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Student progress not found' });

    const progress = normalizeStudentProgressRow(result.rows[0]);
    const analysis = generateStudentAnalysis(progress);
    res.json({ progress, analysis });
  } catch (err) {
    console.error('Fetch student progress failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch student progress' });
  }
});

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
