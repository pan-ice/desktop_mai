import { useEffect, useId, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api";

function portText(port: number) {
  return port > 0 ? String(port) : "";
}

/** 分配结果只同步到未编辑的字段，提交期间的新输入继续作为草稿保留。 */
export function useAdapterPort(savedPort: number) {
  const [value, setValue] = useState(() => portText(savedPort));
  const current = useRef({ value, dirty: false, revision: 0 });

  useEffect(() => {
    const saved = portText(savedPort);
    if (!current.current.dirty || current.current.value === saved) {
      current.current.value = saved;
      current.current.dirty = false;
      setValue(saved);
    }
  }, [savedPort]);

  const change = (next: string) => {
    current.current = {
      value: next,
      dirty: next !== portText(savedPort),
      revision: current.current.revision + 1,
    };
    setValue(next);
  };

  const save = async () => {
    const submitted = { ...current.current };
    const adapterPort = submitted.value.trim() ? Number(submitted.value) : 0;
    if (
      submitted.value.trim() !== "" &&
      (!Number.isInteger(adapterPort) ||
        adapterPort < 1024 ||
        adapterPort > 65535)
    )
      throw new Error("接入端口请留空自动分配，或填写 1024 至 65535 的整数");
    const updated = await api.updateSettings({
      connectionMode: "local",
      adapterPort,
    });
    if (current.current.revision === submitted.revision) {
      const saved = portText(updated.settings.adapterPort);
      current.current.value = saved;
      current.current.dirty = false;
      setValue(saved);
    }
  };

  return { value, change, save };
}

export function AdapterPortField({
  label,
  savedPort,
  draft,
  disabled,
}: {
  label: string;
  savedPort: number;
  draft: ReturnType<typeof useAdapterPort>;
  disabled: boolean;
}) {
  const id = useId();
  const automatic = !draft.value.trim();
  const changed = draft.value !== portText(savedPort);
  return (
    <div className="field adapter-port-field">
      <label htmlFor={id}>{label}</label>
      <div className="adapter-port-controls">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={1024}
          max={65535}
          step={1}
          disabled={disabled}
          value={draft.value}
          placeholder="留空自动分配"
          aria-describedby={`${id}-hint ${id}-saved`}
          onChange={(event) => draft.change(event.target.value)}
        />
        <button
          type="button"
          className="button secondary"
          disabled={disabled || automatic}
          onClick={() => draft.change("")}
        >
          <RefreshCw size={14} />
          {savedPort > 0 ? "重新自动分配" : "自动分配"}
        </button>
      </div>
      <small id={`${id}-hint`}>
        留空时在开启接入或导出配置时自动选择空闲端口；也可手动填写 1024–65535。
      </small>
      <p
        id={`${id}-saved`}
        className={`adapter-port-status ${changed ? "dirty" : ""}`}
        role="status"
      >
        {savedPort > 0 ? `当前已保存端口：${savedPort}。` : "尚未分配端口。"}
        {changed
          ? automatic
            ? "下次开启或导出时重新分配；请重新导出并替换适配器配置。"
            : "修改尚未生效；应用后请重新导出并替换适配器配置。"
          : savedPort > 0
            ? "后续启动会复用；更换端口后需重新导出适配器配置。"
            : "分配后会保存并在后续启动时复用。"}
      </p>
    </div>
  );
}
