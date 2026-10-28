/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * **引用的读回半边**（`\`……` 的两个语法族 + 媒体引用的落地）—— 随「Obsidian 互通」批
 * 从 `mdSyntax.ts` 拆册（体量门 + 名实归位：行引擎与引用还原各是一个知识）。
 *
 * 两个族（同一台切跨度的机 `spliceDraftRefs`）：
 * ① **导出物的降级形态** `[名](<目标.md>)`（`R09-EXPORT-4` 把 `[[ ]]` 降级成的样子）；
 * ② **原文语法** `[[页名]]` / `((块名))`（=「复制为块引用」写出的 `refToken` 形态）与 Obsidian 的
 *    `[[页名|别名]]` / `[[路径/页名]]`（`![[ ]]` 是块级形态，在 `mdSyntax.mediaRefOf` 里认）。
 *
 * 三条纪律（与导出侧成对，`R09-MD-7` 的「往返无歧义」）：
 * - **认得出就还原**（片段 + 引用点一起写，反链照常上账）；**认不出保持字面**（不凭空造页）；
 * - **代码是字面**：围栏块与带 `code` mark 的片段不扫；
 * - **在最终片段流上还原**，从原始整行文字重建会把行内记号（marks）丢掉。
 */
import type { BlockAsset, ContentFragment } from './block'
import type { OutlineDraft } from './mdSyntax'

/** 引用跨度 → 片段的**同一台机**（两条语法表共用；`place` 返回字符串 = 保持字面）。 */
function marksEqual(left: ContentFragment['marks'], right: ContentFragment['marks']): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
}

function spliceDraftRefs<S extends object>(
  draft: OutlineDraft,
  scan: (value: string) => Array<{ text: string } | S>,
  place: (span: S) => ContentFragment | string,
): { content: ContentFragment[]; touched: boolean } | null {
  if (draft.mediaRef || draft.type === 'code') return null
  const source = draft.content ?? [{ t: 'text', v: draft.text }]
  const pieces: ContentFragment[] = []
  let touched = false
  for (const fragment of source) {
    if (fragment.t !== 'text') { pieces.push(fragment); continue }
    if (fragment.marks?.some((mark) => mark.type === 'code')) { pieces.push({ ...fragment }); continue }
    for (const span of scan(fragment.v)) {
      if ('text' in span) {
        if (span.text.length > 0) pieces.push(fragment.marks ? { t: 'text', v: span.text, marks: fragment.marks } : { t: 'text', v: span.text })
        continue
      }
      const placed = place(span)
      if (typeof placed === 'string') pieces.push(fragment.marks ? { t: 'text', v: placed, marks: fragment.marks } : { t: 'text', v: placed })
      else { touched = true; pieces.push(placed) }
    }
  }
  if (!touched) return null
  // 相邻的**同格式**文字片段并成一段（切跨度留下的碎段读起来太碎）。
  const merged: ContentFragment[] = []
  for (const fragment of pieces) {
    const previous = merged[merged.length - 1]
    if (fragment.t === 'text' && previous?.t === 'text' && marksEqual(previous.marks, fragment.marks)) previous.v += fragment.v
    else merged.push(fragment)
  }
  return { content: merged, touched: true }
}

// ---------------------------------------------------------------------------
// ① 导出物的降级形态：`[名](<目标.md>)`
// ---------------------------------------------------------------------------

/** 一行里的「页面链接」跨度：`[显示文字](目标.md)`（我们的导出物里，它就是 `[[ ]]` 的降级形态）。 */
export type PageRefSpan = { label: string; file: string }

/**
 * 切一行里的页面链接（纯函数）：返回**文字段与页面链接段**交替的序列。
 * 只认指向 `.md` 的链接——外部链接（`http…`）与附件（`assets/x.csv`）不在这里。
 * **两种写法都认**：`[名](目标.md)` 与 `[名](<目标.md>)`——导出侧对行内引用**总是**加尖括号
 * （`exportMd.ts` 的 `fragmentMarkdown`：名字里有空格时那是 CommonMark 的正确写法），
 * 读回侧不认它的话，自家导出物再导入会**静默退化成字面文本**（台账 D-045， 修）。
 */
