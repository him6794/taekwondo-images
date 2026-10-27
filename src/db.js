import { isoFromRunId, isoTaipei } from "./logic.js";

export async function loadAnswerKey(db) {
  const { results } = await db.prepare("SELECT filename, trial_id, answer FROM answer_key").all();
  return new Map(results.map((r) => [r.filename, { trial_id: r.trial_id, answer: r.answer }]));
}

const KEY_TTL_MS = 60 * 1000;
let keyCache = null;

export async function cachedAnswerKey(db) {
  const now = Date.now();
  if (keyCache && keyCache.expires > now) return keyCache.map;
  const map = await loadAnswerKey(db);
  keyCache = { map, expires: now + KEY_TTL_MS };
  return map;
}

export async function participantExists(db, code) {
  return (await db.prepare("SELECT 1 AS ok FROM participants WHERE code = ?").bind(code).first()) !== null;
}

export async function storedSequence(db, code) {
  const row = await db.prepare("SELECT filenames FROM sequences WHERE code = ?").bind(code).first();
  if (!row) return null;
  try {
    return JSON.parse(row.filenames);
  } catch {
    return null;
  }
}

export function insertSequenceIfAbsentStmt(db, code, filenames) {
  return db.prepare("INSERT INTO sequences (code, filenames, created_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(code) DO NOTHING").bind(code, JSON.stringify(filenames), isoTaipei());
}

export function replaceSequenceStmt(db, code, filenames) {
  return db.prepare("INSERT INTO sequences (code, filenames, created_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(code) DO UPDATE SET filenames = excluded.filenames, created_at = excluded.created_at")
    .bind(code, JSON.stringify(filenames), isoTaipei());
}

export function startRunStmt(db, meta) {
  return db.prepare("INSERT INTO runs (run_id, participant_code, session, started_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(run_id, participant_code) DO NOTHING")
    .bind(meta.run_id, meta.code, meta.session, isoFromRunId(meta.run_id) ?? isoTaipei());
}

export function upsertTrialStmt(db, rec) {
  return db.prepare("INSERT OR REPLACE INTO trials (run_id, participant_code, session, presentation_order, " +
    "trial_id, image, correct_answer, response, is_correct, rt_ms, isi_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(rec.run_id, rec.participant_code, rec.session, rec.presentation_order, rec.trial_id,
      rec.image, rec.correct_answer, rec.response, rec.is_correct, rec.rt_ms, rec.isi_ms);
}

export function deleteRunTrialsStmt(db, meta) {
  return db.prepare("DELETE FROM trials WHERE run_id = ? AND participant_code = ?").bind(meta.run_id, meta.code);
}

export function finishRunStmt(db, meta, finishedAt) {
  return db.prepare("INSERT INTO runs (run_id, participant_code, session, started_at, finished_at) " +
    "VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, participant_code) DO UPDATE SET " +
    "session = excluded.session, finished_at = excluded.finished_at")
    .bind(meta.run_id, meta.code, meta.session, isoFromRunId(meta.run_id) ?? finishedAt, finishedAt);
}

export async function finishedTrials(db) {
  const { results } = await db.prepare(`
    SELECT t.run_id, t.participant_code, t.session, t.presentation_order, t.trial_id, t.image,
           t.correct_answer, t.response, t.is_correct, t.rt_ms, t.isi_ms
    FROM trials t
    JOIN runs r ON r.run_id = t.run_id AND r.participant_code = t.participant_code
    WHERE r.finished_at IS NOT NULL
    ORDER BY r.finished_at, t.run_id, t.participant_code, t.presentation_order`).all();
  return results;
}

export async function runSummaries(db) {
  const { results } = await db.prepare(`
    SELECT r.run_id, r.participant_code, p.name, r.session, r.started_at, r.finished_at,
           COUNT(t.presentation_order) AS n, AVG(t.is_correct) * 100 AS acc, AVG(t.rt_ms) AS rt
    FROM runs r
    LEFT JOIN participants p ON p.code = r.participant_code
    LEFT JOIN trials t ON t.run_id = r.run_id AND t.participant_code = r.participant_code
    GROUP BY r.run_id, r.participant_code
    ORDER BY r.started_at DESC, r.run_id DESC`).all();
  return results;
}

