import { useEffect } from "react";
import { useStore } from "zustand";
import { IconBtn } from "./IconBtn";
import { useTabsStore, type Tab } from "../stores/tabsStore";
import { seqShotNames } from "../lib/prism";
import { basename } from "../lib/paths";
import { inFlightJobs } from "../lib/jobs";
import { requestCloseTab } from "../lib/tabs";

/**
 * The tab strip. Each tab is a whole session — its own project/sequence/shot,
 * gallery, chain and job list (see `stores/tabStores.ts`).
 *
 * Every row subscribes to *its own* tab's stores via `useStore(tab.stores.…)`
 * rather than through the `useSessionStore` proxy, which only ever reports the
 * front tab. That's what lets a background tab's label track a rename and its
 * badge tick along with a job it is still running.
 */
export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const setActive = useTabsStore((s) => s.setActive);
  const newTab = useTabsStore((s) => s.newTab);
  const duplicateTab = useTabsStore((s) => s.duplicateTab);

  useTabShortcuts();

  return (
    <div className="flex items-stretch gap-[2px] text-xs font-mono shrink-0">
      <div className="flex items-stretch gap-[2px] flex-1 min-w-0 overflow-x-auto thin-scroll">
        {tabs.map((tab) => (
          <TabChip
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            closable={tabs.length > 1}
            onSelect={() => setActive(tab.id)}
          />
        ))}
      </div>
      <IconBtn
        name="add"
        size={20}
        title="New tab — same project and sequence, no shot (Ctrl+T)"
        onClick={() => void newTab()}
      />
      <IconBtn
        name="content_copy"
        size={18}
        title="Duplicate this tab, chain included"
        onClick={() => void duplicateTab()}
      />
    </div>
  );
}

/** Ctrl+T new · Ctrl+W close · Ctrl+Tab cycle · Ctrl+1-9 jump. */
function useTabShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const { tabs, activeId, setActive, newTab } = useTabsStore.getState();
      const idx = tabs.findIndex((t) => t.id === activeId);

      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        void newTab();
      } else if (e.key === "w" || e.key === "W") {
        // preventDefault matters: the webview would otherwise take this as
        // "close window" and take every tab down with it.
        e.preventDefault();
        const tab = tabs[idx];
        if (tab && tabs.length > 1) void requestCloseTab(tab);
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (tabs.length < 2) return;
        const step = e.shiftKey ? -1 : 1;
        setActive(tabs[(idx + step + tabs.length) % tabs.length].id);
      } else if (/^[1-9]$/.test(e.key)) {
        const target = tabs[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          setActive(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function TabChip({
  tab,
  active,
  closable,
  onSelect,
}: {
  tab: Tab;
  active: boolean;
  closable: boolean;
  onSelect: () => void;
}) {
  const shotPath = useStore(tab.stores.session, (s) => s.shotPath);
  const sequencePath = useStore(tab.stores.session, (s) => s.sequencePath);
  const projectTitle = useStore(tab.stores.session, (s) => s.projectTitle);
  const restoring = useStore(tab.stores.session, (s) => s.restoringLastSession);
  const jobs = useStore(tab.stores.generation, (s) => s.jobs);
  const unseen = useStore(tab.stores.generation, (s) => s.unseenOutputs);

  const running = inFlightJobs(jobs).length;
  const { seq, shot } = seqShotNames(shotPath);
  // Narrow to broad: the shot is what you're working on, but a tab that hasn't
  // picked one yet still needs to say which sequence (or project) it holds.
  const label = shot
    ? `${seq}/${shot}`
    : sequencePath
      ? `${basename(sequencePath)}/—`
      : (projectTitle ?? "empty");

  // Orange while this tab has work in the queue, green + bold once results have
  // landed that the user hasn't come back to. Busy wins while both are true:
  // "still working" is the live fact, and the green call-to-action arrives on
  // its own the moment the queue drains.
  const stateClass = running > 0
    ? "text-warn"
    : unseen > 0
      ? "text-ok font-bold"
      : active
        ? "text-text"
        : "text-dim group-hover:text-text";

  const stateTitle =
    running > 0
      ? `${running} job${running > 1 ? "s" : ""} queued or running`
      : unseen > 0
        ? `${unseen} new result${unseen > 1 ? "s" : ""} — not looked at yet`
        : null;

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
      onAuxClick={(e) => {
        // Middle-click closes, as everywhere else with tabs.
        if (e.button === 1 && closable) {
          e.stopPropagation();
          void requestCloseTab(tab);
        }
      }}
      title={
        stateTitle
          ? `${shotPath ?? sequencePath ?? projectTitle ?? "No project"} — ${stateTitle}`
          : (shotPath ?? sequencePath ?? projectTitle ?? "No project")
      }
      className={`group flex items-center gap-1 px-2 py-[3px] max-w-[240px] cursor-pointer shrink-0 ${
        active ? "bg-panel" : "bg-src-bg"
      } ${stateClass}`}
    >
      <span className="truncate">{label}</span>
      {running > 0 && (
        <span className="shrink-0" title={stateTitle ?? undefined}>
          ●{running > 1 ? running : ""}
        </span>
      )}
      {running === 0 && unseen > 0 && (
        <span className="shrink-0" title={stateTitle ?? undefined}>
          ▲{unseen > 1 ? unseen : ""}
        </span>
      )}
      {restoring && (
        <span className="opacity-50 shrink-0" title="Restoring session…">
          …
        </span>
      )}
      {closable && (
        <span
          role="button"
          aria-label="Close tab"
          className="shrink-0 opacity-50 hover:opacity-100 px-[2px]"
          onClick={(e) => {
            e.stopPropagation();
            void requestCloseTab(tab);
          }}
        >
          ×
        </span>
      )}
    </div>
  );
}
