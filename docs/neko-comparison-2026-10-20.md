# 结合 MaiBot 的 N.E.K.O 功能取舍

核对日期：2026-10-20（Asia/Shanghai）。

**当前项目的定位是 MaiBot 的 Windows 桌面陪伴客户端。** MaiBot 负责人格、记忆、表达学习、回复决策、Agent、插件和工具；桌宠负责本机输入、声音、角色渲染和日常交互。N.E.K.O 的独立后端与生态用于了解不同实现，不直接转化为本项目的待办。

比较基准：

- 桌宠：`E:\Code\desktop_mai` 当前工作区，包含未提交与未跟踪的实现；HEAD 为 `4caab8fe1c1db41eeb53e6a92a982937d1b915dd`，应用版本 `0.4.1`。
- MaiBot：沿用本项目适配器参考笔记的固定提交 [`ac6ed61b7b9c971ad94921de3b16fa6f63c36a20`][M0]，核对官方源码；没有假设某个实际部署已启用所有插件或实验功能。
- N.E.K.O：固定提交 [`30c6d7556d0a5f04ce30dd0b2aaec75e39f387de`][N0]。

## 取舍结论

现有工程已经覆盖桌面陪伴的主要链路：文字与媒体、连续语音、音色复刻、模型导入、屏幕/摄像头分享、网关模式主动陪伴、QQ 登录与服务器聊天历史。

接下来值得改善的是**麦麦在桌面上如何被听到、被看到，以及用户如何与她继续交流**。优先考虑真实音频口型、顺畅的语音轮换和符合 MaiBot 节奏的状态反馈。语义表情可以在内核有合适信息来源时接入。记忆编辑器、插件市场、Agent 控制台、多人格体系等不进入默认待办。

## MaiBot 已承担的能力

| 参考 N.E.K.O 时看到的能力 | MaiBot 与当前项目的实际情况 | 本项目的取舍 |
|---|---|---|
| Agent、规划、工具调用 | MaiBot 已有 Planner、工具选择和执行体系，另有受实验开关控制的子代理；配置与启用情况由部署方决定。[M1] [M2] | 继续通过 MaiBot 完成。独立 Agent、浏览器/电脑执行系统与任务 HUD 都不因 N.E.K.O 有这些功能就成为桌宠需求。 |
| 人格、关系、表达学习 | 人格与行为准则由 MaiBot 配置；表达学习与人物信息也在内核侧。[M3] [M4] | 桌宠的昵称和模型外观服务于已连接的麦麦；切换模型不要求切换人格。无需新增另一套多人格预设或角色卡体系。 |
| 长期记忆、画像和知识管理 | MaiBot 已有记忆系统和管理 WebUI，包含检索、事实、图谱、时间线、画像及维护接口。[M5] | 使用内核能力及现有管理界面；桌宠保留日常聊天记录。桌宠未内置记忆编辑器不算能力缺失。 |
| 插件市场、MCP、模型配置 | MaiBot 有插件管理/安装更新、MCP Provider、连接测试与状态接口，以及模型配置管理。[M6] [M7] [M8] [M16] | 由 MaiBot 及部署方管理。无需在桌宠重复提供后台、市场或第二套 MCP 客户端。 |
| 主动聊天和陪伴决策 | 正式插件入口把意图提交给现有会话，内核结合关系、记忆和上下文决定是否回复及如何表达。[M9] [M10] | 桌宠负责免打扰、专注、设备授权等本机条件并提交意图。主动内容与表达继续由 MaiBot 决定。 |
| 搜索、点歌和内容来源 | 可通过 MaiBot 配置的工具与插件提供；特定部署是否已安装、启用和授权需要单独核实。桌宠已能收发图文和播放原始音频。 | 具体需求具体接插件；不预建新闻/社区推荐系统，不为点歌重复建设完整音乐产品。 |
| 内核管理 | 本项目已明确由部署方独立运行和管理 MaiBot；客户端此前已移除内核启停与管理面板。[本地职责说明](../README.md)、[既有验证记录](verification.md)。 | 保持日常客户端定位。没有管理入口是职责划分，不需要因功能对照而重新加回。 |

MaiBot 支持某种扩展方式，与目标服务器已配置某项功能，是两个事实。接入某项能力时应核对该部署的版本、正式接口与插件，不以客户端缺少同名页面推断内核缺失。

## 当前桌宠已有的基础不需要重做