export function splitPageRefs(text: string): Array<{ text: string } | PageRefSpan> {
  const spans: Array<{ text: string } | PageRefSpan> = []
  // 标签允许 `\[` / `\]` 转义（导出侧对标签里的方括号就是那么写的）、目标允许 `<>` 包裹。
  const pattern = /\[((?:\\.|[^\]\\])*)\]\(<?([^)>]+?\.md)>?\)/g
  let cursor = 0
  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
    if (found.index > cursor) spans.push({ text: text.slice(cursor, found.index) })
    spans.push({ label: unescapeLinkLabel(found[1]), file: decodeURIComponent(found[2]) })
    cursor = found.index + found[0].length
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor) })
  return spans
}

/** 链接标签的反解：`\[` → `[`、`\]` → `]`、`\\` → `\`（与导出侧 `escapeLabel` 成对）。 */
function unescapeLinkLabel(label: string): string {
  return label.replace(/\\([\\[\]])/g, '$1')
}

/** 标签回写成 Markdown 文字时把方括号挡回去（保持字面的那条路要用）。 */
function escapeLabelText(label: string): string {
  return label.replace(/([\\[\]])/g, '\\$1')
}

/** 文件名 → 页名（去 `.md`、去重名后缀 ` (2)`、去目录前缀——导出物的名字都过过净化，仍兜一层）。 */
function pageNameOf(file: string): string {
  const base = file.split('/').pop() ?? file
  return base.replace(/\.md$/i, '').replace(/\s*\(\d+\)$/, '')
}

/**
 * 把草稿树里的页面链接**还原成引用**（纯函数，返回新树）：
 * `resolve(页名)` 由调用方注入（界面拿它查库里有没有这一页——领域层不认识「名字 → id」这件事）。
 * 对上 → 该行的片段里插入 `inline-ref`（显示文字保持原样）、引用点进 `draft.refs`；
 * 对不上 → 保持字面（**不凭空造页**），目标文件名进 `unresolved`。
 */
export function resolvePageRefs(
  drafts: OutlineDraft[],
  resolve: (pageName: string) => string | null,
): { drafts: OutlineDraft[]; unresolved: string[] } {
  const unresolved: string[] = []
  const walk = (list: OutlineDraft[]): OutlineDraft[] => list.map((draft) => {
    const children = walk(draft.children)
    const refs: Array<{ kind: 'object' | 'block'; targetId: string }> = []
    const spliced = spliceDraftRefs(draft, splitPageRefs, (span) => {
      const targetId = resolve(pageNameOf(span.file))
      if (!targetId) {
        if (!unresolved.includes(span.file)) unresolved.push(span.file)
        return `[${escapeLabelText(span.label)}](${span.file})`
      }
      refs.push({ kind: 'object', targetId })
      return { t: 'inline-ref', v: span.label, ref: { kind: 'object', targetId } }
    })
    if (!spliced) return { ...draft, children }
    return { ...draft, content: spliced.content, refs, children }
  })
  return { drafts: walk(drafts), unresolved }
}

// ---------------------------------------------------------------------------
// ② 原文语法：`[[页名]]` / `[[页名|别名]]` / `[[路径/页名]]` / `((块名))`
// ---------------------------------------------------------------------------

/** 一个行内引用跨度：`target` = 解析用的名字、`display` = 显示文字（别名优先）。 */
export type InlineRefSpan = { kind: 'object' | 'block'; target: string; display: string; raw: string }

/**
 * 一行里的 `[[…]]` / `((…))` 跨度（纯函数）。
 *
 * **Obsidian 的三处扩展都认**（，互通批）：
 * - `[[页名|别名]]` → 显示文字取别名（我们的 `inline-ref` 本来就有显示文字字段，**无损**）；
 * - `[[路径/页名]]` → 解析按**全名与末段**各试一次（Obsidian 的库是文件夹，链接可带路径）；
 *   `[[页名.md]]` 也认（去扩展名）；
 * - `[[页名#标题]]` / `[[页名#^块ID]]` / `[[#标题]]` → **带锚点，保持字面**（我们的模型没有标题 /
 *   块锚点，硬转会把锚点吞掉——调用方按「锚点」单独报数，不算「页没找到」）。
 *
 * 先认 `[[`：`((` 的捕获组为 undefined 时才当块引用。`raw` 是原文 token（保持字面时原样放回）。
 */
