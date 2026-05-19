import { useEffect, useMemo, useRef, useState } from "react";
import { cmd } from "../lib/tauri";
import { pickFile, showMessage } from "../lib/dialog";
import { applyColors, COLOR_KEYS, DEFAULT_COLORS } from "../lib/colors";
import type { ColorOverrides, Config, FalLifecycle } from "../lib/types";

const FAL_LIFECYCLE_OPTIONS: { value: "" | FalLifecycle; label: string }[] = [
  { value: "", label: "fal default (keep forever)" },
  { value: "immediate", label: "delete immediately after fetch" },
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "1y", label: "1 year" },
  { value: "never", label: "never (explicit)" },
];

const COLOR_LABELS: Record<keyof ColorOverrides, string> = {
  bg: "bg",
  border: "border",
  src: "panel bg",
  handle: "handles",
  text: "text",
  accent: "accent",
};

type Props = {
  onClose: () => void;
};

const FILENAME_TEMPLATE_DEFAULT =
  "<date>_<time>_<sequence>_<shot>_<model>_<version>";

const DEFAULT: Config = {
  windowBounds: { width: 1600, height: 1000 },
  projectPath: "",
  lastSequence: "",
  lastShot: "",
  lastModel: "",
  ffmpegPath: "",
  maxConcurrentJobs: 3,
  filenameTemplate: undefined,
  colors: undefined,
  falLifecycle: undefined,
};

