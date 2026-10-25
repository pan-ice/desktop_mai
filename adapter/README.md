# Mai 桌面伙伴独立适配器

按 [MaiBot 适配器指南](https://docs.mai-mai.org/develop/adapters/)实现的独立 Python 进程。通过官方 `maim_message.MessageClient` 连接 **经典消息服务 `/ws`**，将桌宠消息转换为 MaiBot 统一消息格式，并把回复投递回桌宠。无需安装 MaiBot 插件，也不修改内核源码。

```text
Mai 桌宠 ⇄ 桌宠协议 v1 ⇄ 本适配器 ⇄ 官方 Legacy WebSocket ⇄ MaiBot
         自动分配端口/maibot                    8000/ws
```

## 要求

- Python **3.11+**，推荐使用 uv 管理隔离环境。
- MaiBot 已运行，模型服务已按上游要求配置。
- 固定使用 **maim-message 0.6.8** 与 **websockets 15.0.1**。`maim_message` 0.7 开发版已切换到 Socket.IO，不能直接升级。协议核对以 MaiBot 提交 `ac6ed61b7b9c971ad94921de3b16fa6f63c36a20` 为基准，详见[来源与限制](../docs/adapter-protocol-reference.md)。
- 同一平台只运行一个经典适配器。首版服务一个固定私聊身份；多个独立桌宠实例须使用不同平台名。`account_id` / `scope` 不会解除经典服务的单平台连接限制。

## 配置 MaiBot

在 MaiBot 的 `config/bot_config.toml` 中合并以下配置。**保留现有配置及 `platforms` 列表中的其他条目**，只追加桌宠平台账号：

```toml
[bot]
# 此处示例仅列出新增项；保留你的 QQ 等其他现有条目。
platforms = ["desktop_pet:mai_desktop_pet"]

[maim_message]
ws_server_host = "127.0.0.1"
ws_server_port = 8000
auth_token = ["替换成一段足够长的随机令牌"]
```

`desktop_pet` 和 `mai_desktop_pet` 必须与适配器 `[identity].platform/account_id` 一致。当前 MaiBot 根据 `bot.platforms` 为新平台注册经典出站通道；遗漏该项可能导致收到用户消息却发不出回复。

重启 MaiBot，使消息服务和账号配置生效。无需开启 `enable_api_server`，不要把 API 服务的 `8090/ws` 当作经典消息服务。

若已为同一平台启用原 `desktop_pet_adapter` 网关插件，请先停用该网关，避免其出站绑定抢占经典通道。已有 QQ 插件可以继续运行。

## 启动适配器

1. 打开桌宠「连接与账号」→「独立适配器接入」→「导出配置并开启接入」，保存为本目录 `config.toml`。桌宠自动生成并保存自己的连接令牌。
2. 修改导出的 `[maibot].url` 和 `[maibot].token`，对应 MaiBot 的消息服务地址与 `auth_token` 中的一个值。认证值是**令牌原文**，不加 `Bearer `。`[desktop].token` 是另一把令牌，由导出过程填写。
3. 在本目录运行：

   ```powershell
   uv sync --locked
   uv run --locked python -m desktop_adapter --config config.toml --check-config
   uv run --locked python -m desktop_adapter --config config.toml
   ```

   也可以使用 pip：

   ```powershell
   python -m venv .venv
   .venv/Scripts/python -m pip install -r requirements.txt
   .venv/Scripts/python -m desktop_adapter --config config.toml
   ```

4. 桌宠显示「MaiBot 消息服务已连接」后发送“你好”。MaiBot 应出现入站日志，桌宠收到回复后，适配器回传 `message_id_echo`。

环境变量 `MAIBOT_TOKEN`、`MAI_DESKTOP_TOKEN` 分别覆盖两侧令牌；配置示例见 [config.example.toml](config.example.toml)。配置校验不会输出凭证，日志不打印消息正文或令牌。

本机默认地址是 `ws://127.0.0.1:8000/ws`。容器内可使用 `ws://maibot:8000/ws` 等可信网络地址，并配置监听地址及端口映射。公网连接请使用 WSS 或隧道；WSS 显式使用 `certifi` CA 文件验证证书和主机名，不沿用官方 0.6.8 库默认跳过验证的行为。桌宠当前只监听本机回环地址；远程适配器通过隧道连接桌宠。

## 访问策略

放行由 MaiBot 的 `config/adapter_policy.toml` 统一处理。本适配器不绕过策略。若需要只放行固定桌宠身份，将下列条目合并进现有策略：

```toml
[[adapters]]
platform = "desktop_pet"
account_id = "mai_desktop_pet"
# 配置了非空 scope 时也可填写相同 scope，进一步缩小匹配范围。

[adapters.group]
default_action = "block"

[adapters.private]
default_action = "block"
allow_ids = ["desktop_owner"]
deny_ids = []
```

不要重复同一身份的策略条目。文件缺失时上游默认放行；有策略时确认用户、账号、作用域一致且未设 `disabled = true`。[官方访问策略](https://docs.mai-mai.org/develop/adapters/policy)

## 支持范围与投递语义

- **自动名称（0.1.1）**：配合桌宠 0.4.4，在「偏好设置」开启「跟随 MaiBot 名称」，首次有效回复后自动使用内核 `bot.nickname`。名称来自已验证目标平台／账号／作用域／收件人及机器人发送者的正常回复，不读取配置文件或 WebUI。经典握手不提供名称，重连后需等待新回复。新旧桌宠通过 WebSocket Upgrade 响应头协商扩展，旧版桌宠继续接收原有帧。
- 入站支持文本、截图/图片及图文混合；平台名固定为小写，所有身份为非空字符串，时间为 float 秒。`additional_config` 正确填写 `platform_io_account_id`、非空时的 `platform_io_scope` 和私聊 `platform_io_target_user_id`。
- 出站递归解析 `seglist`，支持文字、PNG/JPEG/WebP/GIF 图片及表情、MP3/WAV/OGG 语音，并将 `at` 和 `reply` 转为可读文字。桌宠保留文字与媒体的原始顺序。按真实收件人校验私聊；群聊和不匹配的账号/作用域被拒绝。文件、转发及未知分段拒绝整条回复，不发送部分内容或成功保存回执，后续合法消息仍可接收。两条链路的结构差异见 [消息对接说明](../docs/message-types.md)。
- 媒体为内嵌 base64，不读取内核文件或任意远程 URL。单媒体最多 9 MB，单桌宠帧最多 16 MB，最多 100 段；长文本按桌宠的 UTF-16 字符限制拆段。
- 官方库负责 MaiBot 的连接与退避重连，桌宠侧单独重连；MaiBot 断线时关闭桌宠通道，恢复后重新握手。未确认的用户请求不自动重放，同进程保留最近 2,000 个请求 ID 的去重记录；重启后不保证去重。
- `send_message()` 返回成功只表示已写入 WebSocket，**不代表内核已接收、策略已放行或保证回复**。经典服务无接收 ACK、无离线队列；断线或发送失败保留“接收未确认”。回复由桌宠保存后才发 `message_id_echo`，保存失败不发成功回执。
- 桌宠协议中的 `sessionId` 在本模式中只是稳定的本地路由标识，真实会话由 MaiBot 解析，不在客户端猜测。界面不会显示“内核会话已确认”。
- 此模式不提供 QQ 登录、服务器账号与云端历史同步；已有服务器/网关模式保留。ASR 在桌宠转为文本后送入 MaiBot，TTS 也继续由桌宠处理。
- 经典消息协议没有主动陪伴任务接口，因此此模式不声明 `proactive` 能力；桌宠关闭相应开关，拒绝把任务伪装成用户发言。需要该能力可继续使用原网关插件。

## 验证和打包

在客户端仓库根目录执行：

```powershell
npm run test:message-adapter
npm run build
npm run test:message-adapter-desktop
npm run dist:adapter
```

测试运行 Python 协议单元测试，再启动官方 0.6.8 `MessageServer`、新适配器和实际 Electron 主进程桥接类，验证原文认证、图文往返、错误收件人拒绝、保存后 ID 回执，以及两端断线重连。全部使用本机回环服务，不使用模型 Key，不调用 LLM。

测试默认查找 `adapter/.venv`，可用 `MAI_MESSAGE_ADAPTER_PYTHON` 指定解释器。ZIP 输出 `release/MaiBot-Desktop-Message-Adapter-0.1.1.zip`，只包含源代码、锁文件、配置示例与文档，不含实际配置或令牌。解压后在独立目录启动，不要放进 `MaiBot/plugins` 当插件加载。

## 排错

| 现象               | 检查                                                             |
| ------------------ | ---------------------------------------------------------------- |
| 连接被拒绝         | MaiBot 已运行；地址、监听和容器端口映射一致                      |
| 立即断开、1008     | `[maibot].token` 与 `auth_token` 原文一致，无 Bearer 前缀        |
| 反复被顶下线       | 同一个 `platform` 是否运行了第二个经典适配器                     |
| 桌宠连接被拒绝     | 桌宠已开启接入；桌宠地址、独立令牌及身份与导出配置一致           |
| 有入站无回复       | `bot.platforms` 已注册桌宠账号；访问策略放行；未被旧网关绑定抢占 |
| 收件人校验失败     | 出站 `platform_io_target_user_id` 是否与配置的私聊用户一致       |
| 未收到消息 ID 回执 | 桌宠是否已成功保存媒体和历史；是否断线或超出媒体限制             |

进一步排查按[官方五段链路](https://docs.mai-mai.org/develop/adapters/debugging)检查日志、策略和出站路由。

## 许可证

本适配器源码采用 [MIT License](LICENSE)。MaiBot、`maim-message` 等第三方依赖保留各自的许可证。
