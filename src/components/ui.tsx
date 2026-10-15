import { useEffect, useState, type ReactNode } from "react";
import { Check, CircleAlert, X } from "lucide-react";
import { api, perform } from "../api";
import type { Settings, Snapshot } from "../../shared/types";

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-row ${disabled ? "disabled" : ""}`}>
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <button
        type="button"
        className={`switch ${checked ? "on" : ""}`}
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <i />
      </button>
    </label>
  );
}

export function SettingToggle({
  state,
  name,
  label,
  hint,
}: {
  state: Snapshot;
  name: keyof Settings;
  label: string;
  hint?: string;
}) {
  return (
    <Toggle
      label={label}
      hint={hint}
      checked={Boolean(state.settings[name])}
      onChange={(value) => {
        void perform(() => api.updateSettings({ [name]: value }));
      }}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Panel({
  title,
  subtitle,
  children,
  className = "",
  action,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-heading">
          <div>
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Status({
  state,
  small = false,
}: {
  state: Snapshot;
  small?: boolean;
}) {
  const online = state.connection.phase === "connected";
  const connecting = ["connecting", "reconnecting"].includes(
    state.connection.phase,
  );
  return (
    <span
      className={`status ${online ? "online" : connecting ? "pending" : "offline"} ${small ? "small" : ""}`}
      title={state.connection.detail}
    >
      <i />
      {online ? "MaiBot 已连接" : connecting ? "正在连接内核" : "MaiBot 未连接"}
    </span>
  );
}

export function Toasts() {
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const handler = (event: Event) => {
      setToast((event as CustomEvent).detail);
      clearTimeout(timeout);
      timeout = setTimeout(() => setToast(null), 6500);
    };
    window.addEventListener("mai:toast", handler);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("mai:toast", handler);
    };
  }, []);
  return toast ? (
    <div
      className={`toast ${toast.error ? "error" : ""}`}
      role={toast.error ? "alert" : "status"}
    >
      {toast.error ? <CircleAlert size={18} /> : <Check size={18} />}
      <span>{toast.text}</span>
      <button aria-label="关闭提示" onClick={() => setToast(null)}>
        <X size={16} />
      </button>
    </div>
  ) : null;
}

export function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
