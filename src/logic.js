export const N_TRIALS = 25;
export const ISI_MIN_MS = 1000;
export const ISI_MAX_MS = 3000;
export const MAX_SAME_ANSWER_RUN = 3;
export const SESSIONS = ["前測", "後測"];

export const RESULT_FIELDS = ["run_id", "participant_code", "session", "presentation_order",
  "trial_id", "image", "correct_answer", "response", "is_correct", "rt_ms", "isi_ms"];
export const COMPARISON_HEADER = ["受試者編碼", "前測正確率%", "後測正確率%", "正確率差",
  "前測RT(全部)", "後測RT(全部)", "RT差(全部)", "前測RT(答對)", "後測RT(答對)", "RT差(答對)"];

export class ValidationError extends Error {}

export function normAnswer(v) {
  const a = String(v ?? "").trim().toLowerCase();
  if (a === "左" || a === "l" || a === "left") return "左";
  if (a === "右" || a === "r" || a === "right") return "右";
  return "";
}

export function normName(v) {
  return String(v ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const strip = (s) => s.trim().replace(/^W\//, "");
  const target = strip(etag);
  return ifNoneMatch.split(",").some((v) => strip(v) === target);
}

export function randomInt(n) {
  const range = 0x100000000;
  const limit = range - (range % n);
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % n;
}

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function choice(a) {
  return a[randomInt(a.length)];
}

export function maxRun(xs) {
  let best = 0, run = 0, prev;
  for (const x of xs) {
    run = x === prev ? run + 1 : 1;
    prev = x;
    best = Math.max(best, run);
  }
  return best;
}

export function drawSequence(items) {
  const groups = { 左: [], 右: [] };
  for (const t of items) groups[t.answer].push(t);
  if (!groups.左.length || !groups.右.length) {
    throw new Error("要讓左右題數平衡，題庫必須同時有答案為「左」和「右」的圖片。");
  }
  const nLeft = Math.floor(N_TRIALS / 2) + (N_TRIALS % 2 === 1 && randomInt(2) === 0 ? 1 : 0);
  const answers = [...Array(nLeft).fill("左"), ...Array(N_TRIALS - nLeft).fill("右")];
  for (let i = 0; i < 2000; i++) {
    shuffle(answers);
    if (maxRun(answers) <= MAX_SAME_ANSWER_RUN) break;
  }
  const seq = [];
  for (const a of answers) {
    let choices = groups[a];
    const prev = seq[seq.length - 1];
    if (prev && choices.length > 1) choices = choices.filter(t => t.filename !== prev.filename);
    const t = choice(choices);
    seq.push({ trial_id: t.trial_id, filename: t.filename });
  }
  return seq;
}

export function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const slotKey = (code, session) => `${code}\u0001${session}`;

export function computeComparison(rows) {
  const latest = new Map();
  for (const r of rows) {
    const k = slotKey(r.participant_code, r.session);
    if (!latest.has(k) || r.run_id > latest.get(k)) latest.set(k, r.run_id);
  }
  const data = new Map();
  for (const r of rows) {
    const k = slotKey(r.participant_code, r.session);
    if (r.run_id !== latest.get(k)) continue;
    if (!data.has(k)) data.set(k, []);
    data.get(k).push(r);
  }
  const stats = (rs) => {
    const acc = mean(rs.map(r => Number(r.is_correct))) * 100;
    const rtAll = mean(rs.map(r => Number(r.rt_ms)));
    const correct = rs.filter(r => Number(r.is_correct) === 1).map(r => Number(r.rt_ms));
    return [acc, rtAll, correct.length ? mean(correct) : NaN];
  };
  const codes = [...new Set(rows.map(r => r.participant_code))].sort();
  const out = [], unpaired = [];
  for (const code of codes) {
    const pre = data.get(slotKey(code, "前測")), post = data.get(slotKey(code, "後測"));
    if (!pre || !post) {
      unpaired.push(code);
      continue;
    }
    const [a1, r1, c1] = stats(pre);
    const [a2, r2, c2] = stats(post);
    out.push([code, a1, a2, a2 - a1, r1, r2, r2 - r1, c1, c2, c2 - c1]);
  }
  const average = out.length
    ? out[0].slice(1).map((_, i) => mean(out.map(r => r[i + 1])))
    : null;
  return { rows: out, average, unpaired };
}

export function makeRecord(meta, r, key) {
  if (!r || typeof r !== "object") throw new ValidationError("bad record");
  const k = key.get(r.image);
  if (!k) throw new ValidationError("unknown image");
  const order = Number(r.order ?? 0);
  const rt = Number(r.rt_ms ?? 0);
  const isi = Number(r.isi_ms ?? 0);
  if (!Number.isInteger(order) || !Number.isFinite(rt) || !Number.isFinite(isi)) {
    throw new ValidationError("bad record");
  }
  const response = normAnswer(r.response);
  return {
    run_id: meta.run_id,
    participant_code: meta.code,
    session: meta.session,
    presentation_order: order,
    trial_id: k.trial_id,
    image: r.image,
    correct_answer: k.answer,
    response,
    is_correct: response === k.answer ? 1 : 0,
    rt_ms: Math.round(rt * 10) / 10,
    isi_ms: Math.trunc(isi),
  };
}

const TAIPEI_MS = 8 * 60 * 60 * 1000;
const pad = (n, w = 2) => String(n).padStart(w, "0");
const taipei = (date) => new Date(date.getTime() + TAIPEI_MS);

export function newRunId(date = new Date()) {
  const t = taipei(date);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}_` +
    `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}_${pad(date.getUTCMilliseconds(), 3)}`;
}

export function isoTaipei(date = new Date()) {
  const t = taipei(date);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+08:00`;
}

