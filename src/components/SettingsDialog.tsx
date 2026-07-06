import { useEffect, useMemo, useState } from "react";
import { cmd } from "../lib/tauri";
import { pickFile, showMessage } from "../lib/dialog";
import { applyColors, COLOR_KEYS, DEFAULT_COLORS } from "../lib/colors";
import { recoverOrphans } from "../lib/recovery";
import { fetchFalPrices } from "../lib/falPrices";
import { pushLog } from "../stores/logStore";
import { useModelsStore } from "../stores/modelsStore";
import { usePricesStore } from "../stores/pricesStore";
import { invalidateConfigCache } from "../lib/metadataCache";
import { ModalDialog } from "./ModalDialog";
import {
  DEFAULT_CONFIG,
  DEFAULT_MAX_CONCURRENT_JOBS,
  type ColorOverrides,
  type Config,
  type FalLifecycle,
} from "../lib/types";

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

export function SettingsDialog({ onClose }: Props) {
  const [falKey, setFalKey] = useState("");
  const [replicateKey, setReplicateKey] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [revealReplicate, setRevealReplicate] = useState(false);
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [originalColors, setOriginalColors] = useState<
    ColorOverrides | undefined
  >(undefined);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [orphanBusy, setOrphanBusy] = useState(false);
  const [orphanStatus, setOrphanStatus] = useState<string | null>(null);
  const [pricesBusy, setPricesBusy] = useState(false);
  const [pricesStatus, setPricesStatus] = useState<string | null>(null);
  const pricesFetchedAt = usePricesStore((s) => s.fetchedAt);
  const pricesCount = usePricesStore((s) => Object.keys(s.prices).length);
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
    void (async () => {
      const records = await cmd.pending_load().catch(() => []);
      setPendingCount(records.length);
    })();
  }, []);

  async function checkOrphans() {
    if (orphanBusy) return;
    setOrphanBusy(true);
    setOrphanStatus("Checking…");
    try {
      const r = await recoverOrphans();
      const parts = [
        `recovered ${r.recovered}`,
        `still running ${r.stillRunning}`,
        `failed ${r.failed}`,
      ];
      setOrphanStatus(`${parts.join(", ")} (of ${r.total}).`);
      for (const n of r.notes) pushLog("INFO", `Orphan: ${n}`);
      const remaining = await cmd.pending_load().catch(() => []);
      setPendingCount(remaining.length);
    } catch (e) {
      setOrphanStatus(`Error: ${String(e)}`);
    } finally {
      setOrphanBusy(false);
    }
  }

  async function fetchPrices() {
    if (pricesBusy) return;
    setPricesBusy(true);
    setPricesStatus("Fetching…");
    try {
      const endpoints = useModelsStore
        .getState()
        .entries.filter((e) => (e.node.provider ?? "fal") === "fal")
        .map((e) => e.node.endpoint);
      const unique = [...new Set(endpoints)];
      const prices = await fetchFalPrices(unique);
      const fetchedAt = new Date().toISOString();

      // Persist immediately into the on-disk config (merged into a fresh
      // load, NOT the dialog's edited copy — Cancel must not lose prices,
      // and fetching must not silently commit unsaved dialog edits).
      const onDisk = (await cmd.config_load().catch(() => null)) ?? DEFAULT_CONFIG;
      await cmd.config_save({
        ...onDisk,
        falPrices: prices,
        falPricesFetchedAt: fetchedAt,
      });
      usePricesStore.getState().setPrices(prices, fetchedAt);
      // Keep the dialog's copy in sync so a later Save doesn't revert them.
      setConfig((c) => ({
        ...c,
        falPrices: prices,
        falPricesFetchedAt: fetchedAt,
      }));
      setPricesStatus(
        `${Object.keys(prices).length} of ${unique.length} fal models priced.`,
      );
    } catch (e) {
      setPricesStatus(`Error: ${String(e)}`);
    } finally {
      setPricesBusy(false);
    }
  }

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
      invalidateConfigCache();
      setOriginalColors(config.colors);
      onClose();
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      onClose={handleClose}
      padded={false}
      panelClassName="max-w-[560px] w-full shadow-xl"
    >
      <div className="px-4 py-2 bg-surface text-text text-sm">Settings</div>

        <div className="p-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto thin-scroll">
          <Field label="FAL_KEY">
            <div className="flex gap-1">
              <input
                type={revealKey ? "text" : "password"}
                value={falKey}
                onChange={(e) => setFalKey(e.currentTarget.value)}
                className="flex-1 bg-inset px-2 py-1 font-mono text-xs"
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
              className="bg-inset px-2 py-1 text-xs font-mono"
            >
              {FAL_LIFECYCLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <div className="text-xs text-dim mt-1">
              Sent as <code>x-fal-object-lifecycle-preference</code>. Controls
              how long fal retains generated objects.
            </div>
          </Field>

          <Field label="REPLICATE_API_TOKEN">
            <div className="flex gap-1">
              <input
                type={revealReplicate ? "text" : "password"}
                value={replicateKey}
                onChange={(e) => setReplicateKey(e.currentTarget.value)}
                className="flex-1 bg-inset px-2 py-1 font-mono text-xs"
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
                className="flex-1 bg-inset px-2 py-1 text-xs font-mono"
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
              value={config.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS}
              onChange={(e) => {
                const n = parseInt(e.currentTarget.value, 10);
                setConfig((c) => ({
                  ...c,
                  maxConcurrentJobs: Number.isFinite(n)
                    ? Math.max(1, Math.min(10, n))
                    : DEFAULT_MAX_CONCURRENT_JOBS,
                }));
              }}
              className="bg-inset px-2 py-1 text-xs font-mono w-20"
              title="Caps how many submissions hit fal.ai in parallel. Extra submits sit in a local queue."
            />
            <div className="text-xs text-dim mt-1">
              Extra submits beyond this cap wait in a local queue.
            </div>
          </Field>

          <Field label="Pending submissions">
            <div className="flex gap-1 items-center">
              <button
                type="button"
                className="px-2 bg-bg text-xs disabled:opacity-50"
                onClick={() => void checkOrphans()}
                disabled={orphanBusy}
              >
                {orphanBusy ? "Checking…" : "Check for orphans"}
              </button>
              <span className="text-xs text-dim">
                {pendingCount === null
                  ? "—"
                  : `${pendingCount} record${pendingCount === 1 ? "" : "s"} on file`}
              </span>
            </div>
            <div className="text-xs text-dim mt-1">
              {orphanStatus ??
                "If the app was killed mid-submit, the result may still be on fal.ai. Click Check to pull it down."}
            </div>
          </Field>

          <Field label="fal.ai prices">
            <div className="flex gap-1 items-center">
              <button
                type="button"
                className="px-2 bg-bg text-xs disabled:opacity-50"
                onClick={() => void fetchPrices()}
                disabled={pricesBusy}
              >
                {pricesBusy ? "Fetching…" : "Fetch prices"}
              </button>
              <span className="text-xs text-dim">
                {pricesCount > 0
                  ? `${pricesCount} cached${
                      pricesFetchedAt
                        ? ` · ${new Date(pricesFetchedAt).toLocaleString()}`
                        : ""
                    }`
                  : "no prices cached"}
              </span>
            </div>
            <div className="text-xs text-dim mt-1">
              {pricesStatus ??
                "Pulls per-model prices from fal.ai's model gallery (unofficial — prices are estimates)."}
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
    </ModalDialog>
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
        className="flex-1 bg-inset px-2 py-1 font-mono text-xs"
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
