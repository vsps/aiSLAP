import { cmd } from "./tauri";

let cached: string | undefined;

/** Loaded once at bootstrap; failures leave it undefined rather than
 *  blocking startup — attribution is best-effort enrichment, not
 *  load-bearing. */
export async function loadSystemUsername(): Promise<void> {
  cached = (await cmd.system_username().catch(() => "")) || undefined;
}

export function currentUsername(): string | undefined {
  return cached;
}
