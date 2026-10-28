/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Markdown 导出（设计全文 13-导出与媒体设计（已归档）；规则 `09-桌面端交互规范` §6.4 `R09-EXPORT-1…6`）。
 *
 * **纯函数**：吃 Block 图 + 元数据注册表 + 导出范围，吐「要写哪些文件、每条内容是什么」；
 * 落盘（`exports/<名>`、多页打 zip）交给 Rust 哑写（`src-tauri/src/export.rs`），**序列化不搬进 Rust**；
 * 界面只做接线与提示，**不拼字符串**（`R09-EXPORT-6`）。本模块是导出格式的唯一所有者。
 *
 * 钉死的口径（每条都有对应测试，`test:R09-EXPORT-*`）：
 * - **页名行**：页名在**容器块自身内容**上（`derivedObjectName`），文件第一行写 `# 页名`；
 *   容器的 `children` 照常逐一导出——首个子块是正文的一部分，不许吞掉。
 * - **范围**：只走未删除（`deleted === false`）。块的删除是级联的，所以这一条天然排除整棵子树；
 *   回收站里的页面整篇不进，指向它的引用按悬空处理（保留原文，不静默删）。
 * - **命名**：替换非法字符 → 截 60 字符 → 按**最终文件名**判重（` (2)`）；Windows 保留名加 `-`。
 * - **front-matter**：键唯一（保留键优先、其余 `原名（2）`）、类型化的转义写法（§5 的类型矩阵）。
 * - **引用落点**：块引用降级到目标页、零块 ID、锚文本取引用处显示文字、目标页导出时现算、悬空保留原文。
 */
import type { Block, BlockMap, ContentFragment, Mark, MetadataRegistry, PropertyDef, PropertyValue } from './block'
import { compareRootOrder } from './block'
import { derivedObjectName } from './operation'
import { escapeInlineMarkers } from './mdInline'
import { escapeLeadingMarker } from './mdSyntax'
import { RESERVED_PROPERTY_KEYS, resolveTagName } from './properties'
import { refLabel } from './refOps'

export type ExportScope = { kind: 'page'; pageId: string } | { kind: 'tag'; tagId: string } | { kind: 'all' }

export type ExportFile = { path: string; content: string }

export type ExportPlan = {
  /** `file` = 单页直接落一个 `.md`；`zip` = 多页打包（包内根平铺）。 */
  kind: 'file' | 'zip'
  /** 落盘文件名（已 sanitize + 按最终名去重；扩展名在内）。 */
  artifactName: string
  /** 要写的内容：单页时一条（`path === artifactName`）；zip 时包内相对路径。 */
  files: ExportFile[]
  /**
   * 要一起打包的资产（13-媒体设计（已归档） §7）：`from` = `assets/` 下的磁盘名、`to` = 包内路径
   * （`assets/<原名>`，重名走 `uniqueFileName`）。**缺文件的那些不进这里**——正文里降级成文件名文字。
   */
  assets: ExportAssetRef[]
  /** 被改名的 front-matter 键（保留键冲突 / 定义间重名），界面据此提示。 */
  renamedKeys: string[]
  pageCount: number
}

/** 资产搬运单：把 `assets/<磁盘名>` 复制成包内 `assets/<原名>`（Rust 哑复制，不解析内容）。 */
export type ExportAssetRef = { from: string; to: string }

export type ExportRequest = {
  /** `YYYY-MM-DD`（界面按本地时间算好传进来——时间来源只有一处）。 */
  today: string
  /** `assets/` 下**真实存在**的磁盘名（Rust 哑读）——缺文件的资产在正文里降级成文件名文字，不静默丢。 */
  existingAssets?: readonly string[]
  /** `exports/` 里已经存在的文件名（来自 Rust 的哑读；用于「不覆盖」的 ` (2)` 规则）。 */
  existingNames?: readonly string[]
}

