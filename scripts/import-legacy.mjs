import fs from "node:fs";
import path from "node:path";
import {
  isoFromRunId, isoTaipei, normAnswer, parseCsv, parseParticipantsCsv, RESULT_FIELDS, SESSIONS,
} from "../src/logic.js";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const answerKeyOnly = args.includes("--answer-key-only");
const srcArg = args.find((a, i) => !a.startsWith("--") && i !== outIdx + 1);
const dir = path.resolve(srcArg ?? "..");
const fail = (msg) => {
  console.error(`[錯誤] ${msg}`);
  process.exit(1);
};

const readOptional = (rel) => {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
};

function rowsOf(text) {
  const [header, ...body] = parseCsv(text);
  return body.filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

function lit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`非有限數字：${v}`);
    return String(v);
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

const now = isoTaipei();
const out = ["-- 由 scripts/import-legacy.mjs 產生（含個資，匯入後請刪除此檔）", `-- 來源：${dir}`];

const keyText = readOptional("answer_key.csv");
if (keyText === null) fail("找不到 answer_key.csv");
const keyRows = rowsOf(keyText);
const keyStmts = keyRows.map((r) => {
  const answer = normAnswer(r.answer);
  if (!answer) fail(`answer_key.csv：${r.filename} 的答案必須是 左 或 右（目前：「${r.answer}」）`);
  if (!fs.existsSync(path.join(dir, "images", r.filename))) {
    console.error(`[警告] images 資料夾找不到 ${r.filename}（題庫仍會匯入，但此圖無法顯示）`);
  }
  return `INSERT INTO answer_key (filename, trial_id, answer) VALUES (${lit(r.filename)}, ${lit(r.trial_id)}, ${lit(answer)});`;
});
out.push("", "-- 題庫", "DELETE FROM answer_key;", ...keyStmts);
const answerKey = new Map(keyRows.map((r) => [r.filename, { trial_id: r.trial_id, answer: normAnswer(r.answer) }]));

const skipParticipants = answerKeyOnly || args.includes("--no-participants");
let items = [], skipped = 0;
if (!skipParticipants) {
  const partText = readOptional("participants.csv");
  if (partText === null) fail("找不到 participants.csv");
  const parsed = parseParticipantsCsv(partText);
  if (parsed.errors.length) fail(`participants.csv 有問題：\n${parsed.errors.join("\n")}`);
  ({ items, skipped } = parsed);
  out.push("", "-- 受試者（以編碼為準，已存在則更新）");
  for (const p of items) {
    out.push(`INSERT INTO participants (code, name, name_key, class_seat, summary, email, created_at, updated_at) ` +
      `VALUES (${lit(p.code)}, ${lit(p.name)}, ${lit(p.name_key)}, ${lit(p.class_seat)}, ${lit(p.summary)}, ` +
      `${lit(p.email)}, ${lit(now)}, ${lit(now)}) ON CONFLICT(code) DO UPDATE SET name = excluded.name, ` +
      `name_key = excluded.name_key, class_seat = excluded.class_seat, summary = excluded.summary, ` +
      `email = excluded.email, updated_at = excluded.updated_at;`);
  }
}

const seqText = answerKeyOnly ? null : readOptional("sequences.json");
if (seqText !== null) {
  const seq = JSON.parse(seqText);
  out.push("", "-- 題目序列");
  for (const [code, files] of Object.entries(seq)) {
    const unknown = files.filter((fn) => !answerKey.has(fn));
    if (unknown.length) console.error(`[警告] ${code} 的序列含有不在題庫的圖片：${unknown.join("、")}`);
    out.push(`INSERT INTO sequences (code, filenames, created_at) VALUES (${lit(code)}, ${lit(JSON.stringify(files))}, ${lit(now)}) ` +
      `ON CONFLICT(code) DO UPDATE SET filenames = excluded.filenames;`);
  }
}

