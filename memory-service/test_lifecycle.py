import unittest
from datetime import datetime, timedelta, timezone

from lifecycle import (
    decayed_importance,
    normalize_key,
    retrieval_score,
    should_archive,
)


class LifecycleTests(unittest.TestCase):
    def test_normalize_key_is_stable(self):
        self.assertEqual(normalize_key("  喜歡　咖啡  "), "喜歡 咖啡")

    def test_core_memory_does_not_decay(self):
        old = datetime.now(timezone.utc) - timedelta(days=3650)
        self.assertEqual(decayed_importance(0.8, "core", old), 0.8)

    def test_daily_memory_decays_quickly(self):
        old = datetime.now(timezone.utc) - timedelta(days=14)
        self.assertLess(decayed_importance(0.8, "daily", old), 0.25)

    def test_event_categories_have_distinct_decay_rates(self):
        old = datetime.now(timezone.utc) - timedelta(days=180)
        event = decayed_importance(0.8, "conversation_event", old)
        preference = decayed_importance(0.8, "user_preference", old)
        relationship = decayed_importance(0.8, "relationship_milestone", old)
        self.assertLess(event, preference)
        self.assertLess(preference, relationship)

    def test_retrieval_score_rewards_semantic_match(self):
        close = retrieval_score(
            cosine_distance=0.1,
            effective_importance=0.5,
            confidence=0.8,
        )
        far = retrieval_score(
            cosine_distance=1.5,
            effective_importance=0.5,
            confidence=0.8,
        )
        self.assertGreater(close, far)

    def test_retrieval_rewards_matching_participant_and_category(self):
        baseline = retrieval_score(
            cosine_distance=0.4,
            effective_importance=0.6,
            confidence=0.9,
            category="conversation_event",
        )
        targeted = retrieval_score(
            cosine_distance=0.4,
            effective_importance=0.6,
            confidence=0.9,
            category="plan_task",
            participant_match=True,
            same_channel=True,
        )
        self.assertGreater(targeted, baseline)

    def test_core_is_never_archived(self):
        self.assertFalse(should_archive(0.01, "core"))
        self.assertTrue(should_archive(0.01, "daily"))


if __name__ == "__main__":
    unittest.main()
