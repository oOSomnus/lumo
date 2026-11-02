# Lumo · PDF 阅读与逐页翻译

本地 PDF 阅读器。视觉模型读取每页图像后生成结构化 Markdown（标题、段落、公式、表格、图片占位），保存在本地 SQLite 中，重新打开可继续阅读。

AI 服务、模型、推理强度与凭证全部在页面内的“设置”中管理。界面语言支持 English 与简体中文；切换后重新加载页面。

[English](README.md) · 简体中文

## 主要能力

- **Markdown 与公式** — 标题、列表、表格和 GFM 正常渲染。行内公式使用 `$$...$$`，独立公式使用单独一行 `$$`，单个 `$` 保持为普通金额文本。
- **逐页与批量翻译** — 流式预览、已保存译文、保存后的“重新生成译文”，以及 Markdown 导出。
- **术语原文标注** — 专有名词与领域术语在每页首次出现时附准确原文，之后只使用一致译名。
- **按书保存阅读视图** — 缩放或适合模式、旋转、滚动方式与跨页方式在翻页、重新打开书籍、刷新页面和重启服务后保持。
- **模型与推理强度** — 设置按模型列出支持的推理强度；默认不覆盖模型自身行为。

详见：[设置](docs/manual.zh-CN.md#设置) · [阅读与翻译](docs/manual.zh-CN.md#阅读与翻译)。

## 快速开始

要求 Bun 1.4.2 或更新版本。

```bash
bun install
bun run dev
```

终端会打印带访问码的地址，例如 `http://127.0.0.1:12345/?token=...`。服务只监听 `127.0.0.1`，请从本机浏览器打开该地址。首次打开后点“设置”，选择支持图像输入的 provider 与模型，可选推理强度，再配置 API key 或 OAuth 登录。

首次运行或 PDF.js 版本变化时会下载官方 viewer 包并解压到 `vendor/pdfjs/`，之后直接复用；系统需安装 `unzip`。

## 文档

- [设置](docs/manual.zh-CN.md#设置) — provider、模型、推理强度、凭证与目标语言。
- [阅读与翻译](docs/manual.zh-CN.md#阅读与翻译) — Markdown 渲染、公式、逐页与批量翻译、重新生成。
- [单文件构建](docs/manual.zh-CN.md#单文件构建)
- [数据与安全](docs/manual.zh-CN.md#数据与安全)

AI 凭证在本机明文保存，备份时请妥善保护。

## 开发

```bash
bun run typecheck
bun test
bun run build
```

面向编码 Agent 的说明与源码级约束见 [AGENTS.md](AGENTS.md)。`bun run update:pi` 可更新 Pi 及其模型目录。
