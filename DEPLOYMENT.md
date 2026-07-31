# 部署說明

## 單機部署（目前建議）

`kurohelper` 直接在主機執行；`kurohelper-ai-runtime` 使用 Compose。Go Bot 透過 `ws://127.0.0.1:2334` 呼叫容器中的 AI Runtime，因此 Discord Bot Token 不會進入任何 AI Runtime 容器。

必要連接埠：

| 連接埠 | 範圍 | 用途 |
|---|---|---|
| 8000 | `127.0.0.1` | 手動查看 SillyTavern UI |
| 2333 | Compose 內部 | 瀏覽器擴充功能到 AI Runtime |
| 2334 | `127.0.0.1` | Go KuroHelper 到 AI Runtime |
| 8090 | Compose 內部 | AI Runtime 到 memory-service |
| 8081 | Compose 內部 | SillyTavern 到 OpenRouter 的用量指標代理 |

SillyTavern 的 Private Request Filter 保持啟用，並以 `ST_PRIVATE_ADDRESS_ALLOWED_RANGES` 只允許可信任的 Compose 子網。若重建 Podman network 後其子網不再是 `10.89.2.0/24`，請依 `podman network inspect kurohelper-ai-runtime_default` 的結果更新此值。

啟動 AI Runtime：

```powershell
Copy-Item .env.example .env
Copy-Item server/config.example.js server/config.js
docker compose up -d --build
docker compose ps
```

然後從 `KuroHelper/kurohelper` 啟動 Go Bot：

```powershell
go run ./cmd
```

確認狀態：

```powershell
docker compose logs -f ai-runtime browser-worker memory-service
```

Discord 中可由授權使用者執行 `小黑 /status`，確認 WebSocket、SillyTavern 與記憶服務狀態。

## 分離主機或分離容器

如果 Go Bot 和 AI Runtime 不在同一台主機：

1. 將 Compose 的 2334 綁定位置改為私有介面，不再使用 `127.0.0.1`。
2. 使用 WireGuard、Tailscale、內網或 TLS reverse proxy 保護流量。
3. `KURO_RUNTIME_URL` 改成可到達 AI Runtime 的 `wss://` 或私網 `ws://` 位址。
4. 兩邊配置相同、足夠長且不可提交的共享密鑰。

共享密鑰只是應用層驗證，不會自行加密明文 WebSocket；跨不可信網路時必須搭配 TLS 或 VPN。

## 更新與備份

更新程式後重建：

```powershell
docker compose up -d --build
```

備份下列資料目錄即可保留角色、聊天、Persona 與長期記憶：

```text
runtime/sillytavern
runtime/browser
runtime/runtime
runtime/memory
```

`runtime/memory/backups` 內另有 memory-service 自動建立的 SQLite 一致性快照。預設每 24 小時備份並保留最近 5 份；服務啟動時若最近 24 小時已有任何備份就不會重複建立。整庫復原後 Chroma 向量索引會自動重建。這能處理記憶誤改或資料庫邏輯錯誤，但主機磁碟損壞時仍需將整個 `runtime/` 定期備份到另一個磁碟或遠端儲存。

## 常見檢查

- `小黑 /status` 顯示 runtime disconnected：確認 2334、兩邊 secret 與 AI Runtime log。
- Runtime 顯示 degraded：通常是 `browser-worker` 尚未成功登入或連上 SillyTavern 擴充功能。
- Discord 沒反應：確認頻道 ID、Message Content Intent、觸發前綴或 mention。
- 記憶暫時不可用：生成設計為 fail-open；檢查 `memory-service` log，不應因此完全阻塞回覆。
