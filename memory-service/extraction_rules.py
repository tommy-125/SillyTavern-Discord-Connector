"""Deterministic validation for model-produced event memories."""

from __future__ import annotations

import re
from typing import Any


MEMORY_CATEGORIES = {
    "conversation_event",
    "user_preference",
    "plan_task",
    "relationship_milestone",
    "decision",
    "summary",
}

CATEGORY_LABELS = {
    "conversation_event": "對話事件",
    "user_preference": "使用者偏好",
    "plan_task": "計畫／待辦",
    "relationship_milestone": "關係里程碑",
    "decision": "共同決定",
    "summary": "階段摘要",
    # Labels retained so pre-migration records remain understandable.
    "profile": "人物資料（舊版）",
    "core": "核心資訊（舊版）",
    "relationship": "關係（舊版）",
    "preference": "偏好（舊版）",
    "event": "事件（舊版）",
    "plan": "計畫（舊版）",
    "daily": "日常（舊版）",
}

CATEGORY_MIN_IMPORTANCE = {
    "conversation_event": 0.45,
    "user_preference": 0.50,
    "plan_task": 0.55,
    "relationship_milestone": 0.75,
    "decision": 0.65,
    "summary": 0.65,
}

_PREFERENCE_PATTERN = re.compile(
    r"(?:^|[\s，。！？、])我(?:真的|很|最|比較|一直|通常|平常|現在)?"
    r"(?:喜歡|愛|偏好|討厭|不喜歡|習慣|常吃|常喝|想要)"
    r"|\bI\s+(?:really\s+|usually\s+|always\s+)?"
    r"(?:like|love|prefer|hate|dislike|want)\b",
    re.IGNORECASE,
)
_PLAN_PATTERN = re.compile(
    r"(?:打算|計畫|準備|預計|約好|待辦|記得要|之後要|明天要|下週要|下次要|"
    r"決定要|我們要)|\b(?:plan|todo|will|going\s+to|agreed\s+to)\b",
    re.IGNORECASE,
)
_RELATIONSHIP_PATTERN = re.compile(
    r"(?:在一起|交往|結婚|訂婚|分手|和好|成為朋友|第一次見面|週年|周年|"
    r"正式認識)|\b(?:dating|married|engaged|broke\s+up|anniversary|"
    r"became\s+friends)\b",
    re.IGNORECASE,
)
_DECISION_PATTERN = re.compile(
    r"(?:決定|確定|改用|採用|選定|結論是|一致同意)|"
    r"\b(?:decided|agreed|switched\s+to|selected|adopted)\b",
    re.IGNORECASE,
)
_ASSISTANT_IDENTITY_PATTERN = re.compile(
    r"(?:Kuro|小黑|助手).{0,24}(?:自稱|名字|叫做|稱呼|是|不是|喜歡被叫|不喜歡被叫)"
    r"|(?:稱呼|叫).{0,16}(?:Kuro|小黑)",
    re.IGNORECASE,
)


def normalize_channel_id(value: str) -> str:
    channel_id = str(value or "").strip()
    for prefix in ("discord:", "kurohelper:"):
        if channel_id.startswith(prefix):
            return channel_id[len(prefix) :]
    return channel_id


def _clean(value: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _is_question_only(text: str) -> bool:
    cleaned = _clean(text, 8000)
    if not cleaned:
        return True
    question = cleaned.endswith(("?", "？")) or bool(
        re.match(r"^(?:誰|什麼|為什麼|怎麼|哪|何時|是否|是不是|你|請問)", cleaned)
    )
    assertion = bool(
        _PREFERENCE_PATTERN.search(cleaned)
        or _PLAN_PATTERN.search(cleaned)
        or _RELATIONSHIP_PATTERN.search(cleaned)
        or _DECISION_PATTERN.search(cleaned)
    )
    return question and not assertion


def _participant_lookup(
    known_participants: list[dict[str, str]],
) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]]]:
    by_id: dict[str, dict[str, str]] = {}
    by_name: dict[str, dict[str, str]] = {}
    for participant in known_participants:
        participant_id = _clean(participant.get("id"), 120)
        display_name = _clean(participant.get("display_name"), 100)
        if not participant_id:
            continue
        normalized = {
            "id": participant_id,
            "display_name": display_name,
            "role": _clean(participant.get("role"), 32) or "participant",
        }
        by_id[participant_id] = normalized
        if participant_id.startswith("discord:"):
            by_id[participant_id.removeprefix("discord:")] = normalized
        if display_name:
            by_name[display_name.casefold()] = normalized
    return by_id, by_name


def _resolve_participants(
    raw_participants: Any,
    known_participants: list[dict[str, str]],
    evidence: str,
) -> list[dict[str, str]]:
    by_id, by_name = _participant_lookup(known_participants)
    resolved: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in raw_participants if isinstance(raw_participants, list) else []:
        if not isinstance(raw, dict):
            continue
        raw_id = _clean(raw.get("id") or raw.get("participant_id"), 120)
        raw_name = _clean(raw.get("display_name") or raw.get("name"), 100)
        participant = by_id.get(raw_id) or by_name.get(raw_name.casefold())
        if participant is None and raw_name and raw_name.casefold() in evidence.casefold():
            participant = {
                "id": f"name:{raw_name.casefold()}"[:120],
                "display_name": raw_name,
                "role": "referenced_person",
            }
        if participant is None:
            continue
        participant_id = participant["id"]
        if participant_id in seen:
            continue
        seen.add(participant_id)
        resolved.append(
            {
                **participant,
                "role": _clean(raw.get("role"), 32) or participant["role"],
            }
        )
    return resolved[:25]


