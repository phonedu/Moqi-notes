/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { INLINE_PATTERNS } from '../domain/mdInline'
import { blockMarkerOf, type BlockMarker } from '../domain/mdSyntax'
import type { TextFormatType } from 'lexical'
/**
 * **输入规则层**（T8 收口，`06` §4 允许的形态：纯函数决策 ＋ 薄触发层）：
 * **Enter / Tab / Backspace / IME 的判据都住这里**，触发与执行留在外壳与 `EditorPlugins`
 * （它们只读事实、执行结论）。MD 输入层（`09-桌面端交互规范` §6.12 `R09-MD-1…6`）接进来时也归这一层——
 * 它要求「每条语法都转发到与工具栏相同的命令入口」，落点就是这些判据。
 *
 * **IME 一条通则**：组合态（`editor.isComposing()`）一律让给浏览器与内核——中文输入法里
 * 这些键有自己的用法，抢过来会打断候选。所以每个判据都接 `composing` 并原样放行。
 *
 * 名字行那处接缝的两个判据（`decideNameRowCross` / `decideNameRowEdge`） 随
 * 名字行收口（T5）迁去 `editor/nameLine.ts`——判据各归各的层，本文件管「输入键落到文档上
 * 变成什么」。
 *
 * Tab 的由来（docs/04 §3「结构操作」、§7）：Lexical 把 Tab 注册成
 * `dispatch('Tab', …, KEY_TAB_COMMAND)`（见 lexical 的 `buildKeyDownShortcuts`），
 * **不会替命令处理器 preventDefault**：只有处理器自己阻止默认行为，
 * 浏览器才不会按「Tab = 移动焦点」继续处理。漏掉这一步会出两种真实故障：
 * - ⇧Tab（反缩进）：焦点交给页面标题，正文列被滚回顶部——用户看到的是「整页抖动、跳到最前面」；
 * - Tab（缩进）：焦点交给块把手等紧随其后的可聚焦元素，之后敲键盘写不进正文。
 *
 * 规则：**光标只要落在某个块里，Tab / ⇧Tab 一律由编辑器消费**——包括规范里定义的 no-op
 * （根块按 ⇧Tab、无前置同级块按 Tab），no-op 也要吃掉按键，否则同样的焦点丢失仍会发生。
 * 光标不在块里或正在输入法组合态时让给浏览器（无障碍：Tab 仍然能离开编辑器）。
 */
export type TabDecision =
  | { kind: 'indent'; blockId: string }
  | { kind: 'outdent'; blockId: string }
  /** **代码块内**：Tab / ⇧Tab 改的是**文本**（插两个空格 / 删行首最多两个空格），块不动（对账裁，`G-3`）。 */
  | { kind: 'code-text'; shiftKey: boolean; blockId: string }
  | { kind: 'browser' }

export function decideTab(input: { blockId: string | null; shiftKey: boolean; composing: boolean; inCode?: boolean }): TabDecision {
  if (input.composing || !input.blockId) return { kind: 'browser' }
  // 写代码的人默认 Tab = 插缩进（Tiptap `enableTabIndentation` 的教训；块缩进会把整块挪走、写不了代码）。
  if (input.inCode) return { kind: 'code-text', shiftKey: input.shiftKey, blockId: input.blockId }
  return { kind: input.shiftKey ? 'outdent' : 'indent', blockId: input.blockId }
}

/**
 * 回车落在列表项里时干什么（docs/04 §3 / §6，用户实测 ）。
 *
 * 列表的「继续」与「退出」是一条链，缺一个都不可用：
 * - **项内有字** → `continue`：拆成两个同级、同类型的列表项（新项从光标处开始）。
 * - **项内为空 + 已缩进**（父块不是页面容器）→ `outdent`：沿用既有规则
 *   `R04-ENTER-3`「缩进块上的空块按 Enter 退出缩进」，仍然是列表项，只是上移一级。
 * - **项内为空 + 已在最外层** → `exit`：**退出列表**——本块类型变回普通文本块
 *   （光标留在原地）。所以连按回车的体感是「先逐级外移，回到最外层再按一次就出列表」。
 * - 不是列表 → `plain`：交给原来的换行逻辑（不改既有行为）。
 */
export type ListEnterAction = 'continue' | 'outdent' | 'exit' | 'plain'

export function decideListEnter(input: { isList: boolean; hasText: boolean; indented: boolean }): ListEnterAction {
  if (!input.isList) return 'plain'
  if (input.hasText) return 'continue'
  return input.indented ? 'outdent' : 'exit'
}

/**
 * 回车落在**普通空块**里时干什么（`04` §3 `R04-ENTER-3`，用户口径 ）：
 * 缩进块上的空块再按一次 Enter → **退出缩进**（本块升一级，光标留在它开头），
 * 仍然不产生新块。页面容器的直接子块已经是一级，按 Enter 仍旧只换行。
 *
 * 与 `decideListEnter` 的分工：列表项走上面那条链（先续项、再逐级外移、最后退出列表）；
 * 这里管**不是列表**的块（触发层先试列表那条，`plain` 才落到这里）。
 */
