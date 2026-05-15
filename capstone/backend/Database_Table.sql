CREATE TABLE IF NOT EXISTS public.accounts (
    id SERIAL NOT NULL,
    name CHARACTER VARYING(100) NOT NULL,
    email CHARACTER VARYING(100) NOT NULL,
    password CHARACTER VARYING(255) NOT NULL,
    mobile_number CHARACTER VARYING(20),
    role CHARACTER VARYING(50) NOT NULL DEFAULT 'Parent',
    employee_id CHARACTER VARYING(50),
    otp_code CHARACTER VARYING(10),
    otp_expires_at TIMESTAMP WITH TIME ZONE,
    is_archived BOOLEAN DEFAULT false,
    must_change_password BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    address CHARACTER VARYING(255),
    birthday DATE,
    gender CHARACTER VARYING(20), 
    status VARCHAR(20) DEFAULT 'Offline',

    CONSTRAINT accounts_pkey PRIMARY KEY (id),
    CONSTRAINT accounts_email_key UNIQUE (email),
    CONSTRAINT accounts_employee_id_key UNIQUE (employee_id)
);

ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS address CHARACTER VARYING(255);
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS birthday DATE;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS gender CHARACTER VARYING(20);
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Offline';
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS employee_id CHARACTER VARYING(50);
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false;
ALTER TABLE public.accounts ADD CONSTRAINT IF NOT EXISTS accounts_employee_id_key UNIQUE (employee_id);

INSERT INTO public.accounts (name, email, password, mobile_number, role, employee_id, gender, status)
VALUES ('Admin User', 'vincenttafalla2@gmail.com', 'Admin12345', '09463066523', 'admin', 'EMP-0001', 'Male', 'Online')
ON CONFLICT (email) DO NOTHING;

-- === NEW TABLE FOR TEACHER/STUDENT RELATIONSHIPS ===
CREATE TABLE IF NOT EXISTS public.teacher_student_relationships (
    id SERIAL NOT NULL,
    teacher_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    relationship_type CHARACTER VARYING(50) DEFAULT 'Parent',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT teacher_student_relationships_pkey PRIMARY KEY (id),
    CONSTRAINT teacher_student_relationships_teacher_fk FOREIGN KEY (teacher_id) REFERENCES public.accounts(id) ON DELETE CASCADE,
    CONSTRAINT teacher_student_relationships_student_fk FOREIGN KEY (student_id) REFERENCES public.accounts(id) ON DELETE CASCADE
);

-- === NEW TABLES FOR GAME PROGRESS AND ACTIVITY LOGS ===

-- Table for student game progress and scores (Top Achievers)
CREATE TABLE IF NOT EXISTS public.student_game_progress (
    id SERIAL NOT NULL,
    student_id INTEGER NOT NULL,
    student_name CHARACTER VARYING(100) NOT NULL,
    grade_level CHARACTER VARYING(20),
    current_quest CHARACTER VARYING(100),
    score INTEGER DEFAULT 0,
    correct_answers INTEGER DEFAULT 0,
    total_questions INTEGER DEFAULT 0,
    accuracy_rate DECIMAL(5, 2) DEFAULT 0.00,
    progress_percentage DECIMAL(5, 2) DEFAULT 0.00,
    last_played TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT student_game_progress_pkey PRIMARY KEY (id),
    CONSTRAINT student_game_progress_student_fk FOREIGN KEY (student_id) REFERENCES public.accounts(id) ON DELETE CASCADE
);

-- Table for activity logs (attendance and gameplay sessions)
CREATE TABLE IF NOT EXISTS public.activity_logs (
    id SERIAL NOT NULL,
    student_id INTEGER NOT NULL,
    student_name CHARACTER VARYING(100) NOT NULL,
    role CHARACTER VARYING(50),
    status VARCHAR(20),
    login_time TIMESTAMP WITH TIME ZONE,
    logout_time TIMESTAMP WITH TIME ZONE,
    session_date DATE DEFAULT CURRENT_DATE,
    activity_description CHARACTER VARYING(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT activity_logs_pkey PRIMARY KEY (id),
    CONSTRAINT activity_logs_student_fk FOREIGN KEY (student_id) REFERENCES public.accounts(id) ON DELETE CASCADE
);

-- === SAMPLE DATA FOR GAME PROGRESS (TOP ACHIEVERS) ===
INSERT INTO public.student_game_progress (student_id, student_name, grade_level, current_quest, score, correct_answers, total_questions, accuracy_rate, progress_percentage, last_played)
VALUES 
    (1, 'Juan Dela Cruz', 'Grade 5', 'Forest Gatekeeper', 90, 18, 20, 90.00, 85.00, NOW()),
    (2, 'Maria Santos', 'Grade 4', 'Village Challenge', 85, 17, 20, 85.00, 78.00, NOW() - INTERVAL '1 hour'),
    (3, 'Carlos Reyes', 'Grade 6', 'Castle Guardian', 95, 19, 20, 95.00, 92.00, NOW() - INTERVAL '2 hours'),
    (4, 'Ana Fernandez', 'Grade 5', 'Quest Master', 88, 17, 19, 89.47, 82.00, NOW() - INTERVAL '3 hours'),
    (5, 'Miguel Torres', 'Grade 4', 'Valley Explorer', 75, 15, 20, 75.00, 68.00, NOW() - INTERVAL '4 hours')
ON CONFLICT DO NOTHING;

-- === SAMPLE DATA FOR ACTIVITY LOGS (RECENT ACTIVITY) ===
INSERT INTO public.activity_logs (student_id, student_name, role, status, login_time, logout_time, session_date, activity_description)
VALUES 
    (1, 'Juan Dela Cruz', 'student', 'Online', NOW(), NOW() + INTERVAL '45 minutes', CURRENT_DATE, 'Logged In - Started Game Session'),
    (2, 'Maria Santos', 'student', 'Offline', NOW() - INTERVAL '1 hour 15 minutes', NOW() - INTERVAL '30 minutes', CURRENT_DATE, 'Logged Out - Completed Quest: Village Challenge'),
    (3, 'Carlos Reyes', 'student', 'Online', NOW() - INTERVAL '2 hours', NULL, CURRENT_DATE, 'Logged In - Played in Online Mode'),
    (4, 'Ana Fernandez', 'student', 'Offline', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours 15 minutes', CURRENT_DATE, 'Logged Out - Quest Session Ended'),
    (5, 'Miguel Torres', 'teacher', 'Offline', NOW() - INTERVAL '4 hours', NOW() - INTERVAL '3 hours 30 minutes', CURRENT_DATE, 'Logged Out - Monitoring Complete')
ON CONFLICT DO NOTHING;

SELECT * FROM public.accounts;