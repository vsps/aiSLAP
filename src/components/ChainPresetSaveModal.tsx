import { useEffect, useRef, useState } from "react";
import type { ChainPresetLink } from "../lib/types";
import { usePresetsStore } from "../stores/presetsStore";
import { ModalDialog } from "./ModalDialog";
import { Btn } from "./Btn";

type Props = {
  links: ChainPresetLink[];
  onClose: () => void;
};

export function ChainPresetSaveModal({ links, onClose }: Props) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const presets = usePresetsStore((s) => s.presets);
  const save = usePresetsStore((s) => s.save);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function confirm() {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("name is required");
      return;
    }
    if (presets.some((p) => p.name === trimmed)) {
      setError("a preset with that name already exists");
      return;
    }
    setBusy(true);
    try {
      await save(trimmed, links);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <ModalDialog title="Save chain preset" onClose={onClose}>
      <div className="text-xs opacity-60">
        {links.length} link{links.length !== 1 ? "s" : ""} · models + prompts
        only
      </div>
      <input
        ref={inputRef}
        type="text"
        value={name}
        placeholder="Preset name"
        disabled={busy}
        className="bg-bg text-text px-2 py-[2px] outline-none border border-accent font-mono text-sm"
        onChange={(e) => {
          setName(e.currentTarget.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void confirm();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      {error && <div className="text-xs text-red-500">{error}</div>}
      <div className="flex justify-end gap-2 mt-1">
        <Btn onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <Btn onClick={() => void confirm()} disabled={busy || !name.trim()}>
          Save
        </Btn>
      </div>
    </ModalDialog>
  );
}