export function splitInlineRefs(text: string): Array<{ text: string } | InlineRefSpan> {
  const spans: Array<{ text: string } | InlineRefSpan> = []
  const pattern = /\[\[([^\][\n]+)\]\]|\(\(([^()\n]+)\)\)/g
  let cursor = 0
  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
    if (found.index > cursor) spans.push({ text: text.slice(cursor, found.index) })
    if (found[1] !== undefined) {
      const raw = found[1]
      const at = raw.indexOf('|')
      const target = (at >= 0 ? raw.slice(0, at) : raw).trim()
      const alias = at >= 0 ? raw.slice(at + 1).trim() : ''
      // 没有别名时显示**末段名**（Obsidian 对 `[[目录/页名]]` 就是这么显示的），去掉 `.md`。
      const basename = (target.split('/').pop() ?? target).replace(/\.md$/i, '')
      spans.push({ kind: 'object', target, display: alias.length > 0 ? alias : basename, raw: `[[${raw}]]` })
    } else {
      const raw = found[2].trim()
      spans.push({ kind: 'block', target: raw, display: raw, raw: `((${found[2]}))` })
    }
    cursor = found.index + found[0].length
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor) })
  return spans
}

/** 名字的尝试序列：全名 → 去 `.md` → 末段（`笔记/产品路线` 在库里叫「产品路线」时也能对上）。 */
function nameCandidates(target: string): string[] {
  const out: string[] = []
  const push = (value: string) => { if (value.length > 0 && !out.includes(value)) out.push(value) }
  push(target)
  push(target.replace(/\.md$/i, ''))
  const base = target.split('/').pop() ?? target
  push(base)
  push(base.replace(/\.md$/i, ''))
  return out
}

/**
 * 把草稿树里的 `[[…]]` / `((…))` **还原成行内引用**（纯函数，返回新树）。
 * `resolve(kind, label)` 由调用方注入（同级分工同 `resolvePageRefs`）。
 * 命中 → 片段里的 `inline-ref`（显示文字 = 别名 / 原标签）+ 引用点进 `draft.refs`；
 * 未命中 → 保持字面：带 `#` 锚点的进 `anchored`，其余进 `unresolved`（两处口径分开，报数才诚实）。
 * **块引用 `((…))` 不做路径尝试**（块标签里出现 `/` 是正文，不是目录）。
 */
export function resolveInlineRefs(
  drafts: OutlineDraft[],
  resolve: (kind: 'object' | 'block', label: string) => string | null,
): { drafts: OutlineDraft[]; unresolved: string[]; anchored: string[] } {
  const unresolved: string[] = []
  const anchored: string[] = []
  const walk = (list: OutlineDraft[]): OutlineDraft[] => list.map((draft) => {
    const children = walk(draft.children)
    const refs: Array<{ kind: 'object' | 'block'; targetId: string }> = []
    const spliced = spliceDraftRefs(draft, splitInlineRefs, (span) => {
      // 锚点（`#标题` / `#^块ID`）：模型里没有它的落点——保持字面并单独报数，不假装「页没找到」。
      if (span.kind === 'object' && span.target.includes('#')) {
        if (!anchored.includes(span.raw)) anchored.push(span.raw)
        return span.raw
      }
      const candidates = span.kind === 'object' ? nameCandidates(span.target) : [span.target]
      let targetId: string | null = null
      for (const candidate of candidates) {
        targetId = resolve(span.kind, candidate)
        if (targetId) break
      }
      if (!targetId) {
        if (!unresolved.includes(span.raw)) unresolved.push(span.raw)
        return span.raw
      }
      refs.push({ kind: span.kind, targetId })
      return { t: 'inline-ref', v: span.display, ref: { kind: span.kind, targetId } }
    })
    if (!spliced) return { ...draft, children }
    return { ...draft, content: spliced.content, refs, children }
  })
  return { drafts: walk(drafts), unresolved, anchored }
}

// ---------------------------------------------------------------------------
// ③ 外部链接：`[文字](url)` / `![alt](url)` → `link` 片段
// ---------------------------------------------------------------------------

