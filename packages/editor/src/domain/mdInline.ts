/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * **行内记号的唯一所有者**（`09-桌面端交互规范` §6.12 `R09-MD-3` 的第二段）：成对表 / 转义 / 反解 / 切片段。
 *
 * 为什么单独一件（2026-10-10，随代码体量门拆册）：`mdSyntax.ts` 里同时住着「行首记号」与「行内记号」
 * 两件事，长过红线；行内这一簇自成一个知识（表 + 三个方向），搬出来两边都短、边界也更清楚。
 *
 * 两个方向吃它：
 * ① **导出**——把「看起来成对但不是格式」的记号转义成 `\*…\*`（`escapeInlineMarkers`），
 *    渲染出来的文字逐字不变、语义不漂；
 * ② **读回来**（粘贴 / 导入）——先认旗再切、片段内部反解（`splitInlineSegments`）。
 *
 * **打字侧的成对闭合触发（`editor/inputRules.ts`）只吃 `INLINE_PATTERNS`**：读回侧比它多认一种
 * （`<u>…</u>` = 导出侧给下划线的写法，Markdown 没有下划线语法），手打 `<u>text</u>` 不该变格式
 * （`R09-MD-3` 的"不做 HTML"）。
 */
import type { ContentFragment } from './block'

/** 行内成对格式表（`R09-MD-3` 的第二段）——输入层「成对闭合时转换」与粘贴共用同一份。 */
export type InlineMark = 'bold' | 'italic' | 'strike' | 'code' | 'highlight'

export const INLINE_PATTERNS: Array<{ pattern: RegExp; mark: InlineMark }> = [
  { pattern: /\*\*([^*\n]+)\*\*/, mark: 'bold' },
  { pattern: /~~([^~\n]+)~~/, mark: 'strike' },
  { pattern: /==([^=\n]+)==/, mark: 'highlight' },
  { pattern: /`([^`\n]+)`/, mark: 'code' },
  { pattern: /\*([^*\n]+)\*/, mark: 'italic' },
]

/** 读回侧的一张表的行类型（`INLINE_PATTERNS` 是它的子集——`extra` 只有粗斜那条用）。 */
type ReadbackPattern = { pattern: RegExp; mark: InlineMark | 'underline'; extra?: InlineMark }

/** 读回侧的成对表（含 `underline`）：**只走"读回来"那条路**，见文件头注。 */
const READBACK_INLINE_PATTERNS: ReadbackPattern[] = [
  // `***粗斜***`（CommonMark 的加粗 + 斜体）——**必须排在 `**` 前面**：不然 `**粗斜**` 先命中，
  // 两侧多余的 `*` 会以字面落进正文（2026-10-10 互通批：Obsidian 文档里这个写法很常见）。
  { pattern: /\*\*\*([^*\n]+)\*\*\*/, mark: 'bold', extra: 'italic' },
  { pattern: /<u>([^<\n]+)<\/u>/, mark: 'underline' },
]

/** 读回侧两张表合起来用（`splitInlineSegments` 与导出转义都看它——字面 `<u>…</u>` 也要转义，往返才无歧义）。 */
const READBACK_ALL_PATTERNS: ReadbackPattern[] = [...INLINE_PATTERNS, ...READBACK_INLINE_PATTERNS]

/** 行内记号的字面转义：`*` `~` `=` `` ` `` 前面加 `\`（导出用；只对**看起来成对**的才加，见 `escapeInlineMarkers`）。 */
function escapeInlineMarker(marker: string): string {
  // 下划线那条读回规则认的是 `<u>` / `</u>` 这两个标签——把标签的 `<` 转义掉即可；正文里的裸 `<` 不碰。
  return marker.replace(/[*~=`]/g, (char) => `\\${char}`).replace(/<(\/?u)>/g, '\\<$1>')
}

/**
 * 行内反解：`\*` → `*`、`\<` → `<`、**`\\` → `\`**（粘贴 / 导入用）。最后那条是 CommonMark 的
 * 「字面反斜杠」写法——缺了它，正文里的 `\\<` 这类组合会被前一条吃掉一个反斜杠
 * （2026-10-11 属性测试 `PROP-MD-1` 抓到，台账 `D-061`；导出侧同批改为双写字面反斜杠）。
 */
