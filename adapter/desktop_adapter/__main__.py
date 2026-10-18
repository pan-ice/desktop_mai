import argparse
import asyncio
import logging
from pathlib import Path
import sys

import certifi
from maim_message import MessageClient

from .bridge import DesktopBridge
from .config import Config


async def run(config: Config) -> None:
    identity = config.identity
    logger = logging.getLogger("desktop_adapter")
    client = MessageClient(custom_logger=logger)
    bridge = DesktopBridge(config, client)
    client.register_message_handler(bridge.receive)
    await client.connect(url=config.maibot_url, platform=identity.platform,
                         token=config.maibot_token or None, ssl_verify=certifi.where())
    logger.info("启动独立适配器 platform=%s account_id=%s scope=%s",
                identity.platform, identity.account_id, identity.scope or "<empty>")
    tasks = [asyncio.create_task(client.run()), asyncio.create_task(bridge.run())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await client.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Mai 桌面伙伴独立 MaiBot 适配器（经典消息协议）")
    parser.add_argument("--config", type=Path, default=Path("config.toml"))
    parser.add_argument("--check-config", action="store_true", help="只校验配置，不连接服务")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        config = Config.load(args.config)
        if args.check_config:
            print("配置校验通过；未连接 MaiBot 或桌宠")
            return
        asyncio.run(run(config))
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError, RuntimeError):
        # TOML 解析器可能在错误中带出令牌原文，因此不输出异常内容。
        logging.error("启动失败：检查配置文件、桌宠身份/独立令牌及端口；详情见 adapter/README.md")
        sys.exit(1)


if __name__ == "__main__":
    main()
