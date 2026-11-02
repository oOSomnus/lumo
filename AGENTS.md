# Lumo agent notes

Personal project. Make clean cutovers: change current behavior, update every caller, and delete replaced code, aliases, shims and dead getters. Storage accepts the current schema only; older databases are rejected untouched, never migrated, reset or rewritten. Keep source mode and the standalone build behaviorally aligned.

## Invariants

- Login is app-managed API key or OAuth only. Never add environment, profile, ADC, credential-file or credential-chain fallbacks, and keep `bunfig.toml` `env = false`. Provider secrets belong in `ai-credentials.sqlite`.
- Preserve the local request gate and secret boundaries: `127.0.0.1` only, access code in the printed URL only, credentials never returned or logged, OAuth semaphore released before a new login writes.
- Multi-statement SQLite mutations stay in immediate transactions; a single statement does not need one. Credential deletion/login must cancel and await the previous login before writing.
- Save flows: validate a copy before `done`/saved state, keep cancellation and attempt guards, retain unsaved drafts, and never mark newer edits saved after an in-flight save.
- PDF worker ownership: PDF.js transfers `data.buffer` it receives. Retain bytes needed for upload before handing a buffer to validation/rendering; never mutate viewer-owned buffers.
- UI locale is independent of target languages. A locale switch waits for persisted reader progress and must not reload while translations, drafts, edits or saves are active.

## Where to look

- Auth, credentials, login: `src/server/{ai-settings,ai-credentials,ai-auth}.ts` and their tests.
- Streaming, queue, wire contracts: `src/shared/contracts.ts`, `src/server/translate.ts`, `src/client/{api,translation-queue}.ts` and their tests.
- PDF bridge, pinned viewer, fetch/build scripts: `src/client/{pdf,pdfBridge}.ts`, `vendor/pdfjs/`, `scripts/`. Pi is updated with `bun run update:pi`.
- Commands: `bun run typecheck`, `bun test`, `bun run build` — see [README.md](README.md#development).

Run the focused test for a changed area, then `bun test` and `bun run typecheck` before handoff. Document user-visible behavior in the README and its Chinese edition; keep protocol and schema details in source.
