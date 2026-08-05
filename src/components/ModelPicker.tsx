import { useMemo } from "react";
import { useModelsStore } from "../stores/modelsStore";
import { usePricesStore } from "../stores/pricesStore";
import {
  selectCurrentModel,
  selectRefImages,
  useGenerationStore,
} from "../stores/generationStore";
import type { ModelEntry } from "../lib/types";
import { hasUnsupportedRefs } from "../lib/chainValidation";

type Provider = "fal" | "replicate" | "bytedance";

type UiGroup = "image" | "video" | "utility" | "model3d";

// Picker grouping is a display concern, orthogonal to output `kind`: utility
// tools (Topaz, Depth Anything, SAM3) span image/video/3d outputs but belong
// under one "Utility" group. Driven by the family's `category` segment; falls
// back to the node's output kind for generators.
function effectiveGroup(e: ModelEntry): UiGroup {
  const seg = e.category.split("/").pop()?.trim().toLowerCase() ?? "";
  if (seg === "utility" || seg === "upscaling") return "utility";
  return e.node.kind; // "image" | "video" | "model3d"
}

// Families grouped by UI group (Image, Video, Utility, 3D), deduped, in
// first-seen order within each group.
function familiesByGroupOf(list: ModelEntry[]): Record<UiGroup, string[]> {
  const out: Record<UiGroup, string[]> = {
    image: [],
    video: [],
    utility: [],
    model3d: [],
  };
  const seen: Record<UiGroup, Set<string>> = {
    image: new Set(),
    video: new Set(),
    utility: new Set(),
    model3d: new Set(),
  };
  for (const e of list) {
    const g = effectiveGroup(e);
    if (!seen[g].has(e.family)) {
      seen[g].add(e.family);
      out[g].push(e.family);
    }
  }
  return out;
}

// Families in picker display order (Image, Video, Utility, 3D), deduped.
function orderedFamilies(list: ModelEntry[]): string[] {
  const g = familiesByGroupOf(list);
  return [...g.image, ...g.video, ...g.utility, ...g.model3d];
}

export function ModelPicker() {
  const entries = useModelsStore((s) => s.entries);
  const loaded = useModelsStore((s) => s.loaded);
  const currentModel = useGenerationStore(selectCurrentModel);
  const selectModel = useGenerationStore((s) => s.selectModel);
  const currentPrice = usePricesStore((s) =>
    currentModel && (currentModel.provider ?? "fal") === "fal"
      ? (s.prices[currentModel.endpoint] ?? null)
      : null,
  );
  const refImages = useGenerationStore(selectRefImages);

  // Provider tab and family mirror the active model rather than living in
  // local state: every interaction here ends in selectModel, so there's
  // nothing extra to remember — and it means a store-driven model change
  // (RESTORE PROMPT, restore chain, chain presets) moves the tabs with it
  // instead of leaving the picker pointing at the previous provider.
  const currentEntry = useMemo(
    () =>
      currentModel
        ? (entries.find((e) => e.node.id === currentModel.id) ?? null)
        : null,
    [entries, currentModel],
  );
  const provider = (currentEntry?.node.provider ??
    currentModel?.provider ??
    "fal") as Provider;

  const providerEntries = useMemo(
    () => entries.filter((e) => (e.node.provider ?? "fal") === provider),
    [entries, provider],
  );

  const familiesByGroup = useMemo(
    () => familiesByGroupOf(providerEntries),
    [providerEntries],
  );

  const imageFamilies = familiesByGroup.image;
  const videoFamilies = familiesByGroup.video;
  const utilityFamilies = familiesByGroup.utility;
  const model3dFamilies = familiesByGroup.model3d;

  const families = useMemo(
    () => [
      ...imageFamilies,
      ...videoFamilies,
      ...utilityFamilies,
      ...model3dFamilies,
    ],
    [imageFamilies, videoFamilies, utilityFamilies, model3dFamilies],
  );

  const selectedFamily = currentEntry?.family ?? families[0] ?? null;

  const familyModels = useMemo(
    () => providerEntries.filter((e) => e.family === selectedFamily),
    [providerEntries, selectedFamily],
  );

  // Selecting a family (via the dropdown or a provider switch, which resets
  // the family to that provider's first) has no submodel of its own — always
  // land on the family's first submodel so a model is immediately active.
  // When ref images are attached, prefer an edit/img2img variant so the user
  // doesn't accidentally switch to a txt2img model that would ignore them.
  function selectFamilyAndFirstModel(
    list: ModelEntry[],
    family: string | null,
  ) {
    const familyList = list.filter((e) => e.family === family);
    if (familyList.length === 0) return;
    let first = familyList[0];
    if (refImages.length > 0) {
      const editModel = familyList.find(
        (e) => !hasUnsupportedRefs(e.node, refImages),
      );
      if (editModel) first = editModel;
    }
    selectModel(first.node);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1 text-xs font-mono">
        {(["fal", "replicate", "bytedance"] as Provider[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              const newProviderEntries = entries.filter(
                (e) => (e.node.provider ?? "fal") === p,
              );
              const fam = orderedFamilies(newProviderEntries)[0] ?? null;
              selectFamilyAndFirstModel(newProviderEntries, fam);
            }}
            className={
              provider === p
                ? "px-2 py-[1px] bg-accent text-bg"
                : "px-2 py-[1px] bg-bg text-text hover:opacity-80"
            }
          >
            {p}
          </button>
        ))}
      </div>
      <select
        className="bg-bg text-text px-1 py-[2px] w-full"
        value={selectedFamily ?? ""}
        onChange={(e) =>
          selectFamilyAndFirstModel(
            providerEntries,
            e.currentTarget.value || null,
          )
        }
      >
        {imageFamilies.length > 0 && (
          <optgroup label="Image">
            {imageFamilies.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
        )}
        {videoFamilies.length > 0 && (
          <optgroup label="Video">
            {videoFamilies.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
        )}
        {utilityFamilies.length > 0 && (
          <optgroup label="Utility">
            {utilityFamilies.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
        )}
        {model3dFamilies.length > 0 && (
          <optgroup label="3D">
            {model3dFamilies.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <div className="flex flex-wrap gap-1">
        {familyModels.map((e) => (
          <button
            key={e.node.id}
            type="button"
            onClick={() => selectModel(e.node)}
            className={
              currentModel?.id === e.node.id
                ? "px-2 py-[1px] text-xs font-mono bg-accent text-bg"
                : "px-2 py-[1px] text-xs font-mono bg-bg text-text hover:opacity-80"
            }
          >
            {e.node.name}
          </button>
        ))}
        {familyModels.length === 0 && loaded && (
          <span className="text-xs text-dim">—</span>
        )}
      </div>
      {currentPrice && (
        <div
          className="text-[11px] font-mono text-dim truncate"
          title={`${currentPrice} (fetched from fal.ai — estimate)`}
        >
          {currentPrice}
        </div>
      )}
    </div>
  );
}