/**
 * 把草稿树里的**外部链接**还原成 `link` 片段（纯函数，返回新树）——**只在导入那条路上跑**
 * （粘贴侧有明文裁决：`[文字](url)` 语法文本不转换，`R09-ELINK-4`）。
 *
 * 为什么值得转：`link` 片段在我们的模型里是**一等公民**（`09` §6.13 `R09-ELINK-*`），
 * 导出还会按同一张表写回 `[文字](url)`（URL 含空格 / 括号时加 `<>`）——**转与不转都是无损的**，
 * 但转过来之后链接是活的、正文里不再躺着一串语法文字（Obsidian 文档里外链极常见）。
 * `![alt](https://…)` 同样落成 link 片段（模型里没有「外链图片」这个块，但 alt 与 URL 都不丢）。
 *
 * 只认 `http://` / `https://` / `mailto:` / 协议相对 `//`；`assets/x.png` 这类**本地**目标
 * 归媒体那条路（`mdSyntax.mediaRefOf`），指向 `.md` 的归页面链接（`resolvePageRefs`）。
 * 认不出的目标（`foo/bar.png` 这种相对路径既不是资产也不是外链）保持字面。
 */
export function resolveExternalLinks(drafts: OutlineDraft[]): { drafts: OutlineDraft[]; links: number } {
  let links = 0
  const scan = (value: string) => splitMarkdownLinks(value)
  const place = (span: MarkdownLinkSpan): ContentFragment | string => {
    if (!isExternalUrl(span.url)) return span.raw
    links += 1
    return { t: 'link', v: span.label || span.url, url: span.url }
  }
  const walk = (list: OutlineDraft[]): OutlineDraft[] => list.map((draft) => {
    const children = walk(draft.children)
    const spliced = spliceDraftRefs(draft, scan, place)
    // 自动链接 `<https://…>`（CommonMark）：单独一趟，因为整行就是一个角括号目标。
    const auto = spliced
      ? spliceDraftRefs({ ...draft, content: spliced.content, children }, splitAutolinks, (span: AutolinkSpan) => {
        links += 1
        return { t: 'link', v: span.url, url: span.url }
      })
      : null
    if (auto) return { ...draft, content: auto.content, children }
    if (spliced) return { ...draft, content: spliced.content, children }
    return { ...draft, children }
  })
  return { drafts: walk(drafts), links }
}

export type MarkdownLinkSpan = { label: string; url: string; raw: string }
export type AutolinkSpan = { url: string; raw: string }

function isExternalUrl(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url) || url.startsWith('//')
}

/**
 * 切一行里的 Markdown 链接（`[文字](url)` 与 `![alt](url)` 同一条正则——图片是带 `!` 的链接）。
 * 标签允许 `\]` 转义、目标允许 `<>` 包裹（我们的导出物对含空格 / 括号的 URL 就是那么写的）。
 */
export function splitMarkdownLinks(text: string): Array<{ text: string } | MarkdownLinkSpan> {
  const spans: Array<{ text: string } | MarkdownLinkSpan> = []
  const pattern = /(!?)\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^<>]+)>|([^)]+?))\s*\)/g
  let cursor = 0
  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
    if (found.index > cursor) spans.push({ text: text.slice(cursor, found.index) })
    const label = found[2].replace(/\\([\\[\]])/g, '$1')
    const url = (found[3] ?? found[4] ?? '').trim()
    // 图片是带 `!` 的链接——两种都落成同一类跨度（`label` 对图片就是 alt）。
    spans.push({ label, url, raw: found[0] })
    cursor = found.index + found[0].length
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor) })
  return spans
}

/** 切一行里的自动链接 `<https://…>`（CommonMark；邮件地址也认）。 */
export function splitAutolinks(text: string): Array<{ text: string } | AutolinkSpan> {
  const spans: Array<{ text: string } | AutolinkSpan> = []
  const pattern = /<((?:https?:|mailto:)[^<>\s]+)>/g
  let cursor = 0
  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
    if (found.index > cursor) spans.push({ text: text.slice(cursor, found.index) })
    spans.push({ url: found[1], raw: found[0] })
    cursor = found.index + found[0].length
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor) })
  return spans
}

// ---------------------------------------------------------------------------
// ③b 行内标签（Obsidian 核心语法 `#标签` / `#父/子`）的**采集**
// ---------------------------------------------------------------------------

/**
 * 把草稿树里的**行内标签**收成名字清单（纯函数；用户裁决 ：导入时按开关收成页面标签）。
 *
 * **只读不写**：正文一个字不动——改了字就不幂等、往返也不再逐字一致（那是本项目的命门）。
 * 所以这里只交出"有哪些标签"，登记与去重由调用方（导入流程）按标签注册表做。
 *
 * 判据照 Obsidian（逐条都对得上它的行为）：
 * - `#` 前面必须是**行首或空白**——`https://x.com/a#anchor` 里的 `#` 不算（URL 不当标签）；
 * - `#` 后紧跟**标签字符**（字母 / 数字 / `_` `-` `/`），且**至少含一个非数字**（`#123` 不是标签）；
 * - 名字尾部的 `/` `-` 去掉（`#标签/` 与 `#标签` 是同一条）；
 * - **代码是字面**：`code` 块与带 `code` mark 的片段不扫（Obsidian 也不在代码里认标签）；
 * - **保序 ＋ 按名去重**（同一篇里同名只交一条）。
 */