export function SettingsDialog({ onClose }: Props) {
  const [falKey, setFalKey] = useState("");
  const [replicateKey, setReplicateKey] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [revealReplicate, setRevealReplicate] = useState(false);
  const [config, setConfig] = useState<Config>(DEFAULT);
  const [originalColors, setOriginalColors] = useState<ColorOverrides | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const currentColors = useMemo<Required<ColorOverrides>>(
    () => ({ ...DEFAULT_COLORS, ...(config.colors ?? {}) }),
    [config.colors],
  );

  useEffect(() => {
    void (async () => {
      const [k, rk, c] = await Promise.all([
        cmd.provider_key_get("fal").catch(() => ""),
        cmd.provider_key_get("replicate").catch(() => ""),
        cmd.config_load().catch(() => null),
      ]);
      setFalKey(k);
      setReplicateKey(rk);
      if (c) {
        const cfg = c as Config;
        setConfig(cfg);
        setOriginalColors(cfg.colors);
      }
      setLoaded(true);
    })();
  }, []);

  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCloseRef.current();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  // Live-preview color edits — only after config has loaded to avoid wiping current colors on mount.
  useEffect(() => {
    if (!loaded) return;
    applyColors(config.colors);
  }, [config.colors, loaded]);

  function handleClose() {
    // Revert live-preview to the saved state.
    applyColors(originalColors);
    onClose();
  }

  async function browseFfmpeg() {
    const paths = await pickFile("Pick ffmpeg executable", {
      extensions: ["exe"],
    });
    if (paths?.[0]) setConfig((c) => ({ ...c, ffmpegPath: paths[0] }));
  }

  function setColor(key: keyof ColorOverrides, value: string) {
    setConfig((c) => ({ ...c, colors: { ...(c.colors ?? {}), [key]: value } }));
  }

  function resetColors() {
    setConfig((c) => ({ ...c, colors: undefined }));
  }

  async function save() {
    setBusy(true);
    try {
      await cmd.provider_key_set("fal", falKey.trim());
      await cmd.provider_key_set("replicate", replicateKey.trim());
      await cmd.config_save(config);
      setOriginalColors(config.colors);
      onClose();
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8"
      onClick={handleClose}
    >
      <div
        className="bg-panel text-text max-w-[560px] w-full border border-dim shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2 bg-surface text-text text-sm">Settings</div>

        <div className="p-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto thin-scroll">
          <Field label="FAL_KEY">
            <div className="flex gap-1">
              <input
                type={revealKey ? "text" : "password"}
                value={falKey}
                onChange={(e) => setFalKey(e.currentTarget.value)}
                className="flex-1 bg-bg px-2 py-1 font-mono text-xs"
                placeholder="fal-…"
              />
              <button
                className="px-2 bg-bg text-xs"
                onClick={() => setRevealKey((v) => !v)}
              >
                {revealKey ? "hide" : "show"}
              </button>
            </div>
            <div className="text-xs text-dim mt-1">
              Stored in <code>%APPDATA%/aiSLAP/.env</code>.
            </div>
          </Field>

          <Field label="fal.ai object lifecycle">
            <select
              value={config.falLifecycle ?? ""}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setConfig((c) => ({
                  ...c,
                  falLifecycle: v ? (v as FalLifecycle) : undefined,
                }));
              }}
              className="bg-bg px-2 py-1 text-xs font-mono"
            >
              {FAL_LIFECYCLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <div className="text-xs text-dim mt-1">
              Sent as <code>x-fal-object-lifecycle-preference</code>. Controls how long fal retains generated objects.
            </div>
          </Field>

          <Field label="REPLICATE_API_TOKEN">
            <div className="flex gap-1">
              <input
                type={revealReplicate ? "text" : "password"}
                value={replicateKey}
                onChange={(e) => setReplicateKey(e.currentTarget.value)}
                className="flex-1 bg-bg px-2 py-1 font-mono text-xs"
                placeholder="r8_…"
              />
              <button
                className="px-2 bg-bg text-xs"
                onClick={() => setRevealReplicate((v) => !v)}
              >
                {revealReplicate ? "hide" : "show"}
              </button>
            </div>
          </Field>

          <Field label="ffmpeg path (for video thumbnails)">
            <div className="flex gap-1">
              <input
                type="text"
                value={config.ffmpegPath}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setConfig((c) => ({ ...c, ffmpegPath: value }));
                }}
                className="flex-1 bg-bg px-2 py-1 text-xs font-mono"
                placeholder="ffmpeg.exe (optional)"
              />
              <button className="px-2 bg-bg text-xs" onClick={browseFfmpeg}>
                browse
              </button>
            </div>
          </Field>

          <Field label="Max concurrent submissions">
            <input
              type="number"
              min={1}
              max={10}
              value={config.maxConcurrentJobs ?? 3}
              onChange={(e) => {
                const n = parseInt(e.currentTarget.value, 10);
                setConfig((c) => ({
                  ...c,
                  maxConcurrentJobs: Number.isFinite(n)
                    ? Math.max(1, Math.min(10, n))
                    : 3,
                }));
              }}
              className="bg-bg px-2 py-1 text-xs font-mono w-20"
              title="Caps how many submissions hit fal.ai in parallel. Extra submits sit in a local queue."
            />
            <div className="text-xs text-dim mt-1">
              Extra submits beyond this cap wait in a local queue.
            </div>
          </Field>

          <Field label="Filename template">
            <div className="flex gap-1">
              <input
                type="text"
                value={config.filenameTemplate ?? ""}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setConfig((c) => ({
                    ...c,
                    filenameTemplate: value || undefined,
                  }));
                }}
                className="flex-1 bg-bg px-2 py-1 text-xs font-mono"
                placeholder={FILENAME_TEMPLATE_DEFAULT}
              />
              <button
                type="button"
                className="px-2 bg-bg text-xs"
                onClick={() =>
                  setConfig((c) => ({ ...c, filenameTemplate: undefined }))
                }
              >
                reset
              </button>
            </div>
            <div className="text-xs text-dim mt-1">
              Tokens: <code>&lt;date&gt;</code> <code>&lt;time&gt;</code>{" "}
              <code>&lt;sequence&gt;</code> <code>&lt;shot&gt;</code>{" "}
              <code>&lt;model&gt;</code> <code>&lt;version&gt;</code>{" "}
              <code>&lt;prompt&gt;</code> <code>&lt;iter&gt;</code>{" "}
              <code>&lt;seed&gt;</code> <code>&lt;provider&gt;</code>
            </div>
          </Field>

          <Field label="Colors">
            <div className="flex flex-col gap-1">
              {COLOR_KEYS.map((key) => (
                <ColorRow
                  key={key}
                  name={COLOR_LABELS[key]}
                  value={currentColors[key]}
                  onChange={(v) => setColor(key, v)}
                />
              ))}
              <button
                type="button"
                onClick={resetColors}
                className="self-start text-xs text-accent hover:underline mt-1"
              >
                reset to defaults
              </button>
            </div>
          </Field>
        </div>

        <div className="px-4 py-2 flex justify-end gap-2 border-t border-dim">
          <button className="px-3 py-1 bg-bg text-xs" onClick={handleClose}>
            Cancel
          </button>
          <button
            className="px-3 py-1 bg-accent text-bg text-xs disabled:opacity-50"
            disabled={busy}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-semibold text-dim uppercase tracking-wide">
        {label}
      </div>
      {children}
    </div>
  );
}

function ColorRow({
  name,
  value,
  onChange,
}: {
  name: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <label className="w-20 font-mono">{name}</label>
      <input
        type="color"
        value={normalizeHex(value)}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="w-8 h-7 p-0 bg-transparent border-0 cursor-pointer"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="flex-1 bg-bg px-2 py-1 font-mono text-xs"
        spellCheck={false}
      />
    </div>
  );
}

function normalizeHex(v: string): string {
  // <input type=color> requires 6-char hex with #.
  const s = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  return "#000000";
}
