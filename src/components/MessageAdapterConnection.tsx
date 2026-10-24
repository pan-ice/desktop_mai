import { useRef, useState } from "react";
import { Download, LoaderCircle, Plug, Square } from "lucide-react";
import { api, perform, showToast } from "../api";
import { Panel } from "./ui";
import { AdapterPortField, useAdapterPort } from "./AdapterPortField";
import type { Snapshot } from "../../shared/types";

export function MessageAdapterConnection({ state }: { state: Snapshot }) {
  const port = useAdapterPort(state.settings.adapterPort);
  const [operation, setOperation] = useState("");
  const pending = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const busy = Boolean(operation);
  const localActive =
    state.settings.connectionMode === "local" &&
    ["connected", "connecting", "reconnecting"].includes(
      state.connection.phase,
    );
  const run = async (action: "connect" | "export" | "disconnect") => {
    if (
      pending.current ||
      (action !== "disconnect" && !form.current?.reportValidity())
    )
      return;
    pending.current = true;
    setOperation(action);
    try {
      await perform(async () => {
        if (action === "disconnect") {
          await api.disconnect();
          return;
        }
        await port.save();
        if (action === "export") {
          if (await api.exportMessageAdapterConfig())
            showToast("配置已导出，接入已开启；请使用新配置启动适配器");
        } else await api.connect();
      });
    } finally {
      pending.current = false;
      setOperation("");
    }
  };
  return (
    <Panel
      title="独立适配器接入"
      subtitle={
        localActive
          ? state.connection.detail
          : "连接你自己部署的 MaiBot，无需安装桌宠插件。"
      }
    >
      <form
        ref={form}
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void run("connect");
        }}
      >
        <AdapterPortField
          label="桌宠接入端口"
          savedPort={state.settings.adapterPort}
          draft={port}
          disabled={busy}
        />
        <div className="form-actions">
          {localActive && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void run("disconnect")}
            >
              {operation === "disconnect" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Square size={14} />
              )}
              {operation === "disconnect" ? "正在断开…" : "断开"}
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void run("export")}
          >
            {operation === "export" ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Download size={15} />
            )}
            {operation === "export" ? "正在导出…" : "导出配置并开启接入"}
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {operation === "connect" ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Plug size={15} />
            )}
            {operation === "connect" ? "正在开启…" : "开启接入"}
          </button>
        </div>
        <p className="helper-text">
          导出后按适配器说明启动；连接成功后即可聊天。
        </p>
      </form>
    </Panel>
  );
}
