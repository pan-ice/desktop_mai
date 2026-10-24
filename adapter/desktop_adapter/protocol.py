"""桌宠协议与 MaiBot Legacy 消息对象间的转换。"""

import base64
import binascii
import hashlib
import re
import time

from .config import Identity

MAX_FRAME = 16 * 1024 * 1024
MAX_MEDIA = 9_000_000
CAPABILITIES = ["chat", "image", "audio"]


def _base64(value: object) -> bytes:
    if not isinstance(value, str) or len(value) > 12_000_000:
        raise ValueError("媒体必须是大小受限的 base64 字符串")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("无效的 base64 媒体") from None
    if not raw or len(raw) > MAX_MEDIA:
        raise ValueError("媒体为空或超过 9 MB")
    return raw


def build_inbound(identity: Identity, request: dict, user_name: str) -> dict:
    if (request.get("v") != 1 or request.get("type") != "request"
            or not isinstance(request.get("id"), str) or not 1 <= len(request["id"]) <= 100):
        raise ValueError("无效的桌宠请求")
    if request.get("method") != "chat":
        raise ValueError("经典消息协议不支持主动陪伴任务")
    params = request.get("params")
    if not isinstance(params, dict) or set(params) - {"text", "image", "source"}:
        raise ValueError("无效的消息参数")
    text = params.get("text", "")
    if not isinstance(text, str) or len(text.encode("utf-16-le")) // 2 > 12000:
        raise ValueError("文本必须是字符串且不超过 12000 字符")
    segments = []
    if text.strip():
        segments.append({"type": "text", "data": text})
    if "image" in params:
        image = params["image"]
        if not isinstance(image, str) or not re.fullmatch(
                r"data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+", image):
            raise ValueError("图片必须是内嵌 base64 data URL")
        encoded = image.split(",", 1)[1]
        _base64(encoded)
        segments.append({"type": "image", "data": encoded})
    if not segments:
        raise ValueError("消息不能为空")
    additional = {"platform_io_account_id": identity.account_id,
                  "platform_io_target_user_id": identity.user_id}
    if identity.scope:
        additional["platform_io_scope"] = identity.scope
    return {
        "message_info": {
            "platform": identity.platform,
            "message_id": request["id"],
            "time": float(time.time()),
            "user_info": {"platform": identity.platform, "user_id": identity.user_id,
                          "user_nickname": user_name or identity.user_name},
            "additional_config": additional,
        },
        "message_segment": segments[0] if len(segments) == 1 else {"type": "seglist", "data": segments},
    }


def _media_url(kind: str, value: object) -> str:
    raw = _base64(value)
    if kind in {"image", "emoji"}:
        if raw.startswith(b"\x89PNG\r\n\x1a\n"):
            mime = "image/png"
        elif raw.startswith(b"\xff\xd8\xff"):
            mime = "image/jpeg"
        elif raw.startswith((b"GIF87a", b"GIF89a")):
            mime = "image/gif"
        elif raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
            mime = "image/webp"
        else:
            raise ValueError("不支持的图片格式")
    elif raw[:4] == b"RIFF" and raw[8:12] == b"WAVE":
        mime = "audio/wav"
    elif raw.startswith(b"OggS"):
        mime = "audio/ogg"
    elif raw.startswith(b"ID3") or (
        len(raw) >= 4 and raw[0] == 0xFF and raw[1] & 0xE0 == 0xE0 and raw[1] & 0x06 != 0
    ):
        mime = "audio/mpeg"
    else:
        raise ValueError("不支持的语音格式（支持 MP3 / WAV / OGG）")
    return f"data:{mime};base64,{value}"


def _reference_text(kind: str, value: object) -> str:
    if not isinstance(value, (str, dict)) or not value:
        raise ValueError(f"{kind}.data 必须包含引用信息")
    if kind == "at":
        if isinstance(value, str):
            return "@全体成员 " if value == "all" else "@对方 "
        name = value.get("target_user_cardname") or value.get("target_user_nickname")
        if name is not None and not isinstance(name, str):
            raise ValueError("at.data 昵称必须是字符串")
        return f"@{name or '对方'} "
    if isinstance(value, str):
        return "[引用消息]\n"
    content = value.get("target_message_content")
    sender = value.get("target_message_sender_cardname") or value.get("target_message_sender_nickname")
    if any(field is not None and not isinstance(field, str) for field in (content, sender)):
        raise ValueError("reply.data 引用内容必须是字符串")
    return f"[引用消息] {sender + '：' if sender else ''}{content or ''}\n"


