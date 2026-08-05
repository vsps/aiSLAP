# Script 001 — Quickstart Explainer (30s)

> **Marketing / video production material, not product documentation.**
> Not maintained alongside the app, and not linked from the user-facing docs. The
> video has never been produced; delete this file if it never will be.

Companion video for [quickstart.md](../guides/quickstart.md). ~80 words VO. Mix
screen-rec + gen-AI cutaways.

**Total runtime:** 30s · **Aspect:** 16:9 · **Tone:** brisk, no fluff

---

## Shot list

| # | Time | Duration | Visual | VO |
|---|------|----------|--------|----|
| 1 | 0:00 | 3s | Gen-AI hero: aiSLAP logo glitches onto a moody studio desk. | "aiSLAP — a desktop GUI for fal, replicate and BytePlus." |
| 2 | 0:03 | 3s | Screen-rec: terminal types `pnpm tauri dev`, app window opens. | "Install with pnpm, then launch." |
| 3 | 0:06 | 3s | Screen-rec: gear icon click → Settings dialog → paste FAL_KEY → save. | "Drop your fal API key into Settings." |
| 4 | 0:09 | 3s | Screen-rec: top bar → pick a project folder. Empty folder highlights. | "Point it at any folder — that's your project." |
| 5 | 0:12 | 4s | Screen-rec: **+** new sequence "intro" → **+** new shot "010". | "Create a sequence. Then a shot." |
| 6 | 0:16 | 3s | Screen-rec: left column → select **Nano Banana Pro**. Params slide in. | "Pick a model. We'll use Nano Banana Pro." |
| 7 | 0:19 | 5s | Screen-rec: typing in SEQUENCE prompt, then SHOT prompt. Text highlights. | "Sequence prompt for shared style. Shot prompt for this frame." |
| 8 | 0:24 | 3s | Screen-rec: cursor hits **Generate**. Progress spinner. | "Hit generate." |
| 9 | 0:27 | 3s | Screen-rec: new `v001/` column populates with the result image. Subtle zoom. | "Result lands in the gallery, saved to disk with its prompt." |

---

## Production notes

- **Screen-rec capture:** 1920×1080, 60fps, hide personal paths. Use a clean demo project named `demo/`.
- **Gen-AI shots:** Shot 1 only. Generate with the app itself (eat the dogfood) — Nano Banana Pro, prompt: `aiSLAP logo glitching onto a moody cinematographer's desk, neon rim light, 35mm`.
- **VO:** single take, conversational, ~155 wpm. Leave 0.2s headroom at cuts.
- **Music:** low-bpm synth bed, duck under VO. Drop out on shot 9 for the reveal.
- **Captions:** burn-in lowercase, bottom-third, mono font to match the README ascii vibe.
- **End card:** 1s freeze on final frame + URL `aislap` / repo link. (Counts toward the 30s budget if added — trim shot 9 to 2s.)

## Asset checklist

- [ ] Clean demo project folder
- [ ] FAL_KEY in a throwaway env (don't leak it on screen — blur if visible)
- [ ] VO recorded + leveled to -16 LUFS
- [ ] Hero shot rendered
- [ ] Final export (no destination decided — the old `../videos/` path never existed)
