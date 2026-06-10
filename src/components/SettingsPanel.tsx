import { useGenerationStore } from "../stores/generationStore";
import type { Parameter, EnumParam, IntParam, FloatParam, BoolParam } from "../lib/types";
import { ToggleGroup } from "./ToggleGroup";

export function SettingsPanel() {
  const currentModel = useGenerationStore((s) => s.currentModel);
  const settings = useGenerationStore((s) => s.settings);
  const setSetting = useGenerationStore((s) => s.setSetting);

  if (!currentModel) {
    return <div className="text-text opacity-60 text-xs">Select a model.</div>;
  }

  const visibleParams = currentModel.parameters.filter((p: Parameter) => {
    if (p.api_field === "seed") return false;
    if (p.type === "enum" && p.options.length <= 1) return false;
    return true;
  });

  return (
    <div className="flex flex-col gap-[10px] overflow-y-auto thin-scroll pr-1">
      {visibleParams.map((p) => (
        <ParamRow
          key={p.api_field}
          param={p}
          value={settings[p.api_field]}
          onChange={(v) => setSetting(p.api_field, v)}
        />
      ))}
    </div>
  );
}

function ParamRow({
  param,
  value,
  onChange,
}: {
  param: Parameter;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <div className="flex flex-col gap-[4px]">
      <label className="text-xs opacity-80 text-text">{param.label}</label>
      {renderControl(param, value, onChange)}
    </div>
  );
}

function renderControl(
  param: Parameter,
  value: unknown,
  onChange: (v: unknown) => void,
): React.ReactNode {
  switch (param.type) {
    case "enum":
      return <EnumControl param={param} value={String(value ?? param.default)} onChange={onChange} />;
    case "int":
      return <IntControl param={param} value={Number(value ?? param.default)} onChange={onChange} />;
    case "float":
      return <FloatControl param={param} value={Number(value ?? param.default)} onChange={onChange} />;
    case "bool":
      return (
        <BoolControl
          param={param}
          value={Boolean(value ?? param.default)}
          onChange={onChange}
        />
      );
  }
}

function EnumControl({
  param,
  value,
  onChange,
}: {
  param: EnumParam;
  value: string;
  onChange: (v: unknown) => void;
}) {
  const opts = param.options.map((o) => ({ value: o, label: o }));
  return <ToggleGroup value={value} options={opts} onChange={onChange} />;
}

function IntControl({
  param,
  value,
  onChange,
}: {
  param: IntParam;
  value: number;
  onChange: (v: unknown) => void;
}) {
  const span = param.max - param.min;
  if (span <= 14 && span > 0) {
    const opts: { value: number; label: string }[] = [];
    for (let i = param.min; i <= param.max; i++) opts.push({ value: i, label: String(i) });
    return <ToggleGroup value={value} options={opts} onChange={onChange} />;
  }
  return (
    <input
      type="number"
      step={1}
      min={param.min}
      max={param.max}
      value={Number.isFinite(value) ? value : param.default}
      className="bg-bg text-text px-1 py-[2px] w-24"
      onChange={(e) => {
        const n = parseInt(e.currentTarget.value, 10);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

function FloatControl({
  param,
  value,
  onChange,
}: {
  param: FloatParam;
  value: number;
  onChange: (v: unknown) => void;
}) {
  return (
    <input
      type="number"
      step={param.step}
      min={param.min}
      max={param.max}
      value={Number.isFinite(value) ? value : param.default}
      className="bg-bg text-text px-1 py-[2px] w-24"
      onChange={(e) => {
        const n = parseFloat(e.currentTarget.value);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

function BoolControl({
  param,
  value,
  onChange,
}: {
  param: BoolParam;
  value: boolean;
  onChange: (v: unknown) => void;
}) {
  const text = param.name.replace(/_/g, " ");
  return (
    <label className="flex items-center gap-[6px] text-xs text-text cursor-pointer select-none">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="accent-accent"
      />
      <span>{text}</span>
    </label>
  );
}
