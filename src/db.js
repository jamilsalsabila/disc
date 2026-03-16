'use strict';

const Path = require('path');
const Database = require('better-sqlite3');
const { parseQuestionsFromTxt } = require('./questions');

const dbPath = Path.join(process.cwd(), 'data', 'disc_app.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  browser_token TEXT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  selected_role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  submitted_at TEXT,
  duration_seconds INTEGER,
  recommendation TEXT,
  reason TEXT,
  disc_d INTEGER,
  disc_i INTEGER,
  disc_s INTEGER,
  disc_c INTEGER,
  score_server INTEGER,
  score_beverage INTEGER,
  score_cook INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  answer_type TEXT NOT NULL DEFAULT 'most',
  option_code TEXT,
  disc_value TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(candidate_id) REFERENCES candidates(id)
);

CREATE TABLE IF NOT EXISTS questions_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_order INTEGER NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_answers_candidate_id ON answers(candidate_id);
CREATE INDEX IF NOT EXISTS idx_questions_bank_order ON questions_bank(question_order);
`);

function ensureAnswerTypeColumn() {
  const columns = db.prepare('PRAGMA table_info(answers)').all();
  const hasAnswerType = columns.some((col) => col.name === 'answer_type');
  if (!hasAnswerType) {
    db.exec("ALTER TABLE answers ADD COLUMN answer_type TEXT NOT NULL DEFAULT 'most'");
  }
}

ensureAnswerTypeColumn();

function ensureCandidateBrowserTokenColumn() {
  const columns = db.prepare('PRAGMA table_info(candidates)').all();
  const hasBrowserToken = columns.some((col) => col.name === 'browser_token');
  if (!hasBrowserToken) {
    db.exec('ALTER TABLE candidates ADD COLUMN browser_token TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_candidates_browser_token ON candidates(browser_token)');
}

ensureCandidateBrowserTokenColumn();

function seedQuestionsFromTxtIfEmpty() {
  const total = db.prepare('SELECT COUNT(*) as total FROM questions_bank').get().total;
  if (total > 0) {
    return;
  }

  const sourcePath = Path.join(process.cwd(), 'one_for_all_v1.txt');
  const parsed = parseQuestionsFromTxt(sourcePath);
  if (!parsed.length) {
    return;
  }

  const insertStmt = db.prepare(`
    INSERT INTO questions_bank (
      question_order, option_a, option_b, option_c, option_d, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `);

  const now = nowIso();
  const transaction = db.transaction(() => {
    parsed.forEach((question, index) => {
      const optionA = question.options.find((opt) => opt.code === 'A')?.text || '';
      const optionB = question.options.find((opt) => opt.code === 'B')?.text || '';
      const optionC = question.options.find((opt) => opt.code === 'C')?.text || '';
      const optionD = question.options.find((opt) => opt.code === 'D')?.text || '';

      insertStmt.run(index + 1, optionA, optionB, optionC, optionD, now, now);
    });
  });

  transaction();
}

seedQuestionsFromTxtIfEmpty();

function nowIso() {
  return new Date().toISOString();
}

function createCandidate({ browserToken, fullName, email, whatsapp, selectedRole, startedAt, deadlineAt }) {
  const stmt = db.prepare(`
    INSERT INTO candidates (
      browser_token, full_name, email, whatsapp, selected_role, status,
      started_at, deadline_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, ?)
  `);

  const result = stmt.run(browserToken, fullName, email, whatsapp, selectedRole, startedAt, deadlineAt, nowIso());
  return result.lastInsertRowid;
}

function getCandidateById(id) {
  return db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
}

function getInProgressCandidateByBrowserToken(browserToken) {
  if (!browserToken) {
    return null;
  }
  return db
    .prepare("SELECT * FROM candidates WHERE browser_token = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
    .get(browserToken);
}

function saveSubmission({
  candidateId,
  answers,
  submittedAt,
  durationSeconds,
  evaluation,
  forceStatus
}) {
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM answers WHERE candidate_id = ?').run(candidateId);

    const insertAnswer = db.prepare(`
      INSERT INTO answers (candidate_id, question_id, answer_type, option_code, disc_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    Object.entries(answers).forEach(([questionId, payload]) => {
      insertAnswer.run(
        candidateId,
        Number(questionId),
        'most',
        payload.most.optionCode,
        payload.most.disc,
        nowIso()
      );
      insertAnswer.run(
        candidateId,
        Number(questionId),
        'least',
        payload.least.optionCode,
        payload.least.disc,
        nowIso()
      );
    });

    db.prepare(`
      UPDATE candidates
      SET
        status = ?,
        submitted_at = ?,
        duration_seconds = ?,
        recommendation = ?,
        reason = ?,
        disc_d = ?,
        disc_i = ?,
        disc_s = ?,
        disc_c = ?,
        score_server = ?,
        score_beverage = ?,
        score_cook = ?
      WHERE id = ?
    `).run(
      forceStatus || 'submitted',
      submittedAt,
      durationSeconds,
      evaluation.recommendation || null,
      evaluation.reason || null,
      evaluation.discCounts?.D ?? 0,
      evaluation.discCounts?.I ?? 0,
      evaluation.discCounts?.S ?? 0,
      evaluation.discCounts?.C ?? 0,
      evaluation.roleScores?.SERVER_SPECIALIST ?? 0,
      evaluation.roleScores?.BEVERAGE_SPECIALIST ?? 0,
      evaluation.roleScores?.SENIOR_COOK ?? 0,
      candidateId
    );
  });

  transaction();
}