export type EmptyEnterAction = 'outdent' | 'plain'

export function decideEmptyEnter(input: { indented: boolean; hasText: boolean }): EmptyEnterAction {
  if (input.hasText) return 'plain'
  return input.indented ? 'outdent' : 'plain'
}

/**
 * 回车落在**代码块**里时干什么（`04` §3 `R04-ENTER-6`，W6 用户裁决；机制 A，
 * 定案：「块内换行只允许出现在代码块」这条的落点）。
 *
 * - `newline`：**Enter = 换行**——在编辑器里插一个 `LineBreakNode`（渲染 `<br>`，光标/点击/打字
 *   都是浏览器标准行为）；**适配器把它序列化成 `\n` 写进块正文**（落库、重载仍在、导出进同一围栏）。
 *   为什么不是「`\n` 直接写进一个文本节点」：Chromium 对 contenteditable 里**结尾的 `\n`** 做悬挂
 *   处理（光标回不到下一行、打字落在换行之前，纯 HTML 可复现）——那条路敲不出多行代码。
 * - `exit`：**空行上再按 = 退出代码块**——`isEmptyBlock`（空代码块 → 直接转成 `text` 块，
 *   不留空代码块）或 `atEmptyLine`（光标就在行尾空行上 → 收掉尾随换行、在其后新建 `text` 块、
 *   光标进新块）；非空且光标不在尾空行 → 一律 `newline`。
 *
 * 只对**块级代码块**（`type === 'code'`）；行内代码是 mark，不受影响。
 */
export type CodeEnterAction = 'newline' | 'exit'

export function decideCodeEnter(input: { isEmptyBlock: boolean; atEmptyLine: boolean }): CodeEnterAction {
  return input.isEmptyBlock || input.atEmptyLine ? 'exit' : 'newline'
}

/**
 * 光标在**有内容的列表项行首**按 Backspace 干什么（`04` §3 `R04-ENTER-4` 的另一半，
 * 用户实测 ）：**本项退出列表**（变回普通文本块，内容与光标都不动）；
 * 再按一次才轮到原来的合并 / 跨行逻辑。没有这一步时，项首 Backspace 会把两个列表项并成一个。
 *
 * 两条边界：**空项**不走这里（空项的 Backspace 让给既有的「空块合并」通路，语义更自然）；
 * **不在行首**也不走（块中间是行内删除）。
 * 这里不看 `composing`：这条只挂在 `KEY_BACKSPACE_COMMAND` 上，组合态里浏览器先吃掉按键、
 * 命令根本不会派发——与 Tab（要在 `KEY_DOWN` 层判）不同。
 */
export function decideLeaveListOnBackspace(input: { isList: boolean; hasText: boolean; atStart: boolean }): boolean {
  return input.isList && input.hasText && input.atStart
}

/**
 * 粘贴纯 URL（`09-桌面端交互规范` §6.13 `R09-ELINK-4`，纪律见 `04` `R04-PASTE-1`）：
 * 剪贴板内容**整体**是一个 `http(s)://` 地址时才变链接（显示文字 = URL 原文），
 * 其余一律按普通文本——`[文字](url)` 语法文本**不**转换（`R09-MD-3` 的「不做」保持）。
 * 返回要转换的 URL，或 null（按普通文本粘贴）。
 */
export function decideBareUrlPaste(text: string): string | null {
  const value = text.trim()
  return /^https?:\/\/\S+$/.test(value) ? value : null
}

/**
 * MD 输入层 · **打字触发**（`09-桌面端交互规范` §6.12 `R09-MD-2` / `R09-MD-4`，）。
 *
 * 形态 = 纯函数判据（这里）+ 薄触发层（编辑器插件里那两条 `registerNodeTransform`）：
 * 记号表住在 `domain/mdSyntax.ts`（导出转义 / 粘贴解析 / 打字触发**同一张表**）。
 * 纪律：只在行首触发（`5 - 3`、`` 不动）、**记号字符先做全角 → 半角归一**（`R09-MD-4.3`，
 * 放宽；见 `normalizeEditorText`）、不看 `composing`（组合态由触发层让路）、
 * 触发词被吞掉、⌘Z 一次回到纯文本（同一次 update 里完成 ⇒ 一个撤销步）。
 */

