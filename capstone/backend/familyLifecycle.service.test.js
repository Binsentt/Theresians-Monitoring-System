const test = require('node:test');
const assert = require('node:assert/strict');

const createPool = (handler) => {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ sql: compact, params });
      return handler(compact, params, calls);
    },
    release: () => calls.push({ sql: 'release', params: [] }),
  };
  return {
    calls,
    connect: async () => client,
  };
};

test('permanent Parent deletion removes the complete owned family in one transaction', async () => {
  const { permanentlyDeleteParentFamily } = require('./familyLifecycle.service');
  const pool = createPool(async (sql) => {
    if (sql.includes('from public.accounts') && sql.includes('for update')) {
      return { rows: [{ id: 19, name: 'Parent User', role: 'parent', parent_id: '112832', is_archived: true }] };
    }
    if (sql.includes('from public.teacher_student_relationships relationship') && sql.includes('join public.accounts student')) {
      return { rows: [
        { relationship_id: 7, student_id: 44, student_name: 'Ava Santos', game_student_id: '00123456' },
        { relationship_id: 8, student_id: 45, student_name: 'Noah Santos', game_student_id: '00123457' },
      ] };
    }
    if (sql.includes('other_parent')) return { rows: [] };
    if (sql.startsWith('delete from public.accounts') && sql.includes('any')) return { rows: [{ id: 44 }, { id: 45 }] };
    if (sql.startsWith('delete from public.accounts')) return { rows: [{ id: 19 }] };
    return { rows: [] };
  });

  const result = await permanentlyDeleteParentFamily(pool, 19);
  const sql = pool.calls.map((call) => call.sql);

  assert.deepEqual(result.deletedStudentIds, [44, 45]);
  assert.equal(result.deletedParent.id, 19);
  assert.equal(sql[0], 'begin');
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.game_results')));
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.playtime_sessions')));
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.accounts') && statement.includes('any')));
  assert.equal(sql.at(-2), 'commit');
  assert.equal(sql.at(-1), 'release');
});

test('permanent Parent deletion aborts when a child has another active Parent relationship', async () => {
  const { permanentlyDeleteParentFamily } = require('./familyLifecycle.service');
  const pool = createPool(async (sql) => {
    if (sql.includes('from public.accounts') && sql.includes('for update')) {
      return { rows: [{ id: 19, role: 'parent', parent_id: '112832', is_archived: true }] };
    }
    if (sql.includes('from public.teacher_student_relationships relationship') && sql.includes('join public.accounts student')) {
      return { rows: [{ relationship_id: 7, student_id: 44, game_student_id: '00123456' }] };
    }
    if (sql.includes('other_parent')) return { rows: [{ student_id: 44, other_parent_id: 27 }] };
    return { rows: [] };
  });

  await assert.rejects(
    permanentlyDeleteParentFamily(pool, 19),
    (error) => error.statusCode === 409 && /another active Parent/i.test(error.message)
  );
  const sql = pool.calls.map((call) => call.sql);
  assert.ok(sql.includes('rollback'));
  assert.equal(sql.some((statement) => statement.startsWith('delete from public.accounts')), false);
});

test('permanent Parent deletion rolls back every family write when a dependent deletion fails', async () => {
  const { permanentlyDeleteParentFamily } = require('./familyLifecycle.service');
  const pool = createPool(async (sql) => {
    if (sql.includes('from public.accounts') && sql.includes('for update')) {
      return { rows: [{ id: 19, role: 'parent', parent_id: '112832', is_archived: true }] };
    }
    if (sql.includes('from public.teacher_student_relationships relationship') && sql.includes('join public.accounts student')) {
      return { rows: [{ relationship_id: 7, student_id: 44, game_student_id: '00123456' }] };
    }
    if (sql.includes('other_parent')) return { rows: [] };
    if (sql.startsWith('delete from public.playtime_sessions')) throw new Error('simulated dependent delete failure');
    return { rows: [] };
  });

  await assert.rejects(permanentlyDeleteParentFamily(pool, 19), /simulated dependent delete failure/);
  const sql = pool.calls.map((call) => call.sql);
  assert.ok(sql.includes('rollback'));
  assert.equal(sql.includes('commit'), false);
});

