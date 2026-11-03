# Lumo 使用手册

[README](../README.zh-CN.md) · [English](manual.md)

## 设置

- **界面语言** — English 或简体中文。应用后页面会重新加载。界面语言与翻译目标语言相互独立。
- **Provider 与模型** — 只列出支持图像输入的模型。可用“刷新模型”从 provider 获取最新列表。
- **推理强度** — 可选。默认不覆盖 provider 与模型自身的行为。可选等级来自所选模型：`minimal`、`low`、`medium`、`high`，模型支持时还有 `xhigh` 和 `max`。不支持推理的模型没有可选项。自定义 OpenAI-compatible endpoint 提供 `minimal` 到 `high`，但 endpoint 是否真正接受该设置只能由它自己决定；Lumo 不会为此发起付费探测。
- **Custom OpenAI-compatible** — 填写 endpoint、context window 和 max tokens。本地 endpoint 可以不使用 API key。
- **凭证** — 保存 API key，或完成 provider 的 OAuth 登录。移除凭证只在本地退出，不会在 provider 侧撤销。
- **Amazon Bedrock 与 Google Vertex** — 在应用内填写 API key（Bedrock bearer token 或 Google Cloud API key）。不提供 AWS profile、默认凭证链、Application Default Credentials、外部凭证文件或凭证链登录。
- **目标语言** — 译文语言与界面语言独立：简体中文、繁體中文、English、日本語、한국어、Deutsch、Français、Español。

设置保存在本地数据库中。Shell 中导出的 provider 密钥不会用于配置 provider。修改模型或推理强度不会自动改写已保存译文；需要重新生成页面才会应用新设置。每次翻译请求在开始时固定当时的 provider、模型与推理强度。打开或保存设置不会发起付费请求。

## 阅读与翻译

- PDF.js 官方 viewer 负责渲染、目录、缩略图、文本选择、表单、批注与原生工具栏。当前缩放或适合模式、旋转、滚动方式和跨页方式属于当前书籍：翻页时保持不变，重新打开书籍、刷新页面或重启服务后仍会恢复。
- 专有名词与领域术语在每页首次出现时以括号附准确原文，例如 `费用（Expenses）`；同页再次出现只使用译名。识别效果取决于所选模型，已保存译文在重新生成前保持原有措辞。
- 译文 Markdown 支持标题、段落、列表、表格、GFM 与公式。行内公式使用 `$$...$$`，独立公式使用单独一行 `$$`；单个 `$` 是普通文本，因此 `$5` 等金额会照常显示。按旧 `$...$` 语法保存的公式会显示为字面量，直到重新生成该页。
- **当前页译文** — 翻译、流式预览，或把本页导出为 Markdown。页面已有译文后，主按钮变为“重新生成译文”；确认后会使用当前设置再次调用 AI。旧译文继续可读，只有新译文保存成功后才被替换。
- **批量翻译** — 按页码表达式或快捷按钮选页；最多 3 页并行。支持停止、重试失败、重新生成已保存页。
- **按目录选择** — PDF 没有可用目录时，批量面板可以用当前视觉模型生成目录。它会逐页发送页面图像和文字，调用次数等于页数，可能产生费用。生成的目录保存在 `reader.sqlite`，再次打开文档时复用；不会修改 PDF 字节，也不会写入 PDF.js 侧栏。勾选章或节会把其完整物理页范围加入同一个选页集合。父章节包括全部子章节；同页开始的章节可能重叠；翻译仍以完整 PDF 页为单位。生成目录是需要核对的推断结果，翻译前请先检查。PDF 有可用原生目录时会直接显示原生目录。
- 译文持久化到 SQLite；再次打开同一页优先显示已保存结果。所有译文可导出为 Markdown。
- 修改表单或批注后，“保存修改副本”会生成新文档并保留原件；有未保存修改时会阻止产生新译文。

## 单文件构建

```bash
bun run build
LUMO_DATA_DIR=/absolute/path ./dist/lumo
```

构建产物内嵌 Bun、服务端、前端和 PDF.js；运行时不需要 `node_modules`、`vendor/` 或 Bun。

## 数据与安全

默认数据目录为 `${XDG_DATA_HOME:-~/.local/share}/lumo`。启动时可用 `LUMO_DATA_DIR` 指定绝对路径：

```bash
LUMO_DATA_DIR=/absolute/path/to/lumo-data bun run dev
```

| 文件 | 内容 |
| --- | --- |
| `reader.sqlite` | PDF 原始字节、书库、阅读进度与每本书的阅读视图、生成的目录、界面语言、AI 配置和全部译文。 |
| `ai-credentials.sqlite` | API key / OAuth 凭证。 |

- 目录权限 `0700`；两个数据库文件权限均为 `0600`。
- AI 凭证在本机明文存储，未加密；不会通过 API 返回，也不会写进日志。备份前请按需保护。
- 多个实例可以共用同一数据目录：各自取得不同端口，写入通过 SQLite 事务串行化，同一条记录以最后提交为准；界面不会实时同步其他窗口。
- 备份前先关闭所有使用该目录的实例；WAL 文件（`reader.sqlite-wal`、`-shm`）是数据库的一部分，不要只复制主文件。
- 删除书库条目会同时删除该 PDF 的全部译文。退出登录只删除本地凭证，不会在 provider 侧撤销；旧备份仍可能包含该凭证。
- 应用只接受当前存储格式。较旧或不受支持的数据库会在启动时被拒绝，原文件保持不变。
- 页面只由本机 `127.0.0.1` 提供；访问码在启动时随机生成，只出现在终端打印的 URL 和 API 的 Bearer 头中。API 校验 Host、Origin、`Sec-Fetch-Site` 和 Bearer token，并拒绝跨源预检、跨站写请求和压缩请求体。
- PDF 中的链接/表单不执行页面脚本；译文渲染禁用原始 HTML 与远程图片。除配置的 AI endpoint 外，应用不向其他第三方发送数据；登录时浏览器直连 provider 的授权页面。

[返回 README](../README.zh-CN.md)
