# 跆拳道踢擊方向判斷測驗（Cloudflare Worker 版）

原本的 `taekwondo_test_mobile.py`（本機伺服器）改為部署在 Cloudflare Worker 上：

- **受試者**：仍然用手機瀏覽器開網址作答，畫面與流程與原版相同。唯一的調整是照片預載方式（只下載、不解碼），見下方「效能設計」。
- **資料**：結果與名單存在 Cloudflare **D1**（SQLite）；題庫照片存在 **R2**。
- **研究者後台** `/admin`：需要密碼登入。可以
  - 檢視前後測比較、每次施測的明細（含未完成的施測）
  - 下載 `all_results.csv`、`comparison.csv`，或單次施測的 CSV
  - 新增、編輯、刪除受試者；或匯入與原本 `participants.csv` 格式相同的 CSV

原本的 Python 檔與資料檔都沒有動。Worker 版取代了它，確認無誤後可自行刪除。

## 檔案說明

| 路徑 | 內容 |
|---|---|
| `wrangler.toml` | Worker 設定（D1、R2 綁定） |
| `src/index.js` | 路由：受試者 API 與後台 API |
| `src/logic.js` | 抽題、前後測比較、CSV 格式等核心邏輯（與原版相同的規則） |
| `src/auth.js` | 後台登入：密碼比對、簽章的登入 cookie |
| `src/db.js` | D1 的 SQL |
| `src/pages/participant.html` | 受試者測驗頁 |
| `src/pages/admin.html` | 研究者後台（與受試者頁相同的字型、顏色與按鈕樣式） |
| `migrations/` | 資料表結構 |
| `scripts/import-legacy.mjs` | 把原本本機版的資料轉成 D1 匯入用的 SQL |
| `scripts/upload-images.mjs` | 把題庫照片上傳到 R2 |
| `test/` | 單元測試（`logic.test.mjs`）與端對端測試（`e2e.mjs`） |

## 本機測試（不需要 Cloudflare 帳號）

在 PowerShell 中執行（路徑請依實際位置調整）：

```powershell
cd "<你的專案資料夾>\worker"
npm install

# 建立本機資料庫並匯入原本的資料
npx wrangler d1 migrations apply taekwondo-test --local
node scripts/import-legacy.mjs .. --out $env:TEMP\seed_local.sql
npx wrangler d1 execute taekwondo-test --local --file $env:TEMP\seed_local.sql
Remove-Item $env:TEMP\seed_local.sql

# 上傳題庫照片到本機 R2
node scripts/upload-images.mjs ..\images --local

# 啟動（管理密碼與簽章用字串只用於本機測試）
npx wrangler dev --local --var "ADMIN_PASSWORD:test-admin-password-123" --var "SESSION_SECRET:test-session-secret-0123456789abcdef0123456789"
```

- 受試者頁：http://localhost:8787/
- 研究者後台：http://localhost:8787/admin（密碼：`test-admin-password-123`）

測試：

```powershell
npm test                 # 單元測試
npm run test:e2e         # 端對端測試（需先啟動上面的 wrangler dev；會在本機資料庫新增測試資料；會從上一層資料夾讀取 participants.csv 與 answer_key.csv，可用 LEGACY_DIR 指定）
```

端對端測試最後會觸發登入鎖定。要重跑時，請先刪除本機的 `admin_login_failures` 資料，或重建本機資料庫。

## 正式部署（需要 Cloudflare 帳號）

以下步驟需要你本人操作，因為會開啟瀏覽器登入，並設定只有你知道的密碼。

```powershell
cd "<你的專案資料夾>\worker"
npm install

# 1. 登入 Cloudflare（會開啟瀏覽器）
npx wrangler login

# 2. 建立 D1 資料庫。輸出中會有 database_id，填入 wrangler.toml 的 REPLACE_WITH_D1_DATABASE_ID
npx wrangler d1 create taekwondo-test

# 3. 建立 R2 bucket（存題庫照片）
npx wrangler r2 bucket create taekwondo-images

# 4. 建立資料表
npx wrangler d1 migrations apply taekwondo-test --remote

# 5. 匯入原本的資料（名單、題庫、題目序列、已完成的施測）
node scripts/import-legacy.mjs .. --out $env:TEMP\seed_remote.sql
npx wrangler d1 execute taekwondo-test --remote --file $env:TEMP\seed_remote.sql
Remove-Item $env:TEMP\seed_remote.sql      # 含姓名與電子郵件，匯入後刪除

# 6. 上傳題庫照片
node scripts/upload-images.mjs ..\images --remote

# 7. 設定後台密碼與簽章用字串（會互動式輸入，輸入內容不會顯示）
#    ADMIN_PASSWORD：至少 12 字元；SESSION_SECRET：至少 32 字元的隨機字串
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET

# 8. 部署
npx wrangler deploy
```

