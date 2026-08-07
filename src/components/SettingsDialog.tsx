import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { cmd } from "../lib/tauri";
import { pickFile, showMessage } from "../lib/dialog";
import { applyColors, COLOR_KEYS, DEFAULT_COLORS } from "../lib/colors";
import { recoverOrphans } from "../lib/recovery";
import { fetchFalPrices, formatCost } from "../lib/falPrices";
import { checkForUpdate } from "../lib/updater";
import { pushLog } from "../stores/logStore";
import { useModelsStore } from "../stores/modelsStore";
import { usePricesStore } from "../stores/pricesStore";
import { useSessionStore } from "../stores/sessionStore";
import { useUpdateStore } from "../stores/updateStore";
import { invalidateConfigCache } from "../lib/metadataCache";
import { ensureRefLifecycleRule, TOS_DEFAULTS } from "../lib/providers/tos";
import { ModalDialog } from "./ModalDialog";
import {
  DEFAULT_CONFIG,
  DEFAULT_MAX_CONCURRENT_JOBS,
  type ColorOverrides,
  type Config,
  type EnumParam,
  type FalLifecycle,
  type ProjectCostScan,
} from "../lib/types";

const TABS = ["General", "Appearance", "APIs", "Costs"] as const;
type Tab = (typeof TABS)[number];

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
  const projectPath = useSessionStore((s) => s.projectPath);
  const [tab, setTab] = useState<Tab>("General");
  const [falKey, setFalKey] = useState("");
  const [replicateKey, setReplicateKey] = useState("");
  const [bytedanceKey, setBytedanceKey] = useState("");
  const [mediaKitKey, setMediaKitKey] = useState("");
  const [tosAk, setTosAk] = useState("");
  const [tosSk, setTosSk] = useState("");
  const [tursoUrl, setTursoUrl] = useState("");
  const [tursoToken, setTursoToken] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [revealReplicate, setRevealReplicate] = useState(false);
  const [revealBytedance, setRevealBytedance] = useState(false);
  const [revealMediaKit, setRevealMediaKit] = useState(false);
  const [revealTosSk, setRevealTosSk] = useState(false);
  const [revealTursoToken, setRevealTursoToken] = useState(false);
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
  const prices = usePricesStore((s) => s.prices);
  const pricesCount = usePricesStore((s) => Object.keys(s.prices).length);
  const [costScan, setCostScan] = useState<ProjectCostScan | null>(null);
  const [costBusy, setCostBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const setPendingUpdate = useUpdateStore((s) => s.setPendingUpdate);
  const modelEntries = useModelsStore((s) => s.entries);
  const [costProvider, setCostProvider] = useState<string>("fal");
  const [priceTableHeight, setPriceTableHeight] = useState(256);

  const currentColors = useMemo<Required<ColorOverrides>>(
    () => ({ ...DEFAULT_COLORS, ...(config.colors ?? {}) }),
    [config.colors],
  );

  const providers = useMemo<string[]>(() => {
    const set = new Set<string>(modelEntries.map((e) => e.node.provider ?? "fal"));
    return [...set].sort();
  }, [modelEntries]);

  useEffect(() => {
    if (providers.length > 0 && !providers.includes(costProvider)) {
      setCostProvider(providers[0]);
    }
  }, [providers, costProvider]);

  const modelsForProvider = useMemo(
    () =>
      modelEntries
        .filter((e) => (e.node.provider ?? "fal") === costProvider)
        .sort((a, b) => a.node.name.localeCompare(b.node.name)),
    [modelEntries, costProvider],
  );

  // One row per model, or one row per resolution option for models whose
  // cost varies by resolution — fal's pricing API only ever returns one flat
  // price per model, so a resolution split only ever affects the override.
  type PriceRow = {
    key: string;
    name: string;
    endpoint: string;
    isVideo: boolean;
    resolution: string | null;
  };
  const priceRows = useMemo<PriceRow[]>(() => {
    const rows: PriceRow[] = [];
    for (const e of modelsForProvider) {
      const resParam = e.node.parameters.find(
        (p): p is EnumParam => p.type === "enum" && p.name === "resolution",
      );
      const isVideo = e.node.kind === "video";
      if (resParam && resParam.options.length > 0) {
        for (const r of resParam.options) {
          rows.push({
            key: `${e.node.id}::${r}`,
            name: e.node.name,
            endpoint: e.node.endpoint,
            isVideo,
            resolution: r,
          });
        }
      } else {
        rows.push({
          key: e.node.id,
          name: e.node.name,
          endpoint: e.node.endpoint,
          isVideo,
          resolution: null,
        });
      }
    }
    return rows;
  }, [modelsForProvider]);

  function overrideKeyFor(row: { endpoint: string; resolution: string | null }): string {
    return row.resolution ? `${row.endpoint}::${row.resolution}` : row.endpoint;
  }

  // Self-contained drag session: onMove/onUp close over startY/startHeight
  // directly rather than a ref, so add/removeEventListener always operate on
  // the exact same function instances for this one drag.
  function startPriceTableResize(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = priceTableHeight;
    function onMove(ev: MouseEvent) {
      setPriceTableHeight(Math.min(600, Math.max(120, startHeight + (ev.clientY - startY))));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function setPriceOverride(overrideKey: string, raw: string) {
    setConfig((c) => {
      const next = { ...(c.priceOverrides ?? {}) };
      if (raw.trim() === "") {
        delete next[overrideKey];
      } else {
        const n = parseFloat(raw);
        if (Number.isFinite(n)) next[overrideKey] = n;
      }
      return { ...c, priceOverrides: next };
    });
  }

  useEffect(() => {
    void (async () => {
      const [k, rk, bk, mk, ak, sk, tu, tt, c] = await Promise.all([
        cmd.provider_key_get("fal").catch(() => ""),
        cmd.provider_key_get("replicate").catch(() => ""),
        cmd.provider_key_get("bytedance").catch(() => ""),
        cmd.provider_key_get("bytedance_mediakit").catch(() => ""),
        cmd.provider_key_get("tos_ak").catch(() => ""),
        cmd.provider_key_get("tos_sk").catch(() => ""),
        cmd.provider_key_get("turso_url").catch(() => ""),
        cmd.provider_key_get("turso_token").catch(() => ""),
        cmd.config_load().catch(() => null),
      ]);
      setFalKey(k);
      setReplicateKey(rk);
      setBytedanceKey(bk);
      setMediaKitKey(mk);
      setTosAk(ak);
      setTosSk(sk);
      setTursoUrl(tu);
      setTursoToken(tt);
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
    void getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  async function checkUpdatesNow() {
    if (updateBusy) return;
    setUpdateBusy(true);
    setUpdateStatus("Checking…");
    try {
      const update = await checkForUpdate();
      if (update) {
        setUpdateStatus(`Update available: v${update.version}`);
        setPendingUpdate(update);
      } else {
        setUpdateStatus(
          appVersion ? `You're up to date (v${appVersion}).` : "You're up to date.",
        );
      }
    } catch (e) {
      setUpdateStatus(`Error: ${String(e)}`);
    } finally {
      setUpdateBusy(false);
    }
  }

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
    if (!falKey.trim()) {
      setPricesStatus("fal API key not configured — enter it in the APIs tab above.");
      return;
    }
    setPricesBusy(true);
    setPricesStatus("Fetching…");
    try {
      const falEntries = useModelsStore
        .getState()
        .entries.filter((e) => (e.node.provider ?? "fal") === "fal");
      const unique = [...new Set(falEntries.map((e) => e.node.endpoint))];

      const prices = await fetchFalPrices(unique, falKey);
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
      const pricedCount = unique.filter((e) => e in prices).length;
      setPricesStatus(`${pricedCount} of ${unique.length} fal models priced.`);
    } catch (e) {
      setPricesStatus(`Error: ${String(e)}`);
    } finally {
      setPricesBusy(false);
    }
  }

  async function recalculateCosts() {
    if (!projectPath) return;
    setCostBusy(true);
    try {
      setCostScan(await cmd.project_cost_scan(projectPath));
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setCostBusy(false);
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

  function setTosField(key: "bucket" | "region" | "endpoint", value: string) {
    setConfig((c) => ({
      ...c,
      tos: {
        bucket: c.tos?.bucket ?? TOS_DEFAULTS.bucket,
        region: c.tos?.region ?? TOS_DEFAULTS.region,
        endpoint: c.tos?.endpoint ?? TOS_DEFAULTS.endpoint,
        refExpiryDays: c.tos?.refExpiryDays ?? TOS_DEFAULTS.refExpiryDays,
        [key]: value,
      },
    }));
  }

  function setTosExpiry(days: number) {
    setConfig((c) => ({
      ...c,
      tos: {
        bucket: c.tos?.bucket ?? TOS_DEFAULTS.bucket,
        region: c.tos?.region ?? TOS_DEFAULTS.region,
        endpoint: c.tos?.endpoint ?? TOS_DEFAULTS.endpoint,
        refExpiryDays: days,
      },
    }));
  }

  async function save() {
    setBusy(true);
    try {
      const ak = tosAk.trim();
      const sk = tosSk.trim();
      await cmd.provider_key_set("fal", falKey.trim());
      await cmd.provider_key_set("replicate", replicateKey.trim());
      await cmd.provider_key_set("bytedance", bytedanceKey.trim());
      await cmd.provider_key_set("bytedance_mediakit", mediaKitKey.trim());
      await cmd.provider_key_set("tos_ak", ak);
      await cmd.provider_key_set("tos_sk", sk);
      await cmd.provider_key_set("turso_url", tursoUrl.trim());
      await cmd.provider_key_set("turso_token", tursoToken.trim());
      await cmd.config_save(config);
      invalidateConfigCache();
      usePricesStore.getState().setOverrides(config.priceOverrides ?? {});
      setOriginalColors(config.colors);

      // Best-effort: install/refresh the TOS ref-expiry lifecycle rule when
      // creds + bucket are present. Failure is surfaced but doesn't block the
      // save — uploads still work without the rule (refs just won't auto-expire).
      const bucket = config.tos?.bucket || TOS_DEFAULTS.bucket;
      if (ak && sk && bucket) {
        try {
          await ensureRefLifecycleRule(
            {
              accessKeyId: ak,
              secretAccessKey: sk,
              region: config.tos?.region || TOS_DEFAULTS.region,
              bucket,
              endpoint: config.tos?.endpoint || TOS_DEFAULTS.endpoint,
            },
            config.tos?.refExpiryDays ?? TOS_DEFAULTS.refExpiryDays,
          );
        } catch (e) {
          await showMessage(
            `Saved, but couldn't set the TOS lifecycle rule: ${String(e)}`,
            { kind: "warning" },
          );
        }
      }
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
      panelClassName="w-[640px] h-[640px] min-w-[440px] min-h-[360px] max-w-[95vw] max-h-[90vh] resize overflow-auto shadow-xl"
    >
      <div className="px-4 py-2 bg-surface text-text text-sm">Settings</div>

      <div className="flex border-b border-dim px-4">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs ${
              tab === t
                ? "text-accent border-b-2 border-accent -mb-px"
                : "text-dim hover:text-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="p-4 flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto thin-scroll">
        {tab === "General" && (
          <>
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

            <Field label="Updates">
              <div className="flex gap-1 items-center">
                <button
                  type="button"
                  className="px-2 bg-bg text-xs disabled:opacity-50"
                  onClick={() => void checkUpdatesNow()}
                  disabled={updateBusy}
                >
                  {updateBusy ? "Checking…" : "Check for updates"}
                </button>
                <span className="text-xs text-dim">
                  {appVersion ? `Current: v${appVersion}` : ""}
                </span>
              </div>
              <label className="flex items-center gap-2 text-xs mt-1">
                <input
                  type="checkbox"
                  checked={config.autoCheckUpdates ?? true}
                  onChange={(e) => {
                    const checked = e.currentTarget.checked;
                    setConfig((c) => ({ ...c, autoCheckUpdates: checked }));
                  }}
                />
                Automatically check for updates on launch
              </label>
              <div className="text-xs text-dim mt-1">
                {updateStatus ??
                  "Checks GitHub Releases for a newer signed build."}
              </div>
            </Field>
          </>
        )}

        {tab === "Appearance" && (
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
        )}

        {tab === "APIs" && (
          <>
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
                Sent as <code>x-fal-object-lifecycle-preference</code>.
                Controls how long fal retains generated objects.
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

            <Field label="BYTEDANCE_API_KEY">
              <div className="flex gap-1">
                <input
                  type={revealBytedance ? "text" : "password"}
                  value={bytedanceKey}
                  onChange={(e) => setBytedanceKey(e.currentTarget.value)}
                  className="flex-1 bg-inset px-2 py-1 font-mono text-xs"
                  placeholder="Ark API key…"
                />
                <button
                  className="px-2 bg-bg text-xs"
                  onClick={() => setRevealBytedance((v) => !v)}
                >
                  {revealBytedance ? "hide" : "show"}
                </button>
              </div>
            </Field>

            <Field label="BYTEDANCE_MEDIAKIT_API_KEY">
              <div className="flex gap-1">
                <input
                  type={revealMediaKit ? "text" : "password"}
                  value={mediaKitKey}
                  onChange={(e) => setMediaKitKey(e.currentTarget.value)}
                  className="flex-1 bg-inset px-2 py-1 font-mono text-xs"
                  placeholder="AI MediaKit API key…"
                />
                <button
                  className="px-2 bg-bg text-xs"
                  onClick={() => setRevealMediaKit((v) => !v)}
                >
                  {revealMediaKit ? "hide" : "show"}
                </button>
              </div>
              <div className="text-xs text-dim mt-1">
                Separate from the Ark key above — used for AI MediaKit video
                enhancement. Get one from the BytePlus console's AI MediaKit
                → API Key page.
              </div>
            </Field>

            <Field label="TOS storage (ByteDance references)">
              <input
                type="text"
                value={tosAk}
                onChange={(e) => setTosAk(e.currentTarget.value)}
                className="w-full bg-inset px-2 py-1 font-mono text-xs"
                placeholder="Access Key ID (AKLT…)"
              />
              <div className="flex gap-1 mt-1">
                <input
                  type={revealTosSk ? "text" : "password"}
                  value={tosSk}
                  onChange={(e) => setTosSk(e.currentTarget.value)}
                  className="flex-1 bg-inset px-2 py-1 font-mono text-xs"
                  placeholder="Secret Access Key"
                />
                <button
                  className="px-2 bg-bg text-xs"
                  onClick={() => setRevealTosSk((v) => !v)}
                >
                  {revealTosSk ? "hide" : "show"}
                </button>
              </div>
              <div className="flex gap-1 mt-1">
                <input
                  type="text"
                  value={config.tos?.bucket ?? TOS_DEFAULTS.bucket}
                  onChange={(e) => setTosField("bucket", e.currentTarget.value)}
                  className="flex-1 bg-inset px-2 py-1 font-mono text-xs"
                  placeholder="bucket"
                  title="TOS bucket name"
                />
                <input
                  type="text"
                  value={config.tos?.region ?? TOS_DEFAULTS.region}
                  onChange={(e) => setTosField("region", e.currentTarget.value)}
                  className="w-32 bg-inset px-2 py-1 font-mono text-xs"
                  placeholder="region"
                  title="TOS region (used in the signature)"
                />
              </div>
              <input
                type="text"
                value={config.tos?.endpoint ?? TOS_DEFAULTS.endpoint}
                onChange={(e) => setTosField("endpoint", e.currentTarget.value)}
                className="w-full bg-inset px-2 py-1 font-mono text-xs mt-1"
                placeholder="endpoint host"
                title="TOS endpoint host suffix"
              />
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-dim">Refs expire after</span>
                <select
                  value={config.tos?.refExpiryDays ?? TOS_DEFAULTS.refExpiryDays}
                  onChange={(e) => setTosExpiry(parseInt(e.currentTarget.value, 10))}
                  className="bg-inset px-2 py-1 text-xs font-mono"
                >
                  {[1, 3, 7, 30].map((d) => (
                    <option key={d} value={d}>
                      {d} day{d === 1 ? "" : "s"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-xs text-dim mt-1">
                AK/SK stored in <code>.env</code>. Uploaded references get a
                presigned URL (bucket stays private) and auto-delete via a
                bucket lifecycle rule set on save.
              </div>
            </Field>

            <Field label="TURSO_DATABASE_URL (optional)">
              <input
                type="text"
                value={tursoUrl}
                onChange={(e) => setTursoUrl(e.currentTarget.value)}
                className="w-full bg-inset px-2 py-1 font-mono text-xs"
                placeholder="libsql://your-db.turso.io"
              />
              <div className="text-xs text-dim mt-1">
                Central index sync. Blank keeps everything local-only —
                nothing breaks, generated assets just aren't shared with
                other machines.
              </div>
            </Field>

            <Field label="TURSO_AUTH_TOKEN">
              <div className="flex gap-1">
                <input
                  type={revealTursoToken ? "text" : "password"}
                  value={tursoToken}
                  onChange={(e) => setTursoToken(e.currentTarget.value)}
                  className="flex-1 bg-inset px-2 py-1 font-mono text-xs"
                  placeholder="ey…"
                />
                <button
                  className="px-2 bg-bg text-xs"
                  onClick={() => setRevealTursoToken((v) => !v)}
                >
                  {revealTursoToken ? "hide" : "show"}
                </button>
              </div>
            </Field>
          </>
        )}

        {tab === "Costs" && (
          <>
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
                  "Pulls per-model prices from fal's official pricing API (requires the fal API key, set above)."}
              </div>
            </Field>

            <Field label="Model prices">
              <div className="flex items-center gap-2">
                <select
                  value={costProvider}
                  onChange={(e) => setCostProvider(e.currentTarget.value)}
                  className="bg-inset px-2 py-1 text-xs font-mono"
                >
                  {providers.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-dim">
                  {priceRows.length} row{priceRows.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="text-xs text-dim mt-1">
                <span className="text-accent">Known price</span> comes straight
                from fal's pricing API (fal only) — one flat rate per model, so
                every resolution row of the same model shows the same value.
                Override is the only way to price a specific resolution
                differently, and always wins for cost estimates and exports
                when set. Video models are billed per second — enter a $/sec
                rate, not a flat price. A few models (FLUX, Topaz image
                upscale) are billed per megapixel — their actual cost is
                measured from the real output size at generation time, not
                from this table; an override for one of these is still a
                flat $ amount, not a $/megapixel rate.
              </div>
              <div
                className="overflow-y-auto thin-scroll mt-1"
                style={{ height: priceTableHeight }}
              >
                <table className="w-full table-fixed text-xs font-mono">
                  <colgroup>
                    <col className="w-[34%]" />
                    <col className="w-[44%]" />
                    <col className="w-[22%]" />
                  </colgroup>
                  <thead>
                    <tr className="text-dim text-left">
                      <th className="font-normal pb-1">Model</th>
                      <th className="font-normal pb-1">Known price</th>
                      <th className="font-normal pb-1">Override</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceRows.map((row) => {
                      const overrideKey = overrideKeyFor(row);
                      const known = prices[overrideKey] ?? prices[row.endpoint];
                      const override = config.priceOverrides?.[overrideKey];
                      return (
                        <tr key={row.key} className="border-t border-dim/30">
                          <td className="py-1 pr-2 truncate" title={row.endpoint}>
                            {row.name}
                            {row.resolution && (
                              <span className="text-dim"> · {row.resolution}</span>
                            )}
                          </td>
                          <td className="py-1 pr-2 text-accent truncate" title={known}>
                            {known ?? "—"}
                          </td>
                          <td className="py-1">
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                step="0.001"
                                min={0}
                                value={override ?? ""}
                                onChange={(ev) =>
                                  setPriceOverride(overrideKey, ev.currentTarget.value)
                                }
                                placeholder="—"
                                className="w-20 bg-inset px-1 py-0.5 text-xs font-mono text-right"
                              />
                              <span className="text-dim">
                                {row.isVideo ? "$/sec" : "$"}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {priceRows.length === 0 && (
                      <tr>
                        <td colSpan={3} className="text-dim py-2">
                          No models for this provider.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div
                onMouseDown={startPriceTableResize}
                className="h-2 mt-0.5 cursor-row-resize flex items-center justify-center group"
                title="Drag to resize"
              >
                <div className="w-8 h-1 rounded-full bg-dim/40 group-hover:bg-accent" />
              </div>
            </Field>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-dim uppercase tracking-wide">
                  Project costs
                </div>
                <button
                  type="button"
                  className="px-2 py-0.5 bg-bg text-xs disabled:opacity-50"
                  disabled={costBusy || !projectPath}
                  onClick={recalculateCosts}
                >
                  {costBusy ? "Calculating…" : "Recalculate"}
                </button>
              </div>

              {!projectPath ? (
                <div className="text-xs text-dim">
                  Open a project to see its cost breakdown.
                </div>
              ) : costScan === null ? (
                <div className="text-xs text-dim">
                  Not yet calculated. Computed from cached fal prices above;
                  older images without a stored cost are backfilled
                  automatically when a price is available.
                </div>
              ) : (
                <>
                  <div className="text-xs font-mono text-text flex items-center gap-2">
                    <span className="font-semibold">Project total:</span>
                    <span>≈ ${formatCost(costScan.totalCostUsd)}</span>
                    {costScan.unknownImageCount > 0 && (
                      <span className="text-dim">
                        ({costScan.unknownImageCount} unpriced)
                      </span>
                    )}
                    {costScan.backfilledCount > 0 && (
                      <span className="text-dim">
                        (backfilled {costScan.backfilledCount})
                      </span>
                    )}
                  </div>
                  <ul className="font-mono text-xs overflow-y-auto thin-scroll max-h-64 flex flex-col gap-0.5 mt-1">
                    {costScan.sequences.map((seq) => (
                      <li key={seq.path}>
                        <div className="flex items-center gap-2">
                          <span className="text-text">{seq.name}/</span>
                          {seq.totalCostUsd > 0 && (
                            <span
                              className="text-[10px] font-mono text-dim shrink-0"
                              title={
                                seq.unknownImageCount > 0
                                  ? `≈ $${formatCost(seq.totalCostUsd)} (${seq.unknownImageCount} unpriced)`
                                  : `≈ $${formatCost(seq.totalCostUsd)}`
                              }
                            >
                              ≈ ${formatCost(seq.totalCostUsd)}
                            </span>
                          )}
                        </div>
                        {seq.shots.map((shot) => (
                          <div
                            key={shot.path}
                            className="pl-4 flex items-center gap-2 text-dim"
                          >
                            <span>{shot.name}/</span>
                            {shot.totalCostUsd > 0 && (
                              <span
                                className="text-[10px] font-mono shrink-0"
                                title={
                                  shot.unknownImageCount > 0
                                    ? `≈ $${formatCost(shot.totalCostUsd)} (${shot.unknownImageCount} unpriced)`
                                    : `≈ $${formatCost(shot.totalCostUsd)}`
                                }
                              >
                                ≈ ${formatCost(shot.totalCostUsd)}
                              </span>
                            )}
                          </div>
                        ))}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </>
        )}
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
