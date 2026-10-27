import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { parseCsv } from "../src/logic.js";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "test-admin-password-123";
const LEGACY = path.resolve(process.env.LEGACY_DIR ?? "..");

const rowsOf = (text) => {
  const [header, ...body] = parseCsv(text);
  return body.filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
};
const readLegacy = (name) => fs.readFileSync(path.join(LEGACY, name), "utf8");

const answerKey = new Map(rowsOf(readLegacy("answer_key.csv"))
  .map((r) => [r.filename, { trial_id: r.trial_id, answer: r.answer }]));
const legacySeq = JSON.parse(readLegacy("sequences.json")).p054;
const legacyAll = rowsOf(readLegacy("all_results.csv"));
const roster = new Map(rowsOf(readLegacy("participants.csv")).map((r) => [r.code, r]));
const NAME_P001 = roster.get("P001").name;
const NAME_P001_SPACED = NAME_P001.slice(0, 1) + "　" + NAME_P001.slice(1);
const CLASS_P001 = roster.get("P001")["班級座號"];
const NAME_P054 = roster.get("p054").name;

let failures = 0;
const log = [];
async function check(name, fn) {
  try {
    await fn();
    log.push(`PASS  ${name}`);
  } catch (e) {
    failures++;
    log.push(`FAIL  ${name}\n      ${String(e.message).split("\n").join("\n      ")}`);
  }
}

async function call(method, p, { body, text, cookie, origin, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (origin === undefined) {
    if (p.startsWith("/admin/") && method !== "GET") h.Origin = new URL(BASE).origin;
  } else if (origin !== null) {
    h.Origin = origin;
  }
  let payload;
  if (text !== undefined) {
    payload = text;
    h["Content-Type"] ??= "text/csv; charset=utf-8";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h["Content-Type"] = "application/json";
  }
  return fetch(BASE + p, { method, headers: h, body: payload, redirect: "manual" });
}

async function simulateRun(code, session, answerFn) {
  const t = await (await call("GET", `/api/trials?code=${encodeURIComponent(code)}`)).json();
  const recs = t.trials.map((tr, i) => ({
    order: i + 1, image: tr.filename, response: answerFn(i, answerKey.get(tr.filename).answer),
    rt_ms: 800 + i * 10.25, isi_ms: 1500,
  }));
  for (const r of recs) {
    const res = await call("POST", "/api/trial", { body: { code, session, run_id: t.run_id, rec: r } });
    assert.equal(res.status, 200, `逐題送出失敗：${res.status}`);
  }
  const fin = await call("POST", "/api/finish", { body: { code, session, run_id: t.run_id, records: recs } });
  return { run_id: t.run_id, trials: t.trials, recs, res: fin, data: await fin.json() };
}

let adminCookie = "";
const mkCsv = (lines) => lines.join("\n") + "\n";

await check("首頁是受試者測驗頁（與原版相同）", async () => {
  const res = await call("GET", "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('id="s-start"') && html.includes("跆拳道踢擊方向判斷測驗"));
});

await check("舊網址 /report 導向後台", async () => {
  const res = await call("GET", "/report");
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get("location"), BASE).pathname, "/admin");
});

