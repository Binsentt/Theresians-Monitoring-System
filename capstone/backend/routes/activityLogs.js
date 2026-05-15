// =========================================
// Activity Log API Handler
// Handles role-based queries, filtering, and gameplay tracking
// =========================================

const express = require('express');
const router = express.Router();
const pool = require('../database/db');

/**
 * GET /api/activity-logs
 * Fetch activity logs with role-based filtering
 * 
 * Query Parameters:
 * - limit: number of records to return (default: 50)
 * - offset: pagination offset (default: 0)
 * - teacher_id: filter by teacher's assigned students
 * - grade_level: filter by grade level
 * - section: filter by section
 * - search: search by student name (partial match)
 * - sort_by: field to sort by (default: activity_timestamp)
 * - sort_order: ASC or DESC (default: DESC)
 */
router.get('/activity-logs', async (req, res) => {
  try {
    const {
      limit = 50,
      offset = 0,
      teacher_id = null,
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
    const sortOrder = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    query += ` ORDER BY al.${sortField} ${sortOrder}`;

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
      countParamIndex++;
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
      },
      meta: {
        filtered: searchTerm || grade_level || section || teacher_id,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error fetching activity logs:', error);
    res.status(500).json({ 
      error: 'Failed to fetch activity logs',
      message: error.message 
    });
  }
});

/**
 * GET /api/activity-logs/stats
 * Get analytics and statistics for activity logs
 */
router.get('/activity-logs/stats', async (req, res) => {
  try {
    const { teacher_id = null } = req.query;

    let whereClause = '';
    let params = [];

    if (teacher_id) {
      whereClause = `
        WHERE al.student_id IN (
          SELECT tsr.student_id 
          FROM public.teacher_student_relationships tsr 
          WHERE tsr.teacher_id = $1
        )
      `;
      params.push(teacher_id);
    }

    const query = `
      SELECT 
        COUNT(DISTINCT al.student_id) as total_students,
        COUNT(DISTINCT al.grade_level) as grades_engaged,
        AVG(al.total_play_time) as avg_playtime,
        MAX(al.total_play_time) as max_playtime,
        AVG(al.quest_progress) as avg_progress,
        COUNT(CASE WHEN al.save_status = 'saved' THEN 1 END) as saved_sessions,
        COUNT(CASE WHEN al.save_status = 'pending' THEN 1 END) as pending_sessions,
        COUNT(CASE WHEN al.save_status = 'completed' THEN 1 END) as completed_sessions
      FROM public.activity_logs al
      ${whereClause}
    `;

    const result = await pool.query(query, params);

    res.json({
      stats: result.rows[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching activity log stats:', error);
    res.status(500).json({ 
      error: 'Failed to fetch statistics',
      message: error.message 
    });
  }
});

/**
 * GET /api/activity-logs/:id
 * Get detailed activity log record
 */
router.get('/activity-logs/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      SELECT * FROM public.activity_logs 
      WHERE id = $1
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activity log record not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching activity log detail:', error);
    res.status(500).json({ 
      error: 'Failed to fetch activity log',
      message: error.message 
    });
  }
});

/**
 * POST /api/activity-logs
 * Create a new activity log entry
 */
router.post('/activity-logs', async (req, res) => {
  try {
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

    if (!student_id || !student_name) {
      return res.status(400).json({ error: 'student_id and student_name are required' });
    }

    const query = `
      INSERT INTO public.activity_logs (
        student_id, student_name, grade_level, section, current_quest,
        save_status, total_play_time, last_played, quest_progress,
        difficulty_level, role, status, activity_description,
        login_time, session_date, activity_timestamp
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11, $12, NOW(), CURRENT_DATE, NOW()
      )
      RETURNING *
    `;

    const result = await pool.query(query, [
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
    ]);

    res.status(201).json({
      message: 'Activity log created successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating activity log:', error);
    res.status(500).json({ 
      error: 'Failed to create activity log',
      message: error.message 
    });
  }
});

/**
 * PUT /api/activity-logs/:id
 * Update an activity log entry
 */
router.put('/activity-logs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      save_status,
      total_play_time,
      quest_progress,
      difficulty_level,
      current_quest
    } = req.body;

    const updateFields = [];
    const params = [];
    let paramIndex = 1;

    if (save_status !== undefined) {
      updateFields.push(`save_status = $${paramIndex}`);
      params.push(save_status);
      paramIndex++;
    }

    if (total_play_time !== undefined) {
      updateFields.push(`total_play_time = $${paramIndex}`);
      params.push(total_play_time);
      paramIndex++;
    }

    if (quest_progress !== undefined) {
      updateFields.push(`quest_progress = $${paramIndex}`);
      params.push(quest_progress);
      paramIndex++;
    }

    if (difficulty_level !== undefined) {
      updateFields.push(`difficulty_level = $${paramIndex}`);
      params.push(difficulty_level);
      paramIndex++;
    }

    if (current_quest !== undefined) {
      updateFields.push(`current_quest = $${paramIndex}`);
      params.push(current_quest);
      paramIndex++;
    }

    // Always update timestamp
    updateFields.push(`activity_timestamp = NOW()`);

    if (updateFields.length === 1) {
      // Only timestamp was updated
      return res.status(400).json({ error: 'No update fields provided' });
    }

    params.push(id);

    const query = `
      UPDATE public.activity_logs 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activity log record not found' });
    }

    res.json({
      message: 'Activity log updated successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating activity log:', error);
    res.status(500).json({ 
      error: 'Failed to update activity log',
      message: error.message 
    });
  }
});

module.exports = router;
