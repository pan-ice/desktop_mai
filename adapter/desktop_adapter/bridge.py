"""桌宠侧连接；MaiBot 侧连接与重连由官方 MessageClient 管理。"""

import asyncio
from collections import OrderedDict
import hashlib
import json
import logging
import time
from uuid import uuid4

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake

from . import __version__
from .config import Config
from .protocol import CAPABILITIES, MAX_FRAME, build_inbound, build_reply

logger = logging.getLogger(__name__)


class DesktopBridge:
    def __init__(self, config: Config, client):
        self.config = config
        self.client = client
        self.socket = None
        self.ready = False
        # 桌宠 sessionId 字段在 Legacy 模式只是稳定的本地路由标识，不是内核会话 ID。
        route = json.dumps(config.identity.desktop_identity(), sort_keys=True).encode()
        self.channel_id = "legacy-" + hashlib.sha256(route).hexdigest()[:40]
        self.started_at = time.time_ns() // 1_000_000
        self.instance_id = str(uuid4())
        self.user_name = config.identity.user_name
        self.pending_replies: dict[str, asyncio.Future] = {}
        self.requests: OrderedDict[str, tuple[str, dict]] = OrderedDict()
        self.delivered: OrderedDict[str, None] = OrderedDict()
        self.request_lock = asyncio.Lock()
        self.reply_lock = asyncio.Lock()

    async def run(self) -> None:
        attempts = 0
        while True:
            while not self.client.is_connected():
                await asyncio.sleep(0.1)
            try:
                async with connect(
                    self.config.desktop_url,
                    additional_headers={"Authorization": f"Bearer {self.config.desktop_token}"},
                    max_size=MAX_FRAME, compression=None, open_timeout=5,
                    ping_interval=20, ping_timeout=10, close_timeout=2,
                    proxy=None,
                ) as socket:
                    self.socket = socket
                    await self._send({"v": 1, "type": "hello", "protocol": "mai-desktop",
                                      "pluginVersion": __version__, "instanceId": self.instance_id,
                                      "startedAt": self.started_at,
                                      "identity": self.config.identity.desktop_identity()})
                    welcome = json.loads(await asyncio.wait_for(socket.recv(), 5))
                    if not isinstance(welcome, dict) or welcome.get("v") != 1 or welcome.get("type") != "welcome":
                        raise ValueError("桌宠握手协议不兼容")
                    name = welcome.get("userName")
                    if isinstance(name, str) and name.strip() and len(name) <= 100:
                        self.user_name = name
                    if not self.client.is_connected():
                        continue
                    await self._send({"v": 1, "type": "ready", "sessionId": self.channel_id,
                                      "transport": "legacy", "capabilities": CAPABILITIES})
                    self.ready = True
                    attempts = 0
                    logger.info("桌宠已连接；使用经典消息协议，无内核接收 ACK")
                    monitor = asyncio.create_task(self._watch_core(socket))
                    requests: set[asyncio.Task] = set()
                    try:
                        async for raw in socket:
                            frame = json.loads(raw)
                            if not isinstance(frame, dict) or frame.get("v") != 1:
                                raise ValueError("无效的桌宠帧")
                            if frame.get("type") == "reply_ack":
                                future = self.pending_replies.get(frame.get("id"))
                                if future and not future.done():
                                    future.set_result(frame.get("ok") is True)
                            elif frame.get("type") == "request":
                                if len(requests) >= 32:
                                    raise ValueError("桌宠待处理请求过多")
                                task = asyncio.create_task(self._handle_request(frame, socket))
                                requests.add(task)
                                task.add_done_callback(requests.discard)
                            else:
                                raise ValueError("未知的桌宠消息类型")
                    finally:
                        self.ready = False
                        monitor.cancel()
                        for task in requests:
                            task.cancel()
                        await asyncio.gather(monitor, *requests, return_exceptions=True)
            except ConnectionClosed as exc:
                logger.warning("桌宠连接断开 code=%s", exc.rcvd.code if exc.rcvd else "abnormal")
                if exc.rcvd and exc.rcvd.code in {1008, 1012}:
                    raise RuntimeError("桌宠拒绝身份/协议，或已有新适配器接管；检查配置后重新启动") from None
            except (OSError, TimeoutError):
                logger.warning("桌宠连接暂不可用，等待重连")
            except InvalidHandshake:
                raise RuntimeError("桌宠握手被拒绝，请检查桌宠地址和独立令牌") from None
            finally:
                self.ready = False
                self.socket = None
                for future in self.pending_replies.values():
                    if not future.done():
                        future.set_result(False)
            await asyncio.sleep(min(2 ** attempts, 10))
            attempts = min(attempts + 1, 4)

    async def _watch_core(self, socket) -> None:
        while self.client.is_connected():
            await asyncio.sleep(0.1)
        logger.warning("MaiBot 已断开，暂停桌宠接入；未确认请求不自动重放")
        await socket.close(1013, "MaiBot disconnected")

    async def _send(self, frame: dict, socket=None) -> None:
        encoded = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode()) > MAX_FRAME:
            raise ValueError("消息超过桌宠 16 MB 帧上限")
        target = socket or self.socket
        if target is None:
            raise ConnectionError("桌宠未连接")
        await target.send(encoded)

    async def _request(self, frame: dict, socket) -> None:
        # 官方消息服务并发处理，适配器只保证按桌宠请求顺序提交。
        async with self.request_lock:
            request_id = frame.get("id")
            if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
                await socket.close(1008, "invalid request id")
                return
            fingerprint = hashlib.sha256(json.dumps(frame, sort_keys=True).encode()).hexdigest()
            previous = self.requests.get(request_id)
            if previous:
                if previous[0] != fingerprint:
                    await socket.close(1008, "request id reused")
                    return
                await self._send(previous[1], socket)
                return
            result = {"v": 1, "type": "result", "id": request_id, "ok": False}
            try:
                if frame.get("method") == "proactive":
                    raise ValueError("经典消息协议不支持主动陪伴任务，请使用网关插件")
                message = build_inbound(self.config.identity, frame, self.user_name)
                if not self.client.is_connected():
                    result["error"] = {"code": "unavailable", "message": "MaiBot 消息服务未连接"}
                else:
                    # 先记录不确定状态。取消/断线后相同 ID 也不会再次提交。
                    result["error"] = {"code": "delivery_unknown", "message": "发送中断，MaiBot 是否接收未确认"}
                    self._remember(self.requests, request_id, (fingerprint, result.copy()))
                    sent = await asyncio.wait_for(self.client.send_message(message), 10)
                    if sent:
                        result = {"v": 1, "type": "result", "id": request_id, "ok": True}
                        logger.info("已发送桌宠消息 id=%s（传输完成，无内核 ACK）", request_id)
            except ValueError as exc:
                result["error"] = {"code": "invalid_request", "message": str(exc)[:500]}
            except (OSError, TimeoutError):
                result["error"] = {"code": "delivery_unknown", "message": "发送中断，MaiBot 是否接收未确认"}
            self._remember(self.requests, request_id, (fingerprint, result))
            try:
                await self._send(result, socket)
            except ConnectionClosed:
                pass

    async def _handle_request(self, frame: dict, socket) -> None:
        try:
            await self._request(frame, socket)
        except (ConnectionClosed, OSError):
            logger.warning("桌宠请求连接已中断；未确认请求不自动重放")

    @staticmethod
    def _remember(cache: OrderedDict, key: str, value) -> None:
        cache[key] = value
        cache.move_to_end(key)
        if len(cache) > 2000:
            cache.popitem(last=False)

    async def receive(self, message: dict) -> None:
        # 串行化实际平台投递及回执，防止同一出站消息并发重复展示。
        async with self.reply_lock:
            try:
                reply = build_reply(self.config.identity, message, self.channel_id)
                if reply["id"] not in self.delivered:
                    if not self.ready or not self.socket:
                        logger.warning("桌宠离线，未投递回复；经典协议没有离线队列")
                        return
                    future = asyncio.get_running_loop().create_future()
                    self.pending_replies[reply["id"]] = future
                    try:
                        await self._send(reply)
                        saved = await asyncio.wait_for(future, 15)
                        if not saved:
                            logger.warning("桌宠未保存回复，不发送 message_id_echo")
                            return
                    finally:
                        self.pending_replies.pop(reply["id"], None)
                    self._remember(self.delivered, reply["id"], None)
                # 仅在桌宠媒体及历史持久化后回传真实平台消息 ID。
                echoed = await self.client.send_custom_message("message_id_echo", {
                    "type": "echo", "echo": message["message_info"]["message_id"],
                    "actual_id": reply["id"],
                })
                if not echoed:
                    logger.warning("回复已保存，但 message_id_echo 未发送")
            except (ValueError, OSError, TimeoutError, ConnectionClosed) as exc:
                logger.warning("回复未投递：%s", str(exc)[:200])
