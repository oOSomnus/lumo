<h1 align="center"><img src="docs/assets/lumo-readme.png" alt="Lumo" width="640"></h1>

A local PDF and EPUB reader that translates pages with a vision model. Each translated page becomes a standalone Typst document, saved and rendered in the app; one that does not compile locally goes back to the model until it does. Translations of a PDF can be exported as one PDF, alone or after each original page. Reading runs on your computer and opens in your browser, with a searchable library and a light, dark, sepia or night theme. [How translation works](docs/manual.md#overview)

English · [简体中文](README.zh-CN.md)

![Lumo in the Sepia (warm paper) theme: a textbook page is opened from the library and translated from English to Simplified Chinese; Typst source streams in, then the saved preview appears beside the original page and is read on its own at 150% and in immersive reading](docs/assets/page-generation-demo.gif)

The translation shown is the one GPT-6.1 Sol produced for this page. For the recording, a local stand-in server replays it, so no AI service was called and the generation is sped up; the animation shows no real latency.

The page is p. 248 of [*Introductory Statistics*](https://openstax.org/details/books/introductory-statistics) by Barbara Illowsky and Susan Dean (OpenStax, © 2018 Rice University), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and not covered by this project's MIT license: a [single-page excerpt](docs/assets/page-generation-demo.pdf) with an added attribution footer. The translation is not endorsed by the authors or OpenStax.

## Install

Download the file for your system from the [latest release](https://github.com/oOSomnus/lumo/releases/latest), check it against `SHA256SUMS`, and install it. Nothing else is needed: Bun, PDF.js, epub.js and the Typst runtime are inside, and the Windows installer carries the WebView2 runtime.

| System | Download | Requires |
| --- | --- | --- |
| Windows x64 | `lumo-v<version>-windows-x64-setup.exe` | Windows 10 1809 or newer |
| Windows ARM64 | `lumo-v<version>-windows-arm64-setup.exe` | Windows 11 |
| macOS Intel / Apple silicon | `lumo-v<version>-macos-x64.dmg` / `lumo-v<version>-macos-arm64.dmg` | macOS 13 or newer |
| Linux x64 / ARM64 | `lumo-v<version>-linux-<arch>.deb`, `.rpm` or `.AppImage` | A desktop session, a default web browser and WebKitGTK 4.1 (Ubuntu 22.04, Debian 12 or newer) |

Per-system steps, updates, and what to do when the system warns about an unsigned build: [docs/manual.md#install](docs/manual.md#install).

## Run from source

Bun 1.4.2 or newer. The desktop window additionally needs Rust 1.90 or newer and the [Tauri system prerequisites](https://tauri.app/start/prerequisites/).

```bash
bun install
bun run dev          # builds the server and opens the desktop window
bun run dev:server   # server only; no Rust needed
```

`bun run dev:server` prints a URL containing an access code, for example `http://127.0.0.1:12345/?token=...`. The server listens on `127.0.0.1` only, so open that URL in a browser on the same machine. In **Settings** (the first **Translate** press opens it for you), pick a model that accepts image input, then add an API key or sign in with OAuth. What the first run downloads: [docs/manual.md#build-from-source](docs/manual.md#build-from-source). A library from the previous version of Lumo has to be upgraded once: [docs/manual.md#data-and-security](docs/manual.md#data-and-security).

## Documentation

[docs/manual.md](docs/manual.md) covers [install](docs/manual.md#install), [settings and credentials](docs/manual.md#settings), [reading and translation](docs/manual.md#reading-and-translation), the [desktop app and standalone server](docs/manual.md#desktop-app-and-standalone-server), [building from source](docs/manual.md#build-from-source) and [data and security](docs/manual.md#data-and-security).

Credentials are stored in plaintext on this machine; protect backups.

## Development

```bash
bun run typecheck
bun test
bun run build                                   # installer for this machine, in src-tauri/target/<triple>/release/bundle/
cargo test --locked --manifest-path src-tauri/Cargo.toml   # after a build
bun scripts/smoke-desktop.ts                    # runs the built server the way the window does
bun run test:e2e -- --project=source            # Playwright end-to-end tests
```

`bun run build --target <triple>` builds another architecture of the same OS; `bun run build:server` builds only the standalone server in `dist/sidecar/`. The end-to-end tests need Node and `bunx playwright install chromium`; `--project=standalone` runs them against the server from `bun run build:server`. Pull requests and pushes to `main` run, on Linux, the typecheck, the unit tests, the standalone server's smoke test, and the library and EPUB end-to-end tests in both projects. A `v*` tag builds all six targets (Windows, macOS, Linux × x64, ARM64) on native runners and drafts a release; the Desktop builds workflow can also be run by hand for an unsigned build of all six. See `.github/workflows/`.

A release build with in-app updates needs `LUMO_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in its environment. Windows and macOS code signing take their own sets, listed in `scripts/signing.ts`. A partial set fails the build. Private keys, certificates and passwords are build secrets; never commit them or expose them to the launcher panel.

Source layout and invariants: [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © 2026 Yihang Zhu. Bundled third-party components retain their own licenses; the installers and the release assets include `LICENSE` and `THIRD_PARTY_NOTICES.txt`.
