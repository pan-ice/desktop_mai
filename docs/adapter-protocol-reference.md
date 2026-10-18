# MaiBot 独立桌宠适配器协议核对

核对日期：2026-10-18。本文记录新建独立适配器的实现依据；桌宠到适配器的自定义协议与适配器到 MaiBot 的官方协议是两条边界。

## 接入结论与版本

首版采用 **独立 Python 适配器 + Legacy WebSocket `/ws` + 官方 `maim_message.MessageClient`**。链路为「桌宠 → 独立适配器 → MaiBot」，符合官方的外部独立适配器路线。它与进程内 `@MessageGateway` 插件路线不同；独立适配器不依赖 `maibot-plugin-sdk`，不要求安装旧的 `desktop_pet_adapter` 插件。[概览][D1] [编写适配器][D3]

- 目标核对版本：MaiBot `main` 提交 `ac6ed61b7b9c971ad94921de3b16fa6f63c36a20`，其依赖锁定 `maim-message==0.6.8`；消息服务启动检查最低 `0.6.2`。不要据此声称支持所有将来的 MaiBot 版本。[MaiBot 依赖][M1] [消息服务初始化][M2]
- 官方示例要求 Python 3.10+。0.6.8 的 `pyproject.toml` 也写 3.10+，但发布 wheel 的元数据写 3.9+；本项目采用 Python 3.11+，使用标准库 `tomllib` 读取配置。[编写适配器][D3] [0.6.8 项目配置][L1] [PyPI 发布元数据][P1]
- 0.6.8 源码固定在 `2bdf255cc19f8b4cc15c98d157bdaadea7118e28`。已对 `api.py`、`ws_connection.py`、`message_base.py`、`server_ws_api.py`、`converter.py` 与本地安装的 PyPI 0.6.8 wheel 做 SHA-256 比较，五份文件逐字节一致。[0.6.8 源码][L2] [官方 wheel][P2]
- `maim_message` 当前开发分支已经是 0.7.4；0.7.0 提交明确把原生 WebSocket 改为 Socket.IO，属于传输层不兼容变化。不要使用不设上限的 `pip install maim_message`，也不要用开发分支推断 0.6.8 的线协议。[开发分支配置][L10] [0.7.0 迁移提交][L11]

## Legacy 握手、生命周期与送达语义

连接 `ws://127.0.0.1:8000/ws`，实际地址由 MaiBot `[maim_message].ws_server_host/ws_server_port` 配置决定。握手头 `platform` 填固定的小写平台名，例如 `desktop_pet`；头 `authorization` 填令牌原文。MaiBot 的 `auth_token` 是允许的令牌列表，列表非空才启用校验，不能加 `Bearer ` 前缀。认证失败关闭码为 `1008`。[服务初始化][M2] [Legacy 连接实现][L3]

同一 `platform` 只保留一条 Legacy 连接。第二条会用 `1000 / 新的连接已建立` 关闭旧连接；添加 `account_id` 或 `scope` 无法改变这个传输限制。应由一个适配器进程集中服务多个桌宠设备，并在进程内按目标用户分发。[Legacy 连接实现][L3]

```python
client = MessageClient()
client.register_message_handler(handle_outbound)  # 回调参数是原始 dict
await client.connect(url=ws_url, platform=platform, token=token or None,
                     ssl_verify=ca_file)
await client.run()  # 长期运行；应与桌宠服务并发执行
```

`connect()` 只保存配置，真正建连和重连发生在 `run()`；用公开的 `is_connected()` 查询当前状态，用 `await stop()` 停止。不要只因 `connect()` 返回就报告 MaiBot 已上线。SDK 的重连退避从 2 秒开始、上限 10 秒，适配器无需再套一套并行重连循环。[客户端 API][L2] [WebSocket 客户端][L3]

`await client.send_message(dict)` 返回 `True` 只说明本次 `ws.send_json()` 未抛异常；它不等待 MaiBot 收到、归一化、策略放行或生成回复。断线时返回 `False`，没有 Legacy 发送队列，也没有标准消息 ACK。桌宠侧如需要 ACK，只能表述为「适配器已接收」或「已写入连接」，不能声称 MaiBot Host 已确认。断线重试需要由桌宠适配器自己的业务协议明确规定，不可将 SDK 的自动重连理解为消息自动补发。[客户端 API][L2] [发送与连接状态实现][L3]

