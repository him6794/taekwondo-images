import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanParticipant, computeComparison, drawSequence, etagMatches, fmtCsvNum, isoFromRunId, isoTaipei, makeRecord,
  maxRun, newRunId, normAnswer, normName, parseCsv, parseParticipantsCsv, randomInt, toCsv, ValidationError,
  MAX_SAME_ANSWER_RUN, N_TRIALS,
} from "../src/logic.js";

const POOL = Array.from({ length: 16 }, (_, i) => ({
  trial_id: String(i + 1),
  filename: `IMG_${String(i).padStart(4, "0")}.jpg`,
  answer: i % 2 === 0 ? "左" : "右",
}));

test("作答正規化：左右與英文寫法", () => {
  assert.equal(normAnswer("左"), "左");
  assert.equal(normAnswer(" L "), "左");
  assert.equal(normAnswer("right"), "右");
  assert.equal(normAnswer("R"), "右");
  assert.equal(normAnswer("上"), "");
  assert.equal(normAnswer(undefined), "");
});

test("姓名正規化：NFKC、去空白、小寫", () => {
  assert.equal(normName(" 測　試甲 "), "測試甲");
  assert.equal(normName("John  Smith"), "johnsmith");
  assert.equal(normName("ＡＢＣ"), "abc");
});

test("亂數在範圍內", () => {
  for (let i = 0; i < 500; i++) {
    const n = randomInt(7);
    assert.ok(n >= 0 && n < 7);
  }
});

test("maxRun", () => {
  assert.equal(maxRun([]), 0);
  assert.equal(maxRun(["左", "左", "右", "左", "左", "左"]), 3);
});

test("抽題：25 題、左右各半（12 或 13）、相同答案不超過連續上限、相鄰不重複", () => {
  for (let trial = 0; trial < 300; trial++) {
    const seq = drawSequence(POOL);
    assert.equal(seq.length, N_TRIALS);
    const answers = seq.map((t) => POOL.find((p) => p.filename === t.filename).answer);
    const left = answers.filter((a) => a === "左").length;
    assert.ok(left === 12 || left === 13, `左的題數 ${left}`);
    assert.ok(maxRun(answers) <= MAX_SAME_ANSWER_RUN, "相同答案連續太多");
    seq.forEach((t, i) => {
      if (i > 0) assert.notEqual(t.filename, seq[i - 1].filename);
      assert.ok(POOL.some((p) => p.filename === t.filename && p.trial_id === t.trial_id));
    });
  }
});

test("抽題：題庫缺少左或右時拋出錯誤", () => {
  assert.throws(() => drawSequence(POOL.filter((p) => p.answer === "左")), /「左」和「右」/);
});

test("前後測比較：每人每階段取最新一次完成的施測，並計算平均列與未配對", () => {
  const rows = [
    { participant_code: "A", session: "前測", run_id: "20260101_100000", is_correct: 0, rt_ms: 1000 },
    { participant_code: "A", session: "前測", run_id: "20260102_100000", is_correct: 1, rt_ms: 2000 },
    { participant_code: "A", session: "前測", run_id: "20260102_100000", is_correct: 1, rt_ms: 4000 },
    { participant_code: "A", session: "後測", run_id: "20260201_100000", is_correct: 1, rt_ms: 3000 },
    { participant_code: "A", session: "後測", run_id: "20260201_100000", is_correct: 0, rt_ms: 5000 },
    { participant_code: "B", session: "前測", run_id: "20260101_090000", is_correct: 1, rt_ms: 1500 },
  ];
  const cmp = computeComparison(rows);
  assert.equal(cmp.rows.length, 1);
  const [code, pre, post, diff, preRt, postRt, rtDiff, preC, postC, cDiff] = cmp.rows[0];
  assert.equal(code, "A");
  assert.equal(pre, 100);
  assert.equal(post, 50);
  assert.equal(diff, -50);
  assert.equal(preRt, 3000);
  assert.equal(postRt, 4000);
  assert.equal(rtDiff, 1000);
  assert.equal(preC, 3000);
  assert.equal(postC, 3000);
  assert.equal(cDiff, 0);
  assert.deepEqual(cmp.average, cmp.rows[0].slice(1));
  assert.deepEqual(cmp.unpaired, ["B"]);
});

test("前後測比較：沒有答對時「答對 RT」為 NaN，格式化為 nan", () => {
  const cmp = computeComparison([
    { participant_code: "C", session: "前測", run_id: "20260101_100000", is_correct: 0, rt_ms: 1000 },
    { participant_code: "C", session: "後測", run_id: "20260201_100000", is_correct: 0, rt_ms: 1000 },
  ]);
  assert.ok(Number.isNaN(cmp.rows[0][7]));
  assert.equal(fmtCsvNum(cmp.rows[0][7]), "nan");
});

