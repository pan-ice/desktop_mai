"""用本机 MaiBot 的实际组件和序列化方法生成契约样本，不加载内核配置或数据库。"""

from abc import ABC, abstractmethod
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import __future__
import ast
import asyncio
import base64
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "MaiBot"
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
WAVE = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 28


def source_definitions() -> dict:
    # 只执行上游定义本身。模块级 import 会加载配置、日志和数据库，与协议校验无关。
    path = CORE / "src/common/data_models/message_component_data_model.py"
    tree = ast.parse(path.read_text("utf-8"), filename=str(path))
    tree.body = [node for node in tree.body if isinstance(node, ast.ClassDef) or (
        isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "StandardMessageComponents" for target in node.targets
        )
    )]
    namespace = {**globals(), "ABC": ABC, "abstractmethod": abstractmethod, "deepcopy": deepcopy,
                 "Any": Any, "Dict": Dict, "List": List, "Optional": Optional, "Union": Union, "hashlib": hashlib}
    exec(compile(tree, str(path), "exec", flags=__future__.annotations.compiler_flag), namespace)
    path = CORE / "src/plugin_runtime/host/message_utils.py"
    tree = ast.parse(path.read_text("utf-8"), filename=str(path))
    serializer = next(node for node in tree.body if (
        isinstance(node, ast.ClassDef) and node.name == "PluginMessageUtils"
    ))
    methods = {"_message_sequence_to_dict", "_component_to_dict", "_binary_component_to_base64",
               "_forward_component_to_dict"}
    serializer.body = [node for node in serializer.body if isinstance(node, ast.FunctionDef) and node.name in methods]
    tree.body = [serializer]
    exec(compile(tree, str(path), "exec", flags=__future__.annotations.compiler_flag), namespace)
    return namespace


async def main() -> None:
    mode = sys.argv[1]
    definitions = source_definitions()
    if mode == "legacy":
        from maim_message import BaseMessageInfo, MessageBase, Seg, UserInfo

        definitions.update(BaseMessageInfo=BaseMessageInfo, MessageBase=MessageBase, Seg=Seg, UserInfo=UserInfo)
        sys.path.insert(0, str(ROOT / "adapter"))
        from desktop_adapter.config import Identity
        from desktop_adapter.protocol import build_reply

        identity = Identity("desktop_pet", "mai_desktop_pet", "desktop_owner")

        async def convert(name, components):
            segments = [await item.to_seg() if hasattr(item, "to_seg") else Seg("dict", item.data)
                        for item in components]
            message = {"message_info": {"platform": identity.platform, "message_id": name,
                                       "additional_config": {"platform_io_target_user_id": identity.user_id}},
                       "message_segment": Seg("seglist", segments).to_dict()}
            return build_reply(identity, message, "contract-session")
    elif mode == "sdk":
        sys.path.insert(0, str(CORE / "plugins"))
        from desktop_pet_adapter.desktop_adapter.config import Identity
        from desktop_pet_adapter.desktop_adapter.gateway import CoreGateway

        identity = Identity()
        gateway = CoreGateway(None, identity)
        gateway.session_id = "contract-session"
        route = {"platform": identity.platform, "account_id": identity.account_id, "scope": None}

        async def convert(name, components):
            sequence = definitions["MessageSequence"](components)
            raw = definitions["PluginMessageUtils"]._message_sequence_to_dict(sequence)
            reply = await gateway.outbound(
                {"message_id": name, "session_id": "contract-session", "raw_message": raw}, route,
            )
            return {"v": 1, "type": "reply", **reply}
    else:
        raise ValueError("mode must be legacy or sdk")

    def component(component_type, *args, **kwargs):
        return definitions[component_type](*args, **kwargs)

    mixed = [component("TextComponent", "图片之前"),
             component("EmojiComponent", binary_hash="", content="图片描述不是媒体", binary_data=base64.b64decode(PNG)),
             component("TextComponent", "图片之后，音频之前"),
             component("VoiceComponent", binary_hash="", content="音频描述不是媒体", binary_data=WAVE),
             component("AtComponent", "desktop_owner", "小明"),
             component("ReplyComponent", "previous", "引用的原话", "user", "朋友"),
             component("TextComponent", "回复正文")]
    frames = [await convert("mixed", mixed), await convert("long", [component("TextComponent", "长😀" * 4001)])]
    unsupported = {
        "file": component("FileComponent", name="报告.pdf", url="https://example.org/report.pdf"),
        "forward": component("ForwardNodeComponent", [
            component("ForwardComponent", "朋友", "node", [component("TextComponent", "转发内容")]),
        ]),
        "dict": component("DictComponent", {"type": "card", "data": {"title": "自定义卡片"}}),
    }
    rejected = []
    for kind, item in unsupported.items():
        try:
            await convert(kind, [component("TextComponent", "不能只保存正文"), item])
        except ValueError:
            rejected.append(kind)
    print(json.dumps({"frames": frames, "rejected": rejected}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