/** 保留键：本设计自己的三个 ＋ Obsidian 的默认属性名与旧默认名——唯一所有者是 `domain/properties.ts`。 */
const RESERVED_KEYS = RESERVED_PROPERTY_KEYS
const ILLEGAL_NAME = /[\\/:*?"<>|]/g
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
/** 与 Windows 的 255 字节上限留出余量（中文按字算 + ` (2)` 后缀 + 扩展名）。 */
const MAX_NAME_CHARS = 60
const UNNAMED = '未命名页面'

/** 文件名净化：非法字符换 `-`、去尾部点与空格、Windows 保留名加后缀、截断。 */
export function sanitizeExportName(name: string): string {
  let out = name.trim().replace(ILLEGAL_NAME, '-').replace(/[. ]+$/, '')
  if (out.length === 0) out = UNNAMED
  if (WINDOWS_RESERVED.test(out)) out = `${out}-`
  return out.slice(0, MAX_NAME_CHARS)
}

/** 取一个没被占用的最终文件名：`名字.md` / `名字 (2).md`……（后缀在扩展名之前）。 */
export function uniqueFileName(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired
  const dot = desired.lastIndexOf('.')
  const base = dot > 0 ? desired.slice(0, dot) : desired
  const ext = dot > 0 ? desired.slice(dot) : ''
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base} (${index})${ext}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base} (${Date.now()})${ext}`
}

/** 本地时区的 ISO 串（`2026-10-06T09:31:00+08:00`）——front-matter 的 `created` / `modified`。 */
export function isoLocal(ms: number): string {
  const at = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  const offset = -at.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hours = pad(Math.floor(Math.abs(offset) / 60))
  const minutes = pad(Math.abs(offset) % 60)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}${sign}${hours}:${minutes}`
}

/** YAML 双引号标量：`"` → `\"`、`\` → `\\`、换行 → `\n`（空串照样引号化，不落成 YAML `null`）。 */
export function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r\n?|\n/g, '\\n')}"`
}

/**
 * 链接 / 引用标签的转义：先加倍原有 `\`，再挡方括号（`]` 会截断链接文字、`[` 会让方括号配不平），
 * 最后补**行内记号**的最小转义（`*x*` 这种看起来成对的要挡住，否则标签会在别的工具里被渲染成斜体）。
 */
function escapeLabel(text: string): string {
  return escapeInlineMarkers(text.replace(/\\/g, '\\\\').replace(/[[\]]/g, (char) => `\\${char}`))
}

/** 一段行内文本 → 导出文本：字面反斜杠先按 CommonMark 双写（读回 `\\` → `\`），再给「看起来成对」
 * 的记号加 `\`；**行内代码里的原样**（代码跨度不处理转义）。不双写的后果：正文里的 `\\<` / `\*`
 * 会被读回侧当转义吃掉一个反斜杠（2026-10-11 属性测试 `PROP-MD-1` 抓到；台账 `D-061`）。 */
function fragmentText(fragment: ContentFragment): string {
  const raw = fragment.v ?? ''
  const isCode = fragment.marks?.some((mark) => mark.type === 'code') ?? false
  return isCode ? raw : escapeInlineMarkers(raw.replace(/\\/g, '\\\\'))
}

