import { useEffect, useRef, useState } from "react";
import type { GalleryImage } from "../lib/types";
import { cmd } from "../lib/tauri";
import { useSessionStore } from "../stores/sessionStore";
import { showMessage } from "../lib/dialog";
import { ModalDialog } from "./ModalDialog";

type Props = {
  image: GalleryImage;
  onClose: () => void;
};

const INVALID_CHARS = /[\\/:*?"<>|]/;
const RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

function splitStemExt(filename: string): { stem: string; ext: string } {
  const i = filename.lastIndexOf(".");
  if (i <= 0) return { stem: filename, ext: "" };
  return { stem: filename.slice(0, i), ext: filename.slice(i) };
}

function validateStem(stem: string): string | null {
  const trimmed = stem.trim();
  if (!trimmed) return "name is empty";
  if (INVALID_CHARS.test(trimmed)) return "contains invalid character";
  if (RESERVED.has(trimmed.toUpperCase())) return "reserved name";
  return null;
}

export function RenameImageModal({ image, onClose }: Props) {
  const { stem, ext } = splitStemExt(image.filename);
  const [value, setValue] = useState(stem);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function confirm() {
    if (busy) return;
    const trimmed = value.trim();
    const err = validateStem(trimmed);
    if (err) {
      setError(err);
      return;
    }
    if (trimmed === stem) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const newPath = await cmd.image_rename(image.path, trimmed);
      const session = useSessionStore.getState();
      await session.rescanShot();
      session.setSelectedImage(newPath);
      onClose();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("FILENAME_EXISTS")) {
        setError("a file with that name already exists");
      } else {
        await showMessage(msg, { kind: "error" });
      }
      setBusy(false);
    }
  }

  return (
    <ModalDialog title="Rename" onClose={onClose}>
        <div className="flex items-center gap-1 font-mono text-sm">
          <input
            ref={inputRef}
            type="text"
            value={value}
            disabled={busy}
            className="bg-bg text-text px-2 py-[2px] outline-none border border-accent flex-1 min-w-0"
            onChange={(e) => {
              setValue(e.currentTarget.value);
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
          <span className="text-dim">{ext}</span>
        </div>
        {error && <div className="text-xs text-red-500">{error}</div>}
        <div className="flex justify-end gap-2 mt-1">
          <button
            type="button"
            className="px-2 py-[2px] text-sm hover:bg-accent"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-2 py-[2px] text-sm bg-accent hover:opacity-80"
            onClick={() => void confirm()}
            disabled={busy}
          >
            Rename
          </button>
        </div>
    </ModalDialog>
  );
}