test("數字格式與 Python round(v, 2) 相同", () => {
  assert.equal(fmtCsvNum(50), "50.0");
  assert.equal(fmtCsvNum(66.666), "66.67");
  assert.equal(fmtCsvNum(-8), "-8.0");
  assert.equal(fmtCsvNum(6580.1), "6580.1");
  assert.equal(fmtCsvNum(7209.4799), "7209.48");
});

test("CSV 輸出：UTF-8 BOM、CRLF、含逗號或引號的欄位會加引號", () => {
  const text = toCsv(["a", "b"], [["x,y", 'say "hi"'], [1, null]]);
  assert.equal(text.charCodeAt(0), 0xFEFF);
  assert.equal(text, "﻿a,b\r\n\"x,y\",\"say \"\"hi\"\"\"\r\n1,\r\n");
});

test("CSV 解析：引號、換行、BOM、CRLF", () => {
  const rows = parseCsv("﻿name,note\r\n\"甲,乙\",\"第一行\n第二行\"\r\n丙,\r\n");
  assert.deepEqual(rows, [["name", "note"], ["甲,乙", "第一行\n第二行"], ["丙", ""]]);
});

test("受試者 CSV：欄位對應、略過空白列、重複與格式錯誤", () => {
  const sample = [
    "﻿name,code,班級座號,研究摘要,電子郵件",
    "甲,P001,10001,無,",
    "乙,P002,10002,紙本,",
    "丙,P004,10004,電子郵件,person@example.com",
    ",P042,,,",
    ",,,,",
    "丁,p054,,,",
  ].join("\n");
  const r = parseParticipantsCsv(sample);
  assert.deepEqual(r.errors, []);
  assert.equal(r.items.length, 4);
  assert.equal(r.skipped, 1);
  assert.equal(r.items[2].email, "person@example.com");
  assert.equal(r.items[3].code, "p054");

  const dup = parseParticipantsCsv("name,code\n甲,P1\n乙,P1\n");
  assert.match(dup.errors[0], /編碼重複/);
  const dupName = parseParticipantsCsv("name,code\n甲,P1\n甲 ,P2\n");
  assert.match(dupName.errors[0], /姓名重複/);
  const noHeader = parseParticipantsCsv("foo,bar\n1,2\n");
  assert.equal(noHeader.items.length, 0);
  assert.match(noHeader.errors[0], /name/);
  const badEmail = parseParticipantsCsv("name,code,電子郵件\n甲,P1,not-an-email\n");
  assert.match(badEmail.errors[0], /電子郵件/);
});

test("受試者欄位檢查：編碼只允許英數字、底線與連字號", () => {
  assert.equal(cleanParticipant({ code: "P001", name: "甲" }).errors.length, 0);
  assert.equal(cleanParticipant({ code: "P 001", name: "甲" }).errors.length, 1);
  assert.equal(cleanParticipant({ code: "P001", name: "" }).errors.length, 1);
});

test("施測編號與時間：台北時間格式、可還原開始時間", () => {
  const d = new Date(Date.UTC(2026, 9, 27, 0, 36, 57, 123));
  assert.equal(isoTaipei(d), "2026-10-27T08:36:57+08:00");
  assert.equal(newRunId(d), "20261027_083657_123");
  assert.equal(isoFromRunId("20261027_083657_123"), "2026-10-27T08:36:57+08:00");
  assert.equal(isoFromRunId("20261020_170416"), "2026-10-20T17:04:16+08:00");
  assert.equal(isoFromRunId("bogus"), null);
});

test("逐題紀錄：正確答案與題號以題庫為準，RT 取一位小數", () => {
  const key = new Map(POOL.map((p) => [p.filename, { trial_id: p.trial_id, answer: p.answer }]));
  const meta = { code: "P001", session: "前測", run_id: "20260101_100000_000" };
  const rec = makeRecord(meta, { order: 3, image: POOL[0].filename, response: "右", rt_ms: 1234.567, isi_ms: 2000.9 }, key);
  assert.equal(rec.correct_answer, "左");
  assert.equal(rec.response, "右");
  assert.equal(rec.is_correct, 0);
  assert.equal(rec.trial_id, "1");
  assert.equal(rec.rt_ms, 1234.6);
  assert.equal(rec.isi_ms, 2000);
  assert.throws(() => makeRecord(meta, { order: 1, image: "nope.jpg", response: "左" }, key), ValidationError);
});

test("條件式請求：If-None-Match 與 ETag 的比對", () => {
  const etag = '"6b4c0a1f-abc"';
  assert.equal(etagMatches(etag, etag), true);
  assert.equal(etagMatches(`"other", ${etag}`, etag), true);
  assert.equal(etagMatches(`W/${etag}`, etag), true);
  assert.equal(etagMatches("*", etag), true);
  assert.equal(etagMatches('"other"', etag), false);
  assert.equal(etagMatches(null, etag), false);
  assert.equal(etagMatches(etag, null), false);
});
