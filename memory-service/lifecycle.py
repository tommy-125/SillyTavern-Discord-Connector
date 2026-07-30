"""Pure lifecycle scoring helpers for long-term memories."""

from __future__ import annotations

import math
import re
import unicodedata
from datetime import datetime, timezone


HALF_LIFE_DAYS = {
    "conversation_event": 60.0,
    "user_preference": 180.0,
    "plan_task": 90.0,
    "relationship_milestone": 730.0,
    "decision": 365.0,
    "summary": 120.0,
    # Legacy categories remain readable during the in-place schema migration.
    "profile": None,
    "core": None,
    "relationship": 365.0,
    "preference": 180.0,
    "event": 60.0,
    "plan": 30.0,
    "daily": 7.0,
}

CATEGORY_RETRIEVAL_PRIORITY = {
    "conversation_event": 0.60,
    "user_preference": 0.85,
    "plan_task": 1.00,
    "relationship_milestone": 0.95,
    "decision": 0.95,
    "summary": 0.75,
    "profile": 0.80,
    "core": 0.90,
    "relationship": 0.85,
    "preference": 0.80,
    "event": 0.60,
    "plan": 0.90,
    "daily": 0.45,
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_key(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    return re.sub(r"\s+", " ", text)[:160]


def normalize_value(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    return re.sub(r"\s+", " ", text)[:1000]


def clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    return max(lower, min(upper, float(value)))


def decayed_importance(
    importance: float,
    category: str,
    updated_at: datetime,
    *,
    access_count: int = 0,
    now: datetime | None = None,
) -> float:
    """Returns importance after time decay and bounded recall reinforcement."""

    now = now or utc_now()
    base = clamp(importance)
    half_life = HALF_LIFE_DAYS.get(category, HALF_LIFE_DAYS["event"])
    if half_life is not None:
        age_days = max(0.0, (now - updated_at).total_seconds() / 86_400)
        base *= math.pow(0.5, age_days / half_life)

    reinforcement = min(1.35, 1.0 + math.log1p(max(0, access_count)) * 0.06)
    return clamp(base * reinforcement)


def retrieval_score(
    *,
    cosine_distance: float,
    effective_importance: float,
    confidence: float,
    category: str = "conversation_event",
    participant_match: bool = False,
    same_channel: bool = False,
) -> float:
    semantic = clamp(1.0 - max(0.0, cosine_distance) / 2.0)
    return clamp(
        semantic * 0.56
        + clamp(effective_importance) * 0.22
        + clamp(confidence) * 0.08
        + CATEGORY_RETRIEVAL_PRIORITY.get(category, 0.60) * 0.08
        + (0.04 if participant_match else 0.0)
        + (0.02 if same_channel else 0.0)
    )


def should_archive(effective_importance: float, category: str) -> bool:
    if category in {"profile", "core"}:
        return False
    return effective_importance < 0.08
