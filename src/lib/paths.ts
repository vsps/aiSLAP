/** Forward slashes, no trailing slash. */
export function normalizeDir(p: string | null | undefined): string {
  if (!p) return "";
  return p.replaceAll("\\", "/").replace(/\/+$/, "");
}

export function basename(p: string | null | undefined): string {
  const s = normalizeDir(p);
  const i = s.lastIndexOf("/");
  return i < 0 ? s : s.slice(i + 1);
}

export function dirname(p: string | null | undefined): string {
  const s = normalizeDir(p);
  const i = s.lastIndexOf("/");
  return i < 0 ? "" : s.slice(0, i);
}

export function joinPath(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => !!p)
    .map((p, i) => {
      const fwd = p.replaceAll("\\", "/");
      return i === 0 ? fwd.replace(/\/+$/, "") : fwd.replace(/^\/+|\/+$/g, "");
    })
    .join("/");
}

export function isChildOf(parent: string, child: string): boolean {
  const p = normalizeDir(parent);
  const c = normalizeDir(child);
  return c === p || c.startsWith(p + "/");
}

/** Forward-slash path relative to `root`, or the unmodified (normalized)
 *  input when it isn't actually under `root`. Mirrors the Rust side's
 *  `fsutil::rel_of` — used for the DB's project-relative `relPath` column. */
export function relativeTo(root: string, path: string): string {
  const r = normalizeDir(root);
  const p = normalizeDir(path);
  if (p === r) return "";
  if (p.startsWith(r + "/")) return p.slice(r.length + 1);
  return p;
}
