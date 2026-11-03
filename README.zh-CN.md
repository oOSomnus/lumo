# Lumo

本地 PDF 阅读器，用视觉模型翻译每一页。页面图像会被读取为 Markdown（标题、段落、公式、表格、图片占位），保存在本地 SQLite 中，重新打开该页时恢复。PDF 没有可用目录时，Lumo 可以用同一视觉模型生成目录，并按目录选择批量翻译的页码范围。

[English](README.md) · 简体中文

![页面生成演示：原始 PDF、流式 Markdown 与已保存的中文译文](docs/assets/page-generation-demo.gif)

[示例 PDF](docs/assets/page-generation-demo.pdf)。动图已加速播放，译文中的图片以占位说明呈现。

## 快速开始

要求 Bun 1.4.2 或更新版本。

```bash
bun install
bun run dev
```

终端会打印带访问码的地址，例如 `http://127.0.0.1:12345/?token=...`。服务只监听 `127.0.0.1`，请在同一台机器的浏览器中打开该地址。首次打开后在“设置”中选择支持图像输入的模型，再配置 API key 或 OAuth 登录。

首次运行会把固定版本的 PDF.js viewer 下载到 `vendor/pdfjs/`，需要系统安装 `unzip`。

## 文档

[docs/manual.zh-CN.md](docs/manual.zh-CN.md) 涵盖[设置与凭证](docs/manual.zh-CN.md#设置)、[阅读与翻译](docs/manual.zh-CN.md#阅读与翻译)、[单文件构建](docs/manual.zh-CN.md#单文件构建)和[数据与安全](docs/manual.zh-CN.md#数据与安全)。

AI 凭证在本机明文保存，备份时请妥善保护。

## 开发

```bash
bun run typecheck
bun test
bun run build
```

源码结构与约束见 [AGENTS.md](AGENTS.md)。