function listCandidates({ search, role, recommendation }) {
  const conditions = [];
  const params = {};

  if (search) {
    conditions.push('(full_name LIKE @search OR email LIKE @search OR whatsapp LIKE @search)');
    params.search = `%${search}%`;
  }

  if (role) {
    conditions.push('selected_role = @role');
    params.role = role;
  }

  if (recommendation) {
    conditions.push('recommendation = @recommendation');
    params.recommendation = recommendation;
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `
    SELECT * FROM candidates
    ${whereClause}
    ORDER BY created_at DESC
  `;

  return db.prepare(query).all(params);
}

function getAnswersForCandidate(candidateId) {
  return db
    .prepare('SELECT * FROM answers WHERE candidate_id = ? ORDER BY question_id ASC, answer_type DESC')
    .all(candidateId);
}

function listQuestions({ includeInactive = true } = {}) {
  const where = includeInactive ? '' : 'WHERE is_active = 1';
  const rows = db.prepare(`
    SELECT *
    FROM questions_bank
    ${where}
    ORDER BY question_order ASC, id ASC
  `).all();

  return rows.map((row) => ({
    id: row.id,
    order: row.question_order,
    isActive: row.is_active === 1,
    optionA: row.option_a,
    optionB: row.option_b,
    optionC: row.option_c,
    optionD: row.option_d,
    options: [
      { code: 'A', text: row.option_a, disc: 'D' },
      { code: 'B', text: row.option_b, disc: 'I' },
      { code: 'C', text: row.option_c, disc: 'S' },
      { code: 'D', text: row.option_d, disc: 'C' }
    ]
  }));
}

function getQuestionById(questionId) {
  const row = db.prepare('SELECT * FROM questions_bank WHERE id = ?').get(questionId);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    order: row.question_order,
    isActive: row.is_active === 1,
    options: {
      A: row.option_a,
      B: row.option_b,
      C: row.option_c,
      D: row.option_d
    }
  };
}

function getNextQuestionOrder() {
  const row = db.prepare('SELECT COALESCE(MAX(question_order), 0) as max_order FROM questions_bank').get();
  return (row?.max_order || 0) + 1;
}

function createQuestion({ order, optionA, optionB, optionC, optionD, isActive }) {
  const result = db.prepare(`
    INSERT INTO questions_bank (
      question_order, option_a, option_b, option_c, option_d, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order,
    optionA,
    optionB,
    optionC,
    optionD,
    isActive ? 1 : 0,
    nowIso(),
    nowIso()
  );
  return result.lastInsertRowid;
}

function updateQuestionById(questionId, { order, optionA, optionB, optionC, optionD, isActive }) {
  const result = db.prepare(`
    UPDATE questions_bank
    SET
      question_order = ?,
      option_a = ?,
      option_b = ?,
      option_c = ?,
      option_d = ?,
      is_active = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    order,
    optionA,
    optionB,
    optionC,
    optionD,
    isActive ? 1 : 0,
    nowIso(),
    questionId
  );
  return result.changes;
}

function toggleQuestionActiveById(questionId) {
  const row = db.prepare('SELECT id, is_active FROM questions_bank WHERE id = ?').get(questionId);
  if (!row) {
    return 0;
  }
  const nextActive = row.is_active === 1 ? 0 : 1;
  const result = db.prepare(`
    UPDATE questions_bank
    SET is_active = ?, updated_at = ?
    WHERE id = ?
  `).run(nextActive, nowIso(), questionId);
  return result.changes;
}

function deleteQuestionById(questionId) {
  const result = db.prepare('DELETE FROM questions_bank WHERE id = ?').run(questionId);
  return result.changes;
}

function getSummaryStats() {
  const roleDistribution = db.prepare(`
    SELECT recommendation, COUNT(*) as total
    FROM candidates
    WHERE status = 'submitted'
    GROUP BY recommendation
  `).all();

  const avgDisc = db.prepare(`
    SELECT
      COALESCE(AVG(disc_d), 0) as avg_d,
      COALESCE(AVG(disc_i), 0) as avg_i,
      COALESCE(AVG(disc_s), 0) as avg_s,
      COALESCE(AVG(disc_c), 0) as avg_c,
      COUNT(*) as total_submitted
    FROM candidates
    WHERE status = 'submitted'
  `).get();

  return { roleDistribution, avgDisc };
}

function deleteCandidateById(candidateId) {
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM answers WHERE candidate_id = ?').run(candidateId);
    const result = db.prepare('DELETE FROM candidates WHERE id = ?').run(candidateId);
    return result.changes;
  });

  return transaction();
}

module.exports = {
  db,
  createCandidate,
  getCandidateById,
  getInProgressCandidateByBrowserToken,
  listQuestions,
  getQuestionById,
  getNextQuestionOrder,
  createQuestion,
  updateQuestionById,
  toggleQuestionActiveById,
  deleteQuestionById,
  deleteCandidateById,
  saveSubmission,
  listCandidates,
  getAnswersForCandidate,
  getSummaryStats
};
