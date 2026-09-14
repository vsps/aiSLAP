import { useMemo } from "react";
import { useModelsStore } from "../stores/modelsStore";

/**
 * Registry display label for a model id, falling back to the id itself.
 *
 * The registry is the source, not any name stored on disk: `assets` carries
 * `model_id` only (deliberately — see `AssetCostRow` in `db/mod.rs`), and the
 * registry follows a model that has since been renamed. Same reasoning as
 * AuditMode's label pass, which resolves from the registry *first* rather than
 * as a fallback so one id always reads as one label.
 *
 * **Node ids are unique; display names are not.** 24 of the registry's 101
 * nodes share a `name` with another — "Seedream 5.0 Pro (edit)" is carried by
 * both a fal and a ByteDance node, and most of the Seedance/Veo/Nano Banana
 * families repeat a name across providers. Rendered raw, those become two
 * identical filter chips that cannot be told apart. So a name held by more than
 * one node gets its provider appended and a unique one is left clean — which
 * resolves every collision in the current registry, with none left over.
 * `provider` defaults to `"fal"` when a node omits it, matching what the
 * generation path stamps into the sidecar.
 *
 * The fallback is the raw slug, which is what a model dropped from the registry
 * looks like — better than a blank chip you can't identify or clear.
 *
 * Referentially stable: `modelsStore.entries` is loaded once at boot and never
 * mutated, so the map and the returned closure survive every gallery rescan.
 * That matters because the filter bar memoises its chip list on this function.
 */
export function useModelLabels(): (id: string) => string {
  const entries = useModelsStore((s) => s.entries);
  const byId = useMemo(() => {
    const perName = new Map<string, number>();
    for (const e of entries)
      perName.set(e.node.name, (perName.get(e.node.name) ?? 0) + 1);
    return new Map(
      entries.map((e) => [
        e.node.id,
        (perName.get(e.node.name) ?? 0) > 1
          ? `${e.node.name} · ${e.node.provider ?? "fal"}`
          : e.node.name,
      ]),
    );
  }, [entries]);
  return useMemo(() => (id: string) => byId.get(id) ?? id, [byId]);
}
