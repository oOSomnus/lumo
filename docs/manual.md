# Lumo manual

[README](../README.md) · [简体中文](manual.zh-CN.md)

## Settings

- **Interface language** — English or Simplified Chinese. Applying it reloads the page. The interface language is independent of the translation target language.
- **Provider and model** — only models that accept images are listed. Refresh the model list from the provider with **Refresh models**.
- **Reasoning effort** — optional. The default leaves the provider and model behavior unchanged. The listed levels come from the selected model: `minimal`, `low`, `medium`, `high`, and, when the model supports them, `xhigh` and `max`. A model without reasoning support has no selectable level. Custom OpenAI-compatible endpoints offer `minimal` through `high`, but the endpoint must accept the setting; Lumo cannot verify that without a paid request.
- **Custom OpenAI-compatible** — enter the endpoint, context window and max tokens. A local endpoint may run without an API key.
- **Credentials** — store an API key or complete the provider's OAuth sign-in. Removing a credential signs out locally only; it does not revoke the token at the provider.
- **Amazon Bedrock and Google Vertex** — enter an API key (Bedrock bearer token or Google Cloud API key) in the app. AWS profiles, the default credential chain, Application Default Credentials, external credential files and credential-chain login are not offered.
- **Target language** — the translation language is separate from the interface language: Simplified Chinese, Traditional Chinese, English, Japanese, Korean, German, French or Spanish.

Settings are stored in the local database. Provider secrets exported in the shell are never used to configure a provider. Changing the model or reasoning effort does not rewrite saved translations; regenerate a page to apply the new choice. Each translation request pins the provider, model and effort active when it starts. Saving or opening Settings never sends a paid request.

## Reading and translation

- Lumo opens on a bookshelf: each book shows a cover rendered from its first page, its title, current page and last-read time. Selecting a book resumes its saved page and reading view. **Library** in the top bar returns to the shelf without ending the session, so running translations, drafts and unsaved edits are kept.
- The official PDF.js viewer handles rendering, outlines, thumbnails, text selection, forms, annotations and the native toolbar. The active zoom or fit mode, rotation, scroll mode and spread mode belong to the open book: turning pages keeps them, and reopening the book, reloading the page or restarting the server restores them.
- Specialised terms and proper nouns are glossed with the source spelling the first time they appear on each page, for example `费用（Expenses）`; later occurrences use the translation alone. Recognition depends on the selected model, and saved translations keep their original wording until regenerated.
- Translation Markdown supports headings, paragraphs, lists, tables, GFM and formulas. Inline math uses `$$...$$`, display math uses its own `$$` lines, and a single `$` is ordinary text so currency such as `$5` stays readable. Formulas saved with the old `$...$` syntax appear literally until the page is regenerated.
- **Current page translation** — translate, follow the streaming preview, or export the page as Markdown. Once a page has a saved translation, the main button becomes **Regenerate translation**; it asks for confirmation and calls the AI service with the current settings. The previous translation stays readable and is only replaced after the new one is saved.
- **Batch translation** — select pages by page expression or shortcut buttons; up to three pages run in parallel. Stop, retry failures, or regenerate saved pages.
- **Outline selection** — when the PDF has no usable outline, the Batch panel can generate one with the configured vision model. It sends each page image and text, one page at a time, so the call count equals the page count and may incur charges. The generated outline is saved in `reader.sqlite` and reused when you reopen the document; it does not modify the PDF bytes or the PDF.js sidebar. Tick a chapter or section to add its whole physical page range to the same selection. Parent sections include their children, and sections that start on the same page may overlap; translation still uses whole PDF pages. Treat the generated headings as a suggestion and verify them before translating. A PDF with a usable native outline shows that outline instead.
- Translations are persisted to SQLite; reopening the same page prefers the saved result. All translations can be exported as Markdown.
- If you edit forms or annotations, **Save edited copy** stores a new document and keeps the original. While modifications are unsaved, new translations are blocked.

## Standalone build

```bash
bun run build
LUMO_DATA_DIR=/absolute/path ./dist/lumo
```

The binary embeds Bun, the server, the client and PDF.js. It runs without `node_modules`, `vendor/` or Bun installed.

## Data and security

The default data directory is `${XDG_DATA_HOME:-~/.local/share}/lumo`. Set `LUMO_DATA_DIR` to an absolute path at launch:

```bash
LUMO_DATA_DIR=/absolute/path/to/lumo-data bun run dev
```

| File | Contents |
| --- | --- |
| `reader.sqlite` | PDF bytes, library, reading progress and per-book reading view, generated outlines, interface language, AI configuration and all translations. |
| `ai-credentials.sqlite` | API keys and OAuth credentials. |

- The directory is created with mode `0700`; both database files use mode `0600`.
- AI credentials are stored in plaintext on this machine and are not encrypted. They are never returned by the API or written to logs. Protect backups accordingly.
- Several instances may share one data directory: each takes a different port, writes are serialized by SQLite transactions, and the last commit wins for a given record. Open windows do not sync in real time.
- Close every instance before backing up the directory. WAL files (`reader.sqlite-wal`, `-shm`) are part of the database; do not copy only the main file.
- Deleting a library entry also deletes all of its translations. Signing out removes the local credential only; older backups may still contain it.
- The app uses the current storage format only. An older or unsupported database is rejected on launch and left untouched.
- The page is served only from `127.0.0.1`; the access code is generated at startup and appears only in the printed URL and API Bearer headers. The API validates Host, Origin, `Sec-Fetch-Site` and the Bearer token, and rejects cross-origin preflights, cross-site writes and compressed request bodies.
- PDF links and forms do not execute page scripts. Translation rendering disables raw HTML and remote images. Apart from the configured AI endpoint, the app sends data to no third party; OAuth sign-in connects the browser directly to the provider's authorization page.

[Back to README](../README.md)