const runs = new Map();
const keyOf = (r) => `${r.run_id}\u0001${r.participant_code}`;
const finishedKeys = new Set();
const allText = answerKeyOnly ? null : readOptional("all_results.csv");
if (allText !== null) {
  for (const r of rowsOf(allText)) {
    const k = keyOf(r);
    finishedKeys.add(k);
    if (!runs.has(k)) runs.set(k, { run_id: r.run_id, code: r.participant_code, session: r.session, finished: true, trials: new Map() });
    runs.get(k).trials.set(Number(r.presentation_order), r);
  }
}
const resultsDir = path.join(dir, "results");
if (!answerKeyOnly && fs.existsSync(resultsDir)) {
  for (const f of fs.readdirSync(resultsDir).filter((n) => n.toLowerCase().endsWith(".csv")).sort()) {
    for (const r of rowsOf(fs.readFileSync(path.join(resultsDir, f), "utf8"))) {
      const k = keyOf(r);
      if (finishedKeys.has(k)) continue;
      if (!runs.has(k)) runs.set(k, { run_id: r.run_id, code: r.participant_code, session: r.session, finished: false, trials: new Map() });
      runs.get(k).trials.set(Number(r.presentation_order), r);
    }
  }
}

out.push("", "-- 施測紀錄與逐題資料");
let trialCount = 0;
for (const run of runs.values()) {
  if (!SESSIONS.includes(run.session)) fail(`施測 ${run.run_id} 的階段不正確：${run.session}`);
  const startedAt = isoFromRunId(run.run_id);
  if (!startedAt) fail(`無法解析施測編號：${run.run_id}`);
  out.push(`INSERT INTO runs (run_id, participant_code, session, started_at, finished_at) VALUES ` +
    `(${lit(run.run_id)}, ${lit(run.code)}, ${lit(run.session)}, ${lit(startedAt)}, ${run.finished ? lit(startedAt) : "NULL"}) ` +
    `ON CONFLICT(run_id, participant_code) DO UPDATE SET session = excluded.session, ` +
    `started_at = excluded.started_at, finished_at = excluded.finished_at;`);
  for (const [order, r] of [...run.trials.entries()].sort((a, b) => a[0] - b[0])) {
    const answer = normAnswer(r.correct_answer);
    const response = normAnswer(r.response);
    if (!answer) fail(`施測 ${run.run_id} 第 ${order} 題的標準答案不正確：「${r.correct_answer}」`);
    const isCorrect = response === answer ? 1 : 0;
    if (Number(r.is_correct) !== isCorrect) {
      console.error(`[警告] ${run.run_id} 第 ${order} 題：is_correct 與作答不一致（以作答重新計算）`);
    }
    const rt = Math.round(Number(r.rt_ms) * 10) / 10;
    out.push(`INSERT INTO trials (${RESULT_FIELDS.join(", ")}) VALUES ` +
      `(${lit(run.run_id)}, ${lit(run.code)}, ${lit(run.session)}, ${lit(order)}, ${lit(r.trial_id)}, ${lit(r.image)}, ` +
      `${lit(answer)}, ${lit(response)}, ${lit(isCorrect)}, ${lit(rt)}, ${lit(Math.trunc(Number(r.isi_ms)))}) ` +
      `ON CONFLICT(run_id, participant_code, presentation_order) DO UPDATE SET session = excluded.session, ` +
      `trial_id = excluded.trial_id, image = excluded.image, correct_answer = excluded.correct_answer, ` +
      `response = excluded.response, is_correct = excluded.is_correct, rt_ms = excluded.rt_ms, isi_ms = excluded.isi_ms;`);
    trialCount++;
  }
}

const sql = out.join("\n") + "\n";
if (outFile) {
  fs.writeFileSync(outFile, sql, "utf8");
  if (answerKeyOnly) {
    console.error(`已產生 ${outFile}：只含題庫 ${keyRows.length} 張（未含名單、序列與施測紀錄）`);
  } else {
    const people = skipParticipants ? "未匯入（--no-participants）" : `${items.length} 人（略過 ${skipped} 列空白）`;
    console.error(`已產生 ${outFile}：受試者 ${people}、題庫 ${keyRows.length} 張、` +
      `施測 ${runs.size} 次（完成 ${[...runs.values()].filter((r) => r.finished).length}）、逐題 ${trialCount} 筆`);
  }
} else {
  process.stdout.write(sql);
}
