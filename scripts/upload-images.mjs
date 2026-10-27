import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BUCKET = "taekwondo-images";
const TYPES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp",
};

const args = process.argv.slice(2);
const mode = args.includes("--local") ? "--local" : args.includes("--remote") ? "--remote" : null;
if (!mode) {
  console.error("請指定 --local 或 --remote");
  process.exit(1);
}
const persistIdx = args.indexOf("--persist-to");
const persistArgs = mode === "--local" && persistIdx >= 0 ? ["--persist-to", args[persistIdx + 1]] : [];
const dirArg = args.find((a, i) => !a.startsWith("--") && i !== persistIdx + 1);
const dir = path.resolve(dirArg ?? "../images");
if (!fs.existsSync(dir)) {
  console.error(`找不到資料夾：${dir}`);
  process.exit(1);
}

const wranglerBin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const files = fs.readdirSync(dir).filter((n) => TYPES[path.extname(n).toLowerCase()]).sort();
if (!files.length) {
  console.error(`${dir} 裡沒有圖片檔`);
  process.exit(1);
}

let failed = 0;
for (const name of files) {
  const r = spawnSync(process.execPath, [
    wranglerBin, "r2", "object", "put", `${BUCKET}/${name}`,
    "--file", path.join(dir, name),
    "--content-type", TYPES[path.extname(name).toLowerCase()],
    mode, ...persistArgs,
  ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (r.status === 0) {
    console.log(`上傳完成：${name}`);
  } else {
    failed++;
    console.error(`上傳失敗：${name}\n${(r.stderr || r.stdout || "").trim()}`);
  }
}
console.log(`共 ${files.length} 個檔案，失敗 ${failed} 個（${mode.slice(2)}）`);
process.exit(failed ? 1 : 0);
