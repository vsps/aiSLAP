import { useState } from "react";
import { IconBtn } from "./IconBtn";
import { InlinePrompt } from "./InlinePrompt";
import { useSessionStore } from "../stores/sessionStore";
import { useScriptStore } from "../stores/scriptStore";
import { confirmAction, pickDirectory, showMessage } from "../lib/dialog";
import { cmd } from "../lib/tauri";
import { basename, normalizeDir } from "../lib/paths";
import { normalizeTitle } from "../lib/script";
import { renameSequence, renameShot } from "../lib/actions";

type Props = {
  onOpenSettings?: () => void;
  onOpenProjectSettings?: () => void;
};

export function SessionBar({
  onOpenSettings,
  onOpenProjectSettings,
}: Props) {
  const projectPath = useSessionStore((s) => s.projectPath);
  const projectTitle = useSessionStore((s) => s.projectTitle);
  const sequencePath = useSessionStore((s) => s.sequencePath);
  const shotPath = useSessionStore((s) => s.shotPath);
  const shotEntityPath = useSessionStore((s) => s.shotEntityPath);
  const prism = useSessionStore((s) => s.prism);
  const entityType = useSessionStore((s) => s.entityType);
  const setEntityType = useSessionStore((s) => s.setEntityType);
  const sequencesInProject = useSessionStore((s) => s.sequencesInProject);
  const shotsInSequence = useSessionStore((s) => s.shotsInSequence);
  const setProject = useSessionStore((s) => s.setProject);
  const setSequence = useSessionStore((s) => s.setSequence);
  const setShot = useSessionStore((s) => s.setShot);
  const createSequence = useSessionStore((s) => s.createSequence);
  const createShot = useSessionStore((s) => s.createShot);

  // PRISM owns entity creation — aiSLAP only writes inside the AI render
  // product.
  const entityLocked = !!prism;
  const lockedTitle = "Managed by PRISM — create it in PRISM first";
  const shotLabel = prism && entityType === "asset" ? "ASSET:" : "SHOT:";

  const [creating, setCreating] = useState<
    null | "sequence" | "shot" | "rename-sequence" | "rename-shot"
  >(null);
  const [prefillName, setPrefillName] = useState("");
  const parsed = useScriptStore((s) => s.parsed);
  const seqTemplates = entityLocked ? [] : parsed.sequences.map((s) => s.title);
  const currentSeqName = sequencePath ? basename(sequencePath) : "";
  const shotTemplates = entityLocked
    ? []
    : (parsed.shotsByParent.get(normalizeTitle(currentSeqName)) ?? []).map(
        (s) => s.title,
      );

  async function pickProject() {
    const p = await pickDirectory("Choose project directory", projectPath ?? undefined);
    if (!p) return;
    try {
      await setProject(p);
      const normalized = normalizeDir(p);
      const [srcExists] = await cmd.dirs_exist([`${normalized}/SRC`]);
      if (!srcExists) {
        const ok = await confirmAction("No SRC folder found. Create it?", { title: "Global SRC" });
        if (ok) await cmd.dir_ensure(`${normalized}/SRC`);
      }
    } catch (e) {
      const msg = String(e);
      await showMessage(msg.includes("NOT A PROJECT FOLDER") ? "NOT A PROJECT FOLDER" : msg, { kind: "error" });
    }
  }

  async function onCreateSequence(name: string) {
    setCreating(null);
    setPrefillName("");
    try {
      await createSequence(name);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }

  async function onCreateShot(name: string) {
    setCreating(null);
    setPrefillName("");
    try {
      await createShot(name);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }

  async function onRenameSequence(name: string) {
    setCreating(null);
    setPrefillName("");
    try {
      await renameSequence(name);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }

  async function onRenameShot(name: string) {
    setCreating(null);
    setPrefillName("");
    try {
      await renameShot(name);
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  }

  return (
    <div className="flex items-center gap-[5px] text-sm">
      <div className="flex flex-1 items-center gap-[6px] min-w-0 bg-panel px-[5px] py-[5px]">
        {/* PROJECT */}
        <span>PROJECT DIR:</span>
        <IconBtn name="folder_open" size={22} title="Pick project directory" onClick={pickProject} />
        <Pill
          value={projectPath ?? "—"}
          truncate
          onClick={pickProject}
          title={projectPath ?? "No project"}
        />
        {/* Derived, read-only — see project_title_for in commands/session.rs.
            Not an input: renaming happens on the folder (or in PRISM), never here. */}
        <Pill
          value={projectTitle ?? "—"}
          title={projectTitle ? `Project name: ${projectTitle}` : undefined}
        />

        <IconBtn
          name="settings_applications"
          size={22}
          title="Project settings"
          onClick={onOpenProjectSettings}
          disabled={!projectPath}
        />

        {/* PRISM entity tree — shots vs assets. Only meaningful for a PRISM
            project, so it isn't rendered for a plain aiSLAP one. */}
        {prism && (
          <div
            className="flex gap-[2px] text-xs font-mono"
            title={`PRISM project${prism.projectName ? `: ${prism.projectName}` : ""}`}
          >
            {(["shot", "asset"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => void setEntityType(t)}
                className={
                  entityType === t
                    ? "px-2 py-[2px] bg-accent text-bg"
                    : "px-2 py-[2px] bg-src-bg text-text hover:opacity-80"
                }
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        )}

        {/* SEQUENCE */}
        <span className="pl-2">SEQUENCE</span>
        {creating === "sequence" || creating === "rename-sequence" ? (
          <InlinePrompt
            placeholder={
              creating === "rename-sequence" ? "rename sequence" : "sequence name"
            }
            initial={prefillName}
            onConfirm={
              creating === "rename-sequence" ? onRenameSequence : onCreateSequence
            }
            onCancel={() => {
              setCreating(null);
              setPrefillName("");
            }}
          />
        ) : (
          <PathSelect
            value={sequencePath}
            options={sequencesInProject}
            templates={seqTemplates}
            onChange={(p) => void setSequence(p)}
            onPickTemplate={(title) => {
              setPrefillName(title);
              setCreating("sequence");
            }}
            disabled={!projectPath}
            placeholder={projectPath ? "— select —" : "pick project first"}
          />
        )}
        <IconBtn
          name="add"
          size={20}
          title={entityLocked ? lockedTitle : "Create sequence"}
          onClick={() => {
            if (!projectPath) {
              void showMessage("Pick a project first", { kind: "warning" });
              return;
            }
            setPrefillName("");
            setCreating("sequence");
          }}
          disabled={!projectPath || entityLocked}
        />
        <IconBtn
          name="edit"
          size={18}
          title={entityLocked ? lockedTitle : "Rename sequence"}
          onClick={() => {
            if (!sequencePath) return;
            setPrefillName(basename(sequencePath));
            setCreating("rename-sequence");
          }}
          disabled={!sequencePath || entityLocked}
        />

        {/* SHOT (or ASSET, in a PRISM asset tree) */}
        <span className="pl-2">{shotLabel}</span>
        {creating === "shot" || creating === "rename-shot" ? (
          <InlinePrompt
            placeholder={
              creating === "rename-shot" ? "rename shot" : "shot name"
            }
            initial={prefillName}
            onConfirm={creating === "rename-shot" ? onRenameShot : onCreateShot}
            onCancel={() => {
              setCreating(null);
              setPrefillName("");
            }}
          />
        ) : (
          <PathSelect
            // The options are entity folders, so in PRISM the select has to
            // match on the entity — shotPath is the media root inside it.
            value={shotEntityPath ?? shotPath}
            options={shotsInSequence}
            templates={shotTemplates}
            onChange={(p) => void setShot(p)}
            onPickTemplate={(title) => {
              setPrefillName(title);
              setCreating("shot");
            }}
            disabled={!sequencePath}
            placeholder={sequencePath ? "— select —" : "pick sequence first"}
          />
        )}
        <IconBtn
          name="add"
          size={20}
          title={entityLocked ? lockedTitle : "Create shot"}
          onClick={() => {
            if (!sequencePath) {
              void showMessage("Pick a sequence first", { kind: "warning" });
              return;
            }
            setPrefillName("");
            setCreating("shot");
          }}
          disabled={!sequencePath || entityLocked}
        />
        <IconBtn
          name="edit"
          size={18}
          title={entityLocked ? lockedTitle : "Rename shot"}
          onClick={() => {
            if (!shotPath) return;
            setPrefillName(basename(shotPath));
            setCreating("rename-shot");
          }}
          disabled={!shotPath || entityLocked}
        />
      </div>

      <IconBtn name="settings" size={24} title="Settings" onClick={onOpenSettings} />
    </div>
  );
}

const TPL_PREFIX = "__tpl__:";

function PathSelect({
  value,
  options,
  templates,
  onChange,
  onPickTemplate,
  disabled,
  placeholder,
}: {
  value: string | null;
  options: string[];
  templates?: string[];
  onChange: (path: string) => void;
  onPickTemplate?: (title: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const tplsFiltered = (templates ?? []).filter(
    (t) => !options.some((p) => basename(p).toLowerCase() === t.trim().toLowerCase()),
  );
  return (
    <select
      className="bg-src-bg text-text px-2 py-[2px] min-w-[140px] max-w-[260px] disabled:opacity-50"
      value={value ?? ""}
      onChange={(e) => {
        const v = e.currentTarget.value;
        if (!v) return;
        if (v.startsWith(TPL_PREFIX)) {
          onPickTemplate?.(v.slice(TPL_PREFIX.length));
          // Reset the select back to current value so the template entry isn't sticky.
          e.currentTarget.value = value ?? "";
        } else {
          onChange(v);
        }
      }}
      disabled={disabled}
    >
      <option value="">{placeholder ?? "— select —"}</option>
      {options.map((p) => (
        <option key={p} value={p}>
          {basename(p)}
        </option>
      ))}
      {tplsFiltered.length > 0 && (
        <optgroup label="From script">
          {tplsFiltered.map((t) => (
            <option key={`tpl-${t}`} value={`${TPL_PREFIX}${t}`}>
              {t} (template)
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function Pill({
  value,
  title,
  truncate,
  onClick,
}: {
  value: string;
  title?: string;
  truncate?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      className={`bg-src-bg text-text px-2 py-[2px] whitespace-nowrap ${
        truncate ? "flex-1 min-w-0 overflow-hidden text-ellipsis" : ""
      } ${onClick ? "cursor-pointer" : ""}`}
      title={title ?? value}
      onClick={onClick}
    >
      {value || "—"}
    </div>
  );
}
