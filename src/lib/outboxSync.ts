import { pushLog } from "../stores/logStore";
import type { SyncReport } from "./types";

/** Silent when Turso isn't configured — that's the normal local-only state,
 *  not something to log every project open / asset write. */
export function reportOutboxSync(report: SyncReport): void {
  if (!report.configured) return;
  if (report.error) {
    pushLog("ERROR", `Turso sync failed: ${report.error}`);
    return;
  }
  if (report.pushed > 0 && report.pending === 0) {
    pushLog("SUCCESS", `Turso: synced (${report.pushed} pushed)`);
  } else if (report.pushed > 0) {
    pushLog("INFO", `Turso: pushed ${report.pushed}, ${report.pending} pending`);
  } else if (report.pending > 0) {
    pushLog("ERROR", `Turso: ${report.pending} asset(s) stuck syncing — check logs`);
  }
}
