import type { Block, BlockMap, ContentFragment } from './block'
import { refLabel } from './refOps'
import { dedupeSelection } from './selectionOps'

/**
 * T6 ⑤（`09-桌面端交互规范` §6.2 `R09-BEDIT-10` / §九 `R09-KEY-21`）：块选中态的「复制 / 剪切 / 复制为块引用」
 * 写给剪贴板的**文本形态**。纯函数、单一所有者——界面只负责把它塞进剪贴板与提示。
 *
 * 两种形态：
 * - `plain`（⌘C / ⌘X 与菜单「复制 / 剪切」）：每个去重后的根一条，子树按层级缩进逐行展开；
 *   行内引用还原成文字形态（`[[页名]]` / `((块名))`），**不丢链**（与导出同一原则，`02`）。
 * - `ref`（菜单「复制为块引用」）：每个根一行 `[[页名]]` / `((块名))`——贴到别处就是一条可读引用，
 *   贴回编辑器则由 `((` / `[[` 那条输入通路认领（识别路径见实施计划 T8 的 MD 输入层）。
 *
 * **有意不是 Markdown 导出格式**：导出（front-matter / 标题层级 / 链接写法）是 V3 的另一件事，
 * 落地时两者应当共用同一个序列化器——登记在`13-编辑器重规划` T6 ⑤，
 * 到那时本文件要么成为它的底层、要么被它取代，不许各写一套。
 */
export type SelectionTextMode = 'plain' | 'ref'

export function selectionAsText(blocks: BlockMap, blockIds: Iterable<string>, mode: SelectionTextMode = 'plain'): string {
  const roots = dedupeSelection(blocks, blockIds)
  if (roots.length === 0) return ''
  const lines: string[] = []
  for (const rootId of roots) {
    const block = blocks.get(rootId)
    if (!block) continue
    if (mode === 'ref') {
      lines.push(refToken(block))
      continue
    }
    collectPlainLines(blocks, rootId, 0, lines)
  }
  return lines.join('\n')
}

/** `((块名))` / `[[页名]]`：与用户手打触发词同一形态（触发词 + 显示名，无空格）。 */
export function refToken(block: Block): string {
  const label = refLabel(block)
  return block.isObject ? `[[${label}]]` : `((${label}))`
}

function collectPlainLines(blocks: BlockMap, blockId: string, depth: number, lines: string[]): void {
  const block = blocks.get(blockId)
  if (!block || block.deleted) return
  lines.push(`${'\t'.repeat(depth)}${plainLine(block)}`)
  for (const childId of block.children) collectPlainLines(blocks, childId, depth + 1, lines)
}

/** 行内文字：`inline-ref` 片段还原成 `((…))` / `[[…]]`（它的 `v` 就是显示名）。 */
function plainLine(block: Block): string {
  return block.content.map((fragment: ContentFragment) => (
    fragment.t === 'inline-ref' ? refTokenFromLabel(fragment) : fragment.v
  )).join('')
}

function refTokenFromLabel(fragment: ContentFragment): string {
  return fragment.ref?.kind === 'object' ? `[[${fragment.v}]]` : `((${fragment.v}))`
}
