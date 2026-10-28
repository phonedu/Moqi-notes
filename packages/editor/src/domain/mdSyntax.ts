/**
 * **Markdown 行引擎的唯一所有者**（`09-桌面端交互规范` §6.12 `R09-MD-3` 的那张行首表）——
 * **行内记号**那一半住在 `mdInline.ts`、**front-matter** 在 `mdFrontMatter.ts`、
 * **引用还原与媒体落地**在 `mdRefs.ts`（2026-10-10 随「Obsidian 互通」批各归各家，体量门也够了）。
 *
 * 四个方向都吃这里的行首表：
 * ① **导出**：行首记号要**转义**（`\- x`）——否则 `- 记着买牛奶` 这种正文会在目标工具里变成列表项（语义漂移）；
 * ② **粘贴 / 导入**：行首记号**转块**（`- ` → 项目列表），且把 `\-` 读回字面 `-`（往返无歧义）；
 * ③ **打字触发**（`editor/inputRules.ts`）：整行就是记号时当场转块；
 * ④ 将来的导入批：同一张表读回块树。
 *
 * 纪律（`R09-MD-1…4`）：只映射到**已有**块类型与行内格式；块级只认行首；**表里只写半角**
 * （打字侧判据把全角 / 中文标点归一成半角再比，见 `editor/inputRules.ts`；读回侧按原文，不归一）；
 * **不提供转义字符**（那是输入侧的规矩——打完触发词 ⌘Z 就回到纯文本）；表外的一律当普通字符。
 *
 * 读回来时另外认三件通用 / Obsidian 写法（2026-10-10 互通批）：
 * - **tab 缩进**（Obsidian 编辑器默认）：缩进按**列**算，tab 跳到下一个 4 的倍数——不然 `\t- 子项` 的层级会丢；
 * - **setext 标题**（CommonMark）：`===` / `---` 紧跟在一段文字下一行时是「标题 1 / 标题 2」，
 *   空行隔开时才按分隔线（导出侧写分隔线**前面保证空行**，所以自家往返不受影响）；
 * - **媒体引用的 Obsidian 形态** `![[图片.png]]` / `![[附件.csv]]`（`![[页面]]` 不是媒体，保持字面）。
 */
import type { BlockAsset, BlockType, ContentFragment } from './block'
import { inlineFragments, unescapeInline } from './mdInline'
import { splitFrontMatter, type FrontMatter } from './mdFrontMatter'

/** 一个行首记号：目标块类型 + 被吞掉的字符数（`- ` 是 2、`---` 是 3）。 */
export type BlockMarker = {
  type: BlockType
  /** 待办专用：`[x] ` 是已勾。 */
  checked?: boolean
  /** 触发词长度——粘贴时从行首剥掉这么多字符。 */
  length: number
  /** 围栏（```）要按「代码块」处理，粘贴时把后续行收进同一块，而不是只转这一行。 */
  handled?: 'fence'
}

