# AGENTS.md

Guidance for AI coding agents working in this repository. Read this before making
changes. If anything here conflicts with a direct instruction from the human, the
human wins — but call out the conflict instead of silently ignoring it.

## Project

`aiSLAP` is a desktop GUI for generative image/video APIs (fal.ai, replicate,
BytePlus Ark), organised around a **project / sequence / shot** file layout, with a
built-in NLE and a prompt-linking mechanism.

- **Frontend:** React 19 + TypeScript + Vite, Tailwind v4, Zustand for state.
- **Backend:** Rust on Tauri v2 (`src-tauri/`).
- **Package manager:** `pnpm` (never `npm` or `yarn`).
- **Primary target:** Windows. macOS/Linux build from source.

## Golden rules

1. **Always work on `dev`.** Never commit, merge, or push directly to `main` unless
   the human explicitly asks for a release. `dev` is the integration branch.
2. **Always bump the version when merging to `main`.** The `release` workflow
   (`.github/workflows/release.yaml`) only fires when `package.json`'s `version`
   changes on a push to `main`. A merge to `main` with an unchanged version silently
   produces no release.
3. **Keep changes surgical.** Do exactly what was asked. Don't refactor, rename, or
   reformat unrelated code, and don't "fix" things you weren't asked to touch.
4. **Never commit or push unless asked.** Make and verify changes locally first.

## Code quality

- **Clean, best-practice code.** Favour clarity over cleverness. Follow the
  conventions and idioms already present in the surrounding code rather than
  introducing new patterns.
- **Minimal duplication.** Factor out repeated logic instead of copy-pasting. If you
  find yourself writing the same thing a second time, extract a shared
  function/hook/component and reuse it — in both the TypeScript and Rust code.
- **No dead code, no commented-out code.** Delete it; Git remembers.
- **Comments explain *why*, not *what*.** Only add a comment where intent, a
  constraint, or a non-obvious tradeoff needs explaining. Never restate the code.
- **Small, focused functions and components.** Prefer composition over large
  multi-purpose units.
- **Type safety.** Keep TypeScript strict and explicit; avoid `any` and unchecked
  casts. Keep Rust code free of warnings — `clippy -D warnings` is enforced.
- **Reuse existing dependencies and utilities** before reaching for a new package.
  Justify any new dependency.

## Commands

```sh
pnpm install            # install deps (use --frozen-lockfile in CI contexts)
pnpm dev                # Vite dev server
pnpm build              # tsc + vite build
pnpm typecheck          # tsc --noEmit
pnpm test:rust          # cargo test
pnpm lint:rust          # cargo clippy (warnings = errors)
pnpm tauri <cmd>        # Tauri CLI
```

Run the relevant checks (`pnpm typecheck`, `pnpm test:rust`, `pnpm lint:rust`) after
changes that touch their scope. Don't claim something passes unless you ran it and
saw it pass.

## Release flow

1. Do the work on `dev` and verify it.
2. Bump `version` in `package.json` (and keep `src-tauri` versions in sync where
   they appear in `Cargo.toml` / `tauri.conf.json`).
3. Merge `dev` into `main` (e.g. `Merge dev: release vX.Y.Z`) and push `main`.
4. The `release` workflow drafts the release, builds all platforms, publishes it,
   then rewrites the README download links on a follow-up `[skip ci]` commit.

Pushing to `main` triggers an irreversible, multi-platform release build — confirm
with the human before doing it.

## Layout

- `src/` — React frontend (`src/lib/` for shared logic).
- `src-tauri/` — Rust backend; commands live under `src-tauri/src/commands/`.
- `.github/workflows/` — `ci.yaml` (checks) and `release.yaml` (releases).
- `scripts/`, `docs/`, `models/`, `public/` — supporting material.