| 体验 | 当前覆盖 | 判断 |
|---|---|---|
| 桌面形态与角色 | 透明窗口、拖动/锁定、置顶、缩放、穿透、托盘；图片/GIF、PNGTuber、Live2D、VRM/GLB、PMX/PMD。 | 已具备基本陪伴外观；高级格式兼容按实际使用的模型处理。 |
| 文字和媒体 | 聊天页/迷你输入/气泡；文字、图片、表情、语音与引用；混合顺序和媒体持久化。 | 重点是正确呈现 MaiBot 的实际输出；不用把上游支持的每一种内容都变成新场景。 |
| 声音 | 手动录音、连续语音 VAD、ASR、系统/在线 TTS、五家音色复刻、原音频优先、按段播放与下一段预取。 | 已有完整基本流程；接下来改善轮换与等待体验。 |
| 屏幕与摄像头 | 所选屏幕/窗口截图、定时观察与相同画面过滤，摄像头预览后拍照分享。 | 已能把视觉上下文交给 MaiBot。持续视频帧是额外需求，不以 N.E.K.O 的采帧频率为达标线。 |
| 主动陪伴 | 网关模式可提交陪伴意图，已有冷却、免打扰和专注暂停；经典消息适配器如实关闭不支持的主动入口。 | 现有边界合理。需要主动陪伴时使用支持的接入方式，无需桌宠另造主动决策。 |
| 登录与历史 | QQ 登录、多桌宠账号、多设备及服务器聊天记录同步；模型和声音保存在本机。 | 已解决当前账号/历史需求；无 Steam 云存档不等于没有历史同步。多账号也不意味着需要多个独立人格。 |

本地实现依据：[项目功能表](../README.md)、[消息与音频](message-types.md)、[连续语音](../src/hooks/useConversation.ts)、[声音播放](../src/hooks/useVoice.ts)、[音频播放器](../src/components/ChatAudio.tsx)、[角色渲染](../src/components/Avatar.tsx)、[接入边界](../adapter/README.md)。

## 本轮已落实的桌宠体验

本轮改善在基线提交 `ecd3e57` 后实现，范围保持在客户端交互。

| 改善 | 实现结果 | 验证 |
|---|---|---|
| **1. 真实音频驱动口型** | MaiBot 原音频、API TTS 和聊天播放器使用实际响度驱动嘴型，停顿时闭嘴；主窗口和桌宠同步。系统朗读无法采样时使用基础动画，衣橱预览保持静止。 | 实际 Electron 与 HTML 音频覆盖有声/静音片段、双窗口同步、跨窗口停止。 |
| **2. 语音轮换更顺畅** | 等待内核回应时继续聆听；播报期间持续开口会停止本机声音并清空队列，再转写下一句。通过声音持续时长、较高阈值及回声消除减少短噪声打断。 | 虚拟麦克风、实际 VAD/录音器和本机 ASR 验证短噪声、插话、转写及等待期间连续发送两句。停止本机声音不承诺取消内核生成。 |
| **3. 等待和回复状态更准确** | 区分发送、等待、聆听、录音、转写、声音准备及播放。等待提示约 15 秒后自然结束；不把正常沉默判为失败，不再把发送与收到回复分别推断成思考与开心。 | 实际协议发送回执、正常沉默、晚到回复、专注及设备释放验证。 |

实现依据：[音频播放与采样](../src/audio/playback.ts)、[口型](../src/renderers/live2d.ts)、[VRM/MMD](../src/renderers/three.ts)、[录音](../src/hooks/useConversation.ts)、[状态文案](../shared/interaction.ts)、[主进程协调](../electron/main.ts)。复验命令：`npm run build` 后执行 `npm run test:interaction`；边界见[验证记录](verification.md)。

真实音频口型借鉴 N.E.K.O 的[响度分析方式][N1]；声音分段、预取和原音频播放原本已经实现，没有再次列为新增后端需求。

## 有具体需求或接口后再考虑

| 项目 | 成立条件与范围 |
|---|---|
| 内容相关的表情和动作 | 先确认 MaiBot/插件能提供何种语义信息，再定义少量表情/动作映射。当前桌宠协议没有标准情绪字段；MaiBot 的表达学习记录也不能直接等同 Live2D 表情。回复扩展机制是可研究的接入点，不代表已具备现成情绪协议。[M11] 暂不另接情绪模型，不把情绪识别作为基础聊天依赖。 |
| 更低延迟的语音 | 先测真实使用中的 ASR、MaiBot 等待和 TTS 各占多少时间，再优化慢的环节。若需边生成边播放，必须先有内核可用的增量接口；现有分段消息不能当 token 流。 |
| 取消后端生成、结构化任务进度 | 只有实际遇到长任务管理需求，并确认目标 MaiBot 正式接口支持时再接；不默认新增任务控制台。 |
| 模型独立显示/声音偏好 | 频繁换外观且希望记住不同缩放、音量或声音时可做轻量配置；人格、记忆和会话归属仍由 MaiBot 管理。 |
| VRMA/VMD、MMD 物理、分层 PNGTuber | 使用的角色资源确实依赖这些能力时再补；不以覆盖全部格式或动作生态为当前目标。 |
| 更密集的视觉观察 | 实际屏幕陪伴需求超出现有截图能力，且 MaiBot 视觉路径可以有效消费这些上下文时再评估。避免仅增加采帧与推理频率却没有体验收益。 |
| 唤醒词与声纹过滤 | 用户确实需要长期免手动唤醒或区分说话人时再做；与已实现的音色复刻分开。 |