心跳使用 WebSocket PING/PONG，不能发送自造 JSON 心跳给 MaiBot。官方文档列的服务端 30 秒间隔、10 秒超时对应库的独立服务配置；当前 MaiBot 把 Legacy 路由挂到自身 FastAPI/uvicorn，并未显式覆盖这两个值。实现应依靠协议层自动 PONG，不依赖固定的服务器心跳秒数。0.6.8 客户端自身开启 `autoping` 与默认 20 秒 heartbeat，单条消息上限 104,857,600 字节。[协议文档][D2] [Legacy 实现][L3] [MaiBot ASGI 服务][M3]

**WSS 的已确认限制**：0.6.8 的 `WebSocketClient.connect()` 在没有传 `ssl_verify` 时关闭证书与 hostname 校验。适配器支持 WSS 时应传可信 CA 文件，例如 `certifi.where()`，使库使用 `ssl.create_default_context()` 并加载 CA；自签名部署可显式配置自己的 CA 文件。[TLS 实现][L3]

## Legacy 私聊消息：必须使用的字段

入站直接发送消息对象，无 API 信封。一个可用的私聊例子：

```json
{
  "message_info": {
    "platform": "desktop_pet",
    "message_id": "desktop_79e956e9a94940d99c1fe05966ec475e",
    "time": 1792252800.123,
    "user_info": {
      "platform": "desktop_pet",
      "user_id": "desktop_user_001",
      "user_nickname": "桌宠用户"
    },
    "additional_config": {
      "platform_io_account_id": "desktop_mai",
      "platform_io_scope": "desktop_bridge",
      "platform_io_target_user_id": "desktop_user_001"
    }
  },
  "message_segment": {"type": "text", "data": "你好"}
}
```

- `message_info.platform`：固定平台名，与握手一致。库不会替适配器强制把帧中的平台名改成握手身份，因此适配器必须自行保证一致。[Legacy 连接实现][L3] [消息类][L4]
- `message_id`：每个逻辑消息稳定且唯一的字符串；`time`：Unix 秒数，使用浮点数。不要传毫秒或空值。[MaiBot 归一化][M4]
- `user_info.user_id`：平台侧发送者身份。`user_nickname`：发送者昵称。两者按官方要求使用非空字符串；数字 ID 先转字符串。私聊省略 `group_info` 或设为 `null`，不能伪造群信息。[协议文档][D2] [MaiBot 归一化][M4]
- 群消息才提供 `group_info`，其中 `group_id`、`group_name` 均使用非空字符串；它与私聊属于不同会话。[协议文档][D2]
- 正文为 `{type,data}`；纯文本 `data` 必须是字符串。[分段归一化][M5]

这里的 `account_id` 是**机器人账号**，与 `user_info.user_id` 表示的人类发送者分开。独立 Legacy 接口的规范落点是 `message_info.additional_config.platform_io_account_id` 与 `platform_io_scope`。兼容别名还包括账号的 `account_id/self_id/bot_account`，作用域的 `route_scope/adapter_scope/connection_id`；本项目应统一使用 `platform_io_*`，不要混用。[路由提取][M6] [Legacy 归一化][M4]

插件网关的新正式字段是消息顶层 `account_id/scope`；不能直接照搬到 Legacy 帧期待生效：0.6.8 `MessageBase.from_dict()` 只接收已定义的字段，会丢弃任意顶层字段。当前 MaiBot 还会从 Legacy 的 `additional_config` 兼容提取账号与作用域，源码提示该兼容读取未来会移除，需要升级前复核。[消息类][L4] [路由提取][M6] [Legacy 归一化][M4]

出站通常为 `seglist`。`user_info` 可以是机器人自己；私聊接收目标优先读 `message_info.additional_config.platform_io_target_user_id`，同时可核对新版出站 `receiver_info.user_info.user_id`。不要用机器人 `user_info.user_id` 找桌宠用户，缺目标时不能退回广播所有设备。[出站消息构造][M4] [发送服务][M7]

**额外字段不保证回显**：SDK 对传入的普通 dict 直接 `send_json()`，但 MaiBot 的归一化会删除非标准字段。入站 `additional_config` 整体进入消息对象，也不等于回复会完整继承：发送服务只透传账号/作用域候选键，再从会话写入 `platform_io_target_user_id` 与 `platform_io_target_group_id`。`pet_id`、`request_id`、桌宠自定义 `sessionId` 不能用来关联官方回复；需在适配器保留自己的用户/设备映射。[消息类][L4] [Legacy 归一化][M4] [路由继承实现][M7]

官方消息结构没有桌宠的 `sessionId` 字段；MaiBot 创建自己的会话。桌宠协议中的该值只能描述适配器内的通道，不能对用户宣称是 MaiBot 内核真实会话 ID。Legacy 也没有标准的「已读」「正在输入」「本次回复结束」「主动请求内核推送」事件，不能用未知自定义消息代替官方能力。[消息类][L4] [协议文档][D2]