/** 行首记号表（顺序有意义：`---` 要在 `- ` 之前判，`[x] ` 要在 `[ ] ` 之前判）。 */
const MARKERS: Array<{ pattern: RegExp; type: BlockType; checked?: boolean; handled?: 'fence' }> = [
  { pattern: /^```(?:[a-zA-Z0-9+-]*)\s*$/, type: 'code', handled: 'fence' },
  { pattern: /^---\s*$/, type: 'divider' },
  { pattern: /^###### /, type: 'heading6' },
  { pattern: /^##### /, type: 'heading5' },
  { pattern: /^#### /, type: 'heading4' },
  { pattern: /^### /, type: 'heading3' },
  { pattern: /^## /, type: 'heading2' },
  { pattern: /^# /, type: 'heading1' },
  { pattern: /^> /, type: 'quote' },
  { pattern: /^\[x\] /, type: 'todo', checked: true },
  { pattern: /^\[ \] /, type: 'todo' },
  // CommonMark 的待办是**列表项带勾选框**（`- [x] 做完的`）——导出侧正是这么写的（`- [${checked}]`），
  // 所以它必须排在通用列表记号前面；上面那两条裸 `[x] ` 保留（老粘贴写法 / 手写文档两种都认）。
  { pattern: /^[-*] \[x\] /, type: 'todo', checked: true },
  { pattern: /^[-*] \[ \] /, type: 'todo' },
  { pattern: /^[-*] /, type: 'bullet' },
  { pattern: /^\d+\. /, type: 'numbered' },
]

/**
 * 行首是不是一个「空记号」（整行就是触发词本身，或触发词后只剩空白）——**打字触发**的判据：
 * `R09-MD-2` 说打完触发词立即转换 ⇒ 只有整行等于记号时才动，句中（`5 - 3`、`2026-10-04`）永不误伤。
 */
export function blockMarkerOf(line: string): BlockMarker | null {
  for (const marker of MARKERS) {
    if (!marker.pattern.test(line)) continue
    const matched = (line.match(marker.pattern) as RegExpMatchArray)[0]
    return { type: marker.type, checked: marker.checked, length: matched.length, handled: marker.handled }
  }
  return null
}

/** 行首是不是「记号 + 正文」（粘贴 / 导入用）——返回记号与被剥掉之后的正文。 */
export function splitBlockMarker(line: string): { marker: BlockMarker; rest: string } | null {
  for (const marker of MARKERS) {
    if (marker.handled === 'fence') continue // 围栏在粘贴里单独处理（要收后续行）
    const matched = line.match(marker.pattern)
    if (!matched) continue
    return { marker: { type: marker.type, checked: marker.checked, length: matched[0].length }, rest: line.slice(matched[0].length) }
  }
  return null
}

/** 转义判据：只认**行首**的记号（句中不动），空记号也认（`-` 单独一行是「记号的空壳」，导出同样要防）。 */
function markerToEscape(line: string): BlockMarker | null {
  const direct = blockMarkerOf(line)
  if (direct) return direct
  const withText = splitBlockMarker(line)
  return withText ? withText.marker : null
}

/**
 * 导出用：行首记号前加 `\`，渲染出来的**文字**逐字不变、语义不漂（13-导出与媒体设计（已归档） §8）。
 * 只动行首；已经是 `\` 开头的不重复加；空行 / 表外字符原样返回。
 */
export function escapeLeadingMarker(line: string): string {
  if (line.startsWith('\\')) return line
  if (!markerToEscape(line)) return line
  return `\\${line}`
}

/**
 * 粘贴 / 导入用：把导出的转义读回字面（`\- x` → `- x`）。
 * 与 `escapeLeadingMarker` 成对——导出 → 导入的往返因此**没有歧义**。
 */
export function unescapeLeadingMarker(line: string): string {
  if (!line.startsWith('\\')) return line
  const candidate = line.slice(1)
  return markerToEscape(candidate) ? candidate : line
}

/** 粘贴 / 导入解析出来的草稿（还没有 entityId——那是插入时才分配的）。 */
export type OutlineDraft = {
  type: BlockType
  checked?: boolean
  /** 纯文本（没有行内记号时用它建一个文本片段）。 */
  text: string
  /** 行内成对记号切出来的片段（有记号时用它；没有则留空按 `text` 建）。 */
  content?: ContentFragment[]
  /**
   * **导入解析出来的图内引用**（`[名](名.md)`，导出侧把 `[[ ]]` / `(( ))` 降级成的形态）：
   * 片段与引用点要一起写，所以引用点单列在这儿——插入时按它补 `object-ref` / `block-ref` 操作
   * （只写片段不写引用点，反链面板就看不到这条引用）。粘贴那条路不产生这个字段。
   */
  refs?: Array<{ kind: 'object' | 'block'; targetId: string }>
  /** 媒体草稿（界面插入图片 / 附件时用）：payload 原样带上。 */
  asset?: BlockAsset
  /**
   * **导入时**的媒体引用（`![](assets/原名.png)` / `[原名.csv](assets/原名.csv)` / `![[原名.png]]`）：
   * 解析层只认「这是图还是附件、指向哪个相对路径」，**文件由导入流程去同目录的 `assets/` 找**
   * （找到才建媒体块；找不到退化成 `text` 草稿——文字不静默丢）。粘贴那条路不产生这个字段。
   */
  mediaRef?: { kind: 'image' | 'file'; href: string; label: string }
  children: OutlineDraft[]
}

const INDENT_UNIT = 2
/** tab 一跳到下一个 4 的倍数（CommonMark / Obsidian 的 tab 宽度；Logseq 也是 tab 缩进）。 */
const TAB_STOP = 4

/** 行首缩进的**列数**：tab 按 TAB_STOP 对齐，空格算 1 列——tab 与空格混写也能算对。 */
function indentColumns(prefix: string): number {
  let columns = 0
  for (const char of prefix) columns += char === '\t' ? TAB_STOP - (columns % TAB_STOP) : 1
  return columns
}

/** 按**列数**剥掉行首缩进（代码块正文用：围栏缩进几列，正文就剥几列）。 */
function stripColumns(line: string, columns: number): string {
  let removed = 0
  let index = 0
  while (index < line.length && removed < columns) {
    const char = line[index]
    if (char === '\t') { removed += TAB_STOP - (removed % TAB_STOP); index += 1 }
    else if (char === ' ') { removed += 1; index += 1 }
    else break
  }
  return line.slice(index)
}

/**
 * Markdown 文本 → 块草稿树（**粘贴即转换**的解析半边；导入批也吃它）。
 *
 * 形态（`R09-MD-3` 的表 + 导出侧同一套）：
 * - 行首记号 → 块类型；**每级 2 列缩进**（tab 按 4 列算） → 父子（与导出写的缩进对称，往返才对得上）；
 * - `\` 开头的行首记号**读回字面**（`unescapeLeadingMarker`）——导出 → 粘贴的往返无歧义；
 * - 围栏（```）把后续行收进同一个代码块，直到收尾围栏（**宽度 ≥ 开栏**）；
 * - setext 标题（`===` / `---` 紧跟段落下一行）；
 * - 表外文本 → `text` 块；空行跳过（不产生空块）。
 *
 * 返回 `null` = 这段文本**不该被当 Markdown 处理**（没有任何记号行）——调用方放行走默认粘贴。
 */
export function parseMarkdownOutline(text: string): OutlineDraft[] | null {
  return parseOutlineLines(text, true)
}

/**
 * 一份 Markdown 文档的解析结果（导入批的入口；13-导出与媒体设计（已归档） §「导入」）。
 *
 * - `name`：**第一个 `# ` 标题**就是页名（导出侧正是这么写的：front-matter 之后跟着 `# 页名`）；
 *   没有 `# ` 就用 front-matter 的 `title`；都没有则为 null（调用方决定退化成什么名）。
 *   **围栏里的 `# ` 不算**（2026-10-10 修：`# 注释` 这种代码行曾被当成页名、还从代码块里被摘掉）。
 * - `frontMatter.tags` / `properties` / `created` / `modified`：语法还原（键、原文、列表值、时间戳），
 *   类型由调用方按属性注册表去对——解析层不猜类型（导出侧的类型矩阵是那次设计的契约，件已归档，
 *   见 `docs/archive/` 的 13-导出与媒体设计）
 *   是导出侧的口径，导入按同一张表反解）。
 * - `roots`：正文草稿树，与粘贴共用一套引擎（行首记号 → 块、缩进 → 父子、`\+记号` 读回字面）。
 *
 * **与粘贴的区别只有一条**：粘贴遇到「整篇没有记号」的文本要放行走默认粘贴（返回 null），
 * 而文档解析**永远给一棵树**（纯段落文档也是一篇文档）。
 */
export function parseMarkdownDocument(text: string): {
  name: string | null
  frontMatter: FrontMatter
  roots: OutlineDraft[]
} {
  const { frontMatter, body } = splitFrontMatter(text)
  const lines = body
  let name: string | null = frontMatter.title
  // **第一处  标题**就是页名（我们的导出物里它紧跟在 front-matter 后面；别人写的文档里
  // 也可能先有一段引言再起标题）。**围栏里的不算**——代码注释里的 `# ` 既不是页名，
  // 更不能从代码块里被摘掉（2026-10-10 互通批修）。它从正文里摘掉，不再变 heading1 块。
  const firstIndex = firstHeadingLine(lines)
  if (firstIndex >= 0) {
    name = lines[firstIndex].trimStart().slice(2).trim() || name
    lines.splice(firstIndex, 1)
  }
  return { name, frontMatter, roots: parseOutlineLines(lines.join('\n'), false) ?? [] }
}

/** 第一处 `# ` 标题的行号；**跳过围栏内的行**（开栏 ``` / 收栏 ```，收栏宽度 ≥ 开栏）。 */
function firstHeadingLine(lines: string[]): number {
  let fence: number | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trimStart()
    const ticks = /^(`{3,})\s*[^`]*$/.exec(line)
    if (ticks) {
      const width = ticks[1].length
      if (fence === null) fence = width
      else if (width >= fence) fence = null
      continue
    }
    if (fence === null && /^# /.test(line)) return index
  }
  return -1
}

/** 一行的媒体引用：`![图注](assets/x.png)` / `[原名](assets/x.csv)` / Obsidian 的 `![[原名.png]]`。 */
function mediaRefOf(line: string): OutlineDraft['mediaRef'] | undefined {
  // 行内链接形态（图 / 附件共用一条正则）：标签允许 `\]` 转义、目标允许 `<>` 包裹（空格安全）。
  const link = /^(?<bang>!)?\[(?<label>(?:\\.|[^\]\\])*)\]\(\s*(?:<(?<angle>[^<>]+)>|(?<plain>[^)]+))\s*\)\s*$/.exec(line)
  if (link?.groups) {
    const href = (link.groups.angle ?? link.groups.plain ?? '').trim()
    const label = unescapeLinkLabel(link.groups.label)
    // 外部图片（`![alt](https://…)`）不是本地资产——留给「外部链接」那条路（`mdRefs.resolveExternalLinks`）。
    if (link.groups.bang) {
      if (isExternalHref(href)) return undefined
      // 行内形态的图片（`![图注](…)`）不要求扩展名：老导出物里有靠显示端判断的分支。
      return { kind: 'image', href, label }
    }
    if (!isFileHref(href)) return undefined
    return { kind: 'file', href, label: label || href.split('/').pop() || href }
  }
  // Obsidian 的嵌入形态：`![[原名.png]]`（宽度 `|300` / 别名两种后缀都见）。`![[页面]]` 没有扩展名 ⇒ 不是媒体。
  const embed = /^!\[\[(?<body>[^\]\n]+)\]\]\s*$/.exec(line)
  if (embed?.groups) {
    const body = embed.groups.body
    const at = body.indexOf('|')
    const target = (at >= 0 ? body.slice(0, at) : body).trim()
    const suffix = at >= 0 ? body.slice(at + 1).trim() : ''
    if (!isFileHref(target)) return undefined
    const basename = target.split('/').pop() ?? target
    // 后缀是纯数字时是**宽度**（`![[图.png|300]]`）——我们存尺寸的方式不同，忽略宽度、标签用文件名。
    const label = suffix.length > 0 && !/^\d+$/.test(suffix) ? suffix : basename
    return { kind: isImageName(target) ? 'image' : 'file', href: target, label }
  }
  return undefined
}

