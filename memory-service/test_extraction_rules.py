import unittest

from extraction_rules import validate_operations


KNOWN = [
    {"id": "discord:594197917477109773", "display_name": "肉圓", "role": "current_speaker"},
    {"id": "discord:566279354343096323", "display_name": "海獺", "role": "recent_speaker"},
    {"id": "kuro", "display_name": "Kuro", "role": "assistant"},
]


def turn(text: str, recent_context: str = "") -> dict:
    return {
        "user_id": "594197917477109773",
        "display_name": "肉圓",
        "channel_id": "discord:1530594800540057781",
        "user_text": text,
        "recent_context": recent_context,
    }


class ExtractionRuleTests(unittest.TestCase):
    def test_accepts_explicit_first_person_preference_as_event_memory(self):
        accepted, rejected = validate_operations(
            [{
                "action": "ADD",
                "scope": "channel",
                "category": "user_preference",
                "attribute_key": "food.ice_pop.flavor",
                "summary": "肉圓表示喜歡紅豆口味的冰棒。",
                "participants": [{"id": "discord:594197917477109773", "role": "speaker"}],
                "importance": 0.6,
                "confidence": 1.0,
            }],
            turn("我喜歡吃紅豆口味的冰棒"),
            KNOWN,
        )
        self.assertEqual(rejected, [])
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]["category"], "user_preference")
        self.assertEqual(accepted[0]["scope_id"], "1530594800540057781")

    def test_rejects_identity_question_even_if_model_calls_it_memory(self):
        accepted, rejected = validate_operations(
            [{
                "action": "ADD",
                "scope": "channel",
                "category": "conversation_event",
                "attribute_key": "assistant.identity",
                "summary": "Kuro 確認自己不是千和或小黑。",
                "participants": [{"id": "kuro"}],
                "importance": 0.8,
                "confidence": 1.0,
            }],
            turn("你是千和還是小黑？"),
            KNOWN,
        )
        self.assertEqual(accepted, [])
        self.assertIn("assistant_identity_belongs_to_character_card", rejected[0])

    def test_rejects_assistant_derived_preference(self):
        accepted, rejected = validate_operations(
            [{
                "action": "ADD",
                "scope": "channel",
                "category": "conversation_event",
                "attribute_key": "preferred_name",
                "summary": "Kuro 不喜歡被叫小黑。",
                "participants": [{"id": "kuro"}],
                "importance": 0.8,
                "confidence": 0.9,
            }],
            turn("小黑就是啊"),
            KNOWN,
        )
        self.assertEqual(accepted, [])
        self.assertIn("assistant_identity_belongs_to_character_card", rejected[0])

    def test_global_scope_is_limited_to_important_decisions_or_summaries(self):
        accepted, _ = validate_operations(
            [{
                "action": "ADD",
                "scope": "global",
                "category": "user_preference",
                "attribute_key": "drink",
                "summary": "肉圓表示喜歡咖啡。",
                "participants": [{"id": "discord:594197917477109773"}],
                "importance": 0.8,
                "confidence": 0.9,
            }],
            turn("我喜歡咖啡"),
            KNOWN,
        )
        self.assertEqual(accepted[0]["scope"], "channel")

    def test_accepts_explicit_group_decision(self):
        accepted, rejected = validate_operations(
            [{
                "action": "ADD",
                "scope": "global",
                "category": "decision",
                "attribute_key": "project.ai_provider",
                "summary": "大家決定專案改用新的 AI API。",
                "participants": [
                    {"id": "discord:594197917477109773"},
                    {"id": "discord:566279354343096323"},
                ],
                "importance": 0.85,
                "confidence": 0.95,
            }],
            turn("我們決定專案改用新的 AI API"),
            KNOWN,
        )
        self.assertEqual(rejected, [])
        self.assertEqual(accepted[0]["scope"], "global")


if __name__ == "__main__":
    unittest.main()