## 新平台的 MaiBot 配置与路由冲突

除配置消息服务器，还应在当前 MaiBot 的 `[bot].platforms` 中追加机器人身份，保留已有条目：

```toml
[bot]
platforms = ["desktop_pet:desktop_mai"]

[maim_message]
ws_server_host = "127.0.0.1"
ws_server_port = 8000
auth_token = ["与适配器配置完全一致的随机令牌"]
```

**这是当前源码中的必要部署条件**：`get_configured_bot_accounts()` 只读取备用配置账号，明确不含数据库身份；`PlatformIOManager._sync_legacy_send_drivers()` 只为这些平台注册 Legacy 后备驱动。仅向 MaiBot 发送一个新平台消息，不能保证它具备出站驱动。`platforms` 条目格式是 `platform:账号`，平台转小写；上例账号须与入站的 `platform_io_account_id` 一致。[账号解析][M8] [Legacy 驱动注册][M9] [配置字段][M10]

Platform IO 出站解析顺序为 `(platform,account_id,scope)` → `(platform,account_id)` → `(platform,scope)` → `(platform)` → 平台 Legacy 后备。存在匹配的显式驱动时不继续走 Legacy 后备。因此，同平台旧插件网关仍在运行时，可能抢先接管回复；迁移应停用旧网关，或为新独立适配器选择独立平台名。不占用 `webui/bot_console/maisaka_cli`。[路由类型][M11] [驱动解析][M9] [访问策略文档][D4] [协议文档][D2]

`scope` 用于机器人路由归属，不是给一个 Legacy 平台额外创建物理连接的办法，也不自动等同于内核会话。多个设备共享同一人类 `user_id` 时可能共享私聊语义；需要独立会话的桌宠应通过平台身份设计明确区分用户，而非臆造官方会话 ID。[路由类型][M11] [消息归一化][M4]

## 回执、重连与去重

桌宠真正收到并接受出站消息后，适配器可向 MaiBot 回传真实平台消息 ID：

```python
await client.send_custom_message(
    "message_id_echo",
    {"type": "echo", "echo": maibot_message_id, "actual_id": desktop_message_id},
)
```

这里 `echo` 对应 MaiBot 出站 `message_info.message_id`；`actual_id` 是桌宠/平台实际采用的消息 ID，必须在平台发送成功后才报。没有实际发送成功不能伪造回执；返回值仍只有传输写入语义。[编写适配器][D3] [客户端自定义消息 API][L2]

0.6.8 自动封装的 Legacy 原始帧如下；自定义接收 handler 收到的是完整帧，不是单独 `content`：

```json
{
  "platform": "desktop_pet",
  "message_type_name": "message_id_echo",
  "content": {"type": "echo", "echo": "maibot-id", "actual_id": "desktop-id"},
  "timestamp": 12345.678,
  "is_custom_message": true
}
```

其中 SDK 的 `timestamp` 来自事件循环单调时钟，勿改造成业务 Unix 时间校验条件。`MessageClient.send_custom_message()` 只有两个参数；服务端方法另有第一个 `platform` 参数，不能混用。[客户端 API 与分发][L2]

Legacy 收发处理均创建并发任务，不保证回调业务完成顺序。需要同设备有序处理时，在适配器按用户/通道串行化；对重发保留逻辑消息 ID，并明确重复时的行为。不要从回复文本、到达先后或“最近一个请求”猜测关联。[Legacy 实现][L3] [客户端分发][L2]

Platform IO 内建去重器默认 TTL 300 秒、最多 10,000 项；目前 Broker 的稳定键含 `driver_id` 和显式消息 ID。这不构成 Legacy 端到端确认协议，不能代替桌宠适配器自己的有限去重缓存和断线结果处理。[去重器][M12] [入站去重键][M9]

## Additional API Server：兼容信息与暂不选用的原因

启用 `[maim_message].enable_api_server=true` 后使用独立端口 `/ws`，默认监听 `0.0.0.0:8090`。头为 `x-apikey/x-platform/x-uuid`；`?api_key=`、`?platform=` 的非空查询值覆盖相应请求头；省略 UUID 时服务端生成。白名单 `api_server_allowed_api_keys=[]` 表示不校验。MaiBot 的 API Server 认证失败由网络层默认关闭码 `1000` 断开。[消息服务桥接][M2] [API 网络实现][L5]

API 消息需要信封和另一种 payload：