test('unlinking a wrong existing child removes only the Parent relationship', async () => {
  const { unlinkManagedChild } = require('./familyLifecycle.service');
  const pool = createPool(async (sql) => {
    if (sql.includes('from public.accounts') && sql.includes('for update')) {
      return { rows: [{ id: 19, role: 'parent', parent_id: '112832', is_archived: false }] };
    }
    if (sql.startsWith('delete from public.teacher_student_relationships')) {
      return { rows: [{ id: 7, teacher_id: 19, student_id: 44 }] };
    }
    return { rows: [] };
  });

  const result = await unlinkManagedChild(pool, 19, 44);
  const sql = pool.calls.map((call) => call.sql);

  assert.equal(result.relationship.student_id, 44);
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.teacher_student_relationships')));
  assert.equal(sql.some((statement) => statement.startsWith('delete from public.accounts')), false);
  assert.ok(sql.includes('commit'));
});

test('explicit Student deletion removes owned data and releases the Student account ID', async () => {
  const { permanentlyDeleteManagedStudent } = require('./familyLifecycle.service');
  const pool = createPool(async (sql) => {
    if (sql.includes('from public.accounts parent') && sql.includes('join public.teacher_student_relationships')) {
      return { rows: [{
        parent_id: 19,
        parent_code: '112832',
        parent_role: 'parent',
        parent_is_archived: false,
        student_id: 44,
        student_name: 'Ava Santos',
        game_student_id: '00123456',
      }] };
    }
    if (sql.includes('other_parent')) return { rows: [] };
    if (sql.startsWith('delete from public.accounts')) return { rows: [{ id: 44, game_student_id: '00123456' }] };
    return { rows: [] };
  });

  const result = await permanentlyDeleteManagedStudent(pool, 19, 44);
  const sql = pool.calls.map((call) => call.sql);

  assert.equal(result.deletedStudent.game_student_id, '00123456');
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.game_results')));
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.playtime_sessions')));
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.accounts')));
  const gameResultDelete = pool.calls.find(({ sql: statement }) => statement.startsWith('delete from public.game_results'));
  const playtimeDelete = pool.calls.find(({ sql: statement }) => statement.startsWith('delete from public.playtime_sessions'));
  const accountDelete = pool.calls.find(({ sql: statement }) => statement.startsWith('delete from public.accounts'));
  assert.deepEqual(gameResultDelete.params, [[44], null]);
  assert.deepEqual(playtimeDelete.params, [[44], null]);
  assert.deepEqual(accountDelete.params, [[44]]);
  assert.ok(sql.includes('commit'));
});

test('permanent Admin Student deletion cleans only the target Student-owned rows in one transaction', async () => {
  const { permanentlyDeleteStudentAccount } = require('./familyLifecycle.service');
  const targetStudent = { id: 44, name: 'Ava Santos', game_student_id: '00123456', role: 'student', is_archived: false };
  const pool = createPool(async (sql, params) => {
    if (sql.includes('from public.accounts') && sql.includes('for update')) return { rows: [targetStudent] };
    if (sql.startsWith('delete from public.accounts')) return { rows: [{ id: 44, game_student_id: '00123456' }] };
    if (sql.startsWith('delete from public.game_results') || sql.startsWith('delete from public.playtime_sessions')) return { rows: [] };
    return { rows: [] };
  });

  const result = await permanentlyDeleteStudentAccount(pool, 44);
  const deletes = pool.calls.filter(({ sql }) => sql.startsWith('delete from public.'));

  assert.equal(result.deletedStudent.game_student_id, '00123456');
  assert.deepEqual(deletes.map(({ sql }) => sql.match(/delete from public\.(\w+)/)?.[1]), ['game_results', 'playtime_sessions', 'accounts']);
  deletes.forEach(({ params }) => {
    if (params.length) assert.ok(JSON.stringify(params).includes('44'));
    assert.equal(JSON.stringify(params).includes('45'), false);
  });
  assert.ok(pool.calls.some(({ sql }) => sql === 'begin'));
  assert.ok(pool.calls.some(({ sql }) => sql === 'commit'));
  assert.equal(pool.calls.some(({ sql }) => sql === 'rollback'), false);
});

