-- =========================================
-- DATABASE MIGRATION: Enhanced Activity Log for Gameplay Tracking
-- =========================================

-- Add new columns to activity_logs table for gameplay tracking
ALTER TABLE public.activity_logs 
  ADD COLUMN IF NOT EXISTS grade_level VARCHAR(20),
  ADD COLUMN IF NOT EXISTS section VARCHAR(50),
  ADD COLUMN IF NOT EXISTS current_quest VARCHAR(150),
  ADD COLUMN IF NOT EXISTS save_status VARCHAR(50) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS total_play_time INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_played TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS quest_progress INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS difficulty_level VARCHAR(50) DEFAULT 'Normal',
  ADD COLUMN IF NOT EXISTS activity_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Create index on commonly filtered columns
CREATE INDEX IF NOT EXISTS idx_activity_logs_grade_level ON public.activity_logs(grade_level);
CREATE INDEX IF NOT EXISTS idx_activity_logs_section ON public.activity_logs(section);
CREATE INDEX IF NOT EXISTS idx_activity_logs_student_name ON public.activity_logs(student_name);
CREATE INDEX IF NOT EXISTS idx_activity_logs_last_played ON public.activity_logs(last_played);

-- Update existing activity logs with sample gameplay data
UPDATE public.activity_logs SET
  grade_level = CASE student_id
    WHEN 1 THEN 'Grade 5'
    WHEN 2 THEN 'Grade 4'
    WHEN 3 THEN 'Grade 6'
    WHEN 4 THEN 'Grade 5'
    WHEN 5 THEN 'Grade 4'
    ELSE 'Grade 4'
  END,
  section = CASE student_id
    WHEN 1 THEN 'Section A'
    WHEN 2 THEN 'Section B'
    WHEN 3 THEN 'Section C'
    WHEN 4 THEN 'Section A'
    WHEN 5 THEN 'Section B'
    ELSE 'Section A'
  END,
  current_quest = CASE student_id
    WHEN 1 THEN 'Forest Gatekeeper'
    WHEN 2 THEN 'Village Challenge'
    WHEN 3 THEN 'Castle Guardian'
    WHEN 4 THEN 'Quest Master'
    WHEN 5 THEN 'Valley Explorer'
    ELSE 'No Active Quest'
  END,
  save_status = CASE student_id
    WHEN 1 THEN 'pending'
    WHEN 2 THEN 'saved'
    WHEN 3 THEN 'pending'
    WHEN 4 THEN 'completed'
    WHEN 5 THEN 'saved'
    ELSE 'pending'
  END,
  total_play_time = CASE student_id
    WHEN 1 THEN 2700
    WHEN 2 THEN 3600
    WHEN 3 THEN 4500
    WHEN 4 THEN 2100
    WHEN 5 THEN 1800
    ELSE 1800
  END,
  last_played = NOW() - INTERVAL '30 minutes' * student_id,
  quest_progress = CASE student_id
    WHEN 1 THEN 85
    WHEN 2 THEN 78
    WHEN 3 THEN 92
    WHEN 4 THEN 82
    WHEN 5 THEN 68
    ELSE 50
  END,
  difficulty_level = CASE student_id
    WHEN 1 THEN 'Normal'
    WHEN 2 THEN 'Easy'
    WHEN 3 THEN 'Hard'
    WHEN 4 THEN 'Normal'
    WHEN 5 THEN 'Easy'
    ELSE 'Normal'
  END,
  activity_timestamp = NOW()
WHERE student_id IN (1, 2, 3, 4, 5);

-- Insert additional sample activity records for testing
INSERT INTO public.activity_logs 
  (student_id, student_name, role, status, grade_level, section, current_quest, save_status, 
   total_play_time, last_played, quest_progress, difficulty_level, login_time, logout_time, 
   session_date, activity_description, activity_timestamp)
SELECT 
  acc.id,
  acc.name,
  acc.role,
  acc.status,
  'Grade ' || (FLOOR(RANDOM() * 6)::INT + 1)::TEXT,
  'Section ' || CHR(65 + (FLOOR(RANDOM() * 3)::INT)),
  CASE FLOOR(RANDOM() * 5)::INT
    WHEN 0 THEN 'Forest Gatekeeper'
    WHEN 1 THEN 'Village Challenge'
    WHEN 2 THEN 'Castle Guardian'
    WHEN 3 THEN 'Quest Master'
    ELSE 'Valley Explorer'
  END,
  CASE FLOOR(RANDOM() * 3)::INT
    WHEN 0 THEN 'pending'
    WHEN 1 THEN 'saved'
    ELSE 'completed'
  END,
  (FLOOR(RANDOM() * 5400) + 600)::INT,
  NOW() - INTERVAL '1 hour' * (FLOOR(RANDOM() * 5) + 1),
  (FLOOR(RANDOM() * 100))::INT,
  CASE FLOOR(RANDOM() * 4)::INT
    WHEN 0 THEN 'Easy'
    WHEN 1 THEN 'Normal'
    WHEN 2 THEN 'Hard'
    ELSE 'Expert'
  END,
  NOW() - INTERVAL '2 hours',
  NOW() - INTERVAL '1 hour',
  CURRENT_DATE,
  'Gameplay Session: Quest in Progress',
  NOW()
FROM public.accounts acc
WHERE acc.role = 'Parent' 
  AND acc.id NOT IN (1, 2, 3, 4, 5)
  AND RANDOM() < 0.4
LIMIT 10
ON CONFLICT DO NOTHING;

-- View to simplify activity log queries with all relevant fields
CREATE OR REPLACE VIEW public.activity_logs_view AS
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
ORDER BY al.activity_timestamp DESC;

-- Verify the migration
SELECT 'Activity Logs Enhanced - Gameplay Tracking Columns Added' AS migration_status;
SELECT COUNT(*) as total_activity_records FROM public.activity_logs;
SELECT COUNT(DISTINCT grade_level) as grades_tracked FROM public.activity_logs WHERE grade_level IS NOT NULL;
