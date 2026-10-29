# 墨契 Moqi

<p align="center">
  <img src="docs/screenshots/desktop-library-light.png" alt="墨契桌面端" width="720">
</p>

**要双链、又要手机上能用——现在没人同时给你。**

墨契是一个**本地优先**的大纲双链笔记：所有内容都是「块」，页面就是块树，页面之间用 `[[双链]]` 相连。数据是你自己机器上的**单文件 SQLite**，随时导出成标准 Markdown 带走。无账号、无遥测、无服务器。

- **桌面**（Windows）与 **Android**：一套交互，两种形态——桌面写的，手机真能用
- **编辑器内核**独立成包（`@moqi/editor`）：宿主契约 + 完整触控交互层，可以带走复用
- 许可证：应用 **AGPL-3.0-or-later** · 编辑器包 **MPL-2.0** · 文档 **CC BY-SA 4.0**

## 它适合谁

**适合你，如果：**

- 你喜欢 Obsidian / Logseq 式的双链和大纲，但被「**手机上不好用**」劝退了——墨契的手机端是完整的日用形态：左滑多选、拖拽排序、键盘上方格式栏、系统分享与文件选择器
- 你在意**数据主权**：本地 SQLite 单文件、标准 Markdown 导出、无账号无云端，隐私和迁移都不用求人
- 你是**中文用户**：检索支持拼音（多音字按词库判断，「银行」和「行走」都能命中）、全角标点自动归一、界面为中文排版打磨
- 你想要 **AI 在本地笔记里干活**（自带 key，OpenAI 兼容接口，也支持 Ollama 这类本地模型）：总结、提取行动、有来源的问答——答案带出处，不动你的原文

**暂时不适合你，如果：**

- 需要**多人协作**或团队空间（没有账号体系）
- 需要**官方托管的云同步**（同步 = 自己指定一个本地目录，可放云盘同步盘）
- 期待 **Notion 型的数据库视图、表格编辑、LaTeX 渲染**（部分在路线图上渐进，部分明确不做）
- 依赖**插件生态**（墨契不做插件 API）

## 功能一览

**编辑（块化大纲）**

