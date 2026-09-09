const PARENT_ROLES = new Set(['parent', 'parent_teacher']);

const createFamilyError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const normalizeId = (value, label) => {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw createFamilyError(`Invalid ${label}.`, 400);
  }
  return id;
};

const normalizeRole = (value) => String(value || '').trim().toLowerCase().replace(/[\s/-]+/g, '_');

const assertParentAccount = (account, { requireArchived = false } = {}) => {
  if (!account) throw createFamilyError('Parent account not found.', 404);
  if (!PARENT_ROLES.has(normalizeRole(account.role))) {
    throw createFamilyError('Selected account must be a Parent account.', 400);
  }
  if (requireArchived && !account.is_archived) {
    throw createFamilyError('Only archived Parent accounts can be permanently deleted.', 409);
  }
  return account;
};

const withFamilyTransaction = async (pool, operation) => {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A database pool with connect is required.');
  }
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const result = await operation(client);
    await client.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const lockParentAccount = async (client, parentId, options = {}) => {
  const result = await client.query(
    `SELECT id, name, email, role, parent_id, is_archived
     FROM public.accounts
     WHERE id = $1
     FOR UPDATE`,
    [normalizeId(parentId, 'Parent account ID')]
  );
  return assertParentAccount(result.rows[0], options);
};

const readManagedChildrenForUpdate = async (client, parentId) => {
  const result = await client.query(
    `SELECT relationship.id AS relationship_id,
            student.id AS student_id,
            student.name AS student_name,
            student.game_student_id,
            student.grade_level,
            student.section,
            student.is_archived
     FROM public.teacher_student_relationships relationship
     JOIN public.accounts student ON student.id = relationship.student_id
     WHERE relationship.teacher_id = $1
       AND LOWER(relationship.relationship_type) = 'parent'
       AND LOWER(student.role) = 'student'
     ORDER BY student.name, student.id
     FOR UPDATE OF relationship, student`,
    [parentId]
  );
  return result.rows;
};

const assertExclusiveParentOwnership = async (client, parentId, studentIds) => {
  if (!studentIds.length) return;
  const result = await client.query(
    `SELECT relationship.student_id, other_parent.id AS other_parent_id
     FROM public.teacher_student_relationships relationship
     JOIN public.accounts other_parent ON other_parent.id = relationship.teacher_id
     WHERE relationship.student_id = ANY($1::INTEGER[])
       AND relationship.teacher_id <> $2
       AND LOWER(relationship.relationship_type) = 'parent'
       AND LOWER(other_parent.role) IN ('parent', 'parent_teacher')
       AND COALESCE(other_parent.is_archived, false) = false
     LIMIT 1`,
    [studentIds, parentId]
  );
  if (result.rows.length > 0) {
    throw createFamilyError(
      'A child has another active Parent relationship. Resolve the ownership conflict before permanent deletion.',
      409
    );
  }
};

const deleteStudentOwnedRecords = async (client, { studentIds, parentCode = null }) => {
  const ids = Array.from(new Set((studentIds || []).map((value) => normalizeId(value, 'Student account ID'))));
  if (ids.length === 0 && !parentCode) return [];

  await client.query(
    `DELETE FROM public.game_results
     WHERE resolved_student_id = ANY($1::INTEGER[])
        OR ($2::TEXT IS NOT NULL AND parent_id = $2)`,
    [ids, parentCode]
  );
  await client.query(
    `DELETE FROM public.playtime_sessions
     WHERE student_id = ANY($1::INTEGER[])
        OR ($2::TEXT IS NOT NULL AND parent_id = $2)`,
    [ids, parentCode]
  );
  if (ids.length === 0) return [];
  const deleted = await client.query(
    `DELETE FROM public.accounts
     WHERE id = ANY($1::INTEGER[])
       AND LOWER(role) = 'student'
     RETURNING id, game_student_id`,
    [ids]
  );
  if (deleted.rows.length !== ids.length) {
    throw createFamilyError('One or more managed Student accounts could not be permanently deleted.', 409);
  }
  return deleted.rows;
};

const permanentlyDeleteParentFamily = async (pool, parentId) => withFamilyTransaction(pool, async (client) => {
  const parent = await lockParentAccount(client, parentId, { requireArchived: true });
  const children = await readManagedChildrenForUpdate(client, parent.id);
  const studentIds = children.map((child) => Number(child.student_id));
  await assertExclusiveParentOwnership(client, parent.id, studentIds);
  const deletedStudents = await deleteStudentOwnedRecords(client, {
    studentIds,
    parentCode: parent.parent_id || null,
  });
  const parentResult = await client.query(
    `DELETE FROM public.accounts
     WHERE id = $1
     RETURNING id, name, email, role, parent_id`,
    [parent.id]
  );
  if (!parentResult.rows[0]) throw createFamilyError('Parent account could not be permanently deleted.', 409);
  return {
    deletedParent: parentResult.rows[0],
    deletedStudents,
    deletedStudentIds: studentIds,
  };
});

const unlinkManagedChild = async (pool, parentId, studentId) => withFamilyTransaction(pool, async (client) => {
  const parent = await lockParentAccount(client, parentId);
  const result = await client.query(
    `DELETE FROM public.teacher_student_relationships
     WHERE teacher_id = $1
       AND student_id = $2
       AND LOWER(relationship_type) = 'parent'
     RETURNING id, teacher_id, student_id, relationship_type`,
    [parent.id, normalizeId(studentId, 'Student account ID')]
  );
  if (!result.rows[0]) throw createFamilyError('Parent-child relationship not found.', 404);
  return { parent, relationship: result.rows[0] };
});

const permanentlyDeleteManagedStudent = async (pool, parentId, studentId) => withFamilyTransaction(pool, async (client) => {
  const normalizedParentId = normalizeId(parentId, 'Parent account ID');
  const normalizedStudentId = normalizeId(studentId, 'Student account ID');
  const result = await client.query(
    `SELECT parent.id AS parent_id,
            parent.parent_id AS parent_code,
            parent.role AS parent_role,
            parent.is_archived AS parent_is_archived,
            student.id AS student_id,
            student.name AS student_name,
            student.game_student_id
     FROM public.accounts parent
     JOIN public.teacher_student_relationships relationship
       ON relationship.teacher_id = parent.id
      AND LOWER(relationship.relationship_type) = 'parent'
     JOIN public.accounts student
       ON student.id = relationship.student_id
      AND LOWER(student.role) = 'student'
     WHERE parent.id = $1
       AND student.id = $2
     FOR UPDATE OF parent, relationship, student`,
    [normalizedParentId, normalizedStudentId]
  );
  const managed = result.rows[0];
  if (!managed) throw createFamilyError('Managed child account not found.', 404);
  assertParentAccount({ role: managed.parent_role, is_archived: managed.parent_is_archived });
  await assertExclusiveParentOwnership(client, normalizedParentId, [normalizedStudentId]);
  const deletedStudents = await deleteStudentOwnedRecords(client, {
    studentIds: [normalizedStudentId],
    parentCode: null,
  });
  return { managed, deletedStudent: deletedStudents[0] };
});

module.exports = {
  assertExclusiveParentOwnership,
  deleteStudentOwnedRecords,
  permanentlyDeleteManagedStudent,
  permanentlyDeleteParentFamily,
  readManagedChildrenForUpdate,
  unlinkManagedChild,
};
