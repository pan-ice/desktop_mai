import asyncio
import base64
import json
import os
from pathlib import Path
import tempfile
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from maim_message import MessageBase
from websockets.asyncio.server import serve
from websockets.datastructures import Headers

from desktop_adapter.bridge import DesktopBridge, _supports_bot_name
from desktop_adapter.config import Config, Identity
from desktop_adapter.protocol import build_inbound, build_reply, reply_name

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


def named_reply(name="麦小萌", **additional):
    message = reply(**additional)
    message["message_info"]["user_info"].update(user_id=IDENTITY.account_id, user_nickname=name)
    return message


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
    def test_bot_name_only_uses_verified_bot_sender_and_route(self):
        self.assertEqual(reply_name(IDENTITY, named_reply("  麦小萌  ")), "麦小萌")
        self.assertEqual(reply_name(IDENTITY, named_reply("😀" * 20)), "😀" * 20)
        self.assertIsNone(reply_name(IDENTITY, reply()))
        for value in [named_reply(platform_io_target_user_id="other"),
                      named_reply(platform_io_account_id="other"), named_reply(platform_io_scope="other")]:
            with self.subTest(value=value):
                self.assertIsNone(reply_name(IDENTITY, value))
        for value in [None, [], "not sender"]:
            message = named_reply()
            message["message_info"]["user_info"] = value
            self.assertIsNone(reply_name(IDENTITY, message))
        message = named_reply()
        message["message_info"]["user_info"]["platform"] = "other"
        self.assertIsNone(reply_name(IDENTITY, message))
        message["message_info"].pop("user_info")
        message["sender_info"] = {"user_info": {"user_nickname": "不能从其他字段猜名字"}}
        self.assertIsNone(reply_name(IDENTITY, message))

    def test_invalid_bot_name_is_ignored_without_truncation(self):
        for value in [None, 123, [], "", "   ", "\n麦麦", "麦\t麦", "麦\x00麦", "麦\x7f麦",
                      "麦\x85麦", "麦" * 41, "😀" * 21, "\ud800"]:
            with self.subTest(value=repr(value)):
                self.assertIsNone(reply_name(IDENTITY, named_reply(value)))
        self.assertNotIn("botName", build_reply(IDENTITY, named_reply(), "channel"))

    def test_name_capability_requires_an_exact_negotiated_header_token(self):
        for values, expected in [([], False), (["bot-name-extra"], False),
                                 (["other, bot-name"], True), (["other", "bot-name"], True)]:
            with self.subTest(values=values):
                headers = Headers(("X-Mai-Desktop-Features", value) for value in values)
                socket = SimpleNamespace(response=SimpleNamespace(headers=headers))
                self.assertEqual(_supports_bot_name(socket), expected)
        self.assertFalse(_supports_bot_name(SimpleNamespace()))

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

    def test_unknown_segment_rejects_whole_reply_without_false_save_ack(self):
        with self.assertRaisesRegex(ValueError, "不支持"):
            build_reply(IDENTITY, reply({"type": "seglist", "data": [
                {"type": "future-type", "data": {}}, {"type": "text", "data": "不能只保存这一段"}]}), "channel")

    def test_legacy_mentions_and_reply_ids_are_readable(self):
        result = build_reply(IDENTITY, reply({"type": "seglist", "data": [
            {"type": "at", "data": "desktop_owner"}, {"type": "reply", "data": "previous"},
            {"type": "text", "data": "回复正文"}]}), "channel")
        text = "".join(part["text"] for part in result["segments"])
        self.assertIn("@对方", text)
        self.assertIn("[引用消息]", text)
        self.assertIn("回复正文", text)

    def test_unsupported_content_is_not_silently_saved_as_a_partial_reply(self):
        for kind, data in [("file", {"name": "报告.pdf"}), ("forward", []),
                           ("dict", {"type": "card", "data": {}})]:
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "不支持"):
                build_reply(IDENTITY, reply({"type": "seglist", "data": [
                    {"type": "text", "data": "附件在后面"}, {"type": kind, "data": data}]}), "channel")

    def test_unsupported_audio_is_not_mislabeled_as_mp3_or_wav(self):
        for raw in (b"RIFF0000WEBP", b"\xff\xf1\x50\x80", b"not an audio file"):
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, "语音格式"):
                build_reply(IDENTITY, reply({"type": "voice", "data": base64.b64encode(raw).decode()}), "channel")

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

    async def ack_reply(self, message):
        self.socket.sent.clear()
        task = asyncio.create_task(self.bridge.receive(message))
        await asyncio.wait_for(self.socket.sent.wait(), 1)
        frame = self.socket.frames[-1]
        self.bridge.pending_replies[frame["id"]].set_result(True)
        await task
        return frame

    async def test_bot_name_is_only_added_to_negotiated_desktop_replies(self):
        frame = await self.ack_reply(named_reply())
        self.assertNotIn("botName", frame)
        self.assertEqual(self.bridge.bot_name, "麦小萌")
        self.bridge.bot_name_supported = True
        message = named_reply("新名字")
        message["message_info"]["message_id"] = "second-reply"
        frame = await self.ack_reply(message)
        self.assertEqual(frame["botName"], "新名字")
        self.assertEqual(self.bridge.bot_name, "新名字")

    async def test_missing_invalid_or_foreign_sender_name_does_not_change_known_name(self):
        self.bridge.bot_name_supported = True
        self.bridge.bot_name = "当前机器人"
        for index, message in enumerate([named_reply("bad\x00name"), named_reply("麦" * 41), reply()]):
            message["message_info"]["message_id"] = f"missing-name-{index}"
            frame = await self.ack_reply(message)
            self.assertNotIn("botName", frame)
            self.assertEqual(self.bridge.bot_name, "当前机器人")

    async def test_rejected_reply_never_poisons_known_bot_name(self):
        self.bridge.bot_name_supported = True
        self.bridge.bot_name = "当前机器人"
        invalid_segment = named_reply("不应采用")
        invalid_segment["message_segment"] = {"type": "file", "data": {"name": "test"}}
        for message in [named_reply("不应采用", platform_io_target_user_id="other"),
                        named_reply("不应采用", platform_io_account_id="other"),
                        named_reply("不应采用", platform_io_scope="other"), invalid_segment]:
            await self.bridge.receive(message)
            self.assertEqual(self.bridge.bot_name, "当前机器人")
        self.assertEqual(self.socket.frames, [])
        self.client.send_custom_message.assert_not_awaited()

    async def test_offline_reply_does_not_cache_a_name_for_a_future_desktop(self):
        self.bridge.ready = False
        await self.bridge.receive(named_reply())
        self.assertIsNone(self.bridge.bot_name)
        self.assertEqual(self.socket.frames, [])

    async def test_core_disconnect_clears_metadata_before_socket_close(self):
        self.bridge.bot_name = "旧连接"
        self.bridge.bot_name_supported = True
        self.client.is_connected = lambda: False

        async def closed(*_args):
            self.assertIsNone(self.bridge.bot_name)
            self.assertFalse(self.bridge.bot_name_supported)

        self.socket.close.side_effect = closed
        await self.bridge._watch_core(self.socket)
        self.socket.close.assert_awaited_once_with(1013, "MaiBot disconnected")

    async def test_real_handshake_negotiates_metadata_and_discards_previous_name(self):
        for features in [[], ["other", "bot-name"]]:
            with self.subTest(features=features):
                frames = []
                ready = asyncio.Event()
                received = asyncio.Event()

                def response_headers(_connection, _request, response):
                    for value in features:
                        response.headers["X-Mai-Desktop-Features"] = value

                async def desktop(socket):
                    frames.append(json.loads(await socket.recv()))
                    await socket.send(json.dumps({"v": 1, "type": "welcome", "userName": "测试用户"}))
                    frames.append(json.loads(await socket.recv()))
                    ready.set()
                    async for raw in socket:
                        frame = json.loads(raw)
                        frames.append(frame)
                        if frame.get("type") == "reply":
                            await socket.send(json.dumps({"v": 1, "type": "reply_ack",
                                                          "id": frame["id"], "ok": True}))
                            received.set()

                async with serve(desktop, "127.0.0.1", 0, process_response=response_headers) as server:
                    port = server.sockets[0].getsockname()[1]
                    self.bridge.config = replace(self.bridge.config, desktop_url=f"ws://127.0.0.1:{port}/maibot")
                    self.bridge.bot_name = "上次连接的名字"
                    self.bridge.bot_name_supported = True
                    self.bridge.delivered.clear()
                    runner = asyncio.create_task(self.bridge.run())
                    try:
                        await asyncio.wait_for(ready.wait(), 2)
                        self.assertEqual(frames[0]["type"], "hello")
                        self.assertEqual(frames[1]["type"], "ready")
                        self.assertNotIn("botName", frames[1])
                        self.assertIsNone(self.bridge.bot_name)
                        self.assertEqual(self.bridge.bot_name_supported, bool(features))
                        await self.bridge.receive(named_reply())
                        await asyncio.wait_for(received.wait(), 2)
                        self.assertEqual(frames[-1].get("botName"), "麦小萌" if features else None)
                    finally:
                        runner.cancel()
                        await asyncio.gather(runner, return_exceptions=True)
                    self.assertIsNone(self.bridge.bot_name)
                    self.assertFalse(self.bridge.bot_name_supported)

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

    async def test_unsupported_reply_does_not_send_partial_content_or_success_echo(self):
        await self.bridge.receive(reply({"type": "seglist", "data": [
            {"type": "text", "data": "不能只收到这一段"}, {"type": "file", "data": {"name": "附件.pdf"}}]}))
        self.assertEqual(self.socket.frames, [])
        self.client.send_custom_message.assert_not_awaited()
        self.assertEqual(self.bridge.delivered, {})


if __name__ == "__main__":
    unittest.main()
