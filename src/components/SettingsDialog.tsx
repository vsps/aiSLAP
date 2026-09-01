import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { cmd } from "../lib/tauri";
import { pickFile, showMessage } from "../lib/dialog";
import { applyColors, COLOR_KEYS, DEFAULT_COLORS } from "../lib/colors";
import { recoverOrphans } from "../lib/recovery";
import { checkForUpdate } from "../lib/updater";
import { pushLog } from "../stores/logStore";
import { usePricesStore } from "../stores/pricesStore";
import { useUpdateStore } from "../stores/updateStore";
import { invalidateConfigCache } from "../lib/metadataCache";
import { ensureRefLifecycleRule, TOS_DEFAULTS } from "../lib/providers/tos";
import { Field } from "./Field";
import { ModalDialog } from "./ModalDialog";
import {
  DEFAULT_CONFIG,
  DEFAULT_MAX_CONCURRENT_JOBS,
  type ColorOverrides,
  type Config,
  type FalLifecycle,
} from "../lib/types";

const TABS = ["General", "Appearance", "APIs"] as const;
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
  const [tab, setTab] = useState<Tab>("General");
  const [falKey, setFalKey] = useState("");
  const [replicateKey, setReplicateKey] = useState("");
  const [bytedanceKey, setBytedanceKey] = useState("");
  const [mediaKitKey, setMediaKitKey] = useState("");
  const [beebleKey, setBeebleKey] = useState("");
  const [tosAk, setTosAk] = useState("");
  const [tosSk, setTosSk] = useState("");
  const [tursoUrl, setTursoUrl] = useState("");
  const [tursoToken, setTursoToken] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [revealReplicate, setRevealReplicate] = useState(false);
  const [revealBytedance, setRevealBytedance] = useState(false);
  const [revealMediaKit, setRevealMediaKit] = useState(false);
  const [revealBeeble, setRevealBeeble] = useState(false);
  const [revealTosSk, setRevealTosSk] = useState(false);
  const [revealTursoToken, setRevealTursoToken] = useState(false);
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [originalColors, setOriginalColors] = useState<
    ColorOverrides | undefined
  >(undefined);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [orphanBusy, setOrphanBusy] = useState(false);
  const [orphanStatus, setOrphanStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const setPendingUpdate = useUpdateStore((s) => s.setPendingUpdate);

  const currentColors = useMemo<Required<ColorOverrides>>(
    () => ({ ...DEFAULT_COLORS, ...(config.colors ?? {}) }),
    [config.colors],
  );

  useEffect(() => {
    void (async () => {
      const [k, rk, bk, mk, bbk, ak, sk, tu, tt, c] = await Promise.all([
        cmd.provider_key_get("fal").catch(() => ""),
        cmd.provider_key_get("replicate").catch(() => ""),
        cmd.provider_key_get("bytedance").catch(() => ""),
        cmd.provider_key_get("bytedance_mediakit").catch(() => ""),
        cmd.provider_key_get("beeble").catch(() => ""),
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
      setBeebleKey(bbk);
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
      await cmd.provider_key_set("beeble", beebleKey.trim());
      await cmd.provider_key_set("tos_ak", ak);
      await cmd.provider_key_set("tos_sk", sk);
      await cmd.provider_key_set("turso_url", tursoUrl.trim());
      await cmd.provider_key_set("turso_token", tursoToken.trim());
      // Pricing lives on AUDIT now and writes straight to disk, so `config`
      // — loaded when this dialog opened — can be holding stale price fields
      // by the time Save runs. Take those three back off disk rather than
      // writing our copy over a newer one.
      const fresh = await cmd.config_load().catch(() => null);
      const merged: Config = {
        ...config,
        falPrices: fresh?.falPrices ?? config.falPrices,
        falPricesFetchedAt: fresh?.falPricesFetchedAt ?? config.falPricesFetchedAt,
        priceOverrides: fresh?.priceOverrides ?? config.priceOverrides,
      };
      await cmd.config_save(merged);
      invalidateConfigCache();
      usePricesStore.getState().setOverrides(merged.priceOverrides ?? {});
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

            <Field label="BEEBLE_API_KEY">
              <div className="flex gap-1">
                <input
                  type={revealBeeble ? "text" : "password"}
                  value={beebleKey}
                  onChange={(e) => setBeebleKey(e.currentTarget.value)}
                  className="flex-1 bg-inset px-2 py-1 font-mono text-xs"
                  placeholder="Beeble API key…"
                />
                <button
                  className="px-2 bg-bg text-xs"
                  onClick={() => setRevealBeeble((v) => !v)}
                >
                  {revealBeeble ? "hide" : "show"}
                </button>
              </div>
              <div className="text-xs text-dim mt-1">
                Powers SwitchX relighting. Create one at{" "}
                <code>developer.beeble.ai/api-keys</code> — it is shown once, so
                copy it before closing Beeble's dialog.
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
