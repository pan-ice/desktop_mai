import { useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { api, perform } from "../api";
import { Field } from "./ui";
import type { Snapshot } from "../../shared/types";

/** 只为已有安装保留接入兼容；日常使用由 QQ 登录完成。 */
export function LegacyConnection({ state }: { state: Snapshot }) {
  const [token, setToken] = useState("");
  const [port, setPort] = useState(state.settings.adapterPort);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await perform(action);
    } finally {
      setBusy(false);
    }
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
            void run(async () => {
              if (await api.importServerConnection()) await api.connect();
            })
          }
        >
          <Download size={15} /> 导入服务器凭证
        </button>
        <details className="connection-more legacy-local">
          <summary>本机适配器接入</summary>
          <form
            className="connection-more-content"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                if (token) {
                  await api.setCredential("adapterToken", token);
                  setToken("");
                }
                await api.updateSettings({
                  connectionMode: "local",
                  adapterPort: port,
                });
                await api.connect();
              });
            }}
          >
            <Field label="本机接入端口">
              <input
                type="number"
                required
                min={1024}
                max={65535}
                value={port}
                onChange={(event) => setPort(Number(event.target.value))}
              />
            </Field>
            <Field
              label="独立连接令牌"
              hint="留空会沿用原令牌，首次使用自动生成。"
            >
              <input
                type="password"
                autoComplete="off"
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
                onClick={() =>
                  void run(async () => {
                    if (token) {
                      await api.setCredential("adapterToken", token);
                      setToken("");
                    }
                    await api.updateSettings({
                      connectionMode: "local",
                      adapterPort: port,
                    });
                    await api.exportAdapterConfig();
                  })
                }
              >
                <Download size={15} /> 导出插件配置
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                {busy && <LoaderCircle size={15} className="spin" />}
                保存并开启接入
              </button>
            </div>
          </form>
        </details>
      </div>
    </details>
  );
}
