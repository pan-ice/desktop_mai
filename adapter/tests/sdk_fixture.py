"""真实 maim_message MessageServer + 独立适配器，不启动 LLM / 用户 MaiBot。"""

import asyncio
import json
import logging
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).parents[1]))

from maim_message import MessageBase, MessageServer

from desktop_adapter.__main__ import run
from desktop_adapter.config import Config


def emit(event, **values):
    print(json.dumps({"event": event, **values}, ensure_ascii=False), flush=True)


async def main():
    config = Config.load(Path(sys.argv[1]))
    bot_name = os.environ.get("MAI_TEST_BOT_NAME", "麦麦")
    server = MessageServer(host="127.0.0.1", port=urlsplit(config.maibot_url).port,
                           enable_token=True, custom_logger=logging.getLogger("fixture"))
    server.add_valid_token(config.maibot_token)

    async def inbound(message):
        parsed = MessageBase.from_dict(message).to_dict()
        emit("inbound", message=parsed)
        info = parsed["message_info"]
        identity = config.identity
        body = message["message_segment"]
        response = {"message_info": {
            "platform": identity.platform, "message_id": "reply-" + info["message_id"],
            "time": float(info["time"]),
            "user_info": {"platform": identity.platform, "user_id": identity.account_id,
                          "user_nickname": bot_name},
            "additional_config": {"platform_io_account_id": identity.account_id,
                                  "platform_io_scope": identity.scope,
                                  "platform_io_target_user_id": identity.user_id}},
            "message_segment": {"type": "seglist", "data": [
                {"type": "text", "data": "真实消息服务回复"}, body]}}
        if body.get("type") == "seglist" and body["data"][0].get("data") == "图文顺序测试":
            response["message_segment"] = {"type": "seglist", "data": [
                {"type": "text", "data": "图片之前"}, body["data"][1],
                {"type": "text", "data": "图片之后"},
            ]}
        # 先发一条错误收件人的消息，确认适配器不会串话。
        wrong = json.loads(json.dumps(response))
        wrong["message_info"]["additional_config"]["platform_io_target_user_id"] = "other-user"
        await server.send_message(MessageBase.from_dict(wrong))
        await server.send_message(MessageBase.from_dict(response))

    async def echo(message):
        emit("echo", content=message["content"])

    server.register_message_handler(inbound)
    server.register_custom_message_handler("message_id_echo", echo)
    server_task = asyncio.create_task(server.run())
    adapter_task = None
    try:
        async with asyncio.timeout(10):
            while not server.connection.server or not server.connection.server.started:
                if server_task.done():
                    server_task.result()
                await asyncio.sleep(0.05)
        adapter_task = asyncio.create_task(run(config))
        emit("started")
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line or line.strip() == "STOP":
                break
            if line.strip() == "DROP_CORE":
                for socket in list(server.connection.active_websockets):
                    await socket.close(code=1012, reason="integration reconnect")
                emit("core_dropped")
            elif line.startswith("BOT_NAME "):
                next_name = line[len("BOT_NAME "):].strip()
                if not next_name or len(next_name) > 40:
                    raise ValueError("测试名字必须为 1–40 字符")
                bot_name = next_name
                emit("bot_name", name=bot_name)
    finally:
        if adapter_task:
            adapter_task.cancel()
            await asyncio.gather(adapter_task, return_exceptions=True)
        await server.stop()
        server_task.cancel()
        await asyncio.gather(server_task, return_exceptions=True)


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    asyncio.run(main())
