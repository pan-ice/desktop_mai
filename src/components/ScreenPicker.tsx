import { useEffect, useState } from "react";
import { LoaderCircle, Monitor, X } from "lucide-react";
import { api, perform } from "../api";
import type { ScreenSource, Snapshot } from "../../shared/types";

export function ScreenPicker({
  state,
  onClose,
  onCapture,
}: {
  state: Snapshot;
  onClose: () => void;
  onCapture: (data: string) => void;
}) {
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState(state.settings.screenEnabled);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    void api
      .screenSources()
      .then((value) => {
        if (!cancelled) setSources(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason.message || reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal screen-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="screen-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <span className="modal-icon">
            <Monitor size={23} />
          </span>
          <div>
            <h2 id="screen-title">一起看看你的世界</h2>
            <p>选择一个屏幕或窗口。截图会先进入预览，发送后麦麦才能看到。</p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭屏幕选择"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        {!enabled ? (
          <div className="permission-prompt">
            <p>
              屏幕感知目前已关闭。这里先选择并预览截图，自动感知可以在设置中单独开启。
            </p>
            <button
              className="button primary"
              onClick={() => {
                void perform(async () => {
                  await api.updateSettings({ screenEnabled: true });
                  setEnabled(true);
                });
              }}
            >
              开启并选择屏幕
            </button>
          </div>
        ) : loading ? (
          <div className="loading-state">
            <LoaderCircle className="spin" />
            正在获取可分享的窗口…
          </div>
        ) : error ? (
          <p className="inline-error">{error}</p>
        ) : (
          <div className="screen-grid">
            {sources.map((source) => (
              <button
                key={source.id}
                onClick={() => {
                  void perform(async () => {
                    const image = await api.captureScreen(source.id);
                    await api.updateSettings({ screenSourceId: source.id });
                    onCapture(image);
                  });
                }}
              >
                <img src={source.thumbnail} alt={source.name} />
                <span>{source.name}</span>
              </button>
            ))}
            {!sources.length && (
              <p>没有可分享的屏幕，请检查系统屏幕录制权限。</p>
            )}
          </div>
        )}
        <div className="modal-footer">
          <span>自动感知默认关闭，可在声音与感知中单独开启</span>
          <button className="button secondary" onClick={onClose}>
            取消
          </button>
        </div>
      </section>
    </div>
  );
}
