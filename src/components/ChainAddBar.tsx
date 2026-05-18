import { useState } from "react";
import { useGenerationStore } from "../stores/generationStore";
import { usePresetsStore } from "../stores/presetsStore";
import { IconBtn } from "./IconBtn";
import { ChainPresetSaveModal } from "./ChainPresetSaveModal";
import { ChainPresetLoadModal } from "./ChainPresetLoadModal";
import type { ChainPresetLink } from "../lib/types";

/**
 * Vertical strip sitting between RefImages (or the rightmost collapsed link)
 * and the Latest preview. Hosts:
 *   - "+" Add link (always available)
 *   - "▶" Collapse & preflight (only when a link is expanded AND more than
 *     one link exists)
 *   - Bookmark Save preset
 *   - Folder Load preset
 */
export function ChainAddBar() {
  const links = useGenerationStore((s) => s.links);
  const expandedIdx = useGenerationStore((s) => s.expandedIdx);
  const addLink = useGenerationStore((s) => s.addLink);
  const expandLink = useGenerationStore((s) => s.expandLink);
  const presets = usePresetsStore((s) => s.presets);

  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  const showCollapse = expandedIdx != null && links.length > 1;

  function buildPresetLinks(): ChainPresetLink[] {
    return links.map((l) => ({
      modelId: l.model?.id ?? null,
      settings: l.settings,
      sequencePrompt: l.sequencePrompt,
      shotPrompts: l.shotPrompts,
    }));
  }

  return (
    <>
      <div className="bg-surface border border-border text-text w-[40px] flex flex-col items-center gap-1 shrink-0 py-2">
        <IconBtn
          name="add_link"
          size={24}
          title="Add link to chain"
          onClick={() => addLink()}
        />
        {showCollapse && (
          <IconBtn
            name="play_arrow"
            size={24}
            title="Collapse and preflight chain"
            onClick={() => expandLink(null)}
          />
        )}
        <div className="flex-1" />
        <IconBtn
          name="bookmark"
          size={20}
          title="Save chain as preset"
          onClick={() => setSaving(true)}
        />
        <IconBtn
          name="folder_open"
          size={20}
          title={presets.length === 0 ? "No presets saved yet" : "Load a chain preset"}
          disabled={presets.length === 0}
          onClick={() => setLoading(true)}
        />
      </div>

      {saving && (
        <ChainPresetSaveModal
          links={buildPresetLinks()}
          onClose={() => setSaving(false)}
        />
      )}
      {loading && (
        <ChainPresetLoadModal
          onClose={() => setLoading(false)}
        />
      )}
    </>
  );
}