def validate_operations(
    raw_operations: Any,
    turn: dict[str, Any],
    known_participants: list[dict[str, str]],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Returns normalized safe operations and human-readable rejection reasons."""

    if not isinstance(raw_operations, list):
        return [], ["operations_not_array"]
    accepted: list[dict[str, Any]] = []
    rejected: list[str] = []
    user_text = _clean(turn.get("user_text"), 8000)
    recent_context = _clean(turn.get("recent_context"), 8000)
    evidence = f"{recent_context}\n{user_text}".strip()
    current_id = f"discord:{_clean(turn.get('user_id'), 100)}"
    by_id, _ = _participant_lookup(known_participants)
    current_participant = by_id.get(current_id)
    channel_id = normalize_channel_id(turn.get("channel_id", ""))

    for index, raw in enumerate(raw_operations[:12]):
        if not isinstance(raw, dict):
            rejected.append(f"{index}:not_object")
            continue
        action = _clean(raw.get("action"), 12).upper() or "NOOP"
        if action == "NOOP":
            continue
        if action == "DELETE":
            memory_id = _clean(raw.get("id"), 100)
            if memory_id:
                accepted.append({"action": "DELETE", "id": memory_id})
            else:
                rejected.append(f"{index}:delete_without_id")
            continue
        if action not in {"ADD", "UPDATE"}:
            rejected.append(f"{index}:invalid_action")
            continue

        category = _clean(raw.get("category"), 40).lower()
        if category not in MEMORY_CATEGORIES:
            rejected.append(f"{index}:invalid_category:{category or 'empty'}")
            continue
        summary = _clean(raw.get("summary") or raw.get("value"), 1000)
        attribute_key = _clean(raw.get("attribute_key") or raw.get("key"), 160)
        if not summary:
            rejected.append(f"{index}:empty_summary")
            continue
        if _ASSISTANT_IDENTITY_PATTERN.search(summary):
            rejected.append(f"{index}:assistant_identity_belongs_to_character_card")
            continue
        if _is_question_only(user_text):
            rejected.append(f"{index}:question_without_fact")
            continue

        try:
            importance = max(0.0, min(1.0, float(raw.get("importance", 0.5))))
            confidence = max(0.0, min(1.0, float(raw.get("confidence", 0.7))))
        except (TypeError, ValueError):
            rejected.append(f"{index}:invalid_scores")
            continue
        if confidence < 0.65 or importance < CATEGORY_MIN_IMPORTANCE[category]:
            rejected.append(f"{index}:below_threshold")
            continue

        participants = _resolve_participants(
            raw.get("participants"), known_participants, evidence
        )
        participant_ids = {participant["id"] for participant in participants}
        if not participants and current_participant is not None:
            participants = [dict(current_participant)]
            participant_ids = {current_participant["id"]}

        if category == "user_preference":
            if not _PREFERENCE_PATTERN.search(user_text):
                rejected.append(f"{index}:preference_not_explicit")
                continue
            if current_id not in participant_ids and current_participant is not None:
                participants.insert(0, dict(current_participant))
            attribute_key = attribute_key or "preference.general"
        elif category == "plan_task":
            if not _PLAN_PATTERN.search(evidence):
                rejected.append(f"{index}:plan_not_explicit")
                continue
            attribute_key = attribute_key or "plan.general"
        elif category == "relationship_milestone":
            if not _RELATIONSHIP_PATTERN.search(evidence):
                rejected.append(f"{index}:relationship_not_explicit")
                continue
            if len(participants) < 2:
                rejected.append(f"{index}:relationship_needs_two_participants")
                continue
            attribute_key = attribute_key or "relationship.milestone"
        elif category == "decision":
            if not _DECISION_PATTERN.search(evidence):
                rejected.append(f"{index}:decision_not_explicit")
                continue
            attribute_key = attribute_key or "decision.general"
        elif category == "summary":
            if len(recent_context) < 80:
                rejected.append(f"{index}:summary_without_context")
                continue
            attribute_key = attribute_key or "conversation.summary"
        else:
            attribute_key = attribute_key or "conversation.event"

        requested_scope = _clean(raw.get("scope"), 20).lower()
        scope = "global" if requested_scope == "global" else "channel"
        if scope == "global" and (
            category not in {"decision", "summary"} or importance < 0.75
        ):
            scope = "channel"
        if scope == "channel" and not channel_id:
            scope = "global"

        accepted.append(
            {
                "action": action,
                "id": _clean(raw.get("id"), 100),
                "scope": scope,
                "scope_id": "" if scope == "global" else channel_id,
                "category": category,
                "attribute_key": attribute_key,
                "summary": summary,
                "participants": participants[:25],
                "importance": importance,
                "confidence": confidence,
            }
        )

    return accepted, rejected
