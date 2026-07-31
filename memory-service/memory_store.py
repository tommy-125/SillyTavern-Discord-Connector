"""SQLite lifecycle store with Chroma as the active-memory vector index."""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import chromadb

from extraction_rules import MEMORY_CATEGORIES, normalize_channel_id
from lifecycle import (
    clamp,
    decayed_importance,
    normalize_key,
    normalize_value,
    retrieval_score,
    should_archive,
    utc_now,
)


LEGACY_CATEGORY_MAP = {
    "preference": "user_preference",
    "event": "conversation_event",
    "daily": "conversation_event",
    "plan": "plan_task",
    "relationship": "relationship_milestone",
}

BACKUP_ID_PATTERN = re.compile(
    r"^(?P<timestamp>\d{8}T\d{6}Z)-(?P<reason>auto|manual|startup|pre-restore)-(?P<suffix>[0-9a-f]{8})$"
)


def _iso(value: datetime | None = None) -> str:
    return (value or utc_now()).isoformat()


def _parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def make_namespace(character_id: str) -> str:
    character = "".join(ch for ch in str(character_id) if ch.isalnum() or ch in "-_")[:80]
    if not character:
        raise ValueError("character_id is required")
    return f"char:{character}:shared"


class MemoryStore:
    def __init__(
        self,
        data_dir: str,
        embed_documents: Callable[[list[str]], list[list[float]]],
        embed_queries: Callable[[list[str]], list[list[float]]],
    ) -> None:
        root = Path(data_dir)
        root.mkdir(parents=True, exist_ok=True)
        self._root = root
        self._db_path = root / "lifecycle.sqlite3"
        self._backup_dir = root / "backups"
        self._backup_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._embed_documents = embed_documents
        self._embed_queries = embed_queries
        self._db = sqlite3.connect(
            self._db_path,
            check_same_thread=False,
            timeout=30,
        )
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._create_schema()

        client = chromadb.PersistentClient(path=str(root / "chroma"))
        self._collection = client.get_or_create_collection(
            name="active_memories",
            metadata={"hnsw:space": "cosine"},
        )
        self._migrate_legacy_namespaces()
        self._migrate_event_columns()
        self._migrate_legacy_categories()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    @staticmethod
    def _validate_backup_database(path: Path) -> None:
        source = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        try:
            check = source.execute("PRAGMA quick_check").fetchone()
            if check is None or check[0] != "ok":
                raise ValueError("backup database failed SQLite quick_check")
            table = source.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'"
            ).fetchone()
            if table is None:
                raise ValueError("backup database does not contain the memories table")
        finally:
            source.close()

    def _backup_info(self, path: Path) -> dict[str, Any]:
        match = BACKUP_ID_PATTERN.fullmatch(path.stem)
        if match is None:
            raise ValueError("invalid backup filename")
        counts: dict[str, int] = {}
        source = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        try:
            rows = source.execute(
                "SELECT status, COUNT(*) FROM memories GROUP BY status"
            ).fetchall()
            counts = {str(status): int(count) for status, count in rows}
        finally:
            source.close()
        timestamp = datetime.strptime(
            match.group("timestamp"), "%Y%m%dT%H%M%SZ"
        ).replace(tzinfo=timezone.utc)
        return {
            "id": path.stem,
            "created_at": timestamp.isoformat(),
            "reason": match.group("reason"),
            "size_bytes": path.stat().st_size,
            "memory_count": sum(counts.values()),
            "status_counts": counts,
        }

    def _backup_paths(self) -> list[Path]:
        return sorted(
            (
                path
                for path in self._backup_dir.glob("*.sqlite3")
                if BACKUP_ID_PATTERN.fullmatch(path.stem)
            ),
            key=lambda path: (path.stat().st_mtime_ns, path.name),
            reverse=True,
        )

    def _prune_backups_locked(self, retention_count: int) -> int:
        keep = max(2, min(int(retention_count), 365))
        removed = 0
        for path in self._backup_paths()[keep:]:
            path.unlink(missing_ok=True)
            removed += 1
        return removed

    def _create_backup_locked(
        self,
        reason: str,
        retention_count: int,
        prune: bool = True,
    ) -> dict[str, Any]:
        normalized_reason = reason if reason in {
            "auto", "manual", "startup", "pre-restore"
        } else "manual"
        timestamp = utc_now().strftime("%Y%m%dT%H%M%SZ")
        backup_id = f"{timestamp}-{normalized_reason}-{uuid.uuid4().hex[:8]}"
        destination = self._backup_dir / f"{backup_id}.sqlite3"
        temporary = self._backup_dir / f".{backup_id}.tmp"
        self._db.commit()
        try:
            target = sqlite3.connect(temporary)
            try:
                self._db.backup(target)
                check = target.execute("PRAGMA quick_check").fetchone()
                if check is None or check[0] != "ok":
                    raise RuntimeError("new backup failed SQLite quick_check")
            finally:
                target.close()
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        temporary.replace(destination)
        info = self._backup_info(destination)
        removed = self._prune_backups_locked(retention_count) if prune else 0
        info["pruned"] = removed
        return info

    def create_backup(
        self,
        reason: str = "manual",
        retention_count: int = 30,
    ) -> dict[str, Any]:
        """Creates an online SQLite snapshot without pausing memory readers."""

        with self._lock:
            return self._create_backup_locked(reason, retention_count)

    def seconds_until_next_backup(self, interval_seconds: int) -> int:
        """Returns the remaining delay based on the newest snapshot of any kind."""

        with self._lock:
            paths = self._backup_paths()
            if not paths:
                return 0
            age = max(0, time.time() - paths[0].stat().st_mtime)
            return max(0, int(interval_seconds - age))

    def create_backup_if_stale(
        self,
        reason: str,
        minimum_age_seconds: int,
        retention_count: int = 30,
    ) -> dict[str, Any]:
        """Creates a snapshot only when no recent snapshot already covers startup."""

        with self._lock:
            remaining = self.seconds_until_next_backup(minimum_age_seconds)
            if remaining > 0:
                latest = self._backup_info(self._backup_paths()[0])
                return {
                    "status": "skipped_recent",
                    "backup": latest,
                    "seconds_until_next": remaining,
                }
            return {
                "status": "created",
                "backup": self._create_backup_locked(reason, retention_count),
                "seconds_until_next": max(1, int(minimum_age_seconds)),
            }

    def list_backups(
        self,
        limit: int = 20,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        with self._lock:
            paths = self._backup_paths()
            start = max(0, int(offset))
            selected = paths[start : start + max(1, min(int(limit), 50))]
            return [self._backup_info(path) for path in selected], len(paths)

    def _resolve_backup_path_locked(self, backup_id: str) -> tuple[Path | None, bool]:
        prefix = str(backup_id or "").strip()
        if len(prefix) < 8 or not re.fullmatch(r"[A-Za-z0-9-]+", prefix):
            return None, False
        matches = [path for path in self._backup_paths() if path.stem.startswith(prefix)]
        return (matches[0], False) if len(matches) == 1 else (None, len(matches) > 1)

    def _rebuild_vector_index_locked(self) -> int:
        existing = self._collection.get()
        existing_ids = list(existing.get("ids") or [])
        if existing_ids:
            self._collection.delete(ids=existing_ids)
        rows = self._db.execute(
            "SELECT * FROM memories WHERE status = 'active' ORDER BY created_at"
        ).fetchall()
        for start in range(0, len(rows), 32):
            chunk = rows[start : start + 32]
            documents = [
                self._document(
                    row["memory_key"],
                    row["memory_value"],
                    row["subject_name"],
                    self._row(row)["participants"],
                )
                for row in chunk
            ]
            self._collection.upsert(
                ids=[row["id"] for row in chunk],
                documents=documents,
                embeddings=self._embed_documents(documents),
                metadatas=[self._metadata(row) for row in chunk],
            )
        return len(rows)

    def _load_backup_locked(self, path: Path) -> int:
        self._validate_backup_database(path)
        source = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        try:
            self._db.commit()
            source.backup(self._db)
        finally:
            source.close()
        check = self._db.execute("PRAGMA quick_check").fetchone()
        if check is None or check[0] != "ok":
            raise RuntimeError("restored database failed SQLite quick_check")
        self._create_schema()
        return self._rebuild_vector_index_locked()

    def restore_backup(
        self,
        backup_id: str,
        retention_count: int = 30,
    ) -> dict[str, Any]:
        """Restores the whole memory database and rebuilds its derived vector index."""

        with self._lock:
            selected, ambiguous = self._resolve_backup_path_locked(backup_id)
            if ambiguous:
                return {"status": "ambiguous"}
            if selected is None:
                return {"status": "not_found"}
            self._validate_backup_database(selected)
            selected_info = self._backup_info(selected)
            safety = self._create_backup_locked(
                "pre-restore", retention_count, prune=False
            )
            safety_path = self._backup_dir / f"{safety['id']}.sqlite3"
            try:
                restored_count = self._load_backup_locked(selected)
            except Exception:
                self._load_backup_locked(safety_path)
                raise
            self._prune_backups_locked(retention_count)
            return {
                "status": "restored_backup",
                "backup": selected_info,
                "safety_backup": safety,
                "restored_active_count": restored_count,
            }

    def _create_schema(self) -> None:
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                memory_key TEXT NOT NULL,
                normalized_key TEXT NOT NULL,
                memory_value TEXT NOT NULL,
                normalized_value TEXT NOT NULL,
                category TEXT NOT NULL,
                importance REAL NOT NULL,
                confidence REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_accessed_at TEXT,
                access_count INTEGER NOT NULL DEFAULT 0,
                supersedes_id TEXT,
                source_request_id TEXT,
                source_channel_id TEXT,
                subject_id TEXT NOT NULL DEFAULT 'shared',
                subject_name TEXT NOT NULL DEFAULT '',
                scope_type TEXT NOT NULL DEFAULT 'channel',
                scope_id TEXT NOT NULL DEFAULT '',
                participants_json TEXT NOT NULL DEFAULT '[]',
                identity_key TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_memories_namespace_status
                ON memories(namespace, status);
            CREATE INDEX IF NOT EXISTS idx_memories_key
                ON memories(namespace, normalized_key, status);
            """
        )
        columns = {
            row["name"]
            for row in self._db.execute("PRAGMA table_info(memories)").fetchall()
        }
        if "subject_id" not in columns:
            self._db.execute(
                "ALTER TABLE memories ADD COLUMN subject_id TEXT NOT NULL DEFAULT 'shared'"
            )
        if "subject_name" not in columns:
            self._db.execute(
                "ALTER TABLE memories ADD COLUMN subject_name TEXT NOT NULL DEFAULT ''"
            )
        if "scope_type" not in columns:
            self._db.execute(
                "ALTER TABLE memories ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'channel'"
            )
        if "scope_id" not in columns:
            self._db.execute(
                "ALTER TABLE memories ADD COLUMN scope_id TEXT NOT NULL DEFAULT ''"
            )
        if "participants_json" not in columns:
            self._db.execute(
                "ALTER TABLE memories ADD COLUMN participants_json TEXT NOT NULL DEFAULT '[]'"
            )
        if "identity_key" not in columns:
            self._db.execute(
                "ALTER TABLE memories ADD COLUMN identity_key TEXT NOT NULL DEFAULT ''"
            )
        self._db.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_memories_subject_key
            ON memories(namespace, subject_id, normalized_key, status)
            """
        )
        self._db.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_memories_scope
            ON memories(namespace, scope_type, scope_id, status)
            """
        )
        self._db.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_memories_identity
            ON memories(namespace, identity_key, status)
            """
        )
        self._db.commit()

    @staticmethod
    def _document(
        key: str,
        value: str,
        subject_name: str = "",
        participants: list[dict[str, str]] | None = None,
    ) -> str:
        names = [
            str(item.get("display_name", "")).strip()
            for item in (participants or [])
            if str(item.get("display_name", "")).strip()
        ]
        subject = "、".join(dict.fromkeys(names)) or str(subject_name or "").strip()
        return f"{subject}｜{key}：{value}" if subject else f"{key}：{value}"

    @staticmethod
    def _row(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        try:
            participants = json.loads(result.get("participants_json") or "[]")
        except (TypeError, json.JSONDecodeError):
            participants = []
        result["participants"] = participants if isinstance(participants, list) else []
        return result

    @staticmethod
    def _metadata(row: sqlite3.Row | dict[str, Any]) -> dict[str, str]:
        return {
            "namespace": str(row["namespace"]),
            "category": str(row["category"]),
            "subject_id": str(row["subject_id"]),
            "scope_type": str(row["scope_type"]),
            "scope_id": str(row["scope_id"] or "__global__"),
        }

    def _migrate_legacy_namespaces(self) -> int:
        """Moves the former per-user namespaces into the shared character pool."""

        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM memories WHERE namespace LIKE 'char:%:user:%'"
            ).fetchall()
            migrated = 0
            for row in rows:
                prefix, separator, user_id = row["namespace"].rpartition(":user:")
                if not separator or not user_id or not prefix.startswith("char:"):
                    continue
                shared_namespace = f"{prefix}:shared"
                subject_id = f"discord:{user_id}"
                subject_name = row["subject_name"] or "未知使用者"
                self._db.execute(
                    """
                    UPDATE memories
                    SET namespace = ?, subject_id = ?, subject_name = ?
                    WHERE id = ?
                    """,
                    (shared_namespace, subject_id, subject_name, row["id"]),
                )
                if row["status"] == "active":
                    self._collection.update(
                        ids=[row["id"]],
                        metadatas=[{
                            "namespace": shared_namespace,
                            "category": row["category"],
                            "subject_id": subject_id,
                            "scope_type": row["scope_type"],
                            "scope_id": row["scope_id"] or "__global__",
                        }],
                    )
                migrated += 1
            if migrated:
                self._db.commit()
            return migrated

    def _migrate_event_columns(self) -> int:
        """Backfills event scope and participants without deleting legacy memories."""

        with self._lock:
            rows = self._db.execute(
                """
                SELECT * FROM memories
                WHERE identity_key = ''
                """
            ).fetchall()
            migrated = 0
            for row in rows:
                scope_id = normalize_channel_id(row["source_channel_id"] or "")
                scope_type = "channel" if scope_id else "global"
                participants: list[dict[str, str]] = []
                if str(row["subject_id"]).startswith(("discord:", "name:")):
                    participants.append({
                        "id": str(row["subject_id"]),
                        "display_name": str(row["subject_name"] or ""),
                        "role": "legacy_subject",
                    })
                identity_key = "|".join(
                    [
                        str(row["category"]),
                        scope_type,
                        scope_id,
                        str(row["subject_id"]),
                        str(row["normalized_key"]),
                    ]
                )
                self._db.execute(
                    """
                    UPDATE memories
                    SET scope_type = ?, scope_id = ?, participants_json = ?,
                        identity_key = ?
                    WHERE id = ?
                    """,
                    (
                        scope_type,
                        scope_id,
                        json.dumps(participants, ensure_ascii=False),
                        identity_key,
                        row["id"],
                    ),
                )
                if row["status"] == "active":
                    metadata = {
                        "namespace": str(row["namespace"]),
                        "category": str(row["category"]),
                        "subject_id": str(row["subject_id"]),
                        "scope_type": scope_type,
                        "scope_id": scope_id or "__global__",
                    }
                    self._collection.update(ids=[row["id"]], metadatas=[metadata])
                migrated += 1
            if migrated:
                self._db.commit()
            return migrated

    def _migrate_legacy_categories(self) -> int:
        """Maps compatible legacy types to event-oriented category names."""

        placeholders = ",".join("?" for _ in LEGACY_CATEGORY_MAP)
        with self._lock:
            rows = self._db.execute(
                f"SELECT * FROM memories WHERE category IN ({placeholders})",
                list(LEGACY_CATEGORY_MAP),
            ).fetchall()
            for row in rows:
                old_category = str(row["category"])
                new_category = LEGACY_CATEGORY_MAP[old_category]
                identity_key = str(row["identity_key"] or "")
                if identity_key.startswith(f"{old_category}|"):
                    identity_key = f"{new_category}|{identity_key.split('|', 1)[1]}"
                self._db.execute(
                    "UPDATE memories SET category = ?, identity_key = ? WHERE id = ?",
                    (new_category, identity_key, row["id"]),
                )
                if row["status"] == "active":
                    migrated_row = {**dict(row), "category": new_category}
                    self._collection.update(
                        ids=[row["id"]],
                        metadatas=[self._metadata(migrated_row)],
                    )
            if rows:
                self._db.commit()
            return len(rows)

    def update_subject_names(
        self,
        character_id: str,
        subjects: list[dict[str, str]],
    ) -> int:
        """Refreshes human-readable labels without changing identity or scope."""

        namespace = make_namespace(character_id)
        updated = 0
        with self._lock:
            for subject in subjects:
                subject_id = str(subject.get("subject_id", "")).strip()[:120]
                subject_name = str(subject.get("subject_name", "")).strip()[:100]
                if not subject_id or not subject_name or subject_id == "shared":
                    continue
                cursor = self._db.execute(
                    """
                    UPDATE memories SET subject_name = ?
                    WHERE namespace = ? AND subject_id = ? AND subject_name != ?
                    """,
                    (subject_name, namespace, subject_id, subject_name),
                )
                updated += cursor.rowcount
            if updated:
                self._db.commit()
            return updated

    def update_participant_names(
        self,
        character_id: str,
        participants: list[dict[str, str]],
    ) -> int:
        """Refreshes participant display names while retaining stable IDs."""

        namespace = make_namespace(character_id)
        names = {
            str(item.get("id", "")).strip(): str(item.get("display_name", "")).strip()[:100]
            for item in participants
            if str(item.get("id", "")).strip() and str(item.get("display_name", "")).strip()
        }
        if not names:
            return 0
        updated = 0
        with self._lock:
            rows = self._db.execute(
                "SELECT id, participants_json FROM memories WHERE namespace = ?",
                (namespace,),
            ).fetchall()
            for row in rows:
                try:
                    stored = json.loads(row["participants_json"] or "[]")
                except (TypeError, json.JSONDecodeError):
                    continue
                changed = False
                for participant in stored if isinstance(stored, list) else []:
                    display_name = names.get(str(participant.get("id", "")))
                    if display_name and participant.get("display_name") != display_name:
                        participant["display_name"] = display_name
                        changed = True
                if changed:
                    self._db.execute(
                        "UPDATE memories SET participants_json = ? WHERE id = ?",
                        (json.dumps(stored, ensure_ascii=False), row["id"]),
                    )
                    updated += 1
            if updated:
                self._db.commit()
        return updated

    def active_memories(self, namespace: str, limit: int = 30) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                """
                SELECT * FROM memories
                WHERE namespace = ? AND status = 'active'
                ORDER BY importance DESC, updated_at DESC
                LIMIT ?
                """,
                (namespace, max(1, min(limit, 100))),
            ).fetchall()
            return [self._row(row) for row in rows]

    def list_memories(
        self,
        character_id: str,
        status: str = "active",
        limit: int = 20,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        namespace = make_namespace(character_id)
        allowed_statuses = {"active", "deleted", "forgotten", "superseded"}
        selected_status = status if status in allowed_statuses else "active"
        with self._lock:
            rows = self._db.execute(
                """
                SELECT * FROM memories
                WHERE namespace = ? AND status = ?
                ORDER BY updated_at DESC
                LIMIT ? OFFSET ?
                """,
                (
                    namespace,
                    selected_status,
                    max(1, min(int(limit), 50)),
                    max(0, int(offset)),
                ),
            ).fetchall()
            return [self._row(row) for row in rows]

    def count_memories(self, character_id: str, status: str = "active") -> int:
        namespace = make_namespace(character_id)
        allowed_statuses = {"active", "deleted", "forgotten", "superseded"}
        selected_status = status if status in allowed_statuses else "active"
        with self._lock:
            row = self._db.execute(
                """
                SELECT COUNT(*) AS total FROM memories
                WHERE namespace = ? AND status = ?
                """,
                (namespace, selected_status),
            ).fetchone()
            return int(row["total"] if row else 0)

    def get_memory(self, character_id: str, memory_id: str) -> dict[str, Any]:
        namespace = make_namespace(character_id)
        prefix = str(memory_id or "").strip()
        if len(prefix) < 6:
            return {"status": "not_found"}
        with self._lock:
            rows = self._db.execute(
                """
                SELECT * FROM memories
                WHERE namespace = ? AND id LIKE ?
                LIMIT 2
                """,
                (namespace, f"{prefix}%"),
            ).fetchall()
            if len(rows) > 1:
                return {"status": "ambiguous"}
            if not rows:
                return {"status": "not_found"}
            return {"status": "found", "memory": self._row(rows[0])}

    def _resolve_memory_id(
        self,
        namespace: str,
        memory_id: str,
        status: str,
    ) -> tuple[sqlite3.Row | None, bool]:
        prefix = str(memory_id or "").strip()
        if len(prefix) < 6:
            return None, False
        rows = self._db.execute(
            """
            SELECT * FROM memories
            WHERE namespace = ? AND status = ? AND id LIKE ?
            LIMIT 2
            """,
            (namespace, status, f"{prefix}%"),
        ).fetchall()
        return (rows[0], False) if len(rows) == 1 else (None, len(rows) > 1)

    def soft_delete(self, character_id: str, memory_id: str) -> dict[str, Any]:
        namespace = make_namespace(character_id)
        with self._lock:
            row, ambiguous = self._resolve_memory_id(namespace, memory_id, "active")
            if ambiguous:
                return {"status": "ambiguous"}
            if row is None:
                return {"status": "not_found"}
            now = _iso()
            self._db.execute(
                "UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ?",
                (now, row["id"]),
            )
            self._db.commit()
            self._collection.delete(ids=[row["id"]])
            return {"status": "deleted", "memory": self._row(row), "deleted_at": now}

    def restore(self, character_id: str, memory_id: str) -> dict[str, Any]:
        namespace = make_namespace(character_id)
        with self._lock:
            row, ambiguous = self._resolve_memory_id(namespace, memory_id, "deleted")
            if ambiguous:
                return {"status": "ambiguous"}
            if row is None:
                return {"status": "not_found"}
            conflict = self._db.execute(
                """
                SELECT id FROM memories
                WHERE namespace = ? AND identity_key = ?
                  AND status = 'active'
                LIMIT 1
                """,
                (namespace, row["identity_key"]),
            ).fetchone()
            if conflict is not None:
                return {"status": "conflict", "conflict_id": conflict["id"]}

            document = self._document(
                row["memory_key"],
                row["memory_value"],
                row["subject_name"],
                self._row(row)["participants"],
            )
            embedding = self._embed_documents([document])[0]
            self._collection.upsert(
                ids=[row["id"]],
                documents=[document],
                embeddings=[embedding],
                metadatas=[self._metadata(row)],
            )
            now = _iso()
            try:
                self._db.execute(
                    "UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?",
                    (now, row["id"]),
                )
                self._db.commit()
            except Exception:
                self._collection.delete(ids=[row["id"]])
                self._db.rollback()
                raise
            restored = self._row(row)
            restored["updated_at"] = now
            restored["status"] = "active"
            return {"status": "restored", "memory": restored}

    def soft_delete_all(self, character_id: str) -> int:
        namespace = make_namespace(character_id)
        with self._lock:
            rows = self._db.execute(
                "SELECT id FROM memories WHERE namespace = ? AND status = 'active'",
                (namespace,),
            ).fetchall()
            if not rows:
                return 0
            ids = [row["id"] for row in rows]
            self._db.execute(
                """
                UPDATE memories SET status = 'deleted', updated_at = ?
                WHERE namespace = ? AND status = 'active'
                """,
                (_iso(), namespace),
            )
            self._db.commit()
            self._collection.delete(ids=ids)
            return len(ids)

    def recall(
        self,
        character_id: str,
        query: str,
        limit: int = 5,
        channel_id: str = "",
        participant_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        namespace = make_namespace(character_id)
        channel_id = normalize_channel_id(channel_id)
        requested_participants = {
            value if value.startswith(("discord:", "name:")) else f"discord:{value}"
            for value in (str(item).strip() for item in (participant_ids or []))
            if value
        }
        limit = max(1, min(int(limit), 10))
        with self._lock:
            if channel_id:
                active_count = self._db.execute(
                    """
                    SELECT COUNT(*) FROM memories
                    WHERE namespace = ? AND status = 'active'
                      AND (scope_type = 'global' OR (scope_type = 'channel' AND scope_id = ?))
                    """,
                    (namespace, channel_id),
                ).fetchone()[0]
                where = {
                    "$and": [
                        {"namespace": {"$eq": namespace}},
                        {
                            "$or": [
                                {"scope_type": {"$eq": "global"}},
                                {"scope_id": {"$eq": channel_id}},
                            ]
                        },
                    ]
                }
            else:
                active_count = self._db.execute(
                    """
                    SELECT COUNT(*) FROM memories
                    WHERE namespace = ? AND status = 'active' AND scope_type = 'global'
                    """,
                    (namespace,),
                ).fetchone()[0]
                where = {
                    "$and": [
                        {"namespace": {"$eq": namespace}},
                        {"scope_type": {"$eq": "global"}},
                    ]
                }
            if active_count == 0:
                return []

            query_embedding = self._embed_queries([str(query or "")])[0]
            results = self._collection.query(
                query_embeddings=[query_embedding],
                n_results=min(active_count, max(limit * 4, 12)),
                where=where,
                include=["distances"],
            )
            ids = (results.get("ids") or [[]])[0]
            distances = (results.get("distances") or [[]])[0]
            if not ids:
                return []

            placeholders = ",".join("?" for _ in ids)
            rows = self._db.execute(
                f"SELECT * FROM memories WHERE status = 'active' AND id IN ({placeholders})",
                ids,
            ).fetchall()
            by_id = {row["id"]: row for row in rows}
            now = utc_now()
            ranked: list[dict[str, Any]] = []
            for memory_id, distance in zip(ids, distances):
                row = by_id.get(memory_id)
                if row is None:
                    continue
                effective = decayed_importance(
                    row["importance"],
                    row["category"],
                    _parse_iso(row["updated_at"]),
                    access_count=row["access_count"],
                    now=now,
                )
                item = self._row(row)
                stored_participants = {
                    str(participant.get("id", ""))
                    for participant in item["participants"]
                    if isinstance(participant, dict)
                }
                score = retrieval_score(
                    cosine_distance=float(distance),
                    effective_importance=effective,
                    confidence=row["confidence"],
                    category=row["category"],
                    participant_match=bool(requested_participants & stored_participants),
                    same_channel=bool(
                        channel_id
                        and row["scope_type"] == "channel"
                        and row["scope_id"] == channel_id
                    ),
                )
                if score < 0.25:
                    continue
                item["effective_importance"] = effective
                item["score"] = score
                ranked.append(item)

            ranked.sort(key=lambda item: item["score"], reverse=True)
            selected = ranked[:limit]
            if selected:
                selected_ids = [item["id"] for item in selected]
                placeholders = ",".join("?" for _ in selected_ids)
                self._db.execute(
                    f"""
                    UPDATE memories
                    SET access_count = access_count + 1, last_accessed_at = ?
                    WHERE id IN ({placeholders})
                    """,
                    [_iso(now), *selected_ids],
                )
                self._db.commit()
            return selected

    def apply_operations(
        self,
        character_id: str,
        operations: list[dict[str, Any]],
        *,
        request_id: str = "",
        channel_id: str = "",
    ) -> dict[str, int]:
        namespace = make_namespace(character_id)
        counts = {"added": 0, "updated": 0, "deleted": 0, "noop": 0}
        with self._lock:
            for operation in operations[:12]:
                action = str(operation.get("action", "NOOP")).upper()
                if action == "DELETE":
                    if self._archive_target(namespace, str(operation.get("id", ""))):
                        counts["deleted"] += 1
                    else:
                        counts["noop"] += 1
                    continue
                if action not in {"ADD", "UPDATE"}:
                    counts["noop"] += 1
                    continue

                key = str(
                    operation.get("attribute_key") or operation.get("key", "")
                ).strip()[:160]
                value = str(
                    operation.get("summary") or operation.get("value", "")
                ).strip()[:1000]
                if not key or not value:
                    counts["noop"] += 1
                    continue
                category = str(operation.get("category", "event")).lower()
                if category not in MEMORY_CATEGORIES:
                    counts["noop"] += 1
                    continue
                importance = clamp(float(operation.get("importance", 0.5)))
                confidence = clamp(float(operation.get("confidence", 0.7)))
                scope_type = (
                    "global" if str(operation.get("scope", "")).lower() == "global"
                    else "channel"
                )
                scope_id = normalize_channel_id(
                    operation.get("scope_id") or channel_id
                )
                if scope_type == "channel" and not scope_id:
                    scope_type = "global"
                if scope_type == "global":
                    scope_id = ""
                participants = [
                    {
                        "id": str(item.get("id", "")).strip()[:120],
                        "display_name": str(item.get("display_name", "")).strip()[:100],
                        "role": str(item.get("role", "participant")).strip()[:32],
                    }
                    for item in operation.get("participants", [])[:25]
                    if isinstance(item, dict) and str(item.get("id", "")).strip()
                ]
                subject_id = "global" if scope_type == "global" else f"channel:{scope_id}"
                subject_name = "跨頻道記憶" if scope_type == "global" else "頻道記憶"
                identity_key = self._identity_key(
                    category,
                    scope_type,
                    scope_id,
                    key,
                    participants,
                    request_id,
                )

                target_id = str(operation.get("id", "")) if action == "UPDATE" else ""
                result = self._upsert(
                    namespace,
                    key,
                    value,
                    category,
                    importance,
                    confidence,
                    subject_id=subject_id,
                    subject_name=subject_name,
                    scope_type=scope_type,
                    scope_id=scope_id,
                    participants=participants,
                    identity_key=identity_key,
                    target_id=target_id,
                    request_id=request_id,
                    channel_id=channel_id,
                )
                counts[result] += 1
        return counts

    @staticmethod
    def _identity_key(
        category: str,
        scope_type: str,
        scope_id: str,
        key: str,
        participants: list[dict[str, str]],
        request_id: str,
    ) -> str:
        participant_ids = sorted(
            str(item.get("id", "")).strip()
            for item in participants
            if str(item.get("id", "")).strip()
        )
        parts = [category, scope_type, scope_id, normalize_key(key)]
        if category == "conversation_event":
            parts.append(str(request_id or uuid.uuid4()))
        elif category in {"user_preference", "plan_task", "relationship_milestone"}:
            parts.extend(participant_ids)
        return "|".join(parts)[:500]

    def _upsert(
        self,
        namespace: str,
        key: str,
        value: str,
        category: str,
        importance: float,
        confidence: float,
        *,
        subject_id: str,
        subject_name: str,
        scope_type: str,
        scope_id: str,
        participants: list[dict[str, str]],
        identity_key: str,
        target_id: str,
        request_id: str,
        channel_id: str,
    ) -> str:
        normalized_key = normalize_key(key)
        normalized_value = normalize_value(value)
        existing = None
        if target_id:
            existing = self._db.execute(
                "SELECT * FROM memories WHERE id = ? AND namespace = ? AND status = 'active'",
                (target_id, namespace),
            ).fetchone()
        if existing is None:
            existing = self._db.execute(
                """
                SELECT * FROM memories
                WHERE namespace = ? AND identity_key = ? AND status = 'active'
                ORDER BY updated_at DESC LIMIT 1
                """,
                (namespace, identity_key),
            ).fetchone()

        now = _iso()
        if existing is not None and existing["normalized_value"] == normalized_value:
            self._db.execute(
                """
                UPDATE memories
                SET updated_at = ?, importance = MAX(importance, ?),
                    confidence = MAX(confidence, ?)
                WHERE id = ?
                """,
                (now, importance, confidence, existing["id"]),
            )
            self._db.commit()
            return "noop"

        supersedes_id = existing["id"] if existing is not None else None
        memory_id = str(uuid.uuid4())
        document = self._document(key, value, subject_name, participants)
        embedding = self._embed_documents([document])[0]
        self._collection.add(
            ids=[memory_id],
            documents=[document],
            embeddings=[embedding],
            metadatas=[{
                "namespace": namespace,
                "category": category,
                "subject_id": subject_id,
                "scope_type": scope_type,
                "scope_id": scope_id or "__global__",
            }],
        )
        try:
            if supersedes_id:
                self._db.execute(
                    "UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?",
                    (now, supersedes_id),
                )
            self._db.execute(
                """
                INSERT INTO memories (
                    id, namespace, memory_key, normalized_key, memory_value,
                    normalized_value, category, importance, confidence, status,
                    created_at, updated_at, supersedes_id, source_request_id,
                    source_channel_id
                    , subject_id, subject_name, scope_type, scope_id,
                    participants_json, identity_key
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    memory_id,
                    namespace,
                    key,
                    normalized_key,
                    value,
                    normalized_value,
                    category,
                    importance,
                    confidence,
                    now,
                    now,
                    supersedes_id,
                    request_id[:100],
                    channel_id[:100],
                    subject_id,
                    subject_name,
                    scope_type,
                    scope_id,
                    json.dumps(participants, ensure_ascii=False),
                    identity_key,
                ),
            )
            self._db.commit()
        except Exception:
            self._collection.delete(ids=[memory_id])
            self._db.rollback()
            raise
        if supersedes_id:
            self._collection.delete(ids=[supersedes_id])
        return "updated" if supersedes_id else "added"

    def _archive_target(self, namespace: str, memory_id: str) -> bool:
        row = self._db.execute(
            "SELECT id FROM memories WHERE id = ? AND namespace = ? AND status = 'active'",
            (memory_id, namespace),
        ).fetchone()
        if row is None:
            return False
        self._db.execute(
            "UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ?",
            (_iso(), memory_id),
        )
        self._db.commit()
        self._collection.delete(ids=[memory_id])
        return True

    def maintenance(self, trash_retention_days: int = 30) -> dict[str, int]:
        archived_ids: list[str] = []
        now = utc_now()
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM memories WHERE status = 'active'",
            ).fetchall()
            for row in rows:
                effective = decayed_importance(
                    row["importance"],
                    row["category"],
                    _parse_iso(row["updated_at"]),
                    access_count=row["access_count"],
                    now=now,
                )
                if not should_archive(effective, row["category"]):
                    continue
                self._db.execute(
                    "UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?",
                    (_iso(now), row["id"]),
                )
                archived_ids.append(row["id"])
            self._db.commit()
            if archived_ids:
                self._collection.delete(ids=archived_ids)
            retention_days = max(1, min(int(trash_retention_days), 3650))
            cutoff = now - timedelta(days=retention_days)
            deleted_rows = self._db.execute(
                "SELECT id, updated_at FROM memories WHERE status = 'deleted'"
            ).fetchall()
            purge_ids = [
                row["id"]
                for row in deleted_rows
                if _parse_iso(row["updated_at"]) < cutoff
            ]
            if purge_ids:
                placeholders = ",".join("?" for _ in purge_ids)
                self._db.execute(
                    f"DELETE FROM memories WHERE id IN ({placeholders})",
                    purge_ids,
                )
                self._db.commit()
        return {
            "archived": len(archived_ids),
            "purged": len(purge_ids),
            "checked": len(rows),
        }

    def stats(self) -> dict[str, Any]:
        with self._lock:
            rows = self._db.execute(
                "SELECT status, COUNT(*) AS count FROM memories GROUP BY status",
            ).fetchall()
            return {row["status"]: row["count"] for row in rows}
