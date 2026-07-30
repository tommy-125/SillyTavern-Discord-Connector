# KuroHelper AI Runtime

KuroHelper 的無 Discord Token AI 執行層。它將 SillyTavern、角色卡、OpenRouter、長期記憶與無頭瀏覽器包在同一組 Compose 服務中，並透過帶共享密鑰的 WebSocket API 接受 `kurohelper` 呼叫。

這個專案源自 SillyTavern Discord Connector；原作者與授權資訊保留在程式檔頭及 `LICENSE`。Discord Gateway、頻道讀取、指令權限和訊息發送已移至 Go 專案。

## 專案分工

```text
KuroHelper/
├─ kurohelper/             Discord Bot 入口、事件與 slash command
├─ kurohelper-service/     可重用的 Kuro runtime client、上下文組裝、資料模型
└─ kurohelper-ai-runtime/  SillyTavern、生成流程、Persona、長期記憶
```

請求流程：

```text
Discord
  -> kurohelper (Bot Token、觸發與最近訊息)
  -> kurohelper-service/kuro (內部協定 client)
  -> kurohelper-ai-runtime:2334 (共享密鑰)
  -> SillyTavern extension:2333
  -> OpenRouter
  -> 最終文字沿原路回到 Discord
```

AI Runtime 不登入 Discord，也不保存 Discord Bot Token。它只接收 Go Bot 已整理好的使用者 ID、顯示名稱、當前問題與最近頻道上下文。

## 容器

- `sillytavern`：SillyTavern 網頁與生成設定，主機僅開放 `127.0.0.1:8000`。
- `browser-worker`：以 Playwright 開啟 SillyTavern，維持瀏覽器端擴充功能運行。
- `ai-runtime`：連接瀏覽器端擴充功能，並在主機 `127.0.0.1:2334` 提供 KuroHelper API。
- `memory-service`：事件型長期記憶、SQLite/向量檢索、分類權重、軟刪除與生命週期維護。記憶以事件或陳述為主體，Discord 使用者只作為參與者中繼資料。
- `character-seed`：將角色卡同步進 SillyTavern data volume。

長期記憶分為 `conversation_event`、`user_preference`、`plan_task`、`relationship_milestone`、`decision` 與 `summary`。預設只在來源頻道回想；只有高重要度的共同決定或階段摘要可以跨頻道。使用者偏好必須由當事人在本次訊息中明確表達，Kuro 的身分與偏好由角色卡負責，不會從助手回覆寫入記憶。

## 設定與啟動

1. 將 `.env.example` 複製為 `.env`。
2. 填入 `OPENROUTER_API_KEY`、`OPENROUTER_MODEL` 與角色卡路徑。
3. 執行 `npm run configure-runtime-secret`，安全產生長隨機字串並同步寫入本專案 `.env` 與 `kurohelper/.env`；腳本不會把密鑰印到終端。
4. 確認 `server/config.js` 存在；可由 `server/config.example.js` 複製。這裡不應出現 Discord Token。
5. 啟動：

```powershell
docker compose up -d --build
docker compose ps
docker compose logs -f ai-runtime browser-worker memory-service
```

若使用 Podman，對應指令為 `podman compose up -d --build`。Windows 上需先啟動 Podman machine。

接著在 `kurohelper/.env` 設定：

```dotenv
KURO_RUNTIME_URL=ws://127.0.0.1:2334
KURO_RUNTIME_SECRET=與上面相同的長隨機字串
KURO_TRIGGER_PREFIX=小黑
KURO_CHANNEL_IDS=允許觸發的頻道ID
KURO_COMMAND_USER_IDS=允許使用管理指令的使用者ID
```

詳細部署與網路邊界見 [DEPLOYMENT.md](DEPLOYMENT.md)，內部封包格式見 [PROTOCOL.md](PROTOCOL.md)。

## 資料持久化

- `runtime/sillytavern/`：SillyTavern 設定、角色與聊天資料。
- `runtime/browser/`：無頭瀏覽器 profile。
- `runtime/runtime/`：Persona 對應等 AI Runtime 狀態。
- `runtime/memory/`：長期記憶資料庫與向量索引。

這些目錄不會隨容器重建消失，且不應提交到 Git。

## 安全邊界

- Discord Bot Token 只存在 `kurohelper/.env`。
- OpenRouter API Key 只存在 AI Runtime 的 `.env`。
- 2334 預設只綁定主機 loopback，並要求 Bearer secret。
- 若 Go Bot 與 AI Runtime 分散在不同主機，請用私有網路、VPN 或 TLS 反向代理；不要直接把 2334 公開到 Internet。
