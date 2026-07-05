import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { bootstrap } from "./lib/bootstrap";
import { isJobTerminal } from "./lib/jobs";
import { swallow } from "./lib/errors";
import { SessionBar } from "./components/SessionBar";
import { Workbench } from "./components/Workbench";
import { Timeline } from "./components/Timeline";
import { Gallery } from "./components/Gallery";
import { ErrorPopup } from "./components/ErrorPopup";
import { LogWindow } from "./components/LogWindow";
import { QueueChecklist } from "./components/QueueChecklist";
import { SettingsDialog } from "./components/SettingsDialog";
import { ProjectSettingsDialog } from "./components/ProjectSettingsDialog";
import { SplashScreen } from "./components/SplashScreen";
import { ResizeBar } from "./components/ResizeBar";
import { useGenerationStore } from "./stores/generationStore";
import { useModelsStore } from "./stores/modelsStore";
import { useSessionStore } from "./stores/sessionStore";

export default function App() {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [version, setVersion] = useState<string>("");
  const traceActive = useSessionStore((s) => s.traceActive);
  const setTrace = useSessionStore((s) => s.setTrace);
  const galleryHeight = useSessionStore((s) => s.galleryHeight);
  const setGalleryHeight = useSessionStore((s) => s.setGalleryHeight);
  const logHeight = useSessionStore((s) => s.logHeight);
  const setLogHeight = useSessionStore((s) => s.setLogHeight);
  const timelineHeight = useSessionStore((s) => s.timelineHeight);
  const setTimelineHeight = useSessionStore((s) => s.setTimelineHeight);
  const thumbColWidth = useSessionStore((s) => s.thumbColWidth);
  const setThumbColWidth = useSessionStore((s) => s.setThumbColWidth);
  const queueWidth = useSessionStore((s) => s.queueWidth);
  const setQueueWidth = useSessionStore((s) => s.setQueueWidth);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    // Pull version from the Tauri bundle manifest and sync it to the title bar.
    getVersion()
      .then((v) => {
        setVersion(v);
        return getCurrentWindow().setTitle(`aiSLAP ${v}`);
      })
      .catch(swallow("window title/version update"));
    bootstrap()
      .then((d) => {
        dispose = d;
        setReady(true);
      })
      .catch((e) => {
        setBootError(String(e));
        setReady(true);
      });
    return () => {
      if (dispose) dispose();
    };
  }, []);

  // Global Esc: exit trace (only if no other modal is open — ErrorPopup / zoom modal handle their own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && traceActive) {
        setTrace(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [traceActive, setTrace]);

  return (
    <div className="flex h-full w-full flex-col gap-prompt-surface bg-bg p-prompt-surface text-text">
      <SessionBar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenProjectSettings={() => setProjectSettingsOpen(true)}
      />

      <Workbench />

      <ResizeBar
        orientation="horizontal"
        value={timelineHeight}
        onChange={setTimelineHeight}
        grow="up"
      />

      <Timeline />

      <ResizeBar
        orientation="horizontal"
        value={galleryHeight}
        onChange={setGalleryHeight}
        grow="up"
      />

      <div
        className="shrink-0 flex min-h-0"
        style={{ height: `${galleryHeight}px` }}
      >
        <Gallery />
      </div>

      <ResizeBar
        orientation="horizontal"
        value={logHeight}
        onChange={setLogHeight}
        grow="up"
      />

      <input
        type="range"
        min={80}
        max={500}
        value={thumbColWidth}
        onChange={(e) => setThumbColWidth(Number(e.target.value))}
        title={`Thumbnail size: ${thumbColWidth}px`}
        className="accent-white w-full shrink-0"
        style={{ height: 4, padding: 0, margin: 0, cursor: "ew-resize" }}
      />

      <div
        className="shrink-0 flex flex-row min-h-0"
        style={{ height: `${logHeight}px` }}
      >
        <QueueChecklist
          height={logHeight}
          className="shrink-0"
          style={{ width: `${queueWidth}px` }}
        />
        <ResizeBar
          orientation="vertical"
          value={queueWidth}
          onChange={setQueueWidth}
          grow="right"
        />
        <LogWindow height={logHeight} className="flex-1 min-w-0" />
      </div>
      <StatusBar ready={ready} bootError={bootError} />
      <ErrorPopup />
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
      {projectSettingsOpen && (
        <ProjectSettingsDialog onClose={() => setProjectSettingsOpen(false)} />
      )}
      <SplashScreen ready={ready} version={version} />
    </div>
  );
}

function StatusBar({
  ready,
  bootError,
}: {
  ready: boolean;
  bootError: string | null;
}) {
  const { entries, loaded } = useModelsStore();
  const jobs = useGenerationStore((s) => s.jobs);
  const traceActive = useSessionStore((s) => s.traceActive);
  const restoringLastSession = useSessionStore((s) => s.restoringLastSession);

  const active = jobs.filter((j) => !isJobTerminal(j.status));
  // Surface the latest active job's progress; with multi-job runs the badge in
  // RunColumn shows the full picture, the status bar just gives the gist.
  const latest = active[active.length - 1];

  return (
    <div className="bg-panel text-dim px-2 py-1 text-xs font-mono whitespace-nowrap overflow-hidden flex items-center gap-4">
      <span>{ready ? "ready" : "booting..."}</span>
      <span>models: {loaded ? entries.length : "…"}</span>
      {bootError && <span className="text-bad">boot error: {bootError}</span>}
      {restoringLastSession && (
        <span title="Restoring the last-used project/sequence/shot in the background — pick a different project any time.">
          restoring last session…
        </span>
      )}
      {latest && (
        <span className="text-text">
          {latest.progressMessage || "Generating..."}
          {latest.iterations > 1
            ? ` · ${latest.currentIteration}/${latest.iterations}`
            : ""}
          {active.length > 1 ? ` · +${active.length - 1} more` : ""}
        </span>
      )}
      {traceActive && (
        <span className="text-warn">
          tracing · {traceActive.traceSet.size} images (Esc to exit)
        </span>
      )}
    </div>
  );
}
