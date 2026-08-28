const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseQuizCsv, parseFlashcardCsv } = require('./csvImport');

const buf = (s) => Buffer.from(s, 'utf8');

test('parseQuizCsv: valid rows produce correctIndex matching correct_answer case-insensitively', () => {
  const csv = 'question,option1,option2,option3,option4,correct_answer,topic_tag\n' +
    'What color is the sky?,Blue,Red,Green,Yellow,blue,science\n';
  const { rows, errors } = parseQuizCsv(buf(csv));
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    question: 'What color is the sky?',
    options: ['Blue', 'Red', 'Green', 'Yellow'],
    correctIndex: 0,
    topicTag: 'science',
  });
});

test('parseQuizCsv: missing question is rejected with a 1-indexed row number', () => {
  const csv = 'question,option1,option2,correct_answer\n,A,B,A\n';
  const { rows, errors } = parseQuizCsv(buf(csv));
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Row 2:/);
  assert.match(errors[0], /missing question/);
});

test('parseQuizCsv: fewer than 2 non-empty options is rejected', () => {
  const csv = 'question,option1,option2,option3,option4,correct_answer\nOnly one option?,A,,,,A\n';
  const { rows, errors } = parseQuizCsv(buf(csv));
  assert.equal(rows.length, 0);
  assert.match(errors[0], /needs at least 2 options/);
});

test('parseQuizCsv: correct_answer not matching any option is rejected', () => {
  const csv = 'question,option1,option2,correct_answer\nQ?,A,B,C\n';
  const { rows, errors } = parseQuizCsv(buf(csv));
  assert.equal(rows.length, 0);
  assert.match(errors[0], /doesn't match any option/);
});

test('parseQuizCsv: topic_tag is optional and null when blank', () => {
  const csv = 'question,option1,option2,correct_answer,topic_tag\nQ?,A,B,A,\n';
  const { rows } = parseQuizCsv(buf(csv));
  assert.equal(rows[0].topicTag, null);
});

test('parseQuizCsv: one bad row does not block other valid rows in the same file', () => {
  const csv = 'question,option1,option2,correct_answer\n' +
    'Good question?,A,B,A\n' +
    ',A,B,A\n' + // bad: no question
    'Another good one?,C,D,D\n';
  const { rows, errors } = parseQuizCsv(buf(csv));
  assert.equal(rows.length, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Row 3:/);
});

test('parseQuizCsv: malformed CSV returns a parse error instead of throwing', () => {
  const { rows, errors } = parseQuizCsv(buf('question,option1\n"unterminated quote,A\n'));
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Could not parse CSV/);
});

test('parseQuizCsv: empty file produces no rows and no errors', () => {
  const { rows, errors } = parseQuizCsv(buf(''));
  assert.deepEqual(rows, []);
  assert.deepEqual(errors, []);
});

test('parseFlashcardCsv: valid rows parse front/back/topicTag', () => {
  const csv = 'front,back,topic_tag\nWhat is 2+2?,4,math\n';
  const { rows, errors } = parseFlashcardCsv(buf(csv));
  assert.equal(errors.length, 0);
  assert.deepEqual(rows[0], { front: 'What is 2+2?', back: '4', topicTag: 'math' });
});

test('parseFlashcardCsv: missing front or back is rejected independently', () => {
  const csv = 'front,back\n,Back only\nFront only,\n';
  const { rows, errors } = parseFlashcardCsv(buf(csv));
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /missing front/);
  assert.match(errors[1], /missing back/);
});

test('parseFlashcardCsv: surrounding whitespace is trimmed', () => {
  const csv = 'front,back\n  spaced front  ,  spaced back  \n';
  const { rows } = parseFlashcardCsv(buf(csv));
  assert.equal(rows[0].front, 'spaced front');
  assert.equal(rows[0].back, 'spaced back');
});
