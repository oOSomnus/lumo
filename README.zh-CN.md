<h1 align="center"><img src="docs/assets/lumo-readme.png" alt="Lumo" width="640"></h1>

本地 PDF / EPUB 阅读器，用视觉模型翻译每一页：PDF 的一页，或 EPUB 屏幕上正在显示的那一页。每次请求还会附带相邻页的简短摘录以保持上下文连贯，摘录只作参考，不会被翻译或保存。每页译文会生成为独立 Typst 文档（标题、列表、表格、公式、图形、保留的图片或明确的占位说明），在模型能看清时保留原文的分栏、表格结构、颜色和粗斜体，保存在本地 SQLite 中并在应用内渲染。无法通过本地编译的文档会自动发回模型修正，一轮接一轮，直到编译通过或你取消（可能产生费用），页面面板会显示最近五轮的诊断与改动的行。PDF 没有可用目录时，Lumo 可以用同一视觉模型生成目录，并按目录选择批量翻译的页码范围；EPUB 提供由自身目录生成的目录面板，以及字号、字体、行距和主题的阅读设置。

[English](README.md) · 简体中文

![Lumo 把教材中的一页从英文翻译为简体中文：Typst 源码流式生成，随后在原页旁显示已保存的预览](docs/assets/page-generation-demo.gif)

录制使用当前版本，模型为 OpenAI GPT-6.1 Sol（推理强度 low），把一页从英文翻译为简体中文。Typst 源码随模型输出流式显示；随后 Lumo 校验、保存，并显示编译后的预览。生成阶段按 2–3 倍速播放，因此动图不代表真实耗时（这次从点击到出现预览约 26 秒）。[示例 PDF](docs/assets/page-generation-demo.pdf) 即录制所用的页面。

该页是 [*Introductory Statistics*](https://openstax.org/details/books/introductory-statistics) 第 248 页，作者 Barbara Illowsky、Susan Dean（OpenStax，© 2018 Rice University），采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可，不在本项目 MIT 许可范围内。示例为单页摘录，并新增了署名页脚；译文由 Lumo 调用 GPT-6.1 Sol 生成，未获作者或 OpenStax 认可。

## 快速开始

### Linux x64 下载

从 [v0.3.0 Release](https://github.com/oOSomnus/lumo/releases/tag/v0.3.0) 下载 `lumo-v0.3.0-linux-x64.tar.gz` 和 `SHA256SUMS`，然后运行：

```bash
sha256sum --check SHA256SUMS
tar -xzf lumo-v0.3.0-linux-x64.tar.gz
cd lumo-v0.3.0-linux-x64
./lumo
```

可执行文件已内置 Bun、PDF.js、epub.js 和 Typst 运行时，无需单独安装。

### 从源码运行

要求 Bun 1.4.2 或更新版本。

```bash
bun install
bun run dev
```

终端会打印带访问码的地址，例如 `http://127.0.0.1:12345/?token=...`。服务只监听 `127.0.0.1`，请在同一台机器的浏览器中打开该地址。在“设置”中（第一次点击“翻译”时会自动为你打开）选择支持图像输入的模型，再配置 API key 或 OAuth 登录。

首次运行会把固定版本的 PDF.js viewer 下载到 `vendor/pdfjs/`，并在 `vendor/typst/` 准备 Typst 运行时与字体，需要系统安装 `unzip`。epub.js 与 JSZip 从 `node_modules` 复制。

PDF 和 EPUB 文件的总大小不设应用层上限；大文件仍受可用内存和磁盘空间限制。EPUB 包最多包含 20,000 个条目，其 container 与包（OPF）XML 文件各自最多 2,097,152 个字符（按 JavaScript 字符串长度计数，不是字节数）。

Lumo 启动后先显示书架：PDF 使用首页作为封面，EPUB 使用生成的封面卡片。选择书籍会恢复上次的 PDF 页码或 EPUB 阅读位置与视图；顶栏的“书库”可返回书架，当前会话不会结束。

用窗格上方的按钮可以把两栏排成仅左侧、仅右侧、均分，或任一侧 60/40；左右方向键可在阅读器的任何位置翻页。Typst 源码在流式生成时、源码视图中和修复片段里都带语法高亮。触屏提供 44 px 的点按目标，窄 viewer 中还有“阅读工具”菜单。详见[手册](docs/manual.zh-CN.md#阅读与翻译)。

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

## 许可证

[MIT](LICENSE) © 2026 Yihang Zhu。内置的第三方组件保留各自的许可证，Release 压缩包附带其许可声明。
