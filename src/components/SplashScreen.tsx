import { useEffect, useMemo, useState } from "react";
import LOGO from "./splash-logo.txt?raw";
import GREETINGS from "./splash-greetings.txt?raw";

const FADE_MS = 400;
const LOADING_MESSAGES = [
  "loading models...",
  "loading config...",
  "restoring session...",
  "warming up...",
];
const MESSAGE_INTERVAL_MS = 600;

export function SplashScreen({
  ready,
  version,
}: {
  ready: boolean;
  version: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [msgIdx, setMsgIdx] = useState(0);

  // Cycle loading messages until ready.
  useEffect(() => {
    if (ready) return;
    const t = setInterval(
      () => setMsgIdx((i) => (i + 1) % LOADING_MESSAGES.length),
      MESSAGE_INTERVAL_MS,
    );
    return () => clearInterval(t);
  }, [ready]);

  // Unmount after fade-out completes.
  useEffect(() => {
    if (!dismissed) return;
    const t = setTimeout(() => setMounted(false), FADE_MS);
    return () => clearTimeout(t);
  }, [dismissed]);

  const greeting = useMemo(() => {
    const lines = GREETINGS.split("\n").filter((l) => l.trim());
    return lines[Math.floor(Math.random() * lines.length)];
  }, []);

  if (!mounted) return null;

  const status = ready ? "ready" : LOADING_MESSAGES[msgIdx];

  return (
    <div
      onClick={() => setDismissed(true)}
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg transition-opacity cursor-pointer ${
        dismissed ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      <pre className="splash-logo font-mono whitespace-pre select-none leading-[1.05] text-[clamp(8px,1.6vw,14px)] text-accent">
        {LOGO}
      </pre>
      <div className="mt-6 text-sm text-dim tracking-wide">
        a desktop token furnace
        {version && (
          <span className="ml-2 opacity-70 font-mono">v{version}</span>
        )}
      </div>
      <div
        className={`mt-8 text-xs font-mono tracking-wide ${
          ready ? "text-accent" : "text-dim"
        }`}
      >
        {status}
      </div>
      {ready && (
        <div className="mt-2 text-xs text-dim italic tracking-wide">
          {greeting}
        </div>
      )}
    </div>
  );
}
