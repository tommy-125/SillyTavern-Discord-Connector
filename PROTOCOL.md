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
- 任一失敗 → `error_response`
- 生成中可收到不終結請求的 `typing` 或 `images` 事件

`generate_request.payload` 包含 `channelId`、`userId`、`displayName`、`text`、`recentChannelContext`、`retrievalText`、`mentionedUsers` 與 `contextParticipants`。`contextParticipants` 只用穩定 Discord ID 標記近期事件參與者，不代表建立使用者人物檔案。AI Runtime 信任這些資料已由持有 Discord Token 的 Go Bot 驗證與整理。

每次請求必須使用唯一 `requestId`。Go client 會保留 pending request，直到收到正式 response、error、逾時或連線中斷；`typing`/`images` 不會提早完成文字生成請求。