/** 包住 `run` 个连续反引号所需的最小围栏（代码块与行内代码共用）。 */
function fenceFor(text: string, minimum: number): string {
  const runs = text.match(/`+/g) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(minimum, longest + 1))
}

type Ctx = {
  blocks: BlockMap
  registry: MetadataRegistry
  /** 导出范围内页面的**最终路径**（`pageId → 文件名`）；范围外的目标另算。 */
  paths: Map<string, string>
  /** 当前页的最终路径——本页内的块引用是自链接。 */
  selfPath: string
  renamed: string[]
  takenKeys: Set<string>
  /** 资产记账（整份导出共用）：包内目标名的去重表 + 已登记的搬运单。 */
  assetTaken: Set<string>
  assets: ExportAssetRef[]
  /** 磁盘上真实存在的资产名（缺的**不进包**，正文降级成文件名文字）。 */
  existingAssets: Set<string>
}

/** 资产显示名：显示与导出都用原名（磁盘名是不可读的随机名）。 */
function assetDisplayName(block: Block): string {
  return block.asset?.originalName ?? '（无文件名）'
}

/**
 * 包内相对路径 → Markdown 链接目标：含空格 / 括号 / 尖括号时**加 `<>`**（CommonMark 的正确写法；
 * 与 `R09-EXPORT-3` 对外链、`R09-EXPORT-4` 对页面链接同一条规矩——资产链接过去漏了它，
 * 文件名带空格时在严格解析器里是断链，2026-10-10 互通批补）。
 * 不编码成 `%20`：读回侧（`mdSyntax.mediaRefOf` 与各家工具）都直接认字面路径，编码反而多一层。
 */
function linkTarget(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path}>` : path
}

/**
 * 登记一块媒体的 payload：磁盘上有文件 → 记一条搬运单并返回包内相对路径；
 * 文件缺失（换机没同步 / 手动删）→ 返回 null，调用方把正文降级成文件名文字（§7 ③）。
 * 目标名 = 原名（净化 + **保扩展名**地去重）——同名的两张图走现成 `uniqueFileName` 的 ` (2)`。
 */
function registerAsset(block: Block, ctx: Ctx): string | null {
  const asset = block.asset
  if (!asset || !ctx.existingAssets.has(asset.fileName)) return null
  const dot = asset.originalName.lastIndexOf('.')
  const base = dot > 0 ? asset.originalName.slice(0, dot) : asset.originalName
  const ext = dot > 0 ? asset.originalName.slice(dot) : ''
  const name = uniqueFileName(`${sanitizeExportName(base)}${ext}`, ctx.assetTaken)
  ctx.assetTaken.add(name)
  if (!ctx.assets.some((item) => item.from === asset.fileName)) ctx.assets.push({ from: asset.fileName, to: `assets/${name}` })
  return `assets/${name}`
}

function liveChildren(block: Block, ctx: Ctx): Block[] {
  const out: Block[] = []
  for (const id of block.children) {
    const child = ctx.blocks.get(id)
    if (child && child.deleted === false) out.push(child)
  }
  return out
}

/** 引用目标所在**页**（沿 `parent` 走到根上的对象块）。 */
function rootPageOf(start: Block, ctx: Ctx): Block | null {
  let cursor: Block | undefined = start
  while (cursor) {
    if (cursor.isObject) return cursor
    cursor = cursor.parent ? ctx.blocks.get(cursor.parent) : undefined
  }
  return null
}

/**
 * 引用目标的链接路径：范围内 → 最终路径；范围外但活着 → 同一套净化规则单独算；
 * 目标缺失 / 已删 / 所在页在回收站 → `null`（调用方按悬空处理，保留原文）。
 */
function hrefFor(targetId: string, ctx: Ctx): string | null {
  const target = ctx.blocks.get(targetId)
  if (!target || target.deleted) return null
  const page = rootPageOf(target, ctx)
  if (!page || page.deleted) return null
  return ctx.paths.get(page.entityId) ?? `${sanitizeExportName(derivedObjectName(page))}.md`
}

/** 包裹行内标记（顺序钉死：内到外 = 下划线 / 高亮 / 删除线 / 斜体 / 加粗 / 代码）。`color` 不导出。 */
function applyMarks(text: string, marks: Mark[] | undefined): string {
  if (!marks || marks.length === 0) return text
  const has = (type: Mark['type']) => marks.some((mark) => mark.type === type)
  let out = text
  if (has('underline')) out = `<u>${out}</u>`
  if (has('highlight')) out = `==${out}==`
  if (has('strike')) out = `~~${out}~~`
  if (has('italic')) out = `*${out}*`
  if (has('bold')) out = `**${out}**`
  if (has('code')) {
    const fence = fenceFor(out, 1)
    out = fence.length > 1 ? `${fence} ${out} ${fence}` : `${fence}${out}${fence}`
  }
  return out
}

/** 一个行内片段 → Markdown：文本（带标记）/ 外部链接 / 图内引用（降级到页）/ 未知按正文。 */
function fragmentMarkdown(fragment: ContentFragment, ctx: Ctx): string {
  if (fragment.t === 'inline-ref' && fragment.ref) {
    const target = ctx.blocks.get(fragment.ref.targetId)
    const display = (fragment.v ?? '').trim() || (target ? refLabel(target) : '（空块）')
    const href = hrefFor(fragment.ref.targetId, ctx)
    if (!href) return fragment.ref.kind === 'block' ? `((${display}))` : `[[${display}]]`
    return `[${escapeLabel(display)}](<${href}>)`
  }
  if (fragment.t === 'link' && fragment.url) {
    const label = (fragment.v ?? '').trim() || fragment.url
    const needsAngle = /[\s()<>]/.test(fragment.url)
    return `[${escapeLabel(label)}](${needsAngle ? `<${fragment.url}>` : fragment.url})`
  }
  // `mention` 与任何将来的未知片段一律按正文出口（不丢字）
  return applyMarks(fragmentText(fragment), fragment.marks)
}

function blockInlineText(block: Block, ctx: Ctx): string {
  return block.content.map((fragment) => fragmentMarkdown(fragment, ctx)).join('')
}

/** 一个块（及其子树）→ 行数组。`level` = 嵌套层级（每级 2 空格）；`listNumber` = 编号列表的序号（0 起）。 */
function emitBlock(block: Block, level: number, listNumber: number, ctx: Ctx): string[] {
  // 未采用的 AI 块是草稿（指令 §6.14.2「草稿非内容」）：生成中 / 完成未接受 / 取消 / 错误一律不导出，整棵子树跳过；
  // 已采用（`accepted`）按承载类型正常导出，`aiMeta` 不落文件。
  if (block.aiMeta && block.aiMeta.status !== 'accepted') return []
  const indent = '  '.repeat(level)
  const text = blockInlineText(block, ctx)
  const children = liveChildren(block, ctx)
  const hasText = text.trim().length > 0
  // 分隔线天然没有正文、附件块 content **恒空**、空嵌入块 = 还没选来源——都不算「空块」
  // （空块 = 无正文**且**无子块、且不是分隔线 / 媒体块）。
  const contentless = block.type === 'divider' || block.type === 'image' || block.type === 'file' || block.type === 'embed'
  if (!hasText && children.length === 0 && !contentless) return []

  const own: string[] = []
  switch (block.type) {
    case 'divider':
      own.push('', `${indent}---`)
      break
    case 'code': {
      // **围栏里的一切都原样**：代码块正文不能走行内转义——`fragmentText` 的免转义守卫只认
      // 「行内代码标记」，而代码块的片段是普通文本 ⇒ 此前 `*a*` / `~x~` 这类"看起来成对"的记号
      // 会被转义成 `\*a\*` 写进围栏，导回来多出反斜杠（2026-10-11 属性测试 `PROP-MD-1` 抓到；
      // 台账 `D-059`）。围栏长度也按**原文**算（转义会改变反引号连续段的长度）。
      const raw = block.content.map((fragment) => fragment.v ?? '').join('')
      const fence = fenceFor(raw, 3)
      own.push(`${indent}${fence}`, ...raw.split('\n').map((line) => `${indent}${line}`), `${indent}${fence}`)
      break
    }
    case 'quote': {
      const inner = [`${indent}${text}`.trimEnd(), ...emitChildren(block, level + 1, ctx)]
      // 引用块每一行（含子块、含空行）都带前缀，否则嵌套内容会从引用里掉出来
      return inner.map((line) => (line.trim().length === 0 ? '>' : `> ${line}`))
    }
    case 'bullet':
      own.push(...markerLines(text, indent, '-'))
      break
    case 'numbered':
      own.push(...markerLines(text, indent, `${listNumber + 1}.`))
      break
    case 'todo':
      own.push(...markerLines(text, indent, `- [${block.checked ? 'x' : ' '}]`))
      break
    case 'heading1':
      own.push(...markerLines(text, indent, '#'))
      break
    case 'heading2':
      own.push(...markerLines(text, indent, '##'))
      break
    case 'heading3':
      own.push(...markerLines(text, indent, '###'))
      break
    case 'heading4':
      own.push(...markerLines(text, indent, '####'))
      break
    case 'heading5':
      own.push(...markerLines(text, indent, '#####'))
      break
    case 'heading6':
      own.push(...markerLines(text, indent, '######'))
      break
    case 'image': {
      // 图片（13-媒体设计（已归档） §7）：`![图注](assets/<原名>)`，图注作 alt；缺文件 → 文件名文字，不静默丢。
      // 图注与路径都过转义（`]` / 空格 / 括号——见 `escapeLabel` 与 `linkTarget`），否则图注里的 `]` 会截断链接。
      const ref = registerAsset(block, ctx)
      own.push(ref ? `${indent}![${escapeLabel(text)}](${linkTarget(ref)})` : `${indent}（图片缺失：${assetDisplayName(block)}）`)
      break
    }
    case 'file': {
      const ref = registerAsset(block, ctx)
      own.push(ref ? `${indent}[${escapeLabel(assetDisplayName(block))}](${linkTarget(ref)})` : `${indent}（附件缺失：${assetDisplayName(block)}）`)
      break
    }
    case 'embed': {
      // 嵌入块（13-媒体设计（已归档） §8）：**就地展开快照**——引用行 + 引用内容。
      // 快照照源块自身的形态发出（标题 / 列表 / 代码围栏 / 里面的图片都会照常注册资产），
      // 整段包进引用块里；源被删 → 一行文字说明，不静默丢。
      const embed = block.blockRefs.find((item) => item.type === 'embed')
      const target = embed ? ctx.blocks.get(embed.targetBlockId) : undefined
      if (target && !target.deleted) {
        const href = hrefFor(target.entityId, ctx)
        const label = target.isObject ? derivedObjectName(target) : refLabel(target)
        own.push(`${indent}> **嵌入自 ${href ? `[${escapeLabel(label)}](<${href}>)` : escapeLabel(label)}**`)
        const snapshot = emitBlock(target, level, 0, ctx)
        if (snapshot.length > 0) {
          own.push(`${indent}>`)
          for (const line of snapshot) own.push(line.trim().length === 0 ? `${indent}>` : `${indent}> ${line}`)
        }
      } else {
        own.push(`${indent}（嵌入来源已删除）`)
      }
      break
    }
    default:
      own.push(...contentLines(text, indent))
  }
  return [...own, ...emitChildren(block, level + 1, ctx)]
}

/**
 * 块自己的文字 → 行：**块内换行按行拆**（每行带缩进），行首记号按 `R09-MD-3` 那张表**转义**——
 * 否则「正文里写的一句 `- 记着买牛奶`」在目标工具里会变成列表项（字面不丢、语义漂移）。
 * 只有第一行带块的记号前缀，续行是同缩进的普通行。
 */
function contentLines(text: string, indent: string): string[] {
  return text.split('\n').map((line) => `${indent}${escapeLeadingMarker(line)}`.trimEnd())
}

/** 带记号前缀的块（列表 / 标题 / 待办）：记号只加在第一行，续行同缩进跟随。 */
function markerLines(text: string, indent: string, marker: string): string[] {
  const lines = contentLines(text, indent)
  const first = (lines[0] ?? indent).slice(indent.length)
  // 空正文的记号行**保留尾空格**（`2. ` / `- ` / `# `）：`trimEnd` 会把它吃成裸 `2.`，
  // 而解析侧的记号表要求「记号 + 空格」⇒ 自家导出的空列表项 / 空标题读不回来
  // （2026-10-11 属性测试 `PROP-MD-1` 抓到；台账 `D-062`）。
  return [first.length > 0 ? `${indent}${marker} ${first}`.trimEnd() : `${indent}${marker} `, ...lines.slice(1)]
}

/** 子块逐一输出：编号列表在同一父块下重新计数（渲染不依赖序号，人读要对）。 */
function emitChildren(block: Block, level: number, ctx: Ctx): string[] {
  const lines: string[] = []
  let numbered = 0
  for (const child of liveChildren(block, ctx)) {
    const at = child.type === 'numbered' ? numbered++ : 0
    lines.push(...emitBlock(child, level, at, ctx))
  }
  return lines
}

/** 页面正文：顶层块之间空行；把连续空行压成一个、去首尾空行。 */
function pageBody(page: Block, ctx: Ctx): string[] {
  const lines: string[] = []
  let numbered = 0
  for (const child of liveChildren(page, ctx)) {
    const at = child.type === 'numbered' ? numbered++ : 0
    const emitted = emitBlock(child, 0, at, ctx)
    if (emitted.length === 0) continue
    if (lines.length > 0) lines.push('')
    lines.push(...emitted)
  }
  const squeezed: string[] = []
  for (const line of lines) {
    if (line === '' && squeezed[squeezed.length - 1] === '') continue
    squeezed.push(line)
  }
  while (squeezed.length > 0 && squeezed[squeezed.length - 1] === '') squeezed.pop()
  return squeezed
}

function renderPropertyValue(value: PropertyValue, def: PropertyDef | undefined): string | null {
  switch (value.type) {
    case 'checkbox':
      return value.value ? 'true' : 'false'
    case 'number':
      return Number.isFinite(value.value) ? String(value.value) : null
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value.value) ? value.value : yamlQuote(value.value)
    case 'select': {
      const label = def?.options?.find((option) => option.id === value.optionId)?.label ?? value.optionId
      return yamlQuote(label)
    }
    default:
      return yamlQuote(value.value)
  }
}

