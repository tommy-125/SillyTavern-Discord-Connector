"""Build compact prompts and normalize model-generated memory candidates."""

from __future__ import annotations

import json
import re
from typing import Any


SYSTEM_PROMPT = """你是 Kuro 的長期記憶篩選器。只判斷本輪對話是否含有未來跨對話仍有用、來源明確的資訊。沒有就輸出 {"memories":[]}；寧可輸出空陣列，也不要推測、補充或為了產生記憶而硬寫。

可保存：明確且相對穩定的偏好、具體計畫或待辦、已做出的決定、重要事件或關係轉折、值得跨時間回想的階段摘要。
不保存：問候、普通問答或知識題、一次性需求、短暫情緒、玩笑、重複內容、Kuro 的台詞／設定／動作、未經當事人確認的推測，以及密碼、Token、API key 等秘密。

只輸出 JSON：{"memories":[{"scope":"channel|global","category":"conversation_event|user_preference|plan_task|relationship_milestone|decision|summary","attribute_key":"穩定且具體的欄位名稱","summary":"第三人稱、簡短、自足的摘要","participants":[{"id":"participants 中的 ID","display_name":"名稱","role":"speaker|mentioned|participant"}],"importance":0到1,"confidence":0到1}]}
預設 scope=channel；只有重要且跨頻道有用的決定或階段摘要才用 global。participants 只能使用輸入提供的 ID。不要解釋或輸出 Markdown。"""


_REFERENCE_PATTERN = re.compile(
    r"(?:這(?:件事|件|個|些|樣)?|那(?:件事|件|個|些|樣)?|剛才|剛剛|前面|上面|"
    r"之前說的|方才|此事|他|她|它|對方|同一件事)"
)
_COMMAND_PATTERN = re.compile(r"^(?:小黑|kuro)?\s*/[a-z0-9_-]+(?:\s|$)", re.I)
_GREETING_PATTERN = re.compile(
    r"^(?:小黑[，,、 ]*)?(?:早安|早上好|午安|下午好|晚安|晚上好|你好|嗨|哈囉|"
    r"在嗎|睡了嗎|最近好嗎)[！!。.?？~～…]*$",
    re.I,
)
_KNOWLEDGE_REQUEST_PATTERN = re.compile(
    r"^(?:請|麻煩你|可以)?\s*(?:解釋|介紹|說明|翻譯|計算|查詢|查一下|搜尋)",
    re.I,
)


def _clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _clip(value: Any, limit: int, *, keep_tail: bool = False) -> str:
    text = _clean(value)
    if len(text) <= limit:
        return text
    if keep_tail:
        return f"…{text[-(limit - 1):]}"
    head = max(1, round((limit - 1) * 0.65))
    return f"{text[:head]}…{text[-(limit - head - 1):]}"


def local_skip_reason(turn: dict[str, Any]) -> str:
    """Conservatively skip turns that cannot create useful long-term memory."""

    user_text = _clean(turn.get("user_text"))
    if not user_text:
        return "empty_message"
    if _COMMAND_PATTERN.search(user_text):
        return "bot_command"
    if _GREETING_PATTERN.fullmatch(user_text):
        return "simple_greeting"
    if _KNOWLEDGE_REQUEST_PATTERN.search(user_text):
        return "knowledge_request"
    return ""


def _needs_recent_context(user_text: str) -> bool:
    return bool(_REFERENCE_PATTERN.search(user_text))


def _compact_participants(
    known_participants: list[dict[str, str]],
    user_text: str,
    assistant_text: str,
    recent_context: str,
) -> list[dict[str, str]]:
    evidence = f"{user_text}\n{assistant_text}\n{recent_context}".casefold()
    selected: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, participant in enumerate(known_participants):
        participant_id = _clean(participant.get("id"))
        display_name = _clean(participant.get("display_name"))
        role = _clean(participant.get("role"))
        required = index == 0 or participant_id == "kuro"
        mentioned = role == "mentioned_user" or (
            bool(display_name) and display_name.casefold() in evidence
        )
        if not (required or mentioned) or not participant_id or participant_id in seen:
            continue
        seen.add(participant_id)
        selected.append(
            {
                "id": participant_id,
                "display_name": display_name,
                "role": role,
            }
        )
        if len(selected) >= 8:
            break
    return selected


def build_candidate_messages(
    turn: dict[str, Any],
    known_participants: list[dict[str, str]],
) -> list[dict[str, str]]:
    """Return the compact extraction request sent to the model."""

    user_text = _clip(turn.get("user_text"), 1400)
    assistant_text = _clip(turn.get("assistant_text"), 1400)
    recent_context = ""
    if _needs_recent_context(user_text):
        recent_context = _clip(turn.get("recent_context"), 1200, keep_tail=True)
    payload: dict[str, Any] = {
        "participants": _compact_participants(
            known_participants,
            user_text,
            assistant_text,
            recent_context,
        ),
        "user_message": user_text,
        "assistant_reply": assistant_text,
    }
    if recent_context:
        payload["recent_context"] = recent_context
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        },
    ]


def candidate_operations(extracted: dict[str, Any]) -> list[dict[str, Any]]:
    """Turn non-authoritative model candidates into locally validated ADD requests."""

    memories = extracted.get("memories")
    if not isinstance(memories, list):
        return []
    return [
        {**candidate, "action": "ADD", "id": ""}
        for candidate in memories[:6]
        if isinstance(candidate, dict)
    ]
