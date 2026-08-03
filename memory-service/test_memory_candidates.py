import json
import unittest

from memory_candidates import (
    build_candidate_messages,
    candidate_operations,
    local_skip_reason,
)


KNOWN = [
    {"id": "discord:1", "display_name": "肉圓", "role": "current_speaker"},
    {"id": "discord:2", "display_name": "海獺", "role": "recent_speaker"},
    {"id": "discord:3", "display_name": "Tommy", "role": "mentioned_user"},
    {"id": "kuro", "display_name": "Kuro", "role": "assistant"},
]


def turn(text: str, context: str = "") -> dict:
    return {
        "user_text": text,
        "assistant_text": "……嗯。我記住了。",
        "recent_context": context,
    }


class MemoryCandidateTests(unittest.TestCase):
    def test_empty_candidate_array_creates_no_operation(self):
        self.assertEqual(candidate_operations({"memories": []}), [])
        self.assertEqual(candidate_operations({}), [])

    def test_candidates_are_only_local_add_requests(self):
        operations = candidate_operations({"memories": [{"summary": "肉圓喜歡紅茶。"}]})
        self.assertEqual(operations[0]["action"], "ADD")
        self.assertEqual(operations[0]["id"], "")

    def test_recent_context_is_omitted_for_self_contained_message(self):
        messages = build_candidate_messages(
            turn("我喜歡無糖紅茶", "[海獺] 很久以前的無關對話"),
            [KNOWN[0], KNOWN[1], KNOWN[3]],
        )
        payload = json.loads(messages[1]["content"])
        self.assertNotIn("recent_context", payload)
        self.assertEqual(
            [item["id"] for item in payload["participants"]],
            ["discord:1", "kuro"],
        )

    def test_recent_context_is_included_for_reference(self):
        messages = build_candidate_messages(
            turn("剛才那件事就照這樣決定", "[Tommy] 要把備份保留五份"),
            KNOWN,
        )
        payload = json.loads(messages[1]["content"])
        self.assertIn("備份保留五份", payload["recent_context"])
        self.assertIn("discord:3", [item["id"] for item in payload["participants"]])

    def test_context_speaker_is_mapped_when_only_context_names_them(self):
        messages = build_candidate_messages(
            turn("他剛才提出的方案就這樣決定", "[海獺] 建議每天備份一次"),
            [KNOWN[0], KNOWN[1], KNOWN[3]],
        )
        payload = json.loads(messages[1]["content"])
        self.assertIn("discord:2", [item["id"] for item in payload["participants"]])

    def test_local_prefilter_is_conservative(self):
        self.assertEqual(local_skip_reason(turn("早安")), "simple_greeting")
        self.assertEqual(local_skip_reason(turn("小黑 /newchat")), "bot_command")
        self.assertEqual(local_skip_reason(turn("解釋廣義相對論")), "knowledge_request")
        self.assertEqual(local_skip_reason(turn("我喜歡無糖紅茶")), "")
        self.assertEqual(local_skip_reason(turn("請記住我喜歡無糖紅茶")), "")


if __name__ == "__main__":
    unittest.main()
