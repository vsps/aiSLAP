import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

/** Check GitHub Releases (via the signed `latest.json` manifest) for a newer
 *  build. Null when already current. Network/endpoint errors propagate to
 *  the caller — a background check swallows them, a manual one surfaces them. */
export async function checkForUpdate(): Promise<Update | null> {
  return await check();
}

/** Download the update and relaunch into it. `onProgress` receives a
 *  human-readable status string for a busy/status line (no numeric
 *  progress bar exists elsewhere in the app to match). */
export async function installUpdate(
  update: Update,
  onProgress?: (status: string) => void,
): Promise<void> {
  let downloaded = 0;
  let total = 0;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0;
        onProgress?.("Downloading…");
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.(
          total > 0
            ? `Downloading… ${Math.min(100, Math.round((downloaded / total) * 100))}%`
            : "Downloading…",
        );
        break;
      case "Finished":
        onProgress?.("Installing…");
        break;
    }
  });
  onProgress?.("Restarting…");
  await relaunch();
}
