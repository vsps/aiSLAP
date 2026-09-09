import { useEffect, useState } from "react";
import { cmd } from "../../lib/tauri";
import { showMessage } from "../../lib/dialog";
import { useSessionStore } from "../../stores/sessionStore";
import { normalizeTitle, parseScript } from "../../lib/script";
import { basename } from "../../lib/paths";
import { Btn } from "../Btn";

function sanitizeName(name: string): string {
  return [...name]
    .map((c) => ('/\\:*?"<>|'.includes(c) || c.charCodeAt(0) < 32 ? "_" : c))
    .join("");
}

type PendingShot = { name: string; isNew: boolean };
type PendingSeq = { seq: string; isNew: boolean; shots: PendingShot[] };

type Props = {
  script: string;
};

/**
 * The real, already-materialized sequence/shot structure, rendered as a
 * navigable tree — "the script locked in": before CREATE DIRS has run at
 * least once this is just whatever already exists on disk (possibly
 * nothing). Clicking a shot drives the app's one shared "current shot"
 * (`sessionStore.setSequence`/`setShot`, the same actions `SessionBar`'s
 * dropdowns use), so column 3's detail panel and the bottom Gallery follow
 * it for free.
 */
export function ShotTreeNav({ script }: Props) {
  const projectPath = useSessionStore((s) => s.projectPath);
  const sequencesInProject = useSessionStore((s) => s.sequencesInProject);
  const sequencePath = useSessionStore((s) => s.sequencePath);
  const shotPath = useSessionStore((s) => s.shotPath);
  const shotEntityPath = useSessionStore((s) => s.shotEntityPath);

  const [shotsBySeq, setShotsBySeq] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [pendingDirs, setPendingDirs] = useState<PendingSeq[] | null>(null);

  // Read-only listing per sequence — deliberately calls the raw command
  // rather than sessionStore.setSequence, which would navigate the app to
  // each one just to list it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        sequencesInProject.map(async (seq) => {
          try {
            const { shots } = await cmd.sequence_open(seq);
            return [seq, shots] as const;
          } catch {
            return [seq, []] as const;
          }
        }),
      );
      if (!cancelled) setShotsBySeq(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [sequencesInProject]);

  async function openShot(seq: string, shot: string) {
    try {
      if (sequencePath !== seq) {
        await useSessionStore.getState().setSequence(seq, { openLastShot: false });
      }
      await useSessionStore.getState().setShot(shot);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }

  async function promptCreateDirs() {
    if (!projectPath) return;
    setBusy(true);
    try {
      const parsed = parseScript(script);
      const seqNames = parsed.sequences.map((s) => s.title);
      const seqPaths = seqNames.map((n) => `${projectPath}/${sanitizeName(n)}`);

      const shotEntries: { seqIdx: number; name: string; path: string }[] = [];
      for (let i = 0; i < parsed.sequences.length; i++) {
        for (const s of parsed.shotsByParent.get(normalizeTitle(seqNames[i])) ?? []) {
          shotEntries.push({
            seqIdx: i,
            name: s.title,
            path: `${seqPaths[i]}/${sanitizeName(s.title)}`,
          });
        }
      }

      const exists = await cmd.dirs_exist([
        ...seqPaths,
        ...shotEntries.map((e) => e.path),
      ]);
      const seqExists = exists.slice(0, seqPaths.length);
      const shotExists = exists.slice(seqPaths.length);

      const indexedShots = shotEntries.map((e, idx) => ({ ...e, idx }));
      const preview = parsed.sequences.map((seq, i) => ({
        seq: seq.title,
        isNew: !seqExists[i],
        shots: indexedShots
          .filter((e) => e.seqIdx === i)
          .map((e) => ({ name: e.name, isNew: !shotExists[e.idx] })),
      }));
      setPendingDirs(preview);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function confirmCreateDirs() {
    if (!projectPath || !pendingDirs) return;
    setPendingDirs(null);
    setBusy(true);
    try {
      let newSeqs = 0;
      let newShots = 0;
      for (const { seq, isNew: seqIsNew, shots } of pendingDirs) {
        const seqPath = await cmd.sequence_create(projectPath, seq);
        if (seqIsNew) newSeqs++;
        for (const { name, isNew: shotIsNew } of shots) {
          await cmd.shot_create(seqPath, name);
          if (shotIsNew) newShots++;
        }
      }
      const sequences = await cmd.project_open(projectPath);
      useSessionStore.setState({ sequencesInProject: sequences });
      await showMessage(`Created ${newSeqs} sequence(s), ${newShots} shot(s)`, {
        kind: "info",
      });
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  const activeShot = shotEntityPath ?? shotPath;

  return (
    <div className="flex flex-col gap-1 w-56 shrink-0 min-h-0">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-dim uppercase tracking-wide">
          Shot tree
        </div>
        <Btn
          disabled={busy || !projectPath || !script.trim()}
          onClick={promptCreateDirs}
          title="Parse the script and create any sequence/shot folders it names"
        >
          CREATE DIRS
        </Btn>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto thin-scroll flex flex-col gap-2 bg-inset p-1 text-xs font-mono">
        {sequencesInProject.length === 0 && (
          <div className="text-dim p-1">
            No sequences yet — write a script and run CREATE DIRS.
          </div>
        )}
        {sequencesInProject.map((seq) => (
          <div key={seq}>
            <button
              type="button"
              onClick={() => void useSessionStore.getState().setSequence(seq)}
              className={`block w-full text-left px-1 ${
                sequencePath === seq ? "text-accent" : "text-text hover:text-accent"
              }`}
            >
              {basename(seq)} /
            </button>
            {(shotsBySeq[seq] ?? []).map((shot) => (
              <button
                key={shot}
                type="button"
                onClick={() => void openShot(seq, shot)}
                className={`block w-full text-left pl-4 px-1 ${
                  activeShot === shot
                    ? "bg-accent-muted text-on-accent-muted"
                    : "text-dim hover:text-text"
                }`}
              >
                {basename(shot)}
              </button>
            ))}
          </div>
        ))}
      </div>

      {pendingDirs && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6">
          <div className="bg-panel border border-dim shadow-xl w-full max-w-sm flex flex-col">
            <div className="px-4 py-2 bg-surface text-text text-sm">
              Create directories?
            </div>
            <ul className="px-4 py-3 font-mono text-xs overflow-y-auto max-h-64 thin-scroll flex flex-col gap-0.5">
              {pendingDirs.map(({ seq, isNew: seqIsNew, shots }) => (
                <li key={seq}>
                  <span className={seqIsNew ? "text-accent" : "text-text"}>
                    {seq}/
                  </span>
                  {shots.map(({ name, isNew: shotIsNew }) => (
                    <div
                      key={name}
                      className={`pl-4 ${shotIsNew ? "text-accent" : "text-dim"}`}
                    >
                      {name}/
                    </div>
                  ))}
                </li>
              ))}
            </ul>
            <div className="px-4 py-2 flex justify-end gap-2 border-t border-dim">
              <Btn onClick={() => setPendingDirs(null)}>Cancel</Btn>
              <Btn onClick={confirmCreateDirs}>Create</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