部署完成後會顯示網址，格式為 `https://taekwondo-test.<你的子網域>.workers.dev`：

- 受試者網址：`https://taekwondo-test.<你的子網域>.workers.dev/`
- 研究者後台：`https://taekwondo-test.<你的子網域>.workers.dev/admin`

### 目前雲端的狀態（最近一次部署）

- Worker：`https://taekwondo-test.<你的子網域>.workers.dev`（後台：`/admin`）。Wrangler 登入的帳號為目前的 Cloudflare 帳號。
- D1：結構（migration 0001、0002）與題庫 16 筆已上傳；**名單、施測結果尚未上傳**。
- R2：`taekwondo-images` 內有 16 張照片。
- `SESSION_SECRET` 已設定（隨機產生，不會顯示）。
- `ADMIN_PASSWORD` 已設定。若要更換，執行：
  ```powershell
  npx wrangler secret put ADMIN_PASSWORD
  ```
- 名單可以在後台「受試者管理」→「匯入 CSV」上傳，格式與 `participants.csv` 相同。
- 施測結果如需上傳，先執行 `node scripts/import-legacy.mjs .. --no-participants --out $env:TEMP\seed_results.sql`，再用 `npx wrangler d1 execute taekwondo-test --remote --file $env:TEMP\seed_results.sql` 匯入，匯入後刪除該 SQL 檔。

## 日常維護

- **新增受試者**：後台「受試者管理」→「新增受試者」，或「匯入 CSV」（格式同 `participants.csv`，以編碼為準：已存在則更新、不存在則新增，不會刪除任何人）。
- **匯出結果**：後台「前後測結果」→ 下載 `all_results.csv` 或 `comparison.csv`（UTF-8 含 BOM，Excel 可直接開啟）。
- **更換後台密碼**：`npx wrangler secret put ADMIN_PASSWORD`。
- **讓所有已登入的工作階段失效**：`npx wrangler secret put SESSION_SECRET`（換成新的字串）。注意：不要把 SESSION_SECRET 換回舊值，否則之前登出的 token 可能在 8 小時內重新有效（登出的撤銷記錄是依目前的簽章金鑰判斷的）。
- **修改題庫（answer_key）**：目前以 `import-legacy.mjs` 整批取代。只有之後新抽的題目會受影響；已存在的受試者序列若與題庫不符，會自動重新抽題。Worker 會把題庫快取 60 秒，修改後最多 60 秒生效。

## 效能設計

- **照片**：回應帶 ETag 與 `max-age=3600`。快取過期後，瀏覽器以 `If-None-Match` 詢問，照片沒變就回 304，不會整包重新下載。
- **題庫**：Worker 內快取 60 秒，每張照片、每一題都不必再查一次資料庫。
- **逐題送出**：每題約兩次資料庫往返（受試者檢查與題庫並行）。逐題送出是中途斷線時的備份，最後的 `/api/finish` 會再送一次完整的 25 題。
- **預載**：受試者頁只把照片下載進瀏覽器快取，不做解碼（一張約 2400 萬像素的照片解碼後約 100MB）。
- **仍然的瓶頸**：照片本身。16 張約 61MB，每位受試者第一次測驗前要下載約 50MB。縮小照片會改變刺激的解析度，需要研究者決定。

## 疑難排解

- **後台顯示「後台暫時無法使用」**：通常是還沒設定 `ADMIN_PASSWORD`（至少 12 字元）或 `SESSION_SECRET`（至少 32 字元）。詳細原因只會寫入記錄檔，可用 `npx wrangler tail` 查看。
- **受試者按下「開始測驗」後出現「無法連線」**：通常是題庫照片還沒上傳到 R2，或 `wrangler.toml` 的 `database_id` 還沒填寫。

## 注意事項

- **個資**：姓名、班級座號、研究摘要、電子郵件會存在 Cloudflare D1。原本版本的設計是「名單只留在研究者電腦」，改為雲端後，請確認符合研究計畫的同意書與倫理審查規定。匯入用的 `seed*.sql` 已列入 `.gitignore`，匯入後請刪除。
- **登入保護**：後台密碼錯誤 5 次，同一 IP 會被鎖定 15 分鐘。另外建議在 Cloudflare 儀表板設定速率限制（Rate limiting）規則，保護 `/admin/api/login`。
- **登出**：會把登入 token 記錄為已撤銷，8 小時後自動到期。
- **QR code**：網址改變後，請用新網址重新產生 QR code（原版會自動產生 `qrcode.png`，這一版沒有）。
- **題目與時間**：題數 25、圖間隔 1～3 秒隨機、左右答案各半、相同答案最多連續 3 題、同一張圖不連續重複，都與原版相同，設定值在 `src/logic.js` 的最上方。
