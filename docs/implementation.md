# 实现与验证说明

2026-10-18 新增官方经典消息协议接入：`adapter/` 作为独立 Python 进程运行，使用固定的 `maim-message==0.6.8`，经 `8000/ws` 接入 MaiBot。桌宠继续使用 v1 协议，握手新增可选 `transport = "legacy"` 与能力协商；只有网关模式承诺内核会话及主动陪伴能力。安装、`bot.platforms`、策略与回执限制见[新适配器说明](../adapter/README.md)。下述原网关/服务器架构继续用于已有部署。

## 结构

```text
React 控制面板 / 透明桌宠
              │ 受限 preload IPC
              ▼
Electron 主进程
 ├─ 本机插件入口 ◄── 独立 SDK MessageGateway 插件 ──► MaiBot 正常私聊管线
 ├─ 按服务器主机隔离的自定义 WSS CA ──► 账号与聊天 WebSocket
 ├─ 语音服务 API                 ──► 转写 / 语音合成
 ├─ 系统屏幕捕获 / 摄像头预览
 ├─ 角色资源与历史媒体文件服务
 └─ 可选本机中继                 ──► 账号服务 / 父控制管道关闭时清理
```

渲染器没有 Node.js 权限，两个窗口使用 context isolation 与 sandbox。所有文件操作、外部连接和密钥保管均在主进程；IPC 输入使用 Zod 校验。渲染器只能获得令牌是否存在的标记。

Live2D 运行库属于可执行代码：Cubism 3 / 4 / 5 的本地 Core 导入和旧角色迁移只接受已核对的官方 SHA-256，或应用从固定官方 HTTPS 地址直接下载后记录的摘要；Cubism 2 运行库只接受固定 N.E.K.O 归档的 SHA-256。语法和 API 名称检查不作为信任依据。两套运行库独立缓存与加载，模型目录不能提供渲染器脚本地址，CSP 只允许共享运行库资源域执行脚本。未校验的运行库可通过衣橱中对应下载按钮恢复。运行库文件不随安装包分发，版本、摘要与来源见 [Live2D 兼容性说明](live2d-compatibility.md)。

