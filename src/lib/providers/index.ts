import { FalProvider } from "./fal";
import { ReplicateProvider } from "./replicate";
import { BytedanceProvider } from "./bytedance";
import { BeebleProvider } from "./beeble";
import type { Provider, ProviderName } from "./provider";

export type { Provider, ProviderName, ProviderOutput, ProviderProgress, ProviderFile } from "./provider";

const cache = new Map<ProviderName, Provider>();

export function getProvider(name: ProviderName | undefined): Provider {
  const key = name ?? "fal";
  let p = cache.get(key);
  if (p) return p;
  p =
    key === "replicate"
      ? new ReplicateProvider()
      : key === "bytedance"
        ? new BytedanceProvider()
        : key === "beeble"
          ? new BeebleProvider()
          : new FalProvider();
  cache.set(key, p);
  return p;
}
