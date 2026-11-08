# Lumo agent notes

Personal project. Make clean cutovers: change current behavior, update every caller, and delete replaced code, aliases, shims and dead getters. Storage accepts the current schema only; older databases are rejected untouched, never migrated, reset or rewritten. Keep source mode and the standalone build behaviorally aligned.

## Invariants

- Login is app-managed API key or OAuth only. Never add environment, profile, ADC, credential-file or credential-chain fallbacks, and keep `bunfig.toml` `env = false`. Provider secrets belong in `ai-credentials.sqlite`.
- Preserve the local request gate and secret boundaries: `127.0.0.1` only, access code in the printed URL only, credentials never returned or logged, OAuth semaphore released before a new login writes.
- Multi-statement SQLite mutations stay in immediate transactions; a single statement does not need one. Credential deletion/login must cancel and await the previous login before writing.
- Save flows: validate a copy before `done`/saved state, keep cancellation and attempt guards, retain unsaved drafts, and never mark newer edits saved after an in-flight save.
- PDF worker ownership: PDF.js transfers `data.buffer` it receives. Retain bytes needed for upload before handing a buffer to validation/rendering; never mutate viewer-owned buffers.
- EPUB text preparation lives in the sandboxed `epub-viewer` iframe; image bytes must come from `book.archive`, never from HTML fetch. The iframe bundle takes no zod or `contracts.ts` at runtime (share limits through `src/shared/limits.ts`) and is built by `bun run prepare:typst`, so rebuild it after editing any module it imports. Typst compiles and renders locally with `vendor/typst/` assets; saved sources must remain valid without network access.
- UI locale is independent of target languages. A locale switch waits for persisted reader progress and must not reload while translations, drafts, edits or saves are active.
- Desktop: the Tauri launcher (`src-tauri/`) owns one `lumo-server --desktop` child and talks to it over stdio only (`src/shared/desktop.ts`). The launcher panel never receives the access code; Rust opens and copies the full link. Every exit path goes through the graceful shutdown (stdin command or EOF), which cancels in-flight work and closes both databases before exiting. Signing credentials exist only in build env (`scripts/signing.ts`); a partial set fails the build, and a release never claims more signing than the build had.

## Where to look

- Auth, credentials, login: `src/server/{ai-settings,ai-credentials,ai-auth}.ts` and their tests.
- Streaming, queue, wire contracts: `src/shared/contracts.ts`, `src/server/translate.ts`, `src/client/{api,translation-queue}.ts` and their tests.
- PDF bridge, pinned viewer, fetch/build scripts: `src/client/{pdf,pdfBridge}.ts`, `vendor/pdfjs/`, `scripts/`. Pi is updated with `bun run update:pi`.
- EPUB and Typst: `src/server/epub.ts`, `src/shared/{epub,limits,typst}.ts`; the iframe `src/client/{epub-viewer,epub-content,epub-image,epub-page,epub-style,epub-toc,epub-js}.ts` and its protocol `src/client/{epub-protocol,epub-bridge,epub-bridge-client}.ts`; the reader side `src/client/{epub-batch,toc,translation-input,typst,typst-worker}.ts`; `scripts/prepare-typst.ts`, `vendor/typst/`.
- Desktop app: launcher `src-tauri/src/{launcher,lib}.rs`, panel `src/desktop/` and its `launcher` strings in `src/client/locales/`, sidecar side `src/server/{index,desktop}.ts`; build and release `scripts/{desktop,build,targets,signing,licenses,release,smoke-desktop}.ts`, `.github/workflows/`.
- Commands: `bun run typecheck`, `bun test`, `bun run build` (desktop installer), `bun run build:server` (sidecar only), `cargo test --locked --manifest-path src-tauri/Cargo.toml` after a build, `bun scripts/smoke-desktop.ts` — see [README.md](README.md#development).

Run the focused test for a changed area, then `bun test` and `bun run typecheck` before handoff. Document user-visible behavior in the README and its Chinese edition; keep protocol and schema details in source.
