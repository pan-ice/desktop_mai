import { useEffect, useRef, useState } from "react";
import { Camera, LoaderCircle, Send, X } from "lucide-react";
import { api, showToast } from "../api";
import type { Snapshot } from "../../shared/types";
import { useDialog } from "../hooks/useDialog";

export function CameraShare({
  state,
  onClose,
}: {
  state: Snapshot;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const dialog = useDialog(onClose);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [image, setImage] = useState("");
  const [text, setText] = useState("这是我现在看到的，一起来看看吧。");
  const closePreview = useRef(onClose);
  closePreview.current = onClose;
  const releaseCamera = useRef<() => void>(() => {});
  useEffect(
    () =>
      api.onWindowHidden(() => {
        // 立即停止轨道，包括尚未完成的 getUserMedia；不等待隐藏窗口重新渲染。
        releaseCamera.current();
        closePreview.current();
      }),
    [],
  );
  useEffect(() => {
    if (image) return;
    let disposed = false,
      stream: MediaStream | undefined;
    const release = () => {
      disposed = true;
      stream?.getTracks().forEach((track) => track.stop());
      if (video.current) video.current.srcObject = null;
    };
    releaseCamera.current = release;
    setLoading(true);
    setError("");
    void navigator.mediaDevices
      .getUserMedia({
        video: selected
          ? {
              deviceId: { exact: selected },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      .then(async (media) => {
        stream = media;
        if (disposed) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        if (video.current) {
          video.current.srcObject = media;
          await video.current.play();
        }
        const available = await navigator.mediaDevices.enumerateDevices();
        if (!disposed) {
          setDevices(
            available.filter((device) => device.kind === "videoinput"),
          );
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (!disposed) {
          release();
          setError(reason.message || String(reason));
          setLoading(false);
        }
      });
    return () => {
      release();
      if (releaseCamera.current === release) releaseCamera.current = () => {};
    };
  }, [selected, image]);
  const take = () => {
    const source = video.current;
    if (!source?.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    canvas.getContext("2d")!.drawImage(source, 0, 0);
    setImage(canvas.toDataURL("image/jpeg", 0.82));
  };
  const send = async () => {
    if (sending || state.connection.phase !== "connected") return;
    setSending(true);
    setSendError("");
    try {
      if (!state.settings.screenEnabled)
        await api.updateSettings({ screenEnabled: true });
      await api.send({ text, image, source: "screen" });
      if (mounted.current) onClose();
      showToast("照片已发送给 MaiBot");
    } catch (reason) {
      if (mounted.current)
        setSendError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setSending(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialog}
        tabIndex={-1}
        className="modal camera-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="camera-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <span className="modal-icon">
            <Camera size={23} />
          </span>
          <div>
            <h2 id="camera-title">分享眼前的小世界</h2>
            <p>仅在这个窗口打开时使用摄像头。拍照预览后，再由你发送。</p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭摄像头"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        <div className="camera-preview">
          {image ? (
            <img src={image} alt="待发送的摄像头照片" />
          ) : (
            <video ref={video} muted playsInline />
          )}
          {loading && !image && (
            <div>
              <LoaderCircle className="spin" />
              正在打开摄像头…
            </div>
          )}
          {error && <div className="inline-error">{error}</div>}
        </div>
        {image ? (
          <textarea
            aria-label="照片附言"
            disabled={sending}
            maxLength={12000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={2}
          />
        ) : (
          devices.length > 1 && (
            <select
              aria-label="选择摄像头"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">默认摄像头</option>
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || "摄像头"}
                </option>
              ))}
            </select>
          )
        )}
        {sendError && (
          <p className="composer-error" role="alert">
            {sendError} · 照片已保留，可重新发送。
          </p>
        )}
        <div className="modal-footer">
          <span>关闭窗口立即释放摄像头</span>
          {image ? (
            <div className="heading-actions">
              <button
                className="button secondary"
                disabled={sending}
                onClick={() => setImage("")}
              >
                重新拍照
              </button>
              <button
                className="button primary"
                disabled={sending || state.connection.phase !== "connected"}
                aria-busy={sending}
                onClick={() => void send()}
              >
                {sending ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Send size={14} />
                )}
                {sending ? "正在发送…" : `发送给${state.settings.nickname}`}
              </button>
            </div>
          ) : (
            <button
              className="button primary"
              disabled={loading || Boolean(error)}
              onClick={take}
            >
              <Camera size={15} />
              拍照并预览
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