function uniqueKey(name: string, ctx: Ctx): string {
  const base = name.trim() || name
  let candidate = base
  let index = 2
  while (ctx.takenKeys.has(candidate.toLocaleLowerCase())) {
    candidate = `${base}（${index}）`
    index += 1
  }
  if (candidate !== base) ctx.renamed.push(`${base} → ${candidate}`)
  ctx.takenKeys.add(candidate.toLocaleLowerCase())
  return candidate
}

/** front-matter（无属性无标签则整块省略，`R09-EXPORT-6`）。 */
function frontMatterLines(page: Block, ctx: Ctx): string[] {
  ctx.takenKeys = new Set(RESERVED_KEYS.map((key) => key.toLocaleLowerCase()))
  const lines: string[] = []
  const tags: string[] = []
  for (const tagId of page.tags) {
    const name = resolveTagName(tagId, ctx.registry)
    if (!tags.includes(name)) tags.push(name)
  }
  if (tags.length > 0) lines.push(`tags: [${tags.map((name) => yamlQuote(name)).join(', ')}]`)
  for (const value of page.properties) {
    const def = ctx.registry.properties.find((item) => item.id === value.defId)
    const rendered = renderPropertyValue(value, def)
    if (rendered === null) continue
    lines.push(`${yamlQuote(uniqueKey(def?.name ?? value.defId, ctx))}: ${rendered}`)
  }
  if (lines.length === 0) return []
  return ['---', ...lines, `created: ${isoLocal(page.created)}`, `modified: ${isoLocal(page.modified)}`, '---', '']
}