/** 打完整行记号（`- ` / `# ` / `1. ` / `---` …）→ 该转成什么块；不是「整行就是记号」则 null。 */
/**
 * 编辑器侧的输入被「看不见」地加工过，判据先归一再比（accept 实测两处 + 用户裁决一处）：
 * ① 零宽字符（锚点挂在文本里）；② **空格是 NBSP（U+00A0）**——打字打出来的空格在编辑器里不是半角，
 * 而记号表按 Markdown 的半角写；领域里落库时会归一成半角（所以导出不受影响，只有这里的判据要对齐）；
 * ③ **中文标点态的记号字符**（用户 裁决：第 22 项**只做"归一"这一半**）——中文输入法
 * 默认开「中文标点」，`>` `.` `[` `]` 等会被换成 `》` `。` `【` `】`，按半角写的记号就打不出来。
 * 这里按**全角 / 中文标点 → 半角**归一后再判，**落库仍是半角**（与 NBSP 同一套做法、同一处）。
 * 只覆盖**记号表用到的字符**（不做通用全角转换）；判据本身要求"整行就是记号"，所以正文不受影响。
 */
const FULL_WIDTH_MARKERS: Record<string, string> = {
  '＞': '>', '－': '-', '＃': '#', '｀': '`', '＊': '*', '＝': '=', '～': '~',
  '【': '[', '】': ']', '。': '.', '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  // `《` 与 `》` **都映到 `>`**：中文标点态下 `>` 到底变成哪一个**要看输入法**（配对括号逻辑；真 IME
  // 实测排在 0.6 验收）——两个都映上就与输入法无关。`<` 不是记号表里的字符，所以 `《 → <` 没有用处。
  // 误伤面 =「一整行恰好是 `《 ` 或 `》 `」这种不存在的段落（判据只认"整行就是记号"）。
  '《': '>', '》': '>',
}
const FULL_WIDTH_RE = new RegExp(`[${Object.keys(FULL_WIDTH_MARKERS).join('')}]`, 'g')

function normalizeEditorText(text: string): string {
  return text
    .replace(/[\u200b\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(FULL_WIDTH_RE, (char) => FULL_WIDTH_MARKERS[char])
}

export function decideBlockMarkerTrigger(text: string): BlockMarker | null {
  // 不做 trimEnd：记号自带尾随空格（`- ` 的那个空格就是触发词的一部分），剪掉它永远触发不了
  // （但**要**去零宽：块里常挂着不可见的锚点，不去掉长度就永远对不上——accept 实测过一次）。
  const exact = normalizeEditorText(text)
  const marker = blockMarkerOf(exact)
  if (!marker) return null
  // 「整行就是记号」：记号之后不许还有字（`# 标题` 不触发，避免把已经写完的句子改掉）
  return marker.length === exact.length ? marker : null
}

/**
 * 打到成对闭合并收尾（`**粗**` 的第二个 `**` 落键）→ 要落的格式、内层文字与**记号区间**；
 * 否则 null。触发层据此把记号从正文里抹掉、只留内层并上格式（同一 update ⇒ 一个撤销步）。
 */
/** 行内记号的 mark → Lexical 的格式位（触发层照着落，映射只有这一份）。 */
export const INLINE_TEXT_FORMAT: Record<'bold' | 'italic' | 'strike' | 'code' | 'highlight', TextFormatType> = {
  bold: 'bold',
  italic: 'italic',
  strike: 'strikethrough',
  code: 'code',
  highlight: 'highlight',
}

/** 定界符与它该有的连跑长度（`**` 是 2、`*` 是 1……）——用来挡住 `**粗*` 被 1 个 `*` 的斜体规则吃掉。 */
const INLINE_DELIMS: Array<{ mark: 'bold' | 'italic' | 'strike' | 'code' | 'highlight'; char: string; run: number }> = [
  { mark: 'bold', char: '*', run: 2 },
  { mark: 'italic', char: '*', run: 1 },
  { mark: 'strike', char: '~', run: 2 },
  { mark: 'highlight', char: '=', run: 2 },
  { mark: 'code', char: '`', run: 1 },
]

function runLength(text: string, index: number, char: string, direction: -1 | 1): number {
  let count = 0
  let cursor = index
  while (cursor >= 0 && cursor < text.length && text[cursor] === char) {
    count += 1
    cursor += direction
  }
  return count
}

export function decideInlinePairTrigger(text: string): { mark: 'bold' | 'italic' | 'strike' | 'code' | 'highlight'; inner: string; index: number; length: number } | null {
  for (const { pattern, mark } of INLINE_PATTERNS) {
    const match = pattern.exec(text)
    if (!match || match.index + match[0].length !== text.length) continue
    const delim = INLINE_DELIMS.find((entry) => entry.mark === mark)
    if (!delim) continue
    // 连跑长度 = **整段连跑**（前后两个方向都算）：`**粗*` 的开头其实是两个 `*` 的连跑，
    // 不能只从 match.index 往右数——否则第 4 个键就被单字符的斜体规则吃掉（accept 实测过一次）。
    const openRun = runLength(text, match.index, delim.char, 1) + runLength(text, match.index - 1, delim.char, -1)
    const end = match.index + match[0].length
    const closeRun = runLength(text, end - 1, delim.char, -1) + runLength(text, end, delim.char, 1)
    if (openRun !== delim.run || closeRun !== delim.run) continue
    return { mark, inner: match[1], index: match.index, length: match[0].length }
  }
  return null
}
