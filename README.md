# Lumo · PDF reading and page-by-page translation

A local PDF reader. A vision model reads each page image and produces structured Markdown (headings, paragraphs, formulas, tables, image placeholders) that is stored in local SQLite and restored when you reopen the page.

AI providers, models, reasoning effort and credentials are managed entirely in the in-app **Settings**. The interface is available in English and Simplified Chinese; switching the interface language reloads the page.

English · [简体中文](README.zh-CN.md)

## What you get

- **Markdown and formulas** — headings, lists, tables and GFM render normally. Inline math uses `$$...$$`, display math uses its own `$$` lines, and a single `$` stays ordinary currency text.
- **Page and batch translation** — streaming preview, saved translations, **Regenerate translation** after a page is saved, and Markdown export.
- **Terminology in context** — a specialised term or proper noun is glossed with its source spelling on first use on each page, then continues as the plain translation.
- **Per-book reading view** — zoom or fit mode, rotation, scroll mode and spread mode survive page turns, reopening the book, reloads and server restarts.
- **Model and reasoning effort** — Settings lists the effort levels each model supports; the default leaves the model's behavior unchanged.

Details: [Settings](docs/manual.md#settings) · [Reading and translation](docs/manual.md#reading-and-translation).

## Quick start

Requires Bun 1.4.2 or newer.

```bash
bun install
bun run dev
```

The terminal prints a URL containing an access code, for example `http://127.0.0.1:12345/?token=...`. The server listens on `127.0.0.1` only; open that URL in a browser on the same machine. On first use, open **Settings**, choose a provider and a model that accepts image input, optionally choose a reasoning effort, then add an API key or sign in through OAuth.

The first run, or a change to the pinned PDF.js version, downloads and extracts the official viewer into `vendor/pdfjs/`; later runs reuse it. `unzip` must be installed.

## Documentation

- [Settings](docs/manual.md#settings) — providers, models, reasoning effort, credentials and target language.
- [Reading and translation](docs/manual.md#reading-and-translation) — Markdown rendering, formulas, current-page and batch translation, regeneration.
- [Standalone build](docs/manual.md#standalone-build)
- [Data and security](docs/manual.md#data-and-security)

AI credentials are stored in plaintext on this machine; protect backups accordingly.

## Development

```bash
bun run typecheck
bun test
bun run build
```

Coding-agent instructions and source-level invariants live in [AGENTS.md](AGENTS.md). `bun run update:pi` updates Pi and its model catalog.
