import type { Block, BlockMap, BlockType, ContentFragment } from '../domain/block'
import type { Transaction } from '../domain/operation'

/**
 * 结构型领域入口（M4）：`DomainStore` 住应用层（`app/src/application/store.ts`），
 * 编辑器包不 import 应用层——这里按「块命令 / 镜像实际用到的方法」定义结构类型，
 * `DomainStore` 天然可赋值给它（方法签名逐一对齐）。
 */
export type EditorStoreHandle = {
  get(blockId: string): Block | undefined
  read(): BlockMap
  snapshot(): BlockMap
  subtree(pageId: string): BlockMap
  apply(input: Omit<Transaction, 'inverse'>): void
  applyMirror(input: Omit<Transaction, 'inverse'>): void
  indent(blockId: string): boolean
  outdent(blockId: string): boolean
  move(blockId: string, newParentId: string | null, newIndex: number): boolean
  convertType(blockId: string, nextType: BlockType, nextContent?: ContentFragment[], options?: { mirror?: boolean; checked?: boolean }): string[] | null
}
