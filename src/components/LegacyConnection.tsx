import { useRef, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { api, perform, showToast } from "../api";
import { Field } from "./ui";
import { AdapterPortField, useAdapterPort } from "./AdapterPortField";
import type { Snapshot } from "../../shared/types";

/** 只为已有安装保留接入兼容；日常使用由 QQ 登录完成。 */
export function LegacyConnection({ state }: { state: Snapshot }) {
  const [token, setToken] = useState("");
  const port = useAdapterPort(state.settings.adapterPort);
  const [operation, setOperation] = useState("");
  const pending = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const busy = Boolean(operation);
  const run = async (name: string, action: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setOperation(name);
    try {
      await perform(action);
    } finally {
      pending.current = false;
      setOperation("");
    }
  };
  const saveConnection = (exportConfig: boolean) => {
    if (!form.current?.reportValidity()) return;
    return run(exportConfig ? "export" : "connect", async () => {
      if (token) {
        await api.setCredential("adapterToken", token);
        setToken("");
      }
      await port.save();
      if (exportConfig) {
        if (await api.exportAdapterConfig())
          showToast("插件配置已导出，接入已开启；请替换配置并重载插件");
      } else await api.connect();
    });
  };
  return (
    <details className="connection-more legacy-connection">
      <summary>旧版接入</summary>
      <div className="connection-more-content">
        <p className="helper-text">已有安装可继续使用原连接方式。</p>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() =>
            void run("import", async () => {
              if (await api.importServerConnection()) await api.connect();
            })
          }
        >
          {operation === "import" ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Download size={15} />
          )}
          {operation === "import" ? "正在导入…" : "导入服务器凭证"}
        </button>
        <details className="connection-more legacy-local">
          <summary>本机适配器接入</summary>
          <form
            ref={form}
            aria-busy={busy}
            className="connection-more-content"
            onSubmit={(event) => {
              event.preventDefault();
              void saveConnection(false);
            }}
          >
            <AdapterPortField
              label="本机接入端口"
              savedPort={state.settings.adapterPort}
              draft={port}
              disabled={busy}
            />
            <Field
              label="独立连接令牌"
              hint="留空会沿用原令牌，首次使用自动生成。"
            >
              <input
                type="password"
                autoComplete="off"
                disabled={busy}
                value={token}
                placeholder={
                  state.credentials.adapterToken ? "已保存" : "自动生成"
                }
                onChange={(event) => setToken(event.target.value)}
              />
            </Field>
            <div className="form-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void saveConnection(true)}
              >
                {operation === "export" ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Download size={15} />
                )}
                {operation === "export"
                  ? "正在导出…"
                  : "导出插件配置并开启接入"}
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                {operation === "connect" && (
                  <LoaderCircle size={15} className="spin" />
                )}
                {operation === "connect" ? "正在开启…" : "保存并开启接入"}
              </button>
            </div>
          </form>
        </details>
      </div>
    </details>
  );
}
