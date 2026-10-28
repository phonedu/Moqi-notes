/**
 * 编辑器里 ⌘Z / ⇧⌘Z 的归属规则（docs/04 §5）。
 *
 * 规范把两种变化分给两套历史：**字符输入**归 Lexical 的 HistoryPlugin，**结构 / 类型 / 引用 /
 * 属性 / 复制 / 删除**归领域事务。两套历史不能互相重复记录同一变化——所以按键要送到
 * 「最后那次改动真正的记录者」那里，而不是固定给其中一边。
 *
 * 规则（ 修订）：
 * - `owner === 'domain'`：最后改动是结构性的 → **领域撤销**（toast 的「撤销」走的也是这条）。
 * - `owner === 'typing'`：**先让 Lexical 撤**（字符级撤销，光标与 IME 手感最好）；
 *   只有 Lexical 明确撤不动时才退回领域，避免「按了没反应」。
 *
 * 为什么不再问 `CAN_UNDO_COMMAND`：Lexical 0.51 的**旧版** `HistoryPlugin` 根本不注册
 * CAN_UNDO / CAN_REDO 这两个查询命令（`@lexical/history` 的 `registerHistory` 只注册
 * UNDO / REDO / CLEAR_EDITOR / CLEAR_HISTORY + 更新监听；CAN_UNDO 由扩展 API 那条路径提供）。
 * 于是「问它能不能撤」永远得到 false，路由器**永远**把 ⌘Z 送去领域：输入文字后按 ⌘Z，
 * 字撤不掉、反倒把更早的结构动作撤了（用户实测）。现在改成「直接试着撤」——
 * `dispatchCommand(UNDO_COMMAND)` 自己会返回有没有撤成（成功 true / 没得撤 false），
 * 拿它的返回值当唯一判据，不再依赖任何查询命令。
 */
export type UndoOwner = 'typing' | 'domain'

/** 按键先往哪边送：`domain` = 直接领域撤销；`lexical-then-domain` = 先让 Lexical 试，撤不动再退回领域。 */
export type UndoRoute = 'domain' | 'lexical-then-domain'

export function routeUndo(input: { owner: UndoOwner }): UndoRoute {
  return input.owner === 'domain' ? 'domain' : 'lexical-then-domain'
}

export function routeRedo(input: { owner: UndoOwner }): UndoRoute {
  return input.owner === 'domain' ? 'domain' : 'lexical-then-domain'
}

/** 撤销/重做之后 `owner` 交还给 `typing`：此刻最近的一次改动已经是敲进去的字了。 */
export const OWNER_AFTER_HISTORY: UndoOwner = 'typing'

/**
 * 这次编辑器更新属于哪一边（docs/04 §5 的分类依据）。
 * 结构性更新都带 `moqi-` 前缀的标签（`moqi-enter` / `moqi-type` / `moqi-outline` …）；
 * 纯字符输入不带标签；Lexical 自己的撤销重放带 `historic`。整篇重载（`moqi-load`）两边都不算。
 */
export function ownerOfUpdate(tags: Iterable<string>): UndoOwner | null {
  const list = [...tags]
  if (list.includes('moqi-load')) return null
  return list.some((tag) => tag.startsWith('moqi-')) ? 'domain' : 'typing'
}
