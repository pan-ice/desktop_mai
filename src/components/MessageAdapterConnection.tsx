import { useState } from "react";
import { Download, LoaderCircle, Plug, Square } from "lucide-react";
import { api, perform } from "../api";
import { Field, Panel } from "./ui";
import type { Snapshot } from "../../shared/types";

export function MessageAdapterConnection({ state }: { state: Snapshot }) {
  const [port, setPort] = useState(state.settings.adapterPort);
  const [busy, setBusy] = useState(false);
  const localActive =
    state.settings.connectionMode === "local" &&
    ["connected", "connecting", "reconnecting"].includes(
      state.connection.phase,
    );
  const run = async (exportConfig: boolean) => {
    setBusy(true);
    try {
      await perform(async () => {
        await api.updateSettings({
          connectionMode: "local",
          adapterPort: port,
        });
        if (exportConfig && !(await api.exportMessageAdapterConfig())) return;
        await api.connect();
      });
    } finally {
      setBusy(false);
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
        onSubmit={(event) => {
          event.preventDefault();
          void run(false);
        }}
      >
        <Field
          label="桌宠接入端口"
          hint="与适配器配置保持一致；首次使用先导出配置。"
        >
          <input
            type="number"
            required
            min={1024}
            max={65535}
            value={port}
            onChange={(event) => setPort(Number(event.target.value))}
          />
        </Field>
        <div className="form-actions">
          {localActive && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void perform(() => api.disconnect())}
            >
              <Square size={14} /> 断开
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void run(true)}
          >
            <Download size={15} /> 导出配置并开启接入
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Plug size={15} />
            )}
            开启接入
          </button>
        </div>
        <p className="helper-text">
          导出后按适配器说明启动；连接成功后即可聊天。
        </p>
      </form>
    </Panel>
  );
}