export function collectInlineTags(drafts: OutlineDraft[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const scan = (text: string) => {
    for (const found of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
      const name = found[1].replace(/[/-]+$/, '')
      // 纯数字不是标签（Obsidian 同）；空名（`# `）自然被这条挡掉。
      if (name.length === 0 || !/[\p{L}_/-]/u.test(name)) continue
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  const walk = (list: OutlineDraft[]) => {
    for (const draft of list) {
      if (draft.type !== 'code') {
        const source = draft.content ?? [{ t: 'text' as const, v: draft.text }]
        for (const fragment of source) {
          if (fragment.t !== 'text') continue
          if (fragment.marks?.some((mark) => mark.type === 'code')) continue
          scan(fragment.v)
        }
      }
      walk(draft.children)
    }
  }
  walk(drafts)
  return out
}

// ---------------------------------------------------------------------------
// ④ 媒体引用的**落地**（13-导出与媒体设计（已归档） §「导入」）
// ---------------------------------------------------------------------------

/** 草稿树里的媒体引用清单（**去重、按出现顺序**）：导入流程拿着它去 `assets/` 逐个找。 */
export function collectMediaRefs(drafts: OutlineDraft[]): Array<{ href: string; kind: 'image' | 'file'; label: string }> {
  const seen = new Set<string>()
  const out: Array<{ href: string; kind: 'image' | 'file'; label: string }> = []
  const walk = (list: OutlineDraft[]) => {
    for (const draft of list) {
      if (draft.mediaRef && !seen.has(draft.mediaRef.href)) {
        seen.add(draft.mediaRef.href)
        out.push({ href: draft.mediaRef.href, kind: draft.mediaRef.kind, label: draft.mediaRef.label })
      }
      walk(draft.children)
    }
  }
  walk(drafts)
  return out
}

/**
 * 把已落地的资产**贴回草稿树**（纯函数，返回新树，不改入参）：
 * - 命中（`assets` 里有那条 href）→ 变成真正的媒体草稿（`type: 'image' | 'file'` + `asset` payload）；
 * - 没命中 → **降级成文字草稿**（`［图片］图注（未找到 assets/…）`），文字一字不丢，`missing` 里报出路径。
 *
 * 为什么降级而不是跳过：跳过等于**静默丢内容**——用户看到的是一篇少了图的文档，还不知道少了什么。
 */
export function applyImportedAssets(
  drafts: OutlineDraft[],
  assets: Map<string, BlockAsset>,
): { drafts: OutlineDraft[]; missing: string[] } {
  const missing: string[] = []
  const walk = (list: OutlineDraft[]): OutlineDraft[] => list.map((draft) => {
    const children = walk(draft.children)
    if (!draft.mediaRef) return { ...draft, children }
    const asset = assets.get(draft.mediaRef.href)
    if (!asset) {
      if (!missing.includes(draft.mediaRef.href)) missing.push(draft.mediaRef.href)
      const prefix = draft.mediaRef.kind === 'image' ? '［图片］' : '［附件］'
      const label = draft.mediaRef.label.trim() || draft.mediaRef.href
      return { ...draft, type: 'text' as const, text: `${prefix}${label}（未找到 ${draft.mediaRef.href}）`, mediaRef: undefined, children }
    }
    return {
      ...draft,
      type: draft.mediaRef.kind === 'image' ? ('image' as const) : ('file' as const),
      asset,
      // 媒体块的 content 只有图注（附件恒空）——图注就是那行 `![图注](…)`。
      content: draft.mediaRef.kind === 'image' && draft.mediaRef.label.length > 0
        ? [{ t: 'text' as const, v: draft.mediaRef.label }]
        : undefined,
      text: draft.mediaRef.kind === 'image' ? draft.mediaRef.label : '',
      mediaRef: undefined,
      children,
    }
  })
  return { drafts: walk(drafts), missing }
}
