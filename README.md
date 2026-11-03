# Lumo

A local PDF reader that translates pages with a vision model. Each page image is read into Markdown (headings, paragraphs, formulas, tables, image placeholders), saved in SQLite, and restored when you reopen the page. If a PDF has no usable outline, Lumo can generate one with the same vision model and use it to select page ranges for batch translation.

English · [简体中文](README.zh-CN.md)

![Page translation demo: original PDF, streaming Markdown and saved Chinese translation](docs/assets/page-generation-demo.gif)

[Example PDF](docs/assets/page-generation-demo.pdf). The recording is sped up; figures show as placeholders.

## Quick start

Bun 1.4.2 or newer.

```bash
bun install
bun run dev
```

The terminal prints a URL containing an access code, for example `http://127.0.0.1:12345/?token=...`. The server listens on `127.0.0.1` only, so open that URL in a browser on the same machine. In **Settings**, pick a model that accepts image input, then add an API key or sign in with OAuth.

The first run downloads the pinned PDF.js viewer into `vendor/pdfjs/`; this needs `unzip`.

## Documentation

[docs/manual.md](docs/manual.md) covers [settings and credentials](docs/manual.md#settings), [reading and translation](docs/manual.md#reading-and-translation), the [standalone build](docs/manual.md#standalone-build) and [data and security](docs/manual.md#data-and-security).

Credentials are stored in plaintext on this machine; protect backups.

## Development

```bash
bun run typecheck
bun test
bun run build
```

Source layout and invariants: [AGENTS.md](AGENTS.md).