自定义 WSS 证书由主进程解析并按目标主机保存；账号 RPC 与聊天桥接共享同一 CA 提供器。传输仍保持 `rejectUnauthorized`，不覆盖主机名与有效期校验，不使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`。证书正文不进入渲染器，界面只展示主机、有效期、数量和 SHA-256 指纹。

## 内核消息边界

当前使用独立的 `desktop_pet_adapter` 仓库，插件通过正式 SDK `MessageGateway` 接入 Platform IO。桌宠与插件使用版本化协议 v1；内核源码与实际用户配置保持不变。

- 插件以 Bearer 独立令牌主动连接桌宠的回环监听端口，协商协议、身份和能力，并通过 SDK 获取真实会话。桌宠保存回复后才确认投递。
- `gateway.update_state` 向 Platform IO 声明账号与作用域，`gateway.route_message` 注入顶层包含 `account_id` / `scope` 的标准消息。无需兼容字段或额外备用平台配置。
- 图片使用 SDK `binary_data_base64`，插件将内核图文、表情与语音转换为桌宠的内嵌媒体消息。出站校验正式路由与实际会话，不从发送者字段猜测接收方。
- 空闲主动陪伴通过 `maisaka.proactive.trigger` 提交意图；定时屏幕分享仍是用户已开启的图文消息。
- 新实例握手就绪后替换旧连接；断线进入退避重连。多套桌宠使用独立端口、令牌与身份/作用域，一个插件配置只对应一个桌宠。
- 发送等待 Host 接收回执；超时和断线记录为“接收未确认”，不自动重放。有限去重不承诺跨进程恰好一次投递，也没有离线消息队列。
- 真正的回复概率、延迟和是否回复由 MaiBot 决定。桌宠分别显示发送、等待、录音、转写和播放状态；接收回执不推断内核已开始思考，等待提示约 15 秒后自然结束，也不把正常沉默判为失败。收到回复不会统一设置开心。

## 参考与复用边界

参考项目：

- [MaiBot](https://github.com/Mai-with-u/MaiBot)，克隆时提交 `475a4b8c2`。
- [N.E.K.O](https://github.com/Project-N-E-K-O/N.E.K.O)，参考其多形态角色、独立桌面窗口、拖动阈值、主动陪伴与语音 / 视觉交互设计。
- 本地参考克隆提交：`aa4c9fb`。
- 特别查看了 N.E.K.O 的 `static/app/app-desktop-window-sensing.js`、`static/app/app-react-chat-window/resize-drag-and-api.js` 与 `frontend/react-neko-chat/src/avatar-tools/desktopContract.ts`。

桌宠源代码为此项目独立实现，没有复制 N.E.K.O 的人物模型、PNG 角色包、品牌或专有服务。MaiBot 和参考仓库保留各自许可证；发行包不包含这两个仓库。

## 当前边界

| 项目                                          | 状态                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 桌面、文字、语音、视觉、主动陪伴、角色导入    | 已实现本地流程                                                                                                                |
| 人格、长期记忆、表达学习、工具执行            | 使用 MaiBot 的实际能力，由部署方管理                                                                                          |
| 连续语音                                      | 本地 VAD + 兼容 ASR + MaiBot + TTS，有按句处理延迟；等待时继续聆听，持续开口停止本机播报，不承诺取消内核生成 |
| 屏幕感知                                      | 手动截图 / 可选定时观察，不是视频帧流                                                                                         |
| VRM                                           | 0.x / 1.x 渲染、表情、口型、视线与 spring bone 更新                                                                           |
| Live2D                                        | Cubism 2 的 model.json 与 Cubism 3 / 4 / 5 的 model3.json；运行库自动下载、分别缓存，具体版本及实测模型见 [兼容性说明](live2d-compatibility.md) |
| MMD                                           | PMX / PMD 渲染与常用 morph 映射；没有物理仿真或 VMD 时间线                                                                    |
| 角色市场 / 云同步 / 手机端 / N.E.K.O 社交网络 | 不包含独立服务，通过未来扩展接入                                                                                              |
| 自定义桌面工具 / 浏览器自动化                 | 由已配置的 MaiBot 插件提供，桌宠本身不执行任意代码指令                                                                        |

## 验证方法

单元测试覆盖协议版本与身份、Host 回执、回复保存回执、新旧实例替换、连接关闭、旧数据备份迁移、资源导入与路径边界、媒体分离保存与导出、免打扰与主动陪伴条件。

插件 `tests/host_fixture.py` 使用真实 `maibot_sdk.PluginContext` 与插件，测试 Host 只替代业务能力。`tests/adapter.integration.ts` 验证 Python 插件与桌宠桥接的实际网络往返；插件自身在 SDK 2.10.0 和 2.13.0 验证。`scripts/validate-plugin-host.py` 则读取实际 Host 版本，用 MaiBot 1.3.5 / 1.3.8 的真实清单校验器与加载器检查插件发现、工厂和网关声明。这些检查不启动 LLM 或读取用户配置。

`scripts/desktop-smoke.mjs` 启动实际 Electron 双窗口与 Python 插件，检查配置导出、布局、透明背景、消息收发、置顶开关、图片与 GLB 导入、3D 渲染、屏幕捕获、摄像头释放、语音服务调用、VAD 连续语音、系统加密与本地记录。使用虚拟音视频设备与本地语音测试 API，退出时卸载插件并关闭应用。

`scripts/local-server-smoke.mjs` 验证可选本机中继的初始化、QQ 登录、重启与退出清理。MaiBot 由部署方独立运行，客户端不再包含内核进程托管器。

洛天依「翡翠石」已使用用户提供的模型文件完成 Live2D 本地渲染验收。没有模型服务配置与 API Key，尚无法验收真实在线 LLM 对话和特定语音服务质量，其他具体 VRM / MMD 角色也仍需导入后验收。所有这些入口均连接实际实现，未用静态假回复替代。
