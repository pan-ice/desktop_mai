import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Monitor, X } from "lucide-react";
import { api } from "../api";
import type { ScreenSource, Snapshot } from "../../shared/types";
import { useDialog } from "../hooks/useDialog";

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
  const [capturing, setCapturing] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [reload, setReload] = useState(0);
  const dialog = useDialog(onClose);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError("");
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
  }, [enabled, reload]);
  const enable = async () => {
    if (capturing) return;
    setCapturing(true);
    setOperationError("");
    try {
      await api.updateSettings({ screenEnabled: true });
      if (mounted.current) setEnabled(true);
    } catch (reason) {
      if (mounted.current)
        setOperationError(
          reason instanceof Error ? reason.message : String(reason),
        );
    } finally {
      if (mounted.current) setCapturing(false);
    }
  };
  const capture = async (id: string) => {
    if (capturing) return;
    setCapturing(true);
    setOperationError("");
    try {
      const image = await api.captureScreen(id);
      if (!mounted.current) return;
      await api.updateSettings({ screenSourceId: id });
      if (mounted.current) onCapture(image);
    } catch (reason) {
      if (mounted.current)
        setOperationError(
          reason instanceof Error ? reason.message : String(reason),
        );
    } finally {
      if (mounted.current) setCapturing(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialog}
        tabIndex={-1}
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
        {operationError && (
          <p className="composer-error" role="alert">
            {operationError} · 可以重试或选择其他窗口。
          </p>
        )}
        {!enabled ? (
          <div className="permission-prompt">
            <p>
              屏幕感知目前已关闭。这里先选择并预览截图，自动感知可以在设置中单独开启。
            </p>
            <button
              className="button primary"
              disabled={capturing}
              onClick={() => void enable()}
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
          <div className="inline-error" role="alert">
            <p>{error}</p>
            <button
              className="button secondary"
              onClick={() => setReload((value) => value + 1)}
            >
              重新获取屏幕
            </button>
          </div>
        ) : (
          <div className="screen-grid">
            {sources.map((source) => (
              <button
                key={source.id}
                disabled={capturing}
                onClick={() => void capture(source.id)}
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
