import sys
import tempfile
import types
import unittest


class FakeCollection:
    def __init__(self):
        self.items = {}

    def add(self, ids, documents, embeddings, metadatas):
        for index, memory_id in enumerate(ids):
            self.items[memory_id] = {
                "document": documents[index],
                "metadata": metadatas[index],
            }

    def upsert(self, ids, documents, embeddings, metadatas):
        self.add(ids, documents, embeddings, metadatas)

    def update(self, ids, metadatas):
        for index, memory_id in enumerate(ids):
            if memory_id in self.items:
                self.items[memory_id]["metadata"] = metadatas[index]

    def delete(self, ids):
        for memory_id in ids:
            self.items.pop(memory_id, None)

    def get(self):
        return {"ids": list(self.items)}

    @staticmethod
    def _matches(metadata, where):
        if "$and" in where:
            return all(FakeCollection._matches(metadata, item) for item in where["$and"])
        if "$or" in where:
            return any(FakeCollection._matches(metadata, item) for item in where["$or"])
        for key, condition in where.items():
            expected = condition.get("$eq") if isinstance(condition, dict) else condition
            if metadata.get(key) != expected:
                return False
        return True

    def query(self, query_embeddings, n_results, where, include):
        ids = [
            memory_id
            for memory_id, item in self.items.items()
            if self._matches(item["metadata"], where)
        ][:n_results]
        return {"ids": [ids], "distances": [[0.1] * len(ids)]}


class FakeClient:
    collection = FakeCollection()

    def __init__(self, path):
        self.path = path

    def get_or_create_collection(self, name, metadata):
        return self.collection


if "chromadb" not in sys.modules:
    sys.modules["chromadb"] = types.SimpleNamespace(PersistentClient=FakeClient)

from memory_store import MemoryStore  # noqa: E402


def vectors(texts):
    return [[1.0, 0.0] for _ in texts]


