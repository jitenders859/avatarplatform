/**
 * CSV import for owner-authored quiz questions and flashcards.
 *
 * Both parsers return { rows, errors } — valid rows ready to insert, plus
 * per-row error messages (1-indexed, matching what a spreadsheet user sees)
 * for rows that don't pass validation. Callers insert what's valid and
 * report the rest back rather than failing the whole import on one bad row.
 */
const { parse } = require('csv-parse/sync');

function parseCsvRows(buffer) {
  return parse(buffer.toString('utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

/** Expected columns: question, option1, option2, option3, option4, correct_answer, topic_tag */
function parseQuizCsv(buffer) {
  let raw;
  try {
    raw = parseCsvRows(buffer);
  } catch (e) {
    return { rows: [], errors: [`Could not parse CSV: ${e.message}`] };
  }

  const rows = [];
  const errors = [];
  raw.forEach((r, i) => {
    const line = i + 2; // +1 for 0-index, +1 for header row
    const question = (r.question || '').trim();
    const options = ['option1', 'option2', 'option3', 'option4']
      .map(k => (r[k] || '').trim())
      .filter(Boolean);
    const correctAnswer = (r.correct_answer || '').trim();

    if (!question) { errors.push(`Row ${line}: missing question`); return; }
    if (options.length < 2) { errors.push(`Row ${line}: needs at least 2 options`); return; }
    const correctIndex = options.findIndex(o => o.toLowerCase() === correctAnswer.toLowerCase());
    if (correctIndex === -1) {
      errors.push(`Row ${line}: correct_answer "${correctAnswer}" doesn't match any option`);
      return;
    }
    rows.push({
      question, options, correctIndex,
      topicTag: (r.topic_tag || '').trim() || null,
    });
  });

  return { rows, errors };
}

/** Expected columns: front, back, topic_tag */
function parseFlashcardCsv(buffer) {
  let raw;
  try {
    raw = parseCsvRows(buffer);
  } catch (e) {
    return { rows: [], errors: [`Could not parse CSV: ${e.message}`] };
  }

  const rows = [];
  const errors = [];
  raw.forEach((r, i) => {
    const line = i + 2;
    const front = (r.front || '').trim();
    const back = (r.back || '').trim();
    if (!front) { errors.push(`Row ${line}: missing front`); return; }
    if (!back) { errors.push(`Row ${line}: missing back`); return; }
    rows.push({ front, back, topicTag: (r.topic_tag || '').trim() || null });
  });

  return { rows, errors };
}

module.exports = { parseQuizCsv, parseFlashcardCsv };
