/**
 * Markdown 导出端口（13-导出与媒体设计（已归档） §7；规则 `09-桌面端交互规范` §6.4 `R09-EXPORT-5`）。
 *
 * **边界**：序列化在域层纯函数（`domain/exportMd.ts`）——端口只负责两件事，且都不参与起名与拼串：
 * ① **哑读** `exports/` 里已有的文件名（给「不覆盖」的 ` (2)` 用）；② 把算好的内容落盘（单文件 / zip）。
 *
 * 两条通路如实上报能力：
 * - 桌面 / Android：走 Rust 命令（`src-tauri/src/export.rs`，zip 在那边打）；
 * - 浏览器预览：**没有「写进数据目录」这回事** ⇒ `capabilities.writeFiles = false`，界面据此禁用并说明原因。
 */
export type MarkdownExportFile = { path: string; content: string }

/** 资产搬运单（与 Rust `ExportAssetIn` 对齐：`from` = `assets/` 磁盘名、`to` = 包内 `assets/<原名>`）。 */
export type MarkdownExportAsset = { from: string; to: string }

/** 要写的东西：形态 + 落盘名（域层已 sanitize 与去重）+ 内容 + 资产搬运单。 */
export type MarkdownExportWrite = {
  kind: 'file' | 'zip'
  artifactName: string
  files: MarkdownExportFile[]
  /** 媒体资产：缺文件的那些域层已排除（正文降级成文件名文字），端口照单搬运（Rust 侧复制 / 入包）。 */
  assets: MarkdownExportAsset[]
  /** 落点（绝对路径）：给了 = 「另存为 / 存到文件夹」（`T-18`）；缺省 = 数据目录的 `exports/`。 */
  targetPath?: string
}

/**
 * 领域层的导出计划 → 落盘入参。**做成纯函数就是为了这个字段有单测看住**：此前调用点在这里
 * 丢掉了 `plan.assets`，桌面端导出的 `.md` / `.zip` 永远不带图（2026-10-11 审计，
 * `EXPORT-ASSET-1`）。Rust 侧一直有搬运能力（`export.rs` 的 `assets`），是前端不喂它。
 */
export function exportWriteOf(plan: {
  kind: 'file' | 'zip'
  artifactName: string
  files: MarkdownExportFile[]
  assets: MarkdownExportAsset[]
}): MarkdownExportWrite {
  return { kind: plan.kind, artifactName: plan.artifactName, files: plan.files, assets: plan.assets }
}

/** 落点：绝对路径 + 大小 + 写进包里的条目数（界面要显示路径，用户才找得到）。 */
export type MarkdownExportResult = { path: string; sizeBytes: number; entries: number }

export interface ExportPort {
  /** 能力如实上报：界面按它决定按钮能不能点、并说明原因（不许装作能用）。 */
  capabilities: { writeFiles: boolean }
  /** `exports/` 里已有的文件名（目录不存在 = 空表）。 */
  listNames(): Promise<string[]>
  /** 落点：不给 = `<数据目录>/exports/`；给了**绝对路径** = 「另存为 / 存到文件夹」（`T-18`）。 */
  write(plan: MarkdownExportWrite, targetPath?: string): Promise<MarkdownExportResult>
  /**
   * 读一个**文本文件**（**导入**那条路：拖入给的是路径，正文要读进来解析）。与 `write` 对偶——
   * 导出把内容写出去、导入把文件读进来，两个方向算在「与本机文件打交道」这一条哑端口的账上。
   * 桌面走 Rust 命令（只放行 `.md` / `.markdown` / `.txt`、上限 8 MB）；浏览器通道没有这条
   * （那边的拖入给的是字节，直接 `File.text()`，见 `ui/EditorShell` 的导入处理器）。
   */
  readTextFile(path: string): Promise<string>
  /**
   * 读一个**导入包**（`.zip`）的条目（第 13 项「拖入 zip」）：逐条 `{ name, base64 }`——
   * 「哪些条目能导」不在这里判（`domain/mdPackage.ts` 是唯一判据）；单条目 > 8 MB 已在
   * 这一层跳过并计入 `skipped`。浏览器通道没有本机路径（拖入给字节，`fflate` 就地解）。
   */
  readPackageEntries(path: string): Promise<{ entries: { name: string; base64: string }[]; skipped: number }>
  /**
   * 列一个**目录**下的 Markdown 文件（设置页「选择文件夹」，`T-18`）：递归、只收 `.md` / `.markdown`、
   * 按路径排序、上限 500 篇。**图片不在这一层读**——每篇连同它的 `dir` 交给既有的导入函数，
   * 相对名的图由那条分支去找（只喂路径，不另开第二条通路）。浏览器通道没有本机目录，返回空数组。
   */
  listMarkdownFiles(dir: string): Promise<string[]>
}
