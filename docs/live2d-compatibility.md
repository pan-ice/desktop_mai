# Live2D 兼容性

2026-10-22：以 N.E.K.O 提交 `c65adc2bb467c812c5fd948c8031aa96d48c0e14` 的运行库与渲染方案为参考，支持新旧 Live2D 运行时模型共存。兼容目标是该方案能够读取的模型格式和渲染能力，不是任意未来 Cubism SDK 特性。

## 导入范围

| 内容                             | 支持方式                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Cubism 2.1 运行时模型            | `.model.json` + `.moc`，使用旧版 `live2d.min.js`                               |
| Cubism 3 / 4 / 5 运行时模型      | `.model3.json` + `.moc3`，使用官方 Cubism Core；已验证 Core 5.1.0              |
| 模型资源                         | 入口中声明的贴图、动作、动作音频、表情、物理、姿势与 UserData 自动复制         |
| 整个文件夹                       | 递归定位唯一的 `.model.json` 或 `.model3.json`；多个入口时要求直接选择具体文件 |
| ZIP / RAR / 7z                   | 先解压，再选择模型文件夹或入口                                                 |
| `.cmo3` / `.can3` / 旧编辑器工程 | 先用 Cubism Editor 导出运行时模型，不能直接播放工程                            |
| 单独的 `.moc` / `.moc3`          | 需要相应模型 JSON 和贴图等资源                                                 |

资源必须位于模型入口所在目录内，不接受外部 URL 或越界路径，单次导入最多 512 MB。缺少必需资源会报错；仅用于编辑器参数名称的 `DisplayInfo` / `.cdi3.json` 缺失时允许导入。非资源字段中的名称和扩展元数据保留，不再误当作文件路径。

## 渲染与参数

- npm alias 使用 `pixi-live2d-display-lipsyncpatch@0.5.0-ls-8`，配套 PixiJS 7.4.3；N.E.K.O 的参考构建为同一维护分支的 `v0.5.0-ls-6`。
- 新旧运行库分别按内容摘要加载，按模型入口选择 Cubism 2 或 Cubism 4 适配器，允许反复切换。
- Cubism 3+ 使用更新的框架处理动作、表情、物理、姿势及乘算色 / 屏幕色。口型与闭眼优先读取模型 `Groups` 的 `LipSync` / `EyeBlink` 声明；缺省时匹配实际存在的常用参数，并尊重参数范围。
- 复杂遮罩采用至少 3 张图集，每增加 32 个遮罩增加一张，最多 32 张；超过 1,024 个遮罩后逐个绘制高精度遮罩。图集位置依据全部遮罩分配，避免显隐变化导致位置漂移；修复余数分配、负坐标边界、GL 缓冲区恢复和调整遮罩尺寸后的上下文恢复。

Core 能读取某个 moc 版本，不等于框架实现了后续 SDK 的全部新功能。此次没有声明 Cubism 5.3 等后续 SDK 新特性或所有第三方改造模型均已兼容；更新 Core 也不能替代框架升级。复杂遮罩的极端数量通过单元测试验证，真实样本覆盖 3、6 和 16 个遮罩。

## 运行库来源与校验

| 运行库    | 来源                                                                                                                                       | 校验                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 新版 Core | [Live2D 官方下载](https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js)                                                    | 固定官方 HTTPS 下载后记录 SHA-256；本地导入只接受已知官方摘要或本机下载记录 |
| Cubism 2  | [N.E.K.O 固定提交归档](https://github.com/Project-N-E-K-O/N.E.K.O/blob/c65adc2bb467c812c5fd948c8031aa96d48c0e14/static/libs/live2d.min.js) | 下载和本地导入均要求下面的固定 SHA-256                                      |

```text
Core 5.1.0: 25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f
Cubism 2:  96cd98047edc7ff319c35c344ede4dc62a286d3c7e1173e5365e7a7ea6bad69e
```

两套运行库独立缓存在应用数据目录的 `models/.live2d-core/`。首次导入对应版本时自动下载，也可在角色衣橱提前下载或从本地导入。运行库均不随应用安装包分发；模型旁的任意 JavaScript 不会执行。运行库和角色资源各自遵循其许可证。

## 实测与复现

| 模型             | 格式 / Core 返回的 moc 版本 | 已验证                                                       |
| ---------------- | --------------------------- | ------------------------------------------------------------ |
| Shizuku          | Cubism 2 `.moc`             | 双窗口渲染、动作、表情、原生物理与姿势、旧版口型             |
| Haru             | `.moc3`，版本枚举 1         | 双窗口渲染、动作、表情、原生物理与姿势、标准口型             |
| N.E.K.O Mao      | `.moc3`，版本枚举 5         | 双窗口渲染、动作、表情、原生物理与姿势、自定义 `ParamA` 口型 |
| 洛天依「翡翠石」 | `.moc3`，版本枚举 5         | 双窗口渲染、动作、口型；模型未声明原生物理或姿势             |

版本枚举是 Core 返回的内部值，不等同于 Editor 的完整版本号。前三套公开样本由测试脚本按固定提交下载，仅保存在被 Git 忽略的 `.cache/live2d-compat/`，不进入应用和发行包；本地模型始终只读。

```powershell
npm test
npm run build
npm run test:live2d-compat
# 可选：追加自己的模型，使用该模型的标准口型参数验证
npm run test:live2d-compat -- D:\path\model.model3.json
# 原有高清渲染、缩放、口型和睡眠回归
npm run test:live2d -- D:\path\model.model3.json D:\path\live2dcubismcore.min.js --hidden
```

兼容性脚本还覆盖新旧模型反复切换、主进程重启后读取两套可信缓存、断网后的双窗口渲染。结果及截图位于 `.cache/live2d-compat/`。完整执行记录见 [验证记录](verification.md)。

参考：[N.E.K.O 运行库入口](https://github.com/Project-N-E-K-O/N.E.K.O/blob/c65adc2bb467c812c5fd948c8031aa96d48c0e14/templates/index.html)、[N.E.K.O 遮罩与参数适配](https://github.com/Project-N-E-K-O/N.E.K.O/blob/c65adc2bb467c812c5fd948c8031aa96d48c0e14/static/live2d/live2d-model.js)、[维护分支](https://github.com/RaSan147/pixi-live2d-display)、[Shizuku / Haru 测试资源](https://github.com/guansss/pixi-live2d-display/tree/31317b37d5e22955a44d5b11f37f421e94a11269/test/assets)。