/** 一个页面 → 文件内容：front-matter（可选）+ `# 页名` + 正文。 */
function pageMarkdown(page: Block, ctx: Ctx): string {
  const head = [`# ${derivedObjectName(page)}`]
  const body = pageBody(page, ctx)
  return [...frontMatterLines(page, ctx), ...head, ...(body.length > 0 ? ['', ...body] : []), ''].join('\n')
}

function pagesInScope(blocks: BlockMap, scope: ExportScope): Block[] {
  const pages = [...blocks.values()]
    .filter((block) => block.isObject && !block.deleted)
    .sort(compareRootOrder)
  if (scope.kind === 'all') return pages
  if (scope.kind === 'page') return pages.filter((page) => page.entityId === scope.pageId)
  return pages.filter((page) => page.tags.includes(scope.tagId))
}

/**
 * 算一份导出计划。返回 `null` = 这个范围里没有可导出的页面（界面据此提示，不写空文件）。
 */
export function planMarkdownExport(
  blocks: BlockMap,
  registry: MetadataRegistry,
  scope: ExportScope,
  request: ExportRequest,
): ExportPlan | null {
  const pages = pagesInScope(blocks, scope)
  if (pages.length === 0) return null

  const taken = new Set<string>(request.existingNames ?? [])
  const paths = new Map<string, string>()
  for (const page of pages) {
    const finalName = uniqueFileName(`${sanitizeExportName(derivedObjectName(page))}.md`, taken)
    taken.add(finalName)
    paths.set(page.entityId, finalName)
  }

  const renamed: string[] = []
  // 资产记账**整份导出共用**（同一张图被多页引用只搬一次、重名去重跨页生效）
  const assets: ExportAssetRef[] = []
  const assetCtx = { assetTaken: new Set<string>(), assets, existingAssets: new Set(request.existingAssets ?? []) }
  const files = pages.map((page) => ({
    path: paths.get(page.entityId) as string,
    content: pageMarkdown(page, {
      blocks,
      registry,
      paths,
      selfPath: paths.get(page.entityId) as string,
      renamed,
      takenKeys: new Set<string>(),
      ...assetCtx,
    }),
  }))

  if (scope.kind === 'page') {
    return { kind: 'file', artifactName: files[0].path, files, assets, renamedKeys: renamed, pageCount: 1 }
  }
  const tagName = scope.kind === 'tag' ? sanitizeExportName(resolveTagName(scope.tagId, registry)) : null
  const desired = tagName === null
    ? `墨契-导出-${request.today}.zip`
    : `墨契-导出-${tagName}-${request.today}.zip`
  return {
    kind: 'zip',
    artifactName: uniqueFileName(desired, new Set(request.existingNames ?? [])),
    files,
    assets,
    renamedKeys: renamed,
    pageCount: pages.length,
  }
}