```json
{
  "ver": 1,
  "msg_id": "wire-unique-id",
  "type": "sys_std",
  "meta": {"sender_user": "api-key", "platform": "desktop_pet", "timestamp": 1792252800.123},
  "payload": {
    "message_info": {
      "platform": "desktop_pet", "message_id": "logical-message-id", "time": 1792252800.123,
      "sender_info": {"user_info": {"platform": "desktop_pet", "user_id": "desktop_user_001", "user_nickname": "桌宠用户"}},
      "additional_config": {"platform_io_account_id": "desktop_mai", "platform_io_target_user_id": "desktop_user_001"}
    },
    "message_segment": {"type": "text", "data": "你好"},
    "message_dim": {"api_key": "api-key", "platform": "desktop_pet"}
  }
}
```

`sender_info` 表示入站发送者；出站通过 `receiver_info` 表示接收方，`message_dim.api_key/platform` 用于 API 投递。`message_info.platform/message_id/time`、`message_segment`、`message_dim` 为 API 类必填。若 payload 只缺两项中的一项也会触发文本兜底：源码条件是“两项同时存在才按标准消息解析”，不是文档所写的“两项同时缺失才兜底”。严格实现应拒绝这种坏帧，而不是接受兜底文本。[API 消息类][L6] [API 服务端][L7] [转换器][L8]

ACK 格式是 `type=sys_ack`，`meta.acked_msg_id` 指向原信封 `msg_id`，payload 含 `status=received` 和时间戳；它确认网络层接收，不确认 MaiBot 业务处理。API 自定义回执类型为 `custom_message_id_echo`，payload 仍为上面的 echo 载荷。[API 网络实现][L5] [API 服务端][L7]

需要特别保留以下源码限制，不能把文档的功能概述当成可靠性保证：

1. API 服务端以信封 `msg_id` 做 1 小时去重，且在业务处理前就标记。相同 ID 的可靠重传只会被再次 ACK、不会再次分发；业务处理失败后另开业务重试需要新信封 ID，但逻辑消息 ID 和幂等策略仍应单独管理。不要把所有重传无条件换 ID，避免重复业务。[API 服务端][L7] [API 网络实现][L5]
2. 默认缓存 TTL 300 秒、最多 1000 条。0.6.8 的服务端仅发送失败或连接缺失时入缓存，成功发送不保留“等待 ACK”项；接收 `sys_ack` 后也没有按 `meta.acked_msg_id` 消除出站缓存，缓存 remove 出现在发送 ACK 的路径里。不能据此宣称完整的 ACK 重投递保证。[API 缓存配置][L9] [API 网络实现][L5]
3. 服务端缓存按 UUID 找目标，重连应复用 UUID。没有任何在线目标用户时，业务层直接返回空发送结果，无法凭平台离线状态自动产生全部待发送消息。[API 服务端][L7] [API 网络实现][L5]
4. 当前 MaiBot API 桥只维护 `platform → 最后一次入站的 api_key`，不是 `(platform,account_id,scope) → UUID`；同平台多 Key 会覆盖，同 Key/平台的出站则发给该身份的所有 UUID。与此同时 Legacy 发送先成功时根本不会进入 API 回退。**“支持多连接”不等于当前 MaiBot 已提供多账号精确隔离。**[消息桥接][M2] [MaiBot 出站回退][M13] [API 服务端][L7]

因此首版选 Legacy，先把一个桌宠平台集中在一个适配器进程中，按官方目标用户分发。未来切换 API Server 需要另做消息转换、UUID 稳定性、广播语义、缓存与去重验证，不能只换握手头。[协议文档][D2] [消息桥接][M2]

## 访问策略与媒体

放行规则由 MaiBot `config/adapter_policy.toml` 控制。策略文件缺失且无默认规则时隐式放行；`[[adapters]]` 至少填写一个身份字段，可按 `platform/account_id/scope` 匹配。`defaults` 的动作是 `allow/block`，条目还可 `inherit`。`allow_ids/deny_ids` 不得交叉，`disabled=true` 拦截整个适配器。私聊列表使用真实用户 ID，群聊列表使用群 ID。[访问策略文档][D4] [策略源码][M14]

当前源码会把所有匹配条目按身份字段数从多到少排序，再依次求值；`inherit` 会继续尝试较宽条目，最后才到 `defaults`，因此比文档简化图中的“只选一条再到 defaults”更具体。同等具体度保持文件顺序；避免配置多个互相矛盾的同级条目。[策略源码][M14]

入站允许 `text/image/emoji/voice/file/at/reply/dict/seglist`。图片、表情、语音的 `data` 是**原始 base64 字符串**，不是 URL、文件路径或 data URI；`file/dict` 是对象，`reply` 是被引用消息 ID 字符串，`at` 是 ID 字符串或受支持的用户字典。分段类型或数据类型错误会断言/抛错；未知出站类型应有受控日志和降级，不能让进程退出。仅实现文本时应如实声明能力，不对桌宠宣称支持媒体/语音。[分段归一化][M5] [编写适配器][D3]

