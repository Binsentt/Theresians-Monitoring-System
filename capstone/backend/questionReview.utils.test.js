const test = require('node:test');
const assert = require('node:assert/strict');
const { buildQuestionCountEligibility, findDuplicateQuestion, getQuestionCountState, isQuestionGenerationActive } = require('./questionReview.utils');

test('no requested count leaves fixed/manual sets eligible', () => { const result = buildQuestionCountEligibility({ file_type: 'fixed_questions' }, 0); assert.equal(result.eligible, true); assert.equal(result.state.applies, false); });
test('generated set with no questions is incomplete', () => { const result = buildQuestionCountEligibility({ file_type: 'lesson', requested_question_count: 25 }, 0); assert.equal(result.eligible, false); assert.equal(result.code, 'QUESTION_COUNT_INCOMPLETE'); assert.match(result.message, /0 of 25.*Add 25 questions/); });
test('generated set reports the exact missing count', () => { const result = buildQuestionCountEligibility({ file_type: 'lesson', requested_question_count: 25 }, 24); assert.equal(result.state.missing, 1); assert.equal(result.message, '24 of 25 questions are currently available. Add 1 question before approval.'); });
test('generated set becomes eligible at the requested count', () => { const result = buildQuestionCountEligibility({ file_type: 'lesson', requested_question_count: 25 }, 25); assert.equal(result.eligible, true); assert.equal(result.state.missing, 0); });
test('extra generated questions do not block approval', () => { const result = buildQuestionCountEligibility({ file_type: 'lesson', requested_question_count: 5 }, 6); assert.equal(result.eligible, true); });
test('publication uses Push to Game wording for an incomplete generated set', () => { const result = buildQuestionCountEligibility({ file_type: 'lesson', requested_question_count: 5 }, 4, 'publication'); assert.match(result.message, /before Push to Game/); });
test('duplicate question detection is case and whitespace insensitive', () => { const duplicate = findDuplicateQuestion([{ id: 1, question: '  What is 2 + 2? ' }], 'what   is 2 + 2?'); assert.equal(duplicate.id, 1); });
test('duplicate question detection permits the current question during edit', () => { const duplicate = findDuplicateQuestion([{ id: 1, question: 'What is 2 + 2?' }], 'What is 2 + 2?', { excludeId: 1 }); assert.equal(duplicate, null); });
test('empty question text is never treated as a duplicate', () => { assert.equal(findDuplicateQuestion([{ id: 1, question: '' }], ''), null); });
test('only active generation stages hide manual add', () => { assert.equal(isQuestionGenerationActive('generating'), true); assert.equal(isQuestionGenerationActive('ready_for_review'), false); assert.equal(isQuestionGenerationActive('not_applicable'), false); });
test('question count state preserves current count for fixed/manual sets', () => { const state = getQuestionCountState({ file_type: 'fixed_questions', requested_question_count: 25 }, 3); assert.deepEqual(state, { applies: false, requested: null, current: 3, missing: 0 }); });