export function unescapeInline(text: string): string {
  return text.replace(/\\([\\*~=<`])/g, '$1')
}

/**
 * 导出用：**看起来成对**的行内记号加 `\`（`**粗**` 是格式、`*不是斜体*` 也得写成 `\*不是斜体\*`，
 * 否则它在别的工具里会渲染成斜体——判据是「内容看着对」；孤零零一个 `*` 不动，免得满屏反斜杠）。
 */
export function escapeInlineMarkers(text: string): string {
  let out = text
  for (const { pattern } of READBACK_ALL_PATTERNS) {
    const global = new RegExp(pattern.source, 'g')
    out = out.replace(global, (match) => escapeInlineMarker(match))
  }
  return out
}

/** 这个下标上的字符是不是被 `\` 转义了（**奇数个**反斜杠才算转义：`\\*` 是「反斜杠 + 未转义的星号」）。 */
function isEscaped(text: string, index: number): boolean {
  let count = 0
  for (let at = index - 1; at >= 0 && text[at] === '\\'; at -= 1) count += 1
  return count % 2 === 1
}

/**
 * 一段行内文本按成对记号切成片段（粘贴 / 导入用）：命中处变成带 mark 的片段，其余是文本。
 *
 * **先认旗再切**（与行首记号那条同一条纪律）：`\*不是斜体\*` 里的星号**不算记号**，整段是字面文本。
 * 这条是往返的命门——导出侧会把「看起来成对但不是格式」的记号转义成 `\*…\*`（`escapeInlineMarkers`），
 * 导入侧若不认旗就会把它读成斜体，**字面变格式**（2026-10-07 由往返语料逮到）。
 * 片段里的字面转义在**这里**反解（`unescapeInline`），调用方拿到的就是最终文字。
 */
export function splitInlineSegments(text: string): Array<{ text: string; mark?: InlineMark | 'underline'; extra?: InlineMark }> {
  const segments: Array<{ text: string; mark?: InlineMark | 'underline'; extra?: InlineMark }> = []
  let rest = text
  while (rest.length > 0) {
    let matched: { index: number; length: number; inner: string; mark: InlineMark | 'underline'; extra?: InlineMark } | null = null
    for (const { pattern, mark, extra } of READBACK_ALL_PATTERNS) {
      const scanner = new RegExp(pattern.source, 'g')
      let found = scanner.exec(rest)
      // 被转义的开记号跳过，继续找下一个（`\**粗**` 里的第一个 `*` 是字面，第二个 `**` 才是格式）。
      while (found && isEscaped(rest, found.index)) found = scanner.exec(rest)
      if (!found) continue
      if (!matched || found.index < matched.index) matched = { index: found.index, length: found[0].length, inner: found[1], mark, extra }
    }
    if (!matched) break
    if (matched.index > 0) segments.push({ text: unescapeInline(rest.slice(0, matched.index)) })
    segments.push({ text: unescapeInline(matched.inner), mark: matched.mark, ...(matched.extra ? { extra: matched.extra } : {}) })
    rest = rest.slice(matched.index + matched.length)
  }
  if (rest.length > 0) segments.push({ text: unescapeInline(rest) })
  return segments
}

/** 一行文字 → 行内片段：没有成对记号时返回 `undefined`（调用方按纯文本处理）。 */
export function inlineFragments(text: string): ContentFragment[] | undefined {
  // **不先反解**：转义是「先认旗」的旗子，交给 `splitInlineSegments` 判（切完再在片段里反解）。
  const segments = splitInlineSegments(text)
  if (segments.every((segment) => segment.mark === undefined)) return undefined
  return segments.map((segment) => {
    if (!segment.mark) return { t: 'text' as const, v: segment.text }
    // `***粗斜***` 一次落两个 mark（Mark[] 本来就支持组合）——顺序与导出侧 `applyMarks` 的内到外一致。
    const marks = segment.extra ? [{ type: segment.extra }, { type: segment.mark }] : [{ type: segment.mark }]
    return { t: 'text' as const, v: segment.text, marks }
  })
}