def _reply_info(identity: Identity, message: dict) -> dict:
    if not isinstance(message, dict):
        raise ValueError("回复必须是消息对象")
    info = message.get("message_info")
    if not isinstance(info, dict) or info.get("platform") != identity.platform:
        raise ValueError("回复平台不匹配")
    if info.get("group_info"):
        raise ValueError("桌宠适配器只接受私聊回复")
    additional = info.get("additional_config") or {}
    if not isinstance(additional, dict) or additional.get("platform_io_target_user_id") != identity.user_id:
        raise ValueError("回复缺少正确的私聊收件人")
    for container in (message, info):
        if "account_id" in container and container["account_id"] != identity.account_id:
            raise ValueError("回复账号不匹配")
        if "scope" in container and (container["scope"] or "") != identity.scope:
            raise ValueError("回复作用域不匹配")
    for keys, expected in [
        (("platform_io_account_id", "account_id", "self_id", "bot_account"), identity.account_id),
        (("platform_io_scope", "route_scope", "adapter_scope", "connection_id"), identity.scope),
    ]:
        for key in keys:
            if key in additional and (additional[key] or "") != expected:
                raise ValueError("回复账号或作用域不匹配")
    message_id = info.get("message_id")
    if not isinstance(message_id, str) or not message_id:
        raise ValueError("回复缺少 message_id")
    return info


def reply_name(identity: Identity, message: dict) -> str | None:
    """仅从目标路由已验证、发送者为当前机器人账号的回复提取昵称。"""
    try:
        info = _reply_info(identity, message)
    except ValueError:
        return None
    sender = info.get("user_info")
    if (not isinstance(sender, dict) or sender.get("user_id") != identity.account_id
            or sender.get("platform", identity.platform) != identity.platform):
        return None
    value = sender.get("user_nickname")
    if not isinstance(value, str) or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value):
        return None
    name = value.strip()
    try:
        # 与桌宠 JavaScript 字符串 / Zod 上限一致，不能把过长 emoji 名发送过去。
        units = len(name.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        return None
    return name if 1 <= units <= 40 else None


def build_reply(identity: Identity, message: dict, channel_id: str) -> dict:
    """只接受配置的私聊收件人，绝不从机器人发送者猜测路由。"""
    info = _reply_info(identity, message)
    message_id = info["message_id"]
    segments = []
    count = 0

    def visit(segment: object, depth: int = 0) -> None:
        nonlocal count
        count += 1
        if depth > 8 or count > 1000 or not isinstance(segment, dict):
            raise ValueError("回复消息结构超出限制")
        kind, value = segment.get("type"), segment.get("data")
        if kind == "seglist":
            if not isinstance(value, list):
                raise ValueError("seglist.data 必须是数组")
            for child in value:
                visit(child, depth + 1)
        elif kind in {"text", "at", "reply"}:
            if kind != "text":
                value = _reference_text(kind, value)
            if not isinstance(value, str):
                raise ValueError("text.data 必须是字符串")
            # 按 UTF-16 长度分块，与桌宠的 Zod / JavaScript 上限一致。
            part, units = [], 0
            for char in value:
                size = 2 if ord(char) > 0xFFFF else 1
                if units + size > 12000:
                    segments.append({"type": "text", "text": "".join(part)})
                    part, units = [], 0
                part.append(char)
                units += size
            if part:
                segments.append({"type": "text", "text": "".join(part)})
        elif kind in {"image", "emoji", "voice"}:
            segments.append({"type": "audio" if kind == "voice" else "image",
                             "dataUrl": _media_url(kind, value)})
        else:
            raise ValueError(f"桌宠不支持的消息分段：{str(kind)[:40]}")

    visit(message.get("message_segment"))
    if not segments or len(segments) > 100:
        raise ValueError("回复为空或超过 100 个桌宠消息段")
    reply_id = "mm-" + hashlib.sha256(message_id.encode()).hexdigest()
    return {"v": 1, "type": "reply", "id": reply_id,
            "sessionId": channel_id, "segments": segments}
