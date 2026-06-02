import { useMemo, useState } from "react";
import { useModelsStore } from "../stores/modelsStore";
import { useGenerationStore } from "../stores/generationStore";

type Provider = "fal" | "replicate";

export function ModelPicker() {
  const { entries, loaded } = useModelsStore();
  const { currentModel, selectModel } = useGenerationStore();

  const [provider, setProvider] = useState<Provider>(
    () => ((currentModel?.provider ?? "fal") as Provider),
  );
  const [manualFamily, setManualFamily] = useState<string | null>(null);

  const providerEntries = useMemo(
    () => entries.filter((e) => (e.node.provider ?? "fal") === provider),
    [entries, provider],
  );

  const imageFamilies = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const e of providerEntries.filter((e) => e.node.kind === "image")) {
      if (!seen.has(e.family)) { seen.add(e.family); result.push(e.family); }
    }
    return result;
  }, [providerEntries]);

  const videoFamilies = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const e of providerEntries.filter((e) => e.node.kind === "video")) {
      if (!seen.has(e.family)) { seen.add(e.family); result.push(e.family); }
    }
    return result;
  }, [providerEntries]);

  const families = useMemo(() => [...imageFamilies, ...videoFamilies], [imageFamilies, videoFamilies]);

  const currentFamily = useMemo(() => {
    if (!currentModel) return null;
    const entry = entries.find((e) => e.node.id === currentModel.id);
    if (!entry || (entry.node.provider ?? "fal") !== provider) return null;
    return entry.family;
  }, [currentModel, entries, provider]);

  const selectedFamily = manualFamily ?? currentFamily ?? families[0] ?? null;

  const familyModels = useMemo(
    () => providerEntries.filter((e) => e.family === selectedFamily),
    [providerEntries, selectedFamily],
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1 text-xs font-mono">
        {(["fal", "replicate"] as Provider[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => { setProvider(p); setManualFamily(null); }}
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
      <div className="flex flex-wrap gap-1 text-xs font-mono">
        {imageFamilies.length > 0 && videoFamilies.length > 0 && (
          <span className="text-[10px] text-dim w-full -mb-[2px]">Image</span>
        )}
        {imageFamilies.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setManualFamily(f)}
            className={selectedFamily === f ? "px-2 py-[1px] bg-accent text-bg" : "px-2 py-[1px] bg-bg text-text hover:opacity-80"}
          >
            {f}
          </button>
        ))}
        {imageFamilies.length > 0 && videoFamilies.length > 0 && (
          <span className="text-[10px] text-dim w-full -mb-[2px]">Video</span>
        )}
        {videoFamilies.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setManualFamily(f)}
            className={selectedFamily === f ? "px-2 py-[1px] bg-accent text-bg" : "px-2 py-[1px] bg-bg text-text hover:opacity-80"}
          >
            {f}
          </button>
        ))}
      </div>
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
    </div>
  );
}