export function isoFromRunId(runId) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(runId);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00` : null;
}

export function toCsv(header, rows) {
  const line = (cells) => cells.map(csvCell).join(",");
  return "﻿" + [header, ...rows].map(line).join("\r\n") + "\r\n";
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function fmtCsvNum(v) {
  if (Number.isNaN(v)) return "nan";
  const s = String(Number(v.toFixed(2)));
  return /[.e]/.test(s) ? s : `${s}.0`;
}

export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export const CODE_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export function cleanParticipant(p) {
  const value = {
    code: String(p.code ?? "").trim(),
    name: String(p.name ?? "").trim(),
    class_seat: String(p.class_seat ?? "").trim(),
    summary: String(p.summary ?? "").trim(),
    email: String(p.email ?? "").trim(),
  };
  const errors = [];
  if (!CODE_PATTERN.test(value.code)) errors.push("編碼只能使用英文字母、數字、底線或連字號（1～40 字）");
  if (!value.name || value.name.length > 50) errors.push("姓名必填，且不超過 50 字");
  if (value.class_seat.length > 50) errors.push("班級座號不超過 50 字");
  if (value.summary.length > 100) errors.push("研究摘要不超過 100 字");
  if (value.email && (value.email.length > 200 || !/^[^\s@]+@[^\s@]+$/.test(value.email))) {
    errors.push("電子郵件格式不正確");
  }
  return { value: { ...value, name_key: normName(value.name) }, errors };
}

export function parseParticipantsCsv(text) {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map(h => h.trim());
  const col = (...names) => header.findIndex(h => names.includes(h));
  const iName = col("name", "姓名"), iCode = col("code", "編碼");
  if (iName < 0 || iCode < 0) {
    return { items: [], skipped: 0, errors: ["第一列必須包含 name（或 姓名）與 code（或 編碼）欄位"] };
  }
  const iSeat = col("班級座號"), iSummary = col("研究摘要"), iEmail = col("電子郵件", "email");
  const items = [], errors = [], seenCode = new Map(), seenName = new Map();
  let skipped = 0;
  table.slice(1).forEach((row, i) => {
    const line = i + 2;
    const cell = (idx) => (idx >= 0 ? String(row[idx] ?? "").trim() : "");
    const name = cell(iName), code = cell(iCode);
    if (!name || !code) {
      if (row.some(c => c.trim())) skipped++;
      return;
    }
    const { value, errors: rowErrors } = cleanParticipant({
      code, name, class_seat: cell(iSeat), summary: cell(iSummary), email: cell(iEmail),
    });
    if (rowErrors.length) {
      errors.push(`第 ${line} 列：${rowErrors.join("；")}`);
      return;
    }
    if (seenCode.has(value.code)) errors.push(`第 ${line} 列：編碼重複（${value.code}）`);
    if (seenName.has(value.name_key)) errors.push(`第 ${line} 列：姓名重複（${name}）`);
    seenCode.set(value.code, line);
    seenName.set(value.name_key, line);
    items.push(value);
  });
  if (!items.length && !errors.length) errors.push("沒有可匯入的資料（每列需要姓名與編碼）");
  return { items, skipped, errors };
}
