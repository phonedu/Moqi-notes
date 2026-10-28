/**
 * 「现在选的是什么」——**一份语义，两个来源**（T7 收口，`docs/09` §6.2 / §九 `R09-KEY-21/22`）。
 *
 * 选择有两个来源：**文字选区**住内核（Lexical 的 selection），**块选中**住界面
 * （`ui/useBlockSelection` 的 `selectedIds`）。以前「谁优先、谁能接管这次按键」是各调用点
 * 各写一遍布尔组合写的（⌘C / ⌘X / ⌫ / ⌘⇧↑↓ 各一套），语气稍异就会分叉。现在收成这里的
 * 纯函数；控制器只负责读事实（有没有文字选区、选了几块、焦点在不在输入框）。
 *
 * 为什么要有这份语义（不是概念洁癖）：0.6.0 的触控会加第三种来源——「跟随手指的块选择」；
 * 三份来源共用一个判据，才谈得上「两端交互形态各自定、语义一致」。
 */

/** 当前选择的三种形态。`blocks` 含**跨块范围**（⇧+点击选一整段也算）。 */
export type SelectionKind = 'text' | 'blocks' | 'none'

/**
 * 优先级就是这一句话：**文字选区 > 块选中 > 无**。
 *
 * 依据是平台惯例（`R09-KEY-21`）：有文字选区时 ⌘C / ⌘X / ⌫ 是**文字**的事，块级动作让路；
 * 反过来，块选中态下焦点仍可能在正文容器上（块标记画在 `.doc-col` 里、点把手不改焦点），
 * 所以「焦点在不在正文里」**不能**当判据（ 踩过：用 `inEditable` 当守卫，
 * 块级 ⌘C / ⌘X 完全不触发）。
 */
export function selectionKindOf(input: { textSelected: boolean; blockCount: number }): SelectionKind {
  if (input.textSelected) return 'text'
  return input.blockCount > 0 ? 'blocks' : 'none'
}

/**
 * 块级按键（⌘C / ⌘X / ⌫ / ⌘⇧↑↓）能不能接管这一次按键。
 *
 * 三条让路：不是块选中态、焦点在输入框里（搜索框 / 属性面板，那里 ⌘C 是输入内容自己的事）、
 * 输入法组合态（同 `inputRules.decideTab` 的口径）。
 */
export function acceptsBlockKeys(input: { kind: SelectionKind; inFormField: boolean; composing: boolean }): boolean {
  if (input.kind !== 'blocks') return false
  return !input.inFormField && !input.composing
}