100 MiB 是 WebSocket 消息上限，不是安全的上传目标；base64 膨胀约三分之一，适配器应另设合理的业务大小限制。桌宠实际发送成功后才能 echo；对未支持媒体的降级文本，应把平台实际采用的消息 ID 与原 MaiBot ID 对上。[Legacy 消息上限][L3] [编写适配器][D3]

## 必须覆盖的联调

最小验收应包括：正确/错误令牌、连接后收发私聊、按 target_user_id 只到目标设备、并发用户无串线、账号/scope 不匹配的出站处理、嵌套分段和不支持媒体降级、真实 ID 回执、断线与重连、重复消息，以及不启动旧插件也能工作。使用固定测试用户与 `[bot].platforms` 账号，先通过允许策略，再验证禁用/deny 生效。[排错文档][D5] [账号配置][M8]

主机侧可用 `GET /api/webui/bot-accounts` 看归属，`POST /api/chat/sessions/adapter-status` 看 `allowed/reason`；这些 WebUI API 需其自己的认证，不属于消息 WebSocket 认证。没有实际 MaiBot 内核运行时，协议级 fake server 测试只能证明序列化和连接行为，不能宣称真实内核端到端已通过。[访问策略文档][D4] [排错文档][D5]

## 来源

[D1]: https://docs.mai-mai.org/develop/adapters/
[D2]: https://docs.mai-mai.org/develop/adapters/protocol
[D3]: https://docs.mai-mai.org/develop/adapters/build
[D4]: https://docs.mai-mai.org/develop/adapters/policy
[D5]: https://docs.mai-mai.org/develop/adapters/debugging
[M1]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/requirements.txt
[M2]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/common/message_server/api.py
[M3]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/common/message_server/server.py
[M4]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/common/data_models/mai_message_data_model.py
[M5]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/common/utils/utils_message.py
[M6]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/platform_io/route_key_factory.py
[M7]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/services/send_service.py
[M8]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/chat/utils/utils.py
[M9]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/platform_io/manager.py
[M10]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/config/official_configs.py
[M11]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/platform_io/types.py
[M12]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/platform_io/dedupe.py
[M13]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/chat/message_receive/uni_message_sender.py
[M14]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/platform_io/adapter_policy.py
[L1]: https://github.com/Mai-with-u/maim_message/blob/2bdf255cc19f8b4cc15c98d157bdaadea7118e28/pyproject.toml
[L2]: https://github.com/Mai-with-u/maim_message/blob/2bdf255cc19f8b4cc15c98d157bdaadea7118e28/src/maim_message/api.py
[L3]: https://github.com/Mai-with-u/maim_message/blob/2bdf255cc19f8b4cc15c98d157bdaadea7118e28/src/maim_message/ws_connection.py
[L4]: https://github.com/Mai-with-u/maim_message/blob/2bdf255cc19f8b4cc15c98d157bdaadea7118e28/src/maim_message/message_base.py
[L5]: https://github.com/Mai-with-u/maim_message/blob/2bdf255cc19f8b4cc15c98d157bdaadea7118e28/src/maim_message/server_ws_connection.py
[L6]: https://github.com/Mai-with-u/maim_message/blob/2bdf255cc19f8b4cc15c98d157bdaadea7118e28/src/maim_message/api_message_base.py
[L7]: https://github.com/Mai-with-u/maim_message/blob/2bdf255cc19f8b4cc15c98d157bdaadea7118e28/src/maim_message/server_ws_api.py
[L8]: https://github.com/Mai-with-u/maim_message/blob/2bdf255cc19f8b4cc15c98d157bdaadea7118e28/src/maim_message/converter.py
[L9]: https://github.com/Mai-with-u/maim_message/blob/2bdf255cc19f8b4cc15c98d157bdaadea7118e28/src/maim_message/ws_config.py
[L10]: https://github.com/Mai-with-u/maim_message/blob/292173616f33090c16f822ce5e5725f75af2423f/pyproject.toml
[L11]: https://github.com/Mai-with-u/maim_message/commit/a1a27375db41368fd24014086f6d709dc64c0517
[P1]: https://pypi.org/pypi/maim-message/0.6.8/json
[P2]: https://files.pythonhosted.org/packages/c6/18/d79fff71b7926069d3c4765498a9207a32ba7ede7349ac9f543fbc413167/maim_message-0.6.8-py3-none-any.whl