await check("登入：姓名正確 → 編碼", async () => {
  const res = await call("POST", "/api/login", { body: { name: NAME_P001 } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { code: "P001" });
});

await check("登入：全形空白、大小寫不影響比對", async () => {
  const res = await call("POST", "/api/login", { body: { name: " " + NAME_P001_SPACED + " " } });
  assert.equal((await res.json()).code, "P001");
});

await check("登入：找不到姓名 → 404", async () => {
  const res = await call("POST", "/api/login", { body: { name: "不存在的人" } });
  assert.equal(res.status, 404);
});

await check("題目：編碼不存在 → 400", async () => {
  const res = await call("GET", "/api/trials?code=NOPE");
  assert.equal(res.status, 400);
});

await check("題目：p054 沿用原本 sequences.json 的序列（前後測相同）", async () => {
  const t = await (await call("GET", "/api/trials?code=p054")).json();
  assert.deepEqual(t.trials.map((x) => x.filename), legacySeq);
  assert.deepEqual(t.config, { isi_min: 1000, isi_max: 3000 });
});

await check("題目：新受試者 25 題、題號對應題庫、相鄰不重複、run_id 格式正確", async () => {
  const t = await (await call("GET", "/api/trials?code=P001")).json();
  assert.equal(t.trials.length, 25);
  assert.match(t.run_id, /^\d{8}_\d{6}_\d{3}$/);
  t.trials.forEach((x, i) => {
    assert.equal(x.trial_id, answerKey.get(x.filename).trial_id);
    if (i > 0) assert.notEqual(x.filename, t.trials[i - 1].filename);
  });
});

await check("施測：P001 前測全部答對 → 完成並回傳正確率", async () => {
  const run = await simulateRun("P001", "前測", (_, correct) => correct);
  assert.equal(run.res.status, 200);
  assert.equal(run.data.acc, 100);
  assert.equal(typeof run.data.rt, "number");
});

await check("施測：題數不符 → 400（不寫入完成紀錄）", async () => {
  const t = await (await call("GET", "/api/trials?code=P001")).json();
  const recs = t.trials.slice(0, 24).map((tr, i) => ({ order: i + 1, image: tr.filename, response: "左", rt_ms: 1, isi_ms: 1 }));
  const res = await call("POST", "/api/finish", { body: { code: "P001", session: "後測", run_id: t.run_id, records: recs } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "題數不符");
});

await check("施測：題序重複 → 400", async () => {
  const t = await (await call("GET", "/api/trials?code=P001")).json();
  const recs = t.trials.map((tr, i) => ({ order: i === 24 ? 1 : i + 1, image: tr.filename, response: "左", rt_ms: 1, isi_ms: 1 }));
  const res = await call("POST", "/api/finish", { body: { code: "P001", session: "後測", run_id: t.run_id, records: recs } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "題序重複");
});

await check("逐題：不在題庫的圖片 → 400；階段或編碼錯誤 → 400", async () => {
  const bad = await call("POST", "/api/trial", { body: { code: "P001", session: "前測", run_id: "20260101_000000_000", rec: { order: 1, image: "x.jpg", response: "左", rt_ms: 1, isi_ms: 1 } } });
  assert.equal(bad.status, 400);
  const badSession = await call("POST", "/api/trial", { body: { code: "P001", session: "其他", run_id: "20260101_000000_000", rec: { order: 1, image: "IMG_0841.jpg", response: "左", rt_ms: 1, isi_ms: 1 } } });
  assert.equal(badSession.status, 400);
  const badCode = await call("POST", "/api/trial", { body: { code: "ZZZ", session: "前測", run_id: "20260101_000000_000", rec: { order: 1, image: "IMG_0841.jpg", response: "左", rt_ms: 1, isi_ms: 1 } } });
  assert.equal(badCode.status, 400);
});

await check("圖片：題庫內檔名可取得（Content-Type 與大小正確）", async () => {
  const res = await call("GET", "/images/IMG_0841.jpg");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  const size = fs.statSync(path.join(LEGACY, "images", "IMG_0841.jpg")).size;
  assert.equal((await res.arrayBuffer()).byteLength, size);
});

await check("圖片：If-None-Match 與 ETag 相同時回 304 且沒有內容", async () => {
  const first = await call("GET", "/images/IMG_0841.jpg");
  const etag = first.headers.get("etag");
  assert.ok(etag, "回應應帶 ETag");
  const again = await call("GET", "/images/IMG_0841.jpg", { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
  assert.equal((await again.arrayBuffer()).byteLength, 0);
  const other = await call("GET", "/images/IMG_0841.jpg", { headers: { "If-None-Match": '"not-the-etag"' } });
  assert.equal(other.status, 200);
});

await check("圖片：不在題庫的檔名、路徑跳脫 → 404；格式錯誤 → 400", async () => {
  assert.equal((await call("GET", "/images/nope.jpg")).status, 404);
  assert.equal((await call("GET", "/images/..%2Fwrangler.toml")).status, 404);
  assert.equal((await call("GET", "/images/%E0%A4%A.jpg")).status, 400);
});

await check("後台頁面有安全標頭（禁止嵌入、CSP）", async () => {
  const res = await call("GET", "/admin");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

await check("未登入：後台 API 與匯出都回 401", async () => {
  assert.equal((await call("GET", "/admin/api/results")).status, 401);
  assert.equal((await call("GET", "/admin/export/all.csv")).status, 401);
  assert.equal((await call("GET", "/admin/api/participants")).status, 401);
});

await check("登入：密碼錯誤 → 401", async () => {
  const res = await call("POST", "/admin/api/login", { body: { password: "wrong-password-xx" } });
  assert.equal(res.status, 401);
});

await check("登入：正確密碼 → 設定 HttpOnly/Secure/SameSite=Strict 的 cookie", async () => {
  const res = await call("POST", "/admin/api/login", { body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  const sc = res.headers.get("set-cookie");
  assert.match(sc, /^tt_admin=[0-9]+\.[0-9a-f]{64};/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Strict/);
  assert.match(sc, /Path=\/admin/);
  adminCookie = sc.split(";")[0];
  assert.equal((await call("GET", "/admin/api/me", { cookie: adminCookie })).status, 200);
});

await check("結果：p054 前後測比較與原版 Python 的數字一致", async () => {
  const data = await (await call("GET", "/admin/api/results", { cookie: adminCookie })).json();
  const row = data.comparison.rows.find((r) => r.code === "p054");
  assert.ok(row, "沒有 p054 的比較列");
  assert.equal(row.name, NAME_P054);
  const expected = [72.0, 64.0, -8.0, 7209.48, 3136.16, -4073.32, 6580.1, 3102.38, -3477.73];
  row.values.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 0.01, `第 ${i} 欄：${v} ≠ ${expected[i]}`));
  assert.ok(data.comparison.unpaired.some((u) => u.code === "P001"), "P001 只有前測，應列為未配對");
});

await check("結果：施測紀錄包含完成與未完成的施測", async () => {
  const data = await (await call("GET", "/admin/api/results", { cookie: adminCookie })).json();
  const p054Runs = data.runs.filter((r) => r.participant_code === "p054");
  assert.equal(p054Runs.length, 3);
  assert.equal(p054Runs.filter((r) => r.finished_at).length, 2);
  const unfinished = p054Runs.find((r) => !r.finished_at);
  assert.equal(unfinished.run_id, "20261020_125442");
});

await check("受試者列表：前後測完成次數正確", async () => {
  const data = await (await call("GET", "/admin/api/participants", { cookie: adminCookie })).json();
  const p054 = data.participants.find((p) => p.code === "p054");
  assert.deepEqual([p054.pre_done, p054.post_done, p054.run_count], [1, 1, 3]);
  const p001 = data.participants.find((p) => p.code === "P001");
  assert.deepEqual([p001.pre_done, p001.post_done, p001.run_count], [1, 0, 1]);
});

await check("匯出 all_results.csv：BOM、欄位、p054 的逐題資料與舊檔一致", async () => {
  const res = await call("GET", "/admin/export/all.csv", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /filename\*=UTF-8''all_results\.csv/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
  const rows = rowsOf(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes));
  const p054 = rows.filter((r) => r.participant_code === "p054");
  assert.equal(p054.length, legacyAll.length);
  const fields = Object.keys(legacyAll[0]);
  legacyAll.forEach((old, i) => {
    for (const f of fields) {
      if (f === "rt_ms") assert.equal(Number(p054[i][f]), Number(old[f]), `第 ${i + 1} 列 rt_ms`);
      else assert.equal(p054[i][f], old[f], `第 ${i + 1} 列 ${f}`);
    }
  });
  assert.equal(rows.filter((r) => r.participant_code === "P001").length, 25);
  assert.equal(rows.some((r) => r.participant_code === "p054" && r.run_id === "20261020_125442"), false, "未完成的施測不應匯出");
});

const EXPECTED_COMPARISON = [
  "受試者編碼,前測正確率%,後測正確率%,正確率差,前測RT(全部),後測RT(全部),RT差(全部),前測RT(答對),後測RT(答對),RT差(答對)",
  "p054,72.0,64.0,-8.0,7209.48,3136.16,-4073.32,6580.1,3102.38,-3477.73",
  "平均,72.0,64.0,-8.0,7209.48,3136.16,-4073.32,6580.1,3102.38,-3477.73",
];
await check("匯出 comparison.csv：與原版 Python 產生的檔案逐行相同", async () => {
  const text = await (await call("GET", "/admin/export/comparison.csv", { cookie: adminCookie })).text();
  const lines = text.replace(/^﻿/, "").split("\r\n").filter(Boolean);
  assert.deepEqual(lines, EXPECTED_COMPARISON);
});

await check("匯出單次施測 CSV（未完成的施測也可下載）", async () => {
  const res = await call("GET", "/admin/export/run.csv?run_id=20261020_125442&code=p054", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(rowsOf(await res.text()).length, 4);
});

await check("施測明細：可看到未完成的施測與逐題資料", async () => {
  const data = await (await call("GET", "/admin/api/runs/20261020_125442/p054", { cookie: adminCookie })).json();
  assert.equal(data.run.finished_at, null);
  assert.equal(data.trials.length, 4);
});

await check("編輯：新增受試者 → 201；重複編碼 → 409；重複姓名（全形空白） → 409；格式錯誤 → 400", async () => {
  const ok = await call("POST", "/admin/api/participants", { cookie: adminCookie, body: { code: "P900", name: "測試甲" } });
  assert.equal(ok.status, 201);
  assert.equal((await call("POST", "/admin/api/participants", { cookie: adminCookie, body: { code: "P900", name: "別人" } })).status, 409);
  assert.equal((await call("POST", "/admin/api/participants", { cookie: adminCookie, body: { code: "P901", name: "測試　甲" } })).status, 409);
  assert.equal((await call("POST", "/admin/api/participants", { cookie: adminCookie, body: { code: "bad code!", name: "x" } })).status, 400);
});

await check("編輯：修改資料 → 200；姓名與他人重複 → 409；不存在 → 404", async () => {
  const ok = await call("PUT", "/admin/api/participants/P900", { cookie: adminCookie, body: { name: "測試乙", class_seat: "1", summary: "紙本", email: "a@b.co" } });
  assert.equal(ok.status, 200);
  const dup = await call("PUT", "/admin/api/participants/P900", { cookie: adminCookie, body: { name: NAME_P001 } });
  assert.equal(dup.status, 409);
  assert.equal((await call("PUT", "/admin/api/participants/NOPE", { cookie: adminCookie, body: { name: "x" } })).status, 404);
  const list = await (await call("GET", "/admin/api/participants", { cookie: adminCookie })).json();
  const p = list.participants.find((x) => x.code === "P900");
  assert.deepEqual([p.name, p.class_seat, p.summary, p.email], ["測試乙", "1", "紙本", "a@b.co"]);
});

await check("編輯：有施測紀錄的受試者不能刪除；沒有紀錄的可以刪除", async () => {
  assert.equal((await call("DELETE", "/admin/api/participants/p054", { cookie: adminCookie })).status, 409);
  assert.equal((await call("DELETE", "/admin/api/participants/P900", { cookie: adminCookie })).status, 200);
  assert.equal((await call("DELETE", "/admin/api/participants/P900", { cookie: adminCookie })).status, 404);
});

await check("匯入：新增與更新（以編碼為準），不刪除任何人", async () => {
  const csv = mkCsv(["name,code,班級座號,研究摘要,電子郵件", "新人甲,P910,10099,電子郵件,x@y.com", "新人乙,P911,,,", `${NAME_P001},P001,${CLASS_P001},無,`]);
  const res = await call("POST", "/admin/api/participants/import", { cookie: adminCookie, text: csv });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, added: 2, updated: 1, skipped: 0 });
});

await check("匯入：編碼重複 → 400 且不寫入；姓名被他人使用 → 409 且不寫入", async () => {
  const dupCode = mkCsv(["name,code", "甲,P930", "乙,P930"]);
  const r1 = await call("POST", "/admin/api/participants/import", { cookie: adminCookie, text: dupCode });
  assert.equal(r1.status, 400);
  assert.match((await r1.json()).error, /編碼重複/);
  const conflict = mkCsv(["name,code", `${NAME_P001},P920`]);
  const r2 = await call("POST", "/admin/api/participants/import", { cookie: adminCookie, text: conflict });
  assert.equal(r2.status, 409);
  const list = await (await call("GET", "/admin/api/participants", { cookie: adminCookie })).json();
  assert.equal(list.participants.some((x) => x.code === "P920" || x.code === "P930"), false);
});

await check("匯入：缺少欄位 → 400", async () => {
  const res = await call("POST", "/admin/api/participants/import", { cookie: adminCookie, text: "foo,bar\n1,2\n" });
  assert.equal(res.status, 400);
});

await check("清理：刪除測試用的 P910、P911", async () => {
  assert.equal((await call("DELETE", "/admin/api/participants/P910", { cookie: adminCookie })).status, 200);
  assert.equal((await call("DELETE", "/admin/api/participants/P911", { cookie: adminCookie })).status, 200);
});

await check("安全：寫入請求的 Origin 是其他網站或沒有帶 Origin → 403", async () => {
  const cross = await call("POST", "/admin/api/participants", { cookie: adminCookie, origin: "https://evil.example", body: { code: "P999", name: "惡意" } });
  assert.equal(cross.status, 403);
  const none = await call("POST", "/admin/api/participants", { cookie: adminCookie, origin: null, body: { code: "P999", name: "惡意" } });
  assert.equal(none.status, 403);
  assert.equal((await call("GET", "/admin/api/participants", { cookie: adminCookie })).status, 200);
});

await check("登出：之後舊的 cookie 立即失效（伺服器端撤銷）", async () => {
  const out = await call("POST", "/admin/api/logout", { cookie: adminCookie });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await call("GET", "/admin/api/results", { cookie: adminCookie })).status, 401);
});

await check("登出：改寫同一個 token（附加字串、補零）也不能繞過撤銷", async () => {
  const appended = await call("GET", "/admin/api/me", { cookie: `${adminCookie}.x` });
  assert.equal(appended.status, 401);
  const padded = await call("GET", "/admin/api/me", { cookie: adminCookie.replace("tt_admin=", "tt_admin=0") });
  assert.equal(padded.status, 401);
});

await check("登出：撤銷只針對被登出的 token，重新登入後可正常使用", async () => {
  const res = await call("POST", "/admin/api/login", { body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  const fresh = res.headers.get("set-cookie").split(";")[0];
  assert.equal((await call("GET", "/admin/api/me", { cookie: fresh })).status, 200);
  assert.equal((await call("POST", "/admin/api/logout", { cookie: fresh })).status, 200);
});

await check("登入鎖定：連續 5 次失敗後 → 429（即使密碼正確）", async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await call("POST", "/admin/api/login", { body: { password: `wrong-${i}-xxxxxxxx` } })).status, 401);
  }
  assert.equal((await call("POST", "/admin/api/login", { body: { password: PASSWORD } })).status, 429);
});

console.log(log.join("\n"));
console.log(failures ? `\n${failures} 項失敗` : "\n全部通過");
process.exit(failures ? 1 : 0);
