from dataclasses import dataclass, field
import os
from pathlib import Path
import re
import tomllib
from urllib.parse import urlsplit


def _text(value: object, name: str, *, empty: bool = False, limit: int = 100) -> str:
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ValueError(f"{name} 必须是{'可为空的' if empty else '非空'}字符串，最长 {limit} 字符")
    if any(ord(char) < 32 for char in value):
        raise ValueError(f"{name} 不能包含控制字符")
    return value


def _url(value: object, name: str, path: str) -> str:
    value = _text(value, name, limit=2048)
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ValueError(f"{name} 地址无效") from None
    if (parsed.scheme not in {"ws", "wss"} or not parsed.hostname
            or parsed.path != path or parsed.query or parsed.fragment
            or parsed.username is not None or parsed.password is not None
            or (port is not None and not 1 <= port <= 65535)):
        raise ValueError(f"{name} 必须是 ws(s)://主机[:端口]{path}，不含凭证或查询参数")
    return value


@dataclass(frozen=True)
class Identity:
    platform: str
    account_id: str
    user_id: str
    user_name: str = "你"
    scope: str = ""

    def desktop_identity(self) -> dict:
        return {"platform": self.platform, "accountId": self.account_id,
                "userId": self.user_id, "scope": self.scope}


@dataclass(frozen=True)
class Config:
    maibot_url: str
    desktop_url: str
    identity: Identity
    maibot_token: str = field(repr=False)
    desktop_token: str = field(repr=False)

    @classmethod
    def load(cls, path: Path) -> "Config":
        with path.open("rb") as stream:
            data = tomllib.load(stream)
        expected = {"maibot": {"url", "token"}, "desktop": {"url", "token"},
                    "identity": {"platform", "account_id", "user_id", "user_name", "scope"}}
        if set(data) - expected.keys():
            raise ValueError("配置只能包含 [maibot]、[desktop]、[identity]；不能使用旧插件配置")
        for section, keys in expected.items():
            if not isinstance(data.get(section), dict) or set(data[section]) - keys:
                raise ValueError(f"[{section}] 缺失或包含未知字段")
        identity = data["identity"]
        platform = _text(identity.get("platform"), "identity.platform")
        if platform != platform.strip().lower() or not re.fullmatch(r"[a-z][a-z0-9_\-]{0,63}", platform):
            raise ValueError("identity.platform 必须是小写平台名，仅使用字母、数字、下划线或连字符")
        if platform in {"webui", "bot_console", "maisaka_cli", "unknown"}:
            raise ValueError("identity.platform 不能使用 MaiBot 保留平台名")
        desktop_token = os.environ.get("MAI_DESKTOP_TOKEN", data["desktop"].get("token", ""))
        if not isinstance(desktop_token, str) or not re.fullmatch(r"[A-Za-z0-9_\-]{32,256}", desktop_token):
            raise ValueError("desktop.token 需要使用桌宠导出的独立连接令牌（32–256 个字母、数字、下划线或连字符）")
        return cls(
            maibot_url=_url(data["maibot"].get("url"), "maibot.url", "/ws"),
            desktop_url=_url(data["desktop"].get("url"), "desktop.url", "/maibot"),
            maibot_token=_text(os.environ.get("MAIBOT_TOKEN", data["maibot"].get("token", "")),
                               "maibot.token", empty=True, limit=4096),
            desktop_token=desktop_token,
            identity=Identity(
                platform=platform,
                account_id=_text(identity.get("account_id"), "identity.account_id"),
                user_id=_text(identity.get("user_id"), "identity.user_id"),
                user_name=_text(identity.get("user_name", "你"), "identity.user_name"),
                scope=_text(identity.get("scope", ""), "identity.scope", empty=True),
            ),
        )