class MemoryStoreTests(unittest.TestCase):
    def setUp(self):
        FakeClient.collection = FakeCollection()
        self.temp = tempfile.TemporaryDirectory()
        self.store = MemoryStore(self.temp.name, vectors, vectors)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    @staticmethod
    def preference(participant_id, name, summary):
        return {
            "action": "ADD",
            "scope": "channel",
            "scope_id": "channel-1",
            "category": "user_preference",
            "attribute_key": "food.ice_pop.flavor",
            "summary": summary,
            "participants": [{"id": participant_id, "display_name": name, "role": "speaker"}],
            "importance": 0.7,
            "confidence": 1.0,
        }

    def test_same_attribute_for_two_participants_does_not_overwrite(self):
        first = self.store.apply_operations(
            "Kuro", [self.preference("discord:u1", "肉圓", "肉圓喜歡紅豆冰棒。")], request_id="r1", channel_id="channel-1"
        )
        second = self.store.apply_operations(
            "Kuro", [self.preference("discord:u2", "海獺", "海獺喜歡巧克力冰棒。")], request_id="r2", channel_id="channel-1"
        )
        self.assertEqual(first["added"], 1)
        self.assertEqual(second["added"], 1)
        self.assertEqual(len(self.store.list_memories("Kuro")), 2)
        first_page = self.store.list_memories("Kuro", limit=1, offset=0)
        second_page = self.store.list_memories("Kuro", limit=1, offset=1)
        self.assertEqual(len(first_page), 1)
        self.assertEqual(len(second_page), 1)
        self.assertNotEqual(first_page[0]["id"], second_page[0]["id"])
        self.assertEqual(self.store.count_memories("Kuro"), 2)

    def test_get_memory_accepts_unique_prefix_across_statuses(self):
        self.store.apply_operations(
            "Kuro",
            [self.preference("discord:u1", "Tommy", "Tommy likes tea")],
            request_id="detail-1",
            channel_id="channel-1",
        )
        memory = self.store.list_memories("Kuro")[0]
        found = self.store.get_memory("Kuro", memory["id"][:8])
        self.assertEqual(found["status"], "found")
        self.assertEqual(found["memory"]["id"], memory["id"])

        self.store.soft_delete("Kuro", memory["id"][:8])
        deleted = self.store.get_memory("Kuro", memory["id"][:8])
        self.assertEqual(deleted["memory"]["status"], "deleted")
        self.assertEqual(self.store.get_memory("Kuro", "missing")["status"], "not_found")

    def test_recall_is_channel_scoped_but_includes_global(self):
        self.store.apply_operations(
            "Kuro", [self.preference("discord:u1", "肉圓", "肉圓喜歡紅豆冰棒。")], request_id="r1", channel_id="channel-1"
        )
        other = self.preference("discord:u2", "海獺", "海獺喜歡巧克力冰棒。")
        other["scope_id"] = "channel-2"
        self.store.apply_operations("Kuro", [other], request_id="r2", channel_id="channel-2")
        self.store.apply_operations(
            "Kuro",
            [{
                "action": "ADD",
                "scope": "global",
                "category": "decision",
                "attribute_key": "project.provider",
                "summary": "專案決定改用新供應商。",
                "participants": [],
                "importance": 0.9,
                "confidence": 1.0,
            }],
            request_id="r3",
            channel_id="channel-1",
        )
        recalled = self.store.recall("Kuro", "冰棒與專案", 10, "channel-1", ["u1"])
        summaries = {item["memory_value"] for item in recalled}
        self.assertIn("肉圓喜歡紅豆冰棒。", summaries)
        self.assertIn("專案決定改用新供應商。", summaries)
        self.assertNotIn("海獺喜歡巧克力冰棒。", summaries)

    def test_store_rejects_new_legacy_person_profile_categories(self):
        result = self.store.apply_operations(
            "Kuro",
            [{
                "action": "ADD",
                "category": "core",
                "key": "preferred_name",
                "value": "Kuro 不喜歡被叫小黑。",
                "importance": 1.0,
                "confidence": 1.0,
            }],
            request_id="r4",
            channel_id="channel-1",
        )
        self.assertEqual(result["noop"], 1)
        self.assertEqual(self.store.list_memories("Kuro"), [])

    def test_backup_restore_replaces_database_and_rebuilds_vectors(self):
        self.store.apply_operations(
            "Kuro", [self.preference("discord:u1", "肉圓", "肉圓喜歡紅豆冰棒。")], request_id="r1", channel_id="channel-1"
        )
        backup = self.store.create_backup("manual", retention_count=10)
        self.store.apply_operations(
            "Kuro", [self.preference("discord:u2", "海獺", "海獺喜歡巧克力冰棒。")], request_id="r2", channel_id="channel-1"
        )

        result = self.store.restore_backup(backup["id"], retention_count=10)

        self.assertEqual(result["status"], "restored_backup")
        self.assertEqual(result["restored_active_count"], 1)
        memories = self.store.list_memories("Kuro")
        self.assertEqual([item["memory_value"] for item in memories], ["肉圓喜歡紅豆冰棒。"])
        self.assertEqual(len(FakeClient.collection.items), 1)
        backups, count = self.store.list_backups()
        self.assertEqual(count, 2)
        self.assertEqual({item["reason"] for item in backups}, {"manual", "pre-restore"})

    def test_backup_retention_keeps_latest_snapshots(self):
        for _ in range(4):
            self.store.create_backup("auto", retention_count=2)
        backups, count = self.store.list_backups()
        self.assertEqual(count, 2)
        self.assertEqual(len(backups), 2)

    def test_startup_backup_is_skipped_when_a_recent_snapshot_exists(self):
        first = self.store.create_backup("manual", retention_count=5)
        result = self.store.create_backup_if_stale("startup", 86400, retention_count=5)
        backups, count = self.store.list_backups()

        self.assertEqual(result["status"], "skipped_recent")
        self.assertEqual(result["backup"]["id"], first["id"])
        self.assertGreater(result["seconds_until_next"], 0)
        self.assertEqual(count, 1)
        self.assertEqual(len(backups), 1)


if __name__ == "__main__":
    unittest.main()
