<h1 align="center"><img src="docs/assets/lumo-readme.png" alt="Lumo" width="640"></h1>

A local PDF and EPUB reader that translates pages with a vision model. Each translated page becomes a standalone Typst document, saved and rendered in the app; one that does not compile locally goes back to the model until it does. Reading runs on your computer and opens in your browser. [How translation works](docs/manual.md#overview)

English · [简体中文](README.zh-CN.md)

![Lumo translating a textbook page from English to Simplified Chinese: Typst source streams in, then the saved preview appears beside the original page](docs/assets/page-generation-demo.gif)

Demo page: p. 248 of [*Introductory Statistics*](https://openstax.org/details/books/introductory-statistics) (OpenStax, CC BY 4.0). Recording and translation notes are in the [manual](docs/manual.md#overview).

## Install

Download the file for your system from the [latest release](https://github.com/oOSomnus/lumo/releases/latest), check it against `SHA256SUMS`, and install it. Nothing else is needed: Bun, PDF.js, epub.js and the Typst runtime are inside, and the Windows installer carries the WebView2 runtime.

| System | Download | Requires |
| --- | --- | --- |
| Windows x64 | `lumo-v<version>-windows-x64-setup.exe` | Windows 10 1809 or newer |
| Windows ARM64 | `lumo-v<version>-windows-arm64-setup.exe` | Windows 11 |
| macOS Intel / Apple silicon | `lumo-v<version>-macos-x64.dmg` / `lumo-v<version>-macos-arm64.dmg` | macOS 13 or newer |
| Linux x64 / ARM64 | `lumo-v<version>-linux-<arch>.deb`, `.rpm` or `.AppImage` | A desktop session, a default web browser and WebKitGTK 4.1 (Ubuntu 22.04, Debian 12 or newer) |

Per-system steps and what to do when the system warns about an unsigned build: [docs/manual.md#install](docs/manual.md#install). Windows, macOS and AppImage builds check the signed release feed at startup and daily; a download starts only when you choose **Download update**, and installation only after **Restart and install**. deb and rpm builds open the release download page. [docs/manual.md#desktop-app-and-standalone-server](docs/manual.md#desktop-app-and-standalone-server)

## Run from source

Bun 1.4.2 or newer. The desktop window additionally needs Rust 1.90 or newer and the [Tauri system prerequisites](https://tauri.app/start/prerequisites/).

```bash
bun install
bun run dev          # builds the server and opens the desktop window
bun run dev:server   # server only; no Rust needed
```

`bun run dev:server` prints a URL containing an access code, for example `http://127.0.0.1:12345/?token=...`. The server listens on `127.0.0.1` only, so open that URL in a browser on the same machine. In **Settings** (the first **Translate** press opens it for you), pick a model that accepts image input, then add an API key or sign in with OAuth. First-run downloads and other build details: [docs/manual.md#build-from-source](docs/manual.md#build-from-source).

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
```

`bun run build --target <triple>` builds another architecture of the same OS; `bun run build:server` builds only the standalone server in `dist/sidecar/`. CI builds all six targets (Windows, macOS, Linux × x64, ARM64) on native runners, and a `v*` tag drafts a release; see `.github/workflows/`.

A release build with in-app updates needs `LUMO_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in its environment. A partial set fails the build. The private key and password are build secrets; never commit them or expose them to the launcher panel.

Source layout and invariants: [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © 2026 Yihang Zhu. Bundled third-party components retain their own licenses; the installers and the release assets include `LICENSE` and `THIRD_PARTY_NOTICES.txt`.