- 无限层级缩进；块类型：正文 / 标题（六级）/ 待办 / 引用 / 代码块 / 分割线 / 图片 / 附件 / 嵌入
- 拖拽排序、多选批量操作（缩进 / 转待办 / 移动 / 复制 / 删除）、块引用与复制为引用
- 输入即转换：`- `、`[ ] `、`> `、` ``` ` 等记号直接成形；全角标点自动归一
- 撤销 / 重做全链路；折叠子树；代码块内换行与缩进

**双链与发现**

- `[[` 自动补全候选（含建议：已引用 / 同标签 / 同源子树）
- 反向链接面板与引用预览；链接跳跃与定位闪烁

**检索（中文一等公民）**

- 全局搜索 ⌘K：中文子串 + **拼音**（`yinhang`、`yh` 都能命中「银行」，多音字按词库）
- 页面库筛选：标签 / 属性 / 时间范围 / 反链数量组合过滤；页内查找

**AI 助手（可选，自带 key）**

- 七条指令：总结 / 提取行动 / 反问我 / 润色 / 扩写 / 换角度 / **有来源问答**（回答带出处，可一键落为块）
- 生成流式输出、可中断；未采用的输出整块不导出

**数据**

- 图片（粘贴 / 拖入 / 相册）、附件、嵌入块（把别的页面内嵌进来）
- 自动快照（每日 / 每周保留）＋ 一键整库导出 `.zip` ＋ Markdown 导出（属性写 front-matter，图片随包）
- 主题 20 套（明暗两态）＋ 正文字号 / 行高 / 列宽三轴可调

**同步**

- 本地目录上的**块级合并**同步（目录可放云盘同步盘实现多机 / 云端），Android 与桌面同构

<p align="center">
  <img src="docs/screenshots/desktop-editor-dark.png" alt="桌面编辑器（深色）" width="560">
</p>

## 界面速览

<table>
  <tr>
    <td><img src="docs/screenshots/desktop-library-light.png" alt="桌面 · 页面库与编辑区（浅色）" width="420"></td>
    <td><img src="docs/screenshots/desktop-editor-dark.png" alt="桌面 · 编辑器（深色）" width="420"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/mobile-home.png" alt="手机 · 首页页面库" width="220"></td>
    <td><img src="docs/screenshots/mobile-edit.png" alt="手机 · 编辑" width="220"></td>
  </tr>
</table>

## 核心概念（只有五个）

| 概念 | 一句话 |
|---|---|
| **块 Block** | 一行内容，可无限缩进成大纲 |
| **页面 Page** | 一棵块树；页面名 = 正文第一行 |
| **双链 Wiki link** | `[[页面名]]` 连接页面 |
| **属性 Property** | 页面级键值，全局定义 |
| **标签 Tag** | 页面级分类 |

新能力必须复用这五个概念，不引入第六个——这是墨契「易上手」的边界。

## 快速开始

### 下载现成包

安装包与 Android APK 在 [GitHub Releases](https://github.com/phonedu/Moqi-notes/releases)（随发布挂出，当前挂 `v0.6.1`）。

### 从源码构建

```bash
# Node 22 / pnpm 9 / Rust stable（Android 构建另需 SDK + NDK）
pnpm install
pnpm -C app dev              # 浏览器预览（最快看到界面）
pnpm -C app check            # 全部门禁：主题 / CSS / 字阶 / 类型检查 / 508 项测试 / 覆盖率
pnpm -C app tauri dev        # Windows 桌面窗口
pnpm -C app tauri android build --debug -t aarch64 --apk   # Android debug 包
```

CI 在每次 push 时跑同样的门禁（[.github/workflows/ci.yml](.github/workflows/ci.yml)）。

## 数据在哪、怎么带走

本地 SQLite 单文件 + assets 目录，见 [docs/DATA](docs/DATA.md)。

- **自动快照**：每日 / 每周保留策略，本地同盘
- **整库导出**：`.zip`（库 + 图片附件），换机器从备份包恢复
- **Markdown 导出**：单页 / 按标签 / 全量；属性写 YAML front-matter；图片随包

## 从其他工具迁来

支持 Obsidian / 幕布 / 通用 Markdown 导入（拖入即建页，zip 批量）。逐项保真边界表（什么保留、什么降级、什么丢失）见 [docs/MIGRATION](docs/MIGRATION.md)。

## 已知限制（诚实清单）

- **同步**：块级合并可靠，但合并结果目前不弹提示；被覆盖版本仅当次会话可撤销
- **导入保真**：表格逐行降级、公式落文本、代码块语言不保留（[docs/MIGRATION](docs/MIGRATION.md) 边界表）
- **换机器**：整库 zip 会带走设备身份，导入前必读 [docs/DATA](docs/DATA.md)
- **Android 包**：当前为 debug 构建（未签名 release 流程在发布计划中）
- Windows 构建未签名（SmartScreen 会提示，见 [docs/SECURITY](docs/SECURITY.md)）

以上缺口与修复方向都登记在 [ROADMAP](docs/ROADMAP.md)。

## 文档

[功能与概念](docs/FEATURES.md) · [上手指南](docs/USER-GUIDE.md) · [数据与备份](docs/DATA.md) · [迁移](docs/MIGRATION.md) · [架构](docs/ARCHITECTURE.md) · [路线图](docs/ROADMAP.md) · [AI 提示词](docs/PROMPTS.md) · [FAQ](docs/FAQ.md) · [安全](docs/SECURITY.md) · [贡献](CONTRIBUTING.md) · [更新日志](CHANGELOG.md)

## 参与贡献

PR 欢迎但可能被拒——先开 Issue 讨论。提交请带 `Signed-off-by`（DCO）；法律面（再许可授权）与工程面（构建 / 测试 / 门禁）见 [CONTRIBUTING](CONTRIBUTING.md)。功能请求请先读 [ROADMAP](docs/ROADMAP.md) 的「不做」清单。

## 维护模式

**修 bug 与安全问题；功能冻结；不承诺路线图。** 墨契首先服务于维护者自己的每日使用——它坏了自己第一个知道。

## 许可

应用 [AGPL-3.0-or-later](app/LICENSE) · 编辑器包 [MPL-2.0](packages/editor/LICENSE) · 文档与设计资产 [CC BY-SA 4.0](LICENSE-DOCS) · 「墨契 / Moqi」名称与 Logo 见 [TRADEMARK](TRADEMARK.md)
