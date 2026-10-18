import asyncio
import base64
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from maim_message import MessageBase

from desktop_adapter.bridge import DesktopBridge
from desktop_adapter.config import Config, Identity
from desktop_adapter.protocol import build_inbound, build_reply

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
IDENTITY = Identity("desktop_pet", "mai_desktop_pet", "desktop_owner", "你", "work")


def request(text="你好", request_id="request-1", **params):
    return {"v": 1, "type": "request", "method": "chat", "id": request_id,
            "params": {"text": text, **params}}


def reply(segment=None, **additional):
    return {"message_info": {
        "platform": IDENTITY.platform, "message_id": "core-reply-1", "time": 1.0,
        "user_info": {"platform": IDENTITY.platform, "user_id": "bot", "user_nickname": "麦麦"},
        "additional_config": {"platform_io_target_user_id": IDENTITY.user_id,
                              "platform_io_account_id": IDENTITY.account_id,
                              "platform_io_scope": IDENTITY.scope, **additional}},
        "message_segment": segment or {"type": "text", "data": "你好呀"}}


class ConfigTests(unittest.TestCase):
    def load(self, content):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            path.write_text(content, encoding="utf-8")
            return Config.load(path)

    def setUp(self):
        self.example = (Path(__file__).parents[1] / "config.example.toml").read_text("utf-8")
        self.env = patch.dict(os.environ, {"MAI_DESKTOP_TOKEN": "t" * 40, "MAIBOT_TOKEN": "raw-secret"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_environment_tokens_and_secret_repr(self):
        config = self.load(self.example)
        self.assertEqual(config.maibot_token, "raw-secret")
        self.assertNotIn("raw-secret", repr(config))
        self.assertNotIn("t" * 40, repr(config))

    def test_reserved_or_mixed_case_platform(self):
        for value in ["webui", "bot_console", "maisaka_cli", "unknown", "Desktop_Pet"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.load(self.example.replace('platform = "desktop_pet"', f'platform = "{value}"'))

    def test_invalid_endpoint_or_embedded_credentials(self):
        for value in ["http://localhost/ws", "ws://localhost:8090/desktop", "ws://a:b@localhost/ws",
                      "ws://localhost/ws?api_key=secret", "ws://localhost:99999/ws"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.load(self.example.replace("ws://127.0.0.1:8000/ws", value))

    def test_container_endpoint_is_supported(self):
        self.assertEqual(self.load(self.example.replace("127.0.0.1:8000", "maibot:8000")).maibot_url,
                         "ws://maibot:8000/ws")

    def test_empty_identity_and_old_plugin_config_rejected(self):
        for content in [self.example.replace('user_id = "desktop_owner"', 'user_id = ""'),
                        '[plugin]\nenabled = true']:
            with self.subTest(content=content), self.assertRaises(ValueError):
                self.load(content)


class MessageTests(unittest.TestCase):
    def test_private_message_parses_with_official_library(self):
        message = build_inbound(IDENTITY, request(), "小明")
        parsed = MessageBase.from_dict(message).to_dict()
        self.assertEqual(parsed["message_info"]["user_info"]["user_nickname"], "小明")
        self.assertEqual(message["message_info"]["additional_config"], {
            "platform_io_account_id": "mai_desktop_pet", "platform_io_scope": "work",
            "platform_io_target_user_id": "desktop_owner"})
        self.assertIsInstance(message["message_info"]["time"], float)

    def test_image_data_url_prefix_is_removed_and_text_keeps_order(self):
        message = build_inbound(IDENTITY, request(image=f"data:image/png;base64,{PNG}"), "你")
        self.assertEqual(message["message_segment"], {"type": "seglist", "data": [
            {"type": "text", "data": "你好"}, {"type": "image", "data": PNG}]})

    def test_empty_scope_and_image_only(self):
        identity = Identity("desktop_pet", "bot", "user")
        message = build_inbound(identity, request("", image=f"data:image/png;base64,{PNG}"), "你")
        self.assertNotIn("platform_io_scope", message["message_info"]["additional_config"])
        self.assertEqual(message["message_segment"]["type"], "image")

    def test_invalid_input_and_proactive_are_rejected(self):
        invalid = [request(""), request(123), request("a" * 12001), request(image="https://example.org/a.png"),
                   request(image="data:image/png;base64,broken="), {**request(), "method": "proactive"}]
        for value in invalid:
            with self.subTest(value=str(value)[:80]), self.assertRaises(ValueError):
                build_inbound(IDENTITY, value, "你")

    def test_nested_reply_text_image_emoji_voice(self):
        audio = base64.b64encode(b"RIFF\x04\x00\x00\x00WAVE").decode()
        segment = {"type": "seglist", "data": [
            {"type": "text", "data": "你好"}, {"type": "seglist", "data": [
                {"type": "emoji", "data": PNG}, {"type": "voice", "data": audio}]}]}
        result = build_reply(IDENTITY, reply(segment), "channel")
        self.assertEqual(result["sessionId"], "channel")
        self.assertEqual([s["type"] for s in result["segments"]], ["text", "image", "audio"])
        self.assertEqual(result["segments"][1]["dataUrl"], f"data:image/png;base64,{PNG}")
        self.assertTrue(result["segments"][2]["dataUrl"].startswith("data:audio/wav;"))

    def test_wrong_recipient_account_scope_group_and_missing_target_rejected(self):
        invalid = [reply(platform_io_target_user_id="other"), reply(platform_io_account_id="other"),
                   reply(platform_io_scope="other"), reply()]
        invalid[-1]["message_info"]["additional_config"].pop("platform_io_target_user_id")
        grouped = reply()
        grouped["message_info"]["group_info"] = {"group_id": "group"}
        invalid.append(grouped)
        invalid.append({**reply(), "account_id": "other"})
        invalid.append({**reply(), "scope": "other"})
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                build_reply(IDENTITY, value, "channel")

    def test_unknown_segments_skip_without_losing_text(self):
        result = build_reply(IDENTITY, reply({"type": "seglist", "data": [
            {"type": "file", "data": {}}, {"type": "text", "data": "仍可聊天"}]}), "channel")
        self.assertEqual(result["segments"], [{"type": "text", "text": "仍可聊天"}])

    def test_long_unicode_reply_chunks_for_javascript_limit(self):
        text = "长😀" * 8001
        result = build_reply(IDENTITY, reply({"type": "text", "data": text}), "channel")
        self.assertEqual("".join(part["text"] for part in result["segments"]), text)
        self.assertTrue(all(len(part["text"].encode("utf-16-le")) // 2 <= 12000
                            for part in result["segments"]))

    def test_oversized_or_remote_media_and_malformed_message_rejected(self):
        for segment in [{"type": "image", "data": "https://example.org/a.png"},
                        {"type": "voice", "data": "a" * 12_000_004},
                        {"type": "seglist", "data": [{"type": "text", "data": "x"}] * 101}]:
            with self.subTest(segment=str(segment)[:80]), self.assertRaises(ValueError):
                build_reply(IDENTITY, reply(segment), "channel")
        with self.assertRaises(ValueError):
            build_reply(IDENTITY, [], "channel")


class Socket:
    def __init__(self):
        self.frames = []
        self.sent = asyncio.Event()
        self.close = AsyncMock()

    async def send(self, raw):
        self.frames.append(json.loads(raw))
        self.sent.set()


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        config = Config("ws://127.0.0.1:8000/ws", "ws://127.0.0.1:18765/maibot",
                        IDENTITY, "core-token", "desktop-token-" + "x" * 32)
        self.client = AsyncMock()
        self.client.is_connected = lambda: True
        self.client.send_message.return_value = True
        self.client.send_custom_message.return_value = True
        self.bridge = DesktopBridge(config, self.client)
        self.socket = Socket()
        self.bridge.socket = self.socket
        self.bridge.ready = True

    async def test_duplicate_request_is_not_submitted_twice(self):
        await self.bridge._request(request(), self.socket)
        await self.bridge._request(request(), self.socket)
        self.client.send_message.assert_awaited_once()
        self.assertTrue(self.socket.frames[-1]["ok"])

    async def test_uncertain_request_not_replayed(self):
        self.client.send_message.return_value = False
        await self.bridge._request(request(), self.socket)
        self.client.send_message.return_value = True
        await self.bridge._request(request(), self.socket)
        self.client.send_message.assert_awaited_once()
        self.assertEqual(self.socket.frames[-1]["error"]["code"], "delivery_unknown")

    async def test_proactive_is_not_injected_as_user_chat(self):
        await self.bridge._request({**request(), "method": "proactive"}, self.socket)
        self.client.send_message.assert_not_awaited()
        self.assertFalse(self.socket.frames[-1]["ok"])

    async def test_same_id_with_different_content_closes_connection(self):
        await self.bridge._request(request(), self.socket)
        await self.bridge._request(request("different"), self.socket)
        self.client.send_message.assert_awaited_once()
        self.socket.close.assert_awaited_once()

    async def test_echo_only_after_save_and_no_duplicate_reply(self):
        task = asyncio.create_task(self.bridge.receive(reply()))
        await asyncio.wait_for(self.socket.sent.wait(), 1)
        self.client.send_custom_message.assert_not_awaited()
        frame = self.socket.frames[-1]
        self.bridge.pending_replies[frame["id"]].set_result(True)
        await task
        self.client.send_custom_message.assert_awaited_with("message_id_echo", {
            "type": "echo", "echo": "core-reply-1", "actual_id": frame["id"]})
        await self.bridge.receive(reply())
        self.assertEqual(len(self.socket.frames), 1)

    async def test_failed_save_does_not_echo(self):
        task = asyncio.create_task(self.bridge.receive(reply()))
        await asyncio.wait_for(self.socket.sent.wait(), 1)
        self.bridge.pending_replies[self.socket.frames[-1]["id"]].set_result(False)
        await task
        self.client.send_custom_message.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
