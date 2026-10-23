import { useState } from "react";
import {
  ArrowUpRight,
  Box,
  Check,
  Download,
  FileImage,
  FolderInput,
  PawPrint,
  Plus,
  Trash2,
} from "lucide-react";
import { api, perform } from "../api";
import { Avatar } from "../components/Avatar";
import { Panel } from "../components/ui";
import type { ImportedModel, Snapshot } from "../../shared/types";

export function ModelsPage({ state }: { state: Snapshot }) {
  const [removing, setRemoving] = useState("");
  const [importing, setImporting] = useState(false);
  const [settingCore, setSettingCore] = useState(false);
  const busy = importing || settingCore || state.live2dCoreDownloading;
  const importModel = async (source: "file" | "folder" = "file") => {
    setImporting(true);
    await perform(() => api.importModel(source));
    setImporting(false);
  };
  const importCore = async () => {
    setSettingCore(true);
    await perform(() => api.importLive2DCore());
    setSettingCore(false);
  };
  const downloadCore = async () => {
    const runtime = state.live2dCoreError
      ? state.live2dCoreErrorRuntime
      : "modern";
    await perform(
      () => api.downloadLive2DCore(runtime),
      "Live2D 运行库已就绪，可以导入模型了",
    );
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">A WARDROBE FULL OF POSSIBILITIES</div>
          <h1>角色衣橱</h1>
          <p>让熟悉的灵魂，拥有你喜欢的样子。</p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            void importModel();
          }}
          disabled={busy}
        >
          <Plus size={17} />
          {state.live2dCoreDownloading
            ? "正在下载运行库…"
            : importing
              ? "正在导入…"
              : "导入角色"}
        </button>
      </div>
      <div className="model-grid">
        <div
          className={`model-card ${!state.settings.activeModelId ? "chosen" : ""}`}
        >
          <div className="model-card-preview placeholder">
            <Avatar
              mood="idle"
              reducedMotion={state.settings.reducedMotion}
              speech={false}
            />
            <span className="model-type">占位角色</span>
          </div>
          <div className="model-card-details">
            <div>
              <h3>一只等待相遇的小猫</h3>
              <p>轻量简笔占位 · 无需模型资源</p>
            </div>
            <button
              className={`model-select ${!state.settings.activeModelId ? "selected" : ""}`}
              title="使用默认占位"
              aria-label="使用默认占位"
              onClick={() => {
                void perform(() => api.updateSettings({ activeModelId: null }));
              }}
            >
              {!state.settings.activeModelId ? (
                <Check size={17} />
              ) : (
                <Plus size={17} />
              )}
            </button>
          </div>
        </div>
        {state.models.map((model) => (
          <div
            key={model.id}
            className={`model-card ${state.settings.activeModelId === model.id ? "chosen" : ""}`}
          >
            <ModelPreview model={model} />
            <div className="model-card-details">
              <div>
                <h3>{model.name}</h3>
                <p>{model.kind.toUpperCase()} · 本地导入</p>
              </div>
              <button
                className={`model-select ${state.settings.activeModelId === model.id ? "selected" : ""}`}
                title={`使用 ${model.name}`}
                aria-label={`使用 ${model.name}`}
                onClick={() => {
                  void perform(() =>
                    api.updateSettings({ activeModelId: model.id }),
                  );
                }}
              >
                {state.settings.activeModelId === model.id ? (
                  <Check size={17} />
                ) : (
                  <Plus size={17} />
                )}
              </button>
            </div>
            <button
              className={`model-delete ${removing === model.id ? "confirm" : ""}`}
              title={
                removing === model.id ? "再点一次确认删除" : "移除本地角色"
              }
              aria-label={
                removing === model.id
                  ? `确认删除 ${model.name}`
                  : `删除 ${model.name}`
              }
              onBlur={() => setRemoving("")}
              onClick={() => {
                if (removing !== model.id) {
                  setRemoving(model.id);
                  return;
                }
                void perform(
                  () => api.removeModel(model.id),
                  "已移除角色，原始模型文件不受影响",
                );
                setRemoving("");
              }}
            >
              <Trash2 size={13} />
              {removing === model.id ? "确认移除" : "移除"}
            </button>
          </div>
        ))}
        <button
          className="model-import-card"
          onClick={() => {
            void importModel();
          }}
          disabled={busy}
        >
          <span>
            <FolderInput size={30} strokeWidth={1.3} />
          </span>
          <h3>下一个，是谁呢？</h3>
          <p>导入本地角色，开始新的相遇。</p>
          <span className="text-button">
            选择模型文件
            <ArrowUpRight size={14} />
          </span>
        </button>
      </div>
      <Panel
        title="把喜欢的角色带来"
        subtitle="不附带第三方角色模型。导入的文件会复制到应用数据目录，原文件可以自由整理。"
        className="import-guide"
      >
        <div className="live2d-runtime">
          <div>
            <h3>Live2D 运行库</h3>
            <p role="status">
              {state.live2dCoreDownloading
                ? "正在下载 Live2D 运行库，请稍候…"
                : state.live2dCoreReady
                  ? "已就绪，导入其他 Live2D 模型时会自动复用。"
                  : "只有模型文件也可以，首次导入时会自动下载官方运行库。"}
            </p>
            {state.live2dCoreError && (
              <p className="live2d-runtime-error" role="alert">
                {state.live2dCoreError}
              </p>
            )}
            <small>
              下载一次后可离线使用。新旧模型分别使用经过校验的运行库，移除角色不会丢失。
            </small>
            <p>
              Cubism 2：
              {state.live2dLegacyReady
                ? "兼容运行库已就绪"
                : "首次导入旧版模型时自动下载兼容运行库"}
            </p>
          </div>
          <div className="live2d-runtime-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void importModel("folder")}
            >
              <FolderInput size={16} />
              导入模型文件夹
            </button>
            <button
              className="button primary"
              onClick={() => {
                void downloadCore();
              }}
              disabled={busy}
            >
              <Download size={16} />
              {state.live2dCoreDownloading
                ? "正在下载…"
                : state.live2dCoreError
                  ? "重试下载"
                  : state.live2dCoreReady
                    ? "更新官方运行库"
                    : "下载官方运行库"}
            </button>
            <button
              className="button secondary"
              onClick={() => {
                void importCore();
              }}
              disabled={busy}
            >
              <FolderInput size={16} />
              {settingCore ? "正在设置…" : "从本地导入"}
            </button>
            {!state.live2dLegacyReady && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void perform(
                    () => api.downloadLive2DCore("legacy"),
                    "Cubism 2 兼容运行库已就绪",
                  )
                }
              >
                <Download size={16} />
                下载旧版运行库
              </button>
            )}
          </div>
        </div>
        <div className="format-grid">
          <div>
            <FileImage size={20} />
            <h4>图片 / PNGTuber</h4>
            <p>PNG、WebP、GIF、JPG。双图角色使用 JSON 指定 idle 与 talking。</p>
          </div>
          <div>
            <PawPrint size={20} />
            <h4>Live2D</h4>
            <p>
              支持 Cubism 2 的 .model.json 和 Cubism 3 / 4 / 5 的 .model3.json。
              可选择入口文件或完整模型文件夹，自动导入贴图、动作、表情与物理。
            </p>
          </div>
          <div>
            <Box size={20} />
            <h4>VRM / GLB / MMD</h4>
            <p>支持 VRM 0 / 1、GLB、PMX、PMD。呼吸与口型随聊天状态变化。</p>
          </div>
        </div>
        <details className="format-example">
          <summary>PNGTuber 配置示例</summary>
          <pre>
            {
              '{\n  "name": "我的麦麦",\n  "idle": "idle.png",\n  "talking": "talking.png"\n}'
            }
          </pre>
          <p>
            将 JSON 和两张图片放在同一文件夹，选择 JSON
            导入。请使用你有权使用的资源。
          </p>
        </details>
      </Panel>
    </>
  );
}

function ModelPreview({ model }: { model: ImportedModel }) {
  return (
    <div className="model-card-preview">
      {model.kind === "image" || model.kind === "pngtuber" ? (
        <img src={model.assetUrl} alt={model.name} />
      ) : (
        <div className="model-format-symbol">
          <Box size={45} strokeWidth={1.1} />
          <strong>{model.kind.toUpperCase()}</strong>
          <span>应用后可在首页预览</span>
        </div>
      )}
      <span className="model-type">{model.kind.toUpperCase()}</span>
    </div>
  );
}
