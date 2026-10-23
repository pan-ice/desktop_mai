# 维护指南

## 仓库与职责

桌宠应用、MaiBot 上游与适配器分别维护。桌宠仓库为私有的 [pan-ice/desktop_mai](https://github.com/pan-ice/desktop_mai)，适配器仓库为私有的 [pan-ice/desktop_pet_adapter](https://github.com/pan-ice/desktop_pet_adapter)。内核仓库保持原样；适配器位于 `MaiBot/plugins/desktop_pet_adapter`，使用独立 Git 历史。首次克隆客户端后，按 README 获取内核和适配器。提交插件时在该目录执行 Git 命令；提交信息使用中文。发行插件通过白名单打包，排除 `.git`、`.venv`、配置、令牌与数据。

| 边界 | 拥有的内容 | 不应依赖 |
| --- | --- | --- |
| `electron/bridge.ts` | 本机监听、握手、实例切换、请求与回执生命周期 | MaiBot 内部消息与数据库 |
| `electron/protocol.ts` | 桌宠协议、输入校验和配置导出 | SDK 内部实现 |
| `electron/store.ts` | 原子写入、设置版本迁移 | 内核会话计算 |
| `electron/tts.ts` / `shared/tts.ts` | 合成与音色复刻协议、音色配置和状态、MiMo 本机参考文件；由主进程获取独立加密凭证 | MaiBot 消息协议与模型人格 |
| 插件 `plugin.py` | SDK 网关声明、QQ 验证命令、启停和配置热更新 | 内核 `src.*` |
| `electron/accounts.ts` | 主进程账号 RPC、登录密钥和设备凭证边界 | QQ 账号和人物标识 |
| `electron/local-server.ts` / 插件 `local_setup.py` | 本机配置配对、重复初始化、受控中继进程与退出回收 | MaiBot 内核配置与人物身份计算 |
| 插件 `accounts.py` / `relay.py` | 账号与设备归属、服务器历史和多设备分发 | 内核源码和客户端自报身份 |
| 插件 `gateway.py` | SDK 正式消息、真实会话、主动任务 | Electron 窗口与媒体设备 |
| 插件 `connector.py` | 重连、有限去重、请求与投递回执 | 人格、模型调用和记忆逻辑 |

领域词汇见 [CONTEXT.md](../CONTEXT.md)，连接方向的原因见 [架构决定](adr/0001-sdk-gateway-and-reverse-connection.md)。协议定义由 [插件 PROTOCOL.md](../MaiBot/plugins/desktop_pet_adapter/PROTOCOL.md) 维护。修改一侧必须验证另一侧。

## 版本与升级

- 桌宠与插件当前版本 `0.4.0`，桌宠会话协议 `1`，服务器多路通道协议 `2`，账号 RPC 协议 `1`，桌宠数据版本 `2`，本机插件配置版本 `1.0.0`、服务器配置版本 `1.1.0`。v2 本地设置新增可选服务器账号选择，旧记录与凭证继续兼容。QQ 登录与历史同步需要客户端、插件、接入程序一起更新。
- 只有通过 `hello → welcome → SDK ready/open_session → ready` 才显示已连接。消息发送成功表示 Host 接收；没有回复不代表失败，MaiBot 会自行决定回复。
- 桌宠状态 v1 首次加载先逐字节备份，再移除旧 URL / 令牌并保存为 v2。未知版本显式失败，不能重置覆盖。回滚旧应用前恢复备份；不要直接用旧版本读 v2。
- 保持原平台、机器人账号、用户 ID 和空作用域以延续旧会话；新隔离环境使用新的作用域。实际会话 ID 必须由 SDK 返回。
- 首次安装将插件 ZIP 解压到 `plugins`。更新先停止/卸载插件，备份配置后替换源码，再检查依赖并加载；勿解压到额外嵌套目录。热重载支持短暂重连，不能承诺无缝投递。
- 本机模式一个配置绑定一个桌宠。QQ 登录账号通过服务器分配的独立设备凭证认证，同账号多设备同时在线并同步发言和回复；每个桌宠账号使用独立内核会话。旧管理员凭证账号继续采用新连接替换旧连接，不会自动并入 QQ 身份。部署与共享内核数据范围见 [SERVER.md](../MaiBot/plugins/desktop_pet_adapter/SERVER.md)。
- 桌宠列表的移除偏好仅存于当前客户端数据目录，并按服务器地址区分；服务器账号、聊天历史、本机缓存和设备授权继续保留。「添加已有桌宠」重新选择后恢复显示，不需要删除或重建服务端身份。旧本机数据缺少该可选字段时按空列表加载。
- 日常入口「连接与账号」仅提供服务器地址、QQ 登录、账号选择和设备管理。客户端不包含 MaiBot 内核进程启动器；本机中继测试、旧版凭证和本机适配器兼容入口按需展开。已有配置中的身份字段继续用于兼容，不在日常表单中编辑。

## 依赖

Node 环境以 `package-lock.json` 为准，使用 `npm ci`。Electron 固定为 41.10.6，打包工具固定 26.15.3；`overrides` 将其下载器升级为公开 API 相容的 `@electron/get` 5。更新 override 时必须重跑安装、依赖审计和发行打包。

Live2D 通过 npm alias 将 `pixi-live2d-display` 固定到 `pixi-live2d-display-lipsyncpatch@0.5.0-ls-8`，配套 `pixi.js@7.4.3`。这是 N.E.K.O 所用维护分支的后续版本，支持新旧运行时与更新的 Cubism 渲染框架；原依赖携带的 `gh-pages` 及对应 override 已移除。升级必须检查 `src/renderers/live2d-clipping.ts` 使用的框架内部字段，运行单元测试、`test:live2d-compat` 与原 `test:live2d`，并重新审计依赖。运行库和测试模型保存在应用数据目录或忽略的 `.cache` 中，不能加入发行包。

插件公开依赖范围在 `pyproject.toml` / `requirements.txt` 同步维护，独立开发环境用 `uv sync --locked`；宿主只安装 requirements，不能在 MaiBot 环境用插件的 lock 执行同步，以免移除内核依赖。最低 Host 为 1.3.5，最低 SDK 为 2.10.0，锁定 SDK 为 2.13.0。

CI 配置位于各自 `.github/workflows`，推送后由 GitHub Actions 执行。桌宠 CI 做类型/单元/构建，插件 CI 覆盖 Windows、Linux、Python 3.12 / 3.13 与最低/锁定 SDK。跨仓库联调在本地按下面的发行流程执行。

## 发布

```powershell
npm ci
npm run typecheck
npm test
npm run test:plugin
npm run test:adapter
npm run build
npm run test:desktop
npm run dist:win
```

最后用 `MAI_TEST_EXE` 指定 `release/win-unpacked/Mai 桌面伙伴.exe` 再运行桌面验收；`npm run test:portable` 验证最终自解压入口，`npm run verify:release` 核对 ASAR。不要直接将便携启动器交给 Playwright 的 Electron 调试管道，它不转发该管道。插件源码包由 `tools/package.py` 白名单生成；从解压后的包再运行测试可发现遗漏文件。生成并保存两个发行文件的 SHA256。

宿主开发环境就绪时，在 MaiBot 目录执行 `uv run python ../scripts/validate-plugin-host.py`，用真实清单校验器和加载器复核适配器契约。检查其他安装时，使用该安装的 Python 运行脚本并传入 `--core-root <MaiBot目录>`；可用 `--plugin-root <插件目录>` 指定待检查插件。脚本读取实际 Host / SDK 版本，在隔离副本中只创建目标插件工厂，不启动模型或读取用户配置。

源码仓库维持私有；manifest 指向实际适配器仓库。源码 ZIP 仍可通过白名单打包交付，需要公开源码时单独决定仓库可见性。

## 故障定位

| 表现 | 检查位置 |
| --- | --- |
| 一直等待插件 | 内核是否加载适配器、配置是否在正确目录、依赖是否安装、端口/令牌是否一致 |
| 401 / 握手拒绝 | 独立令牌、`/maibot` 路径、是否有浏览器 Origin；重新导出配置后重载插件 |
| 身份不一致 | 重新保存身份并导出配置，确保平台/账号/用户/作用域完全一致 |
| Host 拒绝入站 | MaiBot 适配器名单策略、网关 ready、账号路由；SDK 拒绝不应自动转用旧协议 |
| 接收未确认 | 先检查聊天记录与内核日志，勿自动重试可能已执行的消息或工具 |
| 保存回执失败 | 应用数据目录写权限、磁盘、媒体上限；内核应收到失败而非伪成功 |
| 重载后短暂断线 | 等待插件退避重连，检查是否保留多个旧 Runner；旧实例会被新实例替换 |
| 服务器拒绝凭证 | 用户是否被撤销、是否导入正确的个人凭证；个人凭证和内部适配器凭证分开使用 |
| 服务器未就绪 | 接入程序和 MaiBot 插件是否均在运行；插件配置 `mode = "server"`，内部地址路径为 `/adapter` |

测试与调试进程必须在结束时关闭。凭证不写入诊断日志；导出的 `config.toml` 自身包含令牌。清除桌宠令牌会断开接入，重新导出后需要同步更新插件。
