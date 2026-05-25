export type ScriptSection = { title: string; body: string };

export type ParsedScript = {
  sequences: ScriptSection[];
  shotsByParent: Map<string, ScriptSection[]>;
};

export function normalizeTitle(s: string): string {
  return s.trim().toLowerCase();
}

export function parseScript(md: string): ParsedScript {
  const seqs: ScriptSection[] = [];
  const shotsByParent = new Map<string, ScriptSection[]>();
  let currentSeq: ScriptSection | null = null;
  let currentShot: ScriptSection | null = null;
  let currentParentKey: string | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const h2 = raw.match(/^##\s+(.+?)\s*$/);
    const h1 = !h2 ? raw.match(/^#\s+(.+?)\s*$/) : null;
    if (h1) {
      currentSeq = { title: h1[1], body: "" };
      seqs.push(currentSeq);
      currentParentKey = normalizeTitle(h1[1]);
      shotsByParent.set(currentParentKey, []);
      currentShot = null;
    } else if (h2) {
      currentShot = { title: h2[1], body: "" };
      if (currentParentKey) shotsByParent.get(currentParentKey)!.push(currentShot);
    } else if (currentShot) {
      currentShot.body += (currentShot.body ? "\n" : "") + raw;
    } else if (currentSeq) {
      currentSeq.body += (currentSeq.body ? "\n" : "") + raw;
    }
  }
  for (const s of seqs) s.body = s.body.replace(/\s+$/, "");
  for (const arr of shotsByParent.values())
    for (const s of arr) s.body = s.body.replace(/\s+$/, "");
  return { sequences: seqs, shotsByParent };
}

export function findSequenceBody(p: ParsedScript, seqName: string): string {
  const key = normalizeTitle(seqName);
  return p.sequences.find((s) => normalizeTitle(s.title) === key)?.body ?? "";
}

export function findShotBody(
  p: ParsedScript,
  seqName: string,
  shotName: string,
): string {
  const arr = p.shotsByParent.get(normalizeTitle(seqName));
  if (!arr) return "";
  const key = normalizeTitle(shotName);
  return arr.find((s) => normalizeTitle(s.title) === key)?.body ?? "";
}
