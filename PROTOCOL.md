# KuroHelper Runtime Protocol v1

KuroHelper 以 WebSocket 連線至 AI Runtime。握手必須包含：

```http
Authorization: Bearer <KUROHELPER_BRIDGE_SECRET>
```

所有訊息使用相同 envelope：

```json
{
  "version": 1,
  "type": "generate_request",
  "requestId": "discord-message-id",
  "payload": {}
}
```

支援的 request/response：

- `generate_request` → `generate_response`
- `health_request` → `health_response`
- `memory_request` → `memory_response`
- `raw_replies_request` → `raw_replies_response`
- AI Runtime → Go Bot 背景統計：`metric_event`（目前用於 `memory_extraction`）
- 任一失敗 → `error_response`
- 生成中可收到不終結請求的 `typing` 或 `images` 事件

`generate_request.payload` 包含 `channelId`、`userId`、`displayName`、`text`、`recentMessages`、`recentChannelContext`、`retrievalText`、`mentionedUsers` 與 `contextParticipants`。`recentMessages` 是依 `/newchat` 邊界整理過的結構化 Discord 訊息，AI Runtime 會把它們注入成真正的 `user`／`assistant` 對話角色；`recentChannelContext` 暫時保留給舊版相容與記憶檢索。`contextParticipants` 只用穩定 Discord ID 標記近期事件參與者，不代表建立使用者人物檔案。AI Runtime 信任這些資料已由持有 Discord Token 的 Go Bot 驗證與整理。

每次請求必須使用唯一 `requestId`。Go client 會保留 pending request，直到收到正式 response、error、逾時或連線中斷；`typing`/`images` 不會提早完成文字生成請求。

`metric_event` 在主 `generate_response` 完成後獨立送出，payload 包含 `requestId`、`channelId`、`operation` 與 `metrics`。Go Bot 會將它寫入 `kuro_ai_metrics`；這讓背景 Memory extraction 的 Token 與費用能納入 `/ai-stats`，但不會影響正常回覆的端到端延遲。
