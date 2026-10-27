import PARTICIPANT_PAGE from "./pages/participant.html";
import ADMIN_PAGE from "./pages/admin.html";
import * as auth from "./auth.js";
import * as db from "./db.js";
import {
  COMPARISON_HEADER, ISI_MAX_MS, ISI_MIN_MS, N_TRIALS, RESULT_FIELDS, SESSIONS, ValidationError,
  cleanParticipant, computeComparison, drawSequence, etagMatches, fmtCsvNum, isoTaipei, makeRecord, mean,
  newRunId, normName, parseParticipantsCsv, toCsv,
} from "./logic.js";

const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_IMPORT_CHARS = 512 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };
const IMAGE_TYPES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp",
};
const ADMIN_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE, ...headers },
  });
}

function htmlResponse(body, headers = {}) {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE, ...headers },
  });
}

function csvResponse(body, filename) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      ...NO_STORE,
    },
  });
}

function notFound() {
  return new Response("not found", { status: 404 });
}

async function readJson(request) {
  let data;
  try {
    data = await request.json();
  } catch {
    throw new HttpError(400, "請求格式錯誤");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "請求格式錯誤");
  return data;
}

function decodePath(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "網址格式錯誤");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err instanceof ValidationError) return json({ error: "資料格式錯誤" }, 400);
      if (String(err?.message).includes("UNIQUE constraint")) {
        return json({ error: "姓名或編碼與既有資料重複" }, 409);
      }
      console.error("[錯誤]", err);
      return json({ error: "伺服器發生錯誤" }, 500);
    }
  },
};

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/" && method === "GET") return htmlResponse(PARTICIPANT_PAGE);
  if (pathname.startsWith("/images/") && method === "GET") {
    return serveImage(request, env, pathname.slice("/images/".length));
  }
  if (pathname === "/api/login" && method === "POST") return login(request, env);
  if (pathname === "/api/trials" && method === "GET") return trials(env, url);
  if (pathname === "/api/trial" && method === "POST") return saveTrial(request, env);
  if (pathname === "/api/finish" && method === "POST") return finishRun(request, env);

  if (pathname === "/report") return Response.redirect(new URL("/admin", url), 302);
  if (pathname === "/admin" || pathname === "/admin/") return htmlResponse(ADMIN_PAGE, ADMIN_HEADERS);
  if (pathname.startsWith("/admin/")) return adminApi(request, env, url);

  return notFound();
}

