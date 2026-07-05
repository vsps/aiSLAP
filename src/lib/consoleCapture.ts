// Mirrors console.error and otherwise-uncaught errors into the in-app log
// panel (LogWindow), so runtime problems are visible without opening
// devtools. console.warn is deliberately left alone — warnings (React DOM
// warnings, third-party notices, etc.) are noisy and not worth surfacing;
// only real errors get logged. Native resource-load failures (404s on
// <img>/asset:// requests) aren't console.* calls and can't be intercepted
// generically — those still only show in devtools.
import { pushLog } from "../stores/logStore";

let installed = false;

export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  const origError = console.error.bind(console);

  console.error = (...args: unknown[]) => {
    origError(...args);
    pushLog("ERROR", formatArgs(args));
  };

  window.addEventListener("error", (e) => {
    pushLog("ERROR", `Uncaught: ${e.message}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    pushLog("ERROR", `Unhandled rejection: ${formatValue(e.reason)}`);
  });
}

function formatArgs(args: unknown[]): string {
  return args.map(formatValue).join(" ");
}

function formatValue(v: unknown): string {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