test('permanent Student deletion rejects a non-Student account before removing owned data', async () => {
  const { permanentlyDeleteStudentAccount } = require('./familyLifecycle.service');
  const pool = createPool(async (sql) => {
    if (sql.includes('from public.accounts') && sql.includes('for update')) {
      return { rows: [{ id: 44, role: 'teacher', is_archived: false }] };
    }
    return { rows: [] };
  });

  await assert.rejects(
    permanentlyDeleteStudentAccount(pool, 44),
    (error) => error.statusCode === 400 && /Student account/i.test(error.message)
  );
  assert.equal(pool.calls.some(({ sql }) => sql.startsWith('delete from public.')), false);
  assert.ok(pool.calls.some(({ sql }) => sql === 'rollback'));
});


test('archiving a Parent archives linked Students without deleting their learning data', async () => {
  const { archiveParentFamily } = require('./familyLifecycle.service');
  const pool = createPool(async (sql) => {
    if (sql.includes('from public.accounts') && sql.includes('for update')) {
      return { rows: [{ id: 19, name: 'Parent User', role: 'parent', parent_id: '112832', is_archived: false }] };
    }
    if (sql.includes('from public.teacher_student_relationships relationship') && sql.includes('join public.accounts student')) {
      return { rows: [
        { relationship_id: 7, student_id: 44, student_name: 'Ava Santos', game_student_id: '00123456' },
        { relationship_id: 8, student_id: 45, student_name: 'Noah Santos', game_student_id: '00123457' },
      ] };
    }
    if (sql.startsWith('update public.accounts') && sql.includes('where id = any')) return { rows: [] };
    if (sql.startsWith('update public.accounts') && sql.includes('where id = $1')) {
      return { rows: [{ id: 19, role: 'parent', is_archived: true }] };
    }
    return { rows: [] };
  });

  const result = await archiveParentFamily(pool, 19);
  const sql = pool.calls.map((call) => call.sql);

  assert.deepEqual(result.archivedStudentIds, [44, 45]);
  assert.equal(pool.calls.some(({ sql: statement }) => statement.startsWith('delete from public.')), false);
  assert.ok(sql.some((statement) => statement.startsWith('update public.accounts') && statement.includes('where id = any')));
  assert.ok(sql.some((statement) => statement.startsWith('update public.accounts') && statement.includes('where id = $1')));
  assert.ok(sql.includes('commit'));
});

test('restoring a Parent restores the linked Student accounts with the family', async () => {
  const { restoreParentFamily } = require('./familyLifecycle.service');
  const pool = createPool(async (sql) => {
    if (sql.includes('from public.accounts') && sql.includes('for update')) {
      return { rows: [{ id: 19, name: 'Parent User', role: 'parent', parent_id: '112832', is_archived: true }] };
    }
    if (sql.includes('from public.teacher_student_relationships relationship') && sql.includes('join public.accounts student')) {
      return { rows: [{ relationship_id: 7, student_id: 44, student_name: 'Ava Santos', game_student_id: '00123456' }] };
    }
    if (sql.startsWith('update public.accounts')) return { rows: [{ id: 19, role: 'parent', is_archived: false }] };
    return { rows: [] };
  });

  const result = await restoreParentFamily(pool, 19);
  const sql = pool.calls.map((call) => call.sql);

  assert.deepEqual(result.restoredStudentIds, [44]);
  assert.equal(sql.filter((statement) => statement.startsWith('update public.accounts')).length, 2);
  assert.ok(sql.includes('commit'));
});

test('legacy six-digit Student cleanup removes only six-digit Student IDs and their learning data', async () => {
  const { permanentlyDeleteLegacySixDigitStudents } = require('./familyLifecycle.service');
  const pool = createPool(async (sql) => {
    if (sql.startsWith('select id, game_student_id')) {
      return { rows: [
        { id: 44, game_student_id: '123123' },
        { id: 45, game_student_id: '00123456' },
      ] };
    }
    if (sql.startsWith('delete from public.accounts')) {
      return { rows: [{ id: 44, game_student_id: '123123' }] };
    }
    return { rows: [] };
  });

  const result = await permanentlyDeleteLegacySixDigitStudents(pool);
  const sql = pool.calls.map((call) => call.sql);

  assert.deepEqual(result.deletedStudents, [{ id: 44, game_student_id: '123123' }]);
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.game_results')));
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.playtime_sessions')));
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.student_game_progress')));
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.student_quest_milestones')));
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.student_ai_insights')));
  assert.ok(sql.some((statement) => statement.startsWith('delete from public.accounts')));
});
