// Word source for the `<rnd>` filename token.
//
// The list is ~16k five-letter words / ~97KB, so it is imported *dynamically*:
// Vite gives it its own chunk, and only a template that actually contains
// `<rnd>` ever fetches it. Same rule as the `<minor>` allocation in output.ts —
// a token you don't use costs nothing.

let cache: Promise<string[]> | null = null;

function load(): Promise<string[]> {
  // The specifier must stay a literal — Vite resolves and chunks it at build
  // time, so a variable (or @vite-ignore) would leave a path that doesn't
  // exist in the bundle.
  cache ??= import("../../components/wordlist_fives.txt?raw").then((m) =>
    m.default
      .split(/\r?\n/)
      .map((w) => w.trim().toLowerCase())
      // Letters only. 21 of the ~16k entries carry an apostrophe or a trailing
      // hyphen ("ain't", "nano-"); both are legal on disk and would survive
      // safeName, but these paths are handed to ffmpeg on the command line, so
      // they're dropped rather than quoted around forever.
      .filter((w) => /^[a-z]+$/.test(w)),
  );
  return cache;
}

/** A picker that returns a **fresh** word per call, so each `<rnd>` in a
 *  template rolls independently — `<rnd>_<rnd>` gives two different words — and
 *  every file in a batch gets its own roll.
 *
 *  Null when the list can't be read. The caller substitutes a placeholder
 *  rather than failing: by the time filenames are resolved the generation has
 *  already been paid for, and a slightly worse name beats a lost output. */
export async function randomWordPicker(): Promise<(() => string) | null> {
  try {
    const words = await load();
    if (words.length === 0) return null;
    return () => words[Math.floor(Math.random() * words.length)];
  } catch {
    // Don't let one failed fetch poison the rest of the session.
    cache = null;
    return null;
  }
}