export async function runInfo(db, runId, code) {
  return db.prepare(`
    SELECT r.run_id, r.participant_code, p.name, r.session, r.started_at, r.finished_at
    FROM runs r LEFT JOIN participants p ON p.code = r.participant_code
    WHERE r.run_id = ? AND r.participant_code = ?`).bind(runId, code).first();
}

export async function runTrials(db, runId, code) {
  const { results } = await db.prepare(`
    SELECT run_id, participant_code, session, presentation_order, trial_id, image,
           correct_answer, response, is_correct, rt_ms, isi_ms
    FROM trials WHERE run_id = ? AND participant_code = ? ORDER BY presentation_order`)
    .bind(runId, code).all();
  return results;
}

export async function participantNames(db) {
  const { results } = await db.prepare("SELECT code, name FROM participants").all();
  return new Map(results.map((r) => [r.code, r.name]));
}

export async function listParticipants(db) {
  const { results } = await db.prepare(`
    SELECT p.code, p.name, p.class_seat, p.summary, p.email,
      (SELECT COUNT(*) FROM runs r WHERE r.participant_code = p.code AND r.session = '前測'
         AND r.finished_at IS NOT NULL) AS pre_done,
      (SELECT COUNT(*) FROM runs r WHERE r.participant_code = p.code AND r.session = '後測'
         AND r.finished_at IS NOT NULL) AS post_done,
      (SELECT COUNT(*) FROM runs r WHERE r.participant_code = p.code) AS run_count
    FROM participants p ORDER BY p.code`).all();
  return results;
}

export async function findParticipant(db, code) {
  return db.prepare("SELECT code, name, name_key, class_seat, summary, email FROM participants WHERE code = ?")
    .bind(code).first();
}

export async function participantCodeByNameKey(db, nameKey) {
  const row = await db.prepare("SELECT code FROM participants WHERE name_key = ?").bind(nameKey).first();
  return row ? row.code : null;
}

export async function allParticipantKeys(db) {
  const { results } = await db.prepare("SELECT code, name_key FROM participants").all();
  return results;
}

export function insertParticipantStmt(db, p, now) {
  return db.prepare("INSERT INTO participants (code, name, name_key, class_seat, summary, email, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(p.code, p.name, p.name_key, p.class_seat, p.summary, p.email, now, now);
}

export function updateParticipantStmt(db, p, now) {
  return db.prepare("UPDATE participants SET name = ?, name_key = ?, class_seat = ?, summary = ?, email = ?, " +
    "updated_at = ? WHERE code = ?")
    .bind(p.name, p.name_key, p.class_seat, p.summary, p.email, now, p.code);
}

export function deleteParticipantIfNoRuns(db, code) {
  return db.prepare("DELETE FROM participants WHERE code = ? AND NOT EXISTS " +
    "(SELECT 1 FROM runs WHERE participant_code = ?)").bind(code, code).run();
}

export async function isSessionRevoked(db, sig) {
  return (await db.prepare("SELECT 1 AS ok FROM revoked_sessions WHERE sig = ?").bind(sig).first()) !== null;
}

export function revokeSession(db, sig, expiresAt, now) {
  return db.batch([
    db.prepare("INSERT OR IGNORE INTO revoked_sessions (sig, expires_at) VALUES (?, ?)").bind(sig, expiresAt),
    db.prepare("DELETE FROM revoked_sessions WHERE expires_at < ?").bind(now),
  ]);
}

export async function isLoginLocked(db, ip, now) {
  const row = await db.prepare("SELECT locked_until FROM admin_login_failures WHERE ip = ?").bind(ip).first();
  return Boolean(row) && row.locked_until > now;
}

export async function recordLoginFailure(db, ip, now, maxFailures, lockMs) {
  const row = await db.prepare("SELECT failures FROM admin_login_failures WHERE ip = ?").bind(ip).first();
  const failures = (row ? row.failures : 0) + 1;
  const locked = failures >= maxFailures;
  await db.prepare("INSERT INTO admin_login_failures (ip, failures, locked_until) VALUES (?, ?, ?) " +
    "ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until")
    .bind(ip, locked ? 0 : failures, locked ? now + lockMs : 0).run();
}

export function clearLoginFailures(db, ip) {
  return db.prepare("DELETE FROM admin_login_failures WHERE ip = ?").bind(ip).run();
}