async function serveImage(request, env, rawName) {
  const name = decodePath(rawName);
  const key = await db.cachedAnswerKey(env.DB);
  if (!key.has(name)) return notFound();
  const obj = await env.IMAGES.get(name);
  if (!obj) return notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Content-Type", IMAGE_TYPES[extOf(name)] ?? "application/octet-stream");
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "max-age=3600");
  if (etagMatches(request.headers.get("If-None-Match"), obj.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(obj.body, { headers });
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

async function login(request, env) {
  const body = await readJson(request);
  const code = await db.participantCodeByNameKey(env.DB, normName(body.name));
  if (!code) return json({ error: "not found" }, 404);
  return json({ code });
}

async function sequenceFor(env, code) {
  const key = await db.cachedAnswerKey(env.DB);
  let files = await db.storedSequence(env.DB, code);
  if (!isValidSequence(files, key)) {
    const pool = [...key].map(([filename, v]) => ({ filename, ...v }));
    const fresh = drawSequence(pool).map((t) => t.filename);
    if (files === null) {
      await db.insertSequenceIfAbsentStmt(env.DB, code, fresh).run();
      files = await db.storedSequence(env.DB, code);
    } else {
      console.warn(`[警告] ${code} 先前儲存的題目序列與目前題庫/題數不符，已重新抽題`);
      await db.replaceSequenceStmt(env.DB, code, fresh).run();
      files = fresh;
    }
    if (!isValidSequence(files, key)) throw new Error("題目序列異常");
  }
  return files.map((fn) => ({ trial_id: key.get(fn).trial_id, filename: fn }));
}

function isValidSequence(files, key) {
  return Array.isArray(files) && files.length === N_TRIALS && files.every((fn) => key.has(fn));
}

async function trials(env, url) {
  const code = url.searchParams.get("code") ?? "";
  if (!(await db.participantExists(env.DB, code))) return json({ error: "bad code" }, 400);
  return json({
    run_id: newRunId(),
    trials: await sequenceFor(env, code),
    config: { isi_min: ISI_MIN_MS, isi_max: ISI_MAX_MS },
  });
}

async function validateMeta(env, body) {
  const meta = {
    code: String(body.code ?? ""),
    session: body.session,
    run_id: String(body.run_id ?? ""),
  };
  if (!SESSIONS.includes(meta.session) || !/^[0-9_]+$/.test(meta.run_id)) throw new HttpError(400, "bad meta");
  if (!(await db.participantExists(env.DB, meta.code))) throw new HttpError(400, "bad meta");
  return meta;
}

async function saveTrial(request, env) {
  const body = await readJson(request);
  const [meta, key] = await Promise.all([validateMeta(env, body), db.cachedAnswerKey(env.DB)]);
  const rec = makeRecord(meta, body.rec, key);
  await env.DB.batch([db.startRunStmt(env.DB, meta), db.upsertTrialStmt(env.DB, rec)]);
  return json({});
}

async function finishRun(request, env) {
  const body = await readJson(request);
  const [meta, key] = await Promise.all([validateMeta(env, body), db.cachedAnswerKey(env.DB)]);
  if (!Array.isArray(body.records)) throw new HttpError(400, "bad records");
  const recs = body.records.map((r) => makeRecord(meta, r, key))
    .sort((a, b) => a.presentation_order - b.presentation_order);
  if (recs.length !== N_TRIALS) throw new HttpError(400, "題數不符");
  if (new Set(recs.map((r) => r.presentation_order)).size !== recs.length) throw new HttpError(400, "題序重複");

  const finishedAt = isoTaipei();
  await env.DB.batch([
    db.finishRunStmt(env.DB, meta, finishedAt),
    db.deleteRunTrialsStmt(env.DB, meta),
    ...recs.map((rec) => db.upsertTrialStmt(env.DB, rec)),
  ]);
  const acc = Number((mean(recs.map((r) => r.is_correct)) * 100).toFixed(1));
  const rt = Math.round(mean(recs.map((r) => r.rt_ms)));
  console.log(`[完成] ${meta.code}（${meta.session}）正確率 ${acc}%  平均RT ${rt} ms`);
  return json({ acc, rt });
}

async function adminApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  if (method !== "GET" && request.headers.get("Origin") !== url.origin) {
    throw new HttpError(403, "來源不被允許");
  }

  if (pathname === "/admin/api/login" && method === "POST") return adminLogin(request, env);
  if (pathname === "/admin/api/logout" && method === "POST") {
    const session = await auth.verifySession(env, auth.readCookie(request, auth.COOKIE));
    if (session) await db.revokeSession(env.DB, session.sig, session.exp, Date.now());
    return json({ ok: true }, 200, { "Set-Cookie": auth.clearedCookie() });
  }

  await requireAdmin(request, env);

  if (pathname === "/admin/api/me" && method === "GET") return json({ ok: true });
  if (pathname === "/admin/api/results" && method === "GET") return adminResults(env);
  if (pathname === "/admin/api/participants" && method === "GET") {
    return json({ participants: await db.listParticipants(env.DB) });
  }
  if (pathname === "/admin/api/participants" && method === "POST") return createParticipant(request, env);
  if (pathname === "/admin/api/participants/import" && method === "POST") return importParticipants(request, env);
  if (pathname === "/admin/export/all.csv" && method === "GET") return exportAll(env);
  if (pathname === "/admin/export/comparison.csv" && method === "GET") return exportComparison(env);
  if (pathname === "/admin/export/run.csv" && method === "GET") return exportRun(env, url);

  const run = /^\/admin\/api\/runs\/([0-9_]+)\/([^/]+)$/.exec(pathname);
  if (run && method === "GET") return adminRun(env, run[1], decodePath(run[2]));

  const one = /^\/admin\/api\/participants\/([^/]+)$/.exec(pathname);
  if (one && method === "PUT") return updateParticipant(request, env, decodePath(one[1]));
  if (one && method === "DELETE") return deleteParticipant(env, decodePath(one[1]));

  return json({ error: "not found" }, 404);
}

async function adminLogin(request, env) {
  const configProblem = auth.configError(env);
  if (configProblem) throw adminUnavailable(configProblem);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const now = Date.now();
  if (await db.isLoginLocked(env.DB, ip, now)) throw new HttpError(429, "嘗試次數過多，請 15 分鐘後再試");

  const body = await readJson(request);
  if (!(await auth.checkPassword(env, body.password))) {
    await db.recordLoginFailure(env.DB, ip, now, MAX_LOGIN_FAILURES, LOGIN_LOCK_MS);
    throw new HttpError(401, "密碼錯誤");
  }
  await db.clearLoginFailures(env.DB, ip);
  const token = await auth.makeSession(env, now);
  return json({ ok: true }, 200, { "Set-Cookie": auth.sessionCookie(token) });
}

async function requireAdmin(request, env) {
  const configProblem = auth.configError(env);
  if (configProblem) throw adminUnavailable(configProblem);
  const session = await auth.verifySession(env, auth.readCookie(request, auth.COOKIE));
  if (!session || await db.isSessionRevoked(env.DB, session.sig)) throw new HttpError(401, "請先登入");
}

function adminUnavailable(problem) {
  console.error("[後台設定]", problem);
  return new HttpError(503, "後台暫時無法使用，請聯絡管理者");
}

async function adminResults(env) {
  const [rows, names, runs] = await Promise.all([
    db.finishedTrials(env.DB), db.participantNames(env.DB), db.runSummaries(env.DB),
  ]);
  const cmp = computeComparison(rows);
  return json({
    comparison: {
      rows: cmp.rows.map((r) => ({ code: r[0], name: names.get(r[0]) ?? "", values: r.slice(1) })),
      average: cmp.average,
      unpaired: cmp.unpaired.map((code) => ({ code, name: names.get(code) ?? "" })),
    },
    runs,
  });
}

async function adminRun(env, runId, code) {
  const run = await db.runInfo(env.DB, runId, code);
  if (!run) throw new HttpError(404, "找不到此施測");
  return json({ run, trials: await db.runTrials(env.DB, runId, code) });
}

function participantInput(body) {
  const { value, errors } = cleanParticipant(body);
  if (errors.length) throw new HttpError(400, errors.join("；"));
  return value;
}

async function createParticipant(request, env) {
  const p = participantInput(await readJson(request));
  if (await db.findParticipant(env.DB, p.code)) throw new HttpError(409, `編碼 ${p.code} 已存在`);
  const owner = await db.participantCodeByNameKey(env.DB, p.name_key);
  if (owner) throw new HttpError(409, `姓名「${p.name}」已被編碼 ${owner} 使用`);
  await db.insertParticipantStmt(env.DB, p, isoTaipei()).run();
  return json({ ok: true, participant: p }, 201);
}

async function updateParticipant(request, env, code) {
  const existing = await db.findParticipant(env.DB, code);
  if (!existing) throw new HttpError(404, "找不到此受試者");
  const body = await readJson(request);
  const p = participantInput({ ...body, code });
  if (p.name_key !== existing.name_key) {
    const owner = await db.participantCodeByNameKey(env.DB, p.name_key);
    if (owner && owner !== code) throw new HttpError(409, `姓名「${p.name}」已被編碼 ${owner} 使用`);
  }
  await db.updateParticipantStmt(env.DB, p, isoTaipei()).run();
  return json({ ok: true });
}

async function deleteParticipant(env, code) {
  const result = await db.deleteParticipantIfNoRuns(env.DB, code);
  if (result.meta.changes > 0) return json({ ok: true });
  if (!(await db.findParticipant(env.DB, code))) throw new HttpError(404, "找不到此受試者");
  throw new HttpError(409, "此受試者已有施測紀錄，無法刪除");
}

async function importParticipants(request, env) {
  const text = await request.text();
  if (text.length > MAX_IMPORT_CHARS) throw new HttpError(413, "檔案太大");
  const { items, skipped, errors } = parseParticipantsCsv(text);
  if (errors.length) throw new HttpError(400, errors.join("\n"));

  const existing = await db.allParticipantKeys(env.DB);
  const codeToKey = new Map(existing.map((r) => [r.code, r.name_key]));
  const keyToCode = new Map(existing.map((r) => [r.name_key, r.code]));
  const conflicts = items
    .filter((p) => keyToCode.has(p.name_key) && keyToCode.get(p.name_key) !== p.code)
    .map((p) => `姓名「${p.name}」已被編碼 ${keyToCode.get(p.name_key)} 使用`);
  if (conflicts.length) throw new HttpError(409, conflicts.join("\n"));

  const now = isoTaipei();
  const stmts = items.map((p) => (codeToKey.has(p.code)
    ? db.updateParticipantStmt(env.DB, p, now)
    : db.insertParticipantStmt(env.DB, p, now)));
  if (stmts.length) await env.DB.batch(stmts);
  const updated = items.filter((p) => codeToKey.has(p.code)).length;
  return json({ ok: true, added: items.length - updated, updated, skipped });
}

function resultRow(r) {
  return [r.run_id, r.participant_code, r.session, r.presentation_order, r.trial_id, r.image,
    r.correct_answer, r.response, r.is_correct, Number(r.rt_ms).toFixed(1), r.isi_ms];
}

async function exportAll(env) {
  const rows = await db.finishedTrials(env.DB);
  return csvResponse(toCsv(RESULT_FIELDS, rows.map(resultRow)), "all_results.csv");
}

async function exportComparison(env) {
  const cmp = computeComparison(await db.finishedTrials(env.DB));
  const rows = cmp.rows.map((r) => [r[0], ...r.slice(1).map(fmtCsvNum)]);
  if (cmp.average) rows.push(["平均", ...cmp.average.map(fmtCsvNum)]);
  return csvResponse(toCsv(COMPARISON_HEADER, rows), "comparison.csv");
}

async function exportRun(env, url) {
  const runId = url.searchParams.get("run_id") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!/^[0-9_]+$/.test(runId)) throw new HttpError(400, "bad run_id");
  const info = await db.runInfo(env.DB, runId, code);
  if (!info) throw new HttpError(404, "找不到此施測");
  const rows = await db.runTrials(env.DB, runId, code);
  return csvResponse(toCsv(RESULT_FIELDS, rows.map(resultRow)), `${code}_${info.session}_${runId}.csv`);
}