## 从默认待办中移出的项目

- 独立 Agent、规划器、任务执行器、浏览器/电脑操作后端：沿用 MaiBot 的能力与扩展方式。
- 五层记忆系统、第二套记忆编辑器、人物画像和表达学习管理页：由 MaiBot 及现有管理界面承担。
- 插件市场、MCP 服务器管理、知识包市场和聊天模型配置后台：由 MaiBot 统一管理。
- 多人格切换、PNG 人格卡和整套角色档案云存档：当前的外观模型切换与账号设计没有提出这些需求。
- 直接连接其他聊天模型的 Realtime 会话、第二套情绪模型、多源推荐及主动人格决策：不作为当前 MaiBot 桌面客户端的默认实现路线。
- Steam Workshop、专有云服务、猫娘社交网络、互访：属于 N.E.K.O 的产品生态。
- 视频共看、唱跳台、小游戏、GalGame 回复选项、Cat Mind 需求系统：有独立产品需求时再考虑，当前不作为基本陪伴缺口。
- 手机端、多语言、macOS/Linux 发行：当前明确交付 Windows 客户端；平台范围扩大时再规划。

这些是根据当前定位作出的范围判断，不是说它们永远没有用途。N.E.K.O 的实现可以作为以后特定需求的参考，但功能存在本身不足以成为开发理由。

## 必须尊重的 MaiBot 接口边界

1. **不是每条消息都必回。** MaiBot 的调度包含静默、频率与动态门控，Planner 也可以正常结束而不调用回复工具。[M12] [M13]
2. **主动意图不等于固定回复。** 插件只提交给当前会话，内核继续结合关系、记忆和上下文决定表达；经典消息路线没有这一任务接口。[M9] [M10] [本地支持范围](../adapter/README.md)
3. **分段消息不等于生成流。** 固定源码中回复工具等待完整生成结果、取出文本、后处理，再逐段发送；SDK 网关交付完整消息和路由。不能通过前端打字效果宣称实现了内核流式生成。[M14] [M15]
4. **停止播报不等于取消内核。** 内核内部的新消息抢占机制，与外部客户端可调用的标准 cancel-turn 接口不同。现有消息路径不能直接承诺 N.E.K.O 式流式 PCM 与轮次取消。[M13] [M15] [现有桌宠协议](../electron/protocol.ts)
5. **管理权限与日常聊天权限分开。** 已有 QQ 多人服务器使用场景下，接上桌宠不应自动获得整个 MaiBot 实例的记忆、插件和模型管理权限。继续使用现有部署方管理方式。[本地服务器范围](../README.md)

## 核对范围

比较依据为本地实现和固定提交的 MaiBot/N.E.K.O 官方源码；后续本轮改善只修改桌宠交互，并通过本机测试服务验证。未访问用户实际部署、未请求付费模型服务。代码存在不代表目标部署已配置或启用相应能力；真实设备回声与在线服务延迟仍取决于目标环境。

[M0]: https://github.com/Mai-with-u/MaiBot/tree/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20
[M1]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/maisaka/reasoning_engine.py
[M2]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/config/official_configs.py#L999
[M3]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/config/official_configs.py#L158
[M4]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/learners/expression_learner.py#L275
[M5]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/webui/routers/memory.py#L4066
[M6]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/webui/routers/plugin/management.py#L353
[M7]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/mcp_module/provider.py
[M8]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/webui/routers/mcp.py
[M9]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/plugin_runtime/capabilities/core.py#L294
[M10]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/maisaka/runtime.py#L666
[M11]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/plugin_runtime/host/reply_extensions.py
[M12]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/maisaka/turn_trigger/scheduler.py#L63
[M13]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/maisaka/reasoning_engine.py#L191
[M14]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/maisaka/builtin_tool/reply.py#L448
[M15]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/platform_io/drivers/plugin_driver.py#L112
[M16]: https://github.com/Mai-with-u/MaiBot/blob/ac6ed61b7b9c971ad94921de3b16fa6f63c36a20/src/webui/routers/model.py
[N0]: https://github.com/Project-N-E-K-O/N.E.K.O/tree/30c6d7556d0a5f04ce30dd0b2aaec75e39f387de
[N1]: https://github.com/Project-N-E-K-O/N.E.K.O/blob/30c6d7556d0a5f04ce30dd0b2aaec75e39f387de/static/app/app-audio-playback.js#L1661