/** 链接标签的反解：`\[` → `[`、`\]` → `]`、`\\` → `\`（与导出侧的 `escapeLabel` 成对）。 */
function unescapeLinkLabel(label: string): string {
  return label.replace(/\\([\\[\]])/g, '$1')
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic'])

function isImageName(name: string): boolean {
  const clean = name.split(/[?#]/)[0]
  const dot = clean.lastIndexOf('.')
  return dot >= 0 && IMAGE_EXTENSIONS.has(clean.slice(dot + 1).toLowerCase())
}

/** 应用之外的目标（`http(s):` / `mailto:` / 协议相对 / `data:`）——不是本地资产。 */
function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')
}

/** 附件与页面链接的区别：附件是「带扩展名的普通文件」，页面链接是 `.md`（`[[ ]]` 的降级形态）。 */
function isFileHref(href: string): boolean {
  if (isExternalHref(href)) return false
  const clean = href.split(/[?#]/)[0]
  if (/\.md$/i.test(clean)) return false
  return /\.[a-z0-9]{1,8}$/i.test(clean)
}

/**
 * 行引擎（粘贴与导入**共用这一份**）：行首记号 → 块类型、每级 2 列缩进 → 父子、`\` 读回字面、围栏收行。
 * `requireMarker = true`（粘贴）：整篇没有一处记号就返回 null，调用方放行走默认粘贴。
 * `requireMarker = false`（导入）：永远给一棵树（纯段落文档也是一篇文档）。
 */
function parseOutlineLines(text: string, requireMarker: boolean): OutlineDraft[] | null {
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n')
  let markerSeen = false
  const roots: OutlineDraft[] = []
  const stack: Array<{ depth: number; draft: OutlineDraft }> = []
  /** 上一行产生的草稿与它的行号 / 层级——setext 标题判「紧邻上一行是段落」要用。
   * （装在小盒子里而不是裸 `let`：赋值发生在下面的闭包里，裸 `let` 的收窄在 TS 里会判成 `never`。） */
  const prevRef: { value: { draft: OutlineDraft; line: number; depth: number } | null } = { value: null }
  /** 上一行是不是引用行、属于哪个引用块（`line` = 行号、`indent` = 引用行以外的缩进、`depth` = 引用块自己的层级）
   * —— **连续引用行合成一个块**要用它（见循环里 `continuation` 那段）。用三个标量而不是对象：
   * 对象会让「本行类型依赖上一行类型、上一行类型依赖本行类型」的推断成环（TS 判 `any` / `never`）。 */
  let lastQuoteLine = -1
  let lastQuoteIndent = -1
  let lastQuoteDepth = 0

  const push = (depth: number, draft: OutlineDraft, line: number) => {
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop()
    const parent = stack[stack.length - 1]?.draft
    if (parent) parent.children.push(draft)
    else roots.push(draft)
    stack.push({ depth, draft })
    prevRef.value = { draft, line, depth }
  }
  /** setext 只把**段落**（正文 / 引用文字）升级成标题——列表 / 代码 / 媒体行不升级。 */
  const paragraphLike = (draft: OutlineDraft) =>
    (draft.type === 'text' || draft.type === 'quote') && draft.mediaRef === undefined && draft.asset === undefined

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index]
    if (line.trim().length === 0) continue
    const indentPrefix = /^[ \t]*/.exec(line)?.[0] ?? ''
    const indentCols = indentColumns(indentPrefix)
    const raw = line.slice(indentPrefix.length)
    // 导出写出的转义（`\- x`）**先认旗**：它是字面文本，不是记号——不然往返会把「带破折号的一句」读成列表
    const wasEscaped = unescapeLeadingMarker(raw) !== raw
    const body = wasEscaped ? raw.slice(1) : raw

    // 引用块（2026-10-10 往返修复，台账 D-047）：导出侧**每一行**（含子块、含空行）都带 `> ` 前缀，
    // 所以读回来先**剥前缀、再按普通行继续解析**：子块靠"前缀里的剩余缩进"落进引用块内部
    // （旧实现把 `>   - 子条目` 整行 trim 成 quote 的文字 ⇒ 子块变字面、层级丢）。
    let work = body
    let quoteSeen = false
    let quoteIndent = 0
    if (!wasEscaped) {
      while (/^>(?: |$)/.test(work)) {
        quoteSeen = true
        const rest = work.slice(1).replace(/^ /, '')
        quoteIndent += indentColumns(/^[ \t]*/.exec(rest)?.[0] ?? '')
        work = rest.trimStart()
      }
    }
    // **连续的引用行 = 同一个引用块**（2026-10-10 互通批，用户裁决"callout 降级成引用 ＋ 首行原文"的机制）：
    // 首行是块自己的文字（callout 的 `[!note] 标题` 就在这儿、原样保留），后续行落成**子块**。
    // 不这么合的话，导出时"块间空行"会把 `> [!note] 标题` 与它的正文拆成两段 ⇒ Obsidian 里成了
    // "一个 callout ＋ 一个孤立引用"（首行原文留住了、callout 的归属丢了）。同一引用块里的空行
    // （导出写成单独一个 `>`）不断组。
    const continuation: boolean = quoteSeen && lastQuoteLine === index - 1 && lastQuoteIndent === indentCols
    const ownDepth = Math.floor((indentCols + quoteIndent) / INDENT_UNIT)
    const lineDepth: number = continuation ? lastQuoteDepth + 1 + Math.floor(quoteIndent / INDENT_UNIT) : ownDepth
    if (quoteSeen) {
      lastQuoteLine = index
      lastQuoteIndent = indentCols
      if (!continuation) lastQuoteDepth = ownDepth
    } else {
      lastQuoteLine = -1
      lastQuoteIndent = -1
    }
    // 引用块里的空行（导出把块内空行写成单独一个 `>`）：不建块，跳过（但**不断组**，见上）。
    if (quoteSeen && work.length === 0) { markerSeen = true; continue }

    // setext 标题（CommonMark）：`===` / `---` **紧跟在段落下一行**时把上一行升级成标题 1 / 标题 2。
    // 空行隔开（导出侧写分隔线就是这样）⇒ 不满足「紧邻」，落回记号表里的分隔线。
    const prev = prevRef.value
    if (!wasEscaped && prev !== null && prev.line === index - 1 && prev.depth === lineDepth && paragraphLike(prev.draft)) {
      const underline = /^(=+|-+)\s*$/.exec(work)
      if (underline) {
        markerSeen = true
        prev.draft.type = underline[1].startsWith('=') ? 'heading1' : 'heading2'
        continue
      }
    }

    // 围栏：**宽度 ≥3、开闭同宽**（2026-10-10 往返修复，台账 D-046）。导出侧 `fenceFor` 会写 4+ 反引号
    // （正文里含 ``` 时），旧实现只认刚好三个 ⇒ 那种代码块读回来围栏行变普通行（里面的 `# ` 还会被当标题）。
    const fence = wasEscaped ? null : /^(`{3,})([a-zA-Z0-9+-]*)\s*$/.exec(work)
    if (fence) {
      markerSeen = true
      const closer = new RegExp('^\\s*`{' + fence[1].length + ',}\\s*$')
      const code: string[] = []
      index += 1
      while (index < rawLines.length && !closer.test(rawLines[index])) {
        code.push(stripColumns(rawLines[index], indentCols))
        index += 1
      }
      push(lineDepth, { type: 'code', text: code.join('\n'), children: [] }, index)
      continue
    }
    const hit = wasEscaped ? null : splitBlockMarker(work)
    if (hit) {
      markerSeen = true
      // `text` 是**反解过的字面**（与纯文字分支同口径，2026-10-08 统一）：`- \*字面\*` 这类
      // 「记号行 + 转义行内记号」粘回来不再漏反斜杠；行内记号切分照旧走原文（`inlineFragments`
      // 里面先认旗再切——转义的字面不会被读成格式）。
      const rest = hit.rest.trim()
      push(lineDepth, { type: hit.marker.type, checked: hit.marker.checked, text: unescapeInline(rest), content: inlineFragments(rest), children: [] }, index)
      continue
    }
    // 导入侧：整行就是一个媒体引用（`![](assets/x.png)` / `[原名](assets/x.csv)` / `![[原名.png]]`）——
    // 只认「像不像」，文件由导入流程去同目录的 `assets/` 找；粘贴那条路（requireMarker）不认它。
    const mediaRef = requireMarker ? undefined : mediaRefOf(work.trim())
    if (mediaRef) {
      markerSeen = true
      push(lineDepth, { type: mediaRef.kind === 'image' ? 'image' : 'file', text: mediaRef.label, mediaRef, children: [] }, index)
      continue
    }
    // 行尾空白（CommonMark 的硬换行标记 = 行尾两空格）不进正文：块内换行我们按行拆块，
    // 留着的空白只会在导出时被 trimEnd 悄悄丢掉。
    const plainLine = work.trimEnd().trim()
    // 剥掉引用前缀后**没有记号**的那一行：**引用块的首行**是块自己的文字（类型是 quote，
    // 导出侧把 `[!note] 标题` 这类原文就放在这里）；**同一引用块的后续行**是它内部的段落（类型是
    // text——落成子块，渲染成"引用里的下一段"，不是嵌套引用）。
    // `text` 是**字面**（反解过的）：没有成对记号时调用方直接拿它建文本片段；
    // `content` 走 `inlineFragments(work)`——那里先认旗再切，片段内部各自反解。
    push(lineDepth, { type: quoteSeen && !continuation ? 'quote' : 'text', text: unescapeInline(plainLine), content: inlineFragments(plainLine), children: [] }, index)
  }

  if (!markerSeen && requireMarker) return null
  return roots
}
