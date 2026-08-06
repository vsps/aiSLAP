import { cmd } from "./tauri";
import { pushLog } from "../stores/logStore";

let cached: string | undefined;
let inFlight: Promise<void> | null = null;
let warned = false;

function attemptLoad(): Promise<void> {
  const p = cmd
    .system_username()
    .then((name) => {
      cached = name || undefined;
      if (!cached && !warned) {
        warned = true;
        pushLog("ERROR", "System username came back empty — asset attribution will be blank.");
      }
    })
    .catch((e) => {
      if (!warned) {
        warned = true;
        pushLog("ERROR", `System username lookup failed — asset attribution will be blank: ${String(e)}`);
      }
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = p;
  return p;
}

/** Awaited once at bootstrap, and retried lazily on every later read while it
 *  still hasn't resolved — a transient IPC hiccup at boot would otherwise
 *  blank out attribution for the rest of the session, since nothing else
 *  ever called this again. The failure itself is only logged once, so a
 *  genuinely persistent failure doesn't spam the log window on every asset. */
export async function loadSystemUsername(): Promise<void> {
  await attemptLoad();
}

export function currentUsername(): string | undefined {
  if (cached === undefined && !inFlight) {
    void attemptLoad();
  }
  return cached;
}
