import { useState } from "react";
import { cmd } from "../lib/tauri";
import { DEFAULT_CONFIG } from "../lib/types";
import { installUpdate, type Update } from "../lib/updater";
import { ModalDialog } from "./ModalDialog";
import { Btn } from "./Btn";

type Props = {
  update: Update;
  onClose: () => void;
};

export function UpdateAvailableDialog({ update, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function later() {
    try {
      const config = (await cmd.config_load().catch(() => null)) ?? DEFAULT_CONFIG;
      await cmd.config_save({
        ...config,
        lastDismissedUpdateVersion: update.version,
      });
    } catch {
      // Best-effort — worst case the next auto-check prompts again.
    }
    onClose();
  }

  async function updateAndRestart() {
    setBusy(true);
    setStatus("Downloading…");
    try {
      await installUpdate(update, setStatus);
      // installUpdate relaunches the app on success — unreachable after that.
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      onClose={busy ? () => {} : onClose}
      padded={false}
      panelClassName="max-w-[480px] w-full shadow-xl"
    >
      <div className="px-4 py-2 bg-surface text-text text-sm">
        Update available — v{update.version}
      </div>
      <div className="p-4 flex flex-col gap-3 text-xs">
        {update.body && (
          <pre className="whitespace-pre-wrap font-mono text-dim max-h-48 overflow-auto">
            {update.body}
          </pre>
        )}
        {status && <div className="text-dim">{status}</div>}
      </div>
      <div className="px-4 py-2 flex justify-end gap-2 border-t border-dim">
        <Btn disabled={busy} onClick={later}>
          Later
        </Btn>
        <Btn disabled={busy} onClick={updateAndRestart}>
          {busy ? status ?? "Updating…" : "Update & Restart"}
        </Btn>
      </div>
    </ModalDialog>
  );
}
