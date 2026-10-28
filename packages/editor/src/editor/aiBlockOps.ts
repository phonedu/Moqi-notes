/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { HISTORIC_TAG, type LexicalEditor } from 'lexical'
import type { AiMeta, Block } from '../domain/block'
import { $createBlockNode, $findBlockNode } from './blockNode'

/**
 * AI 块的编辑器写回（模块化 M2-2b）。
 *
 * 领域侧的状态 / 插入事务仍由 `ui/useAiRuntime.ts` 发起；这里只负责把同一份结果镜像到
 * Lexical 节点：状态、落块位置、采用后的 `aiMeta`。全部用 `moqi-ai` + `discrete`，
 * 与流式写回同一条“中间态不进撤销栈”的契约。
 */
export type AiEditorHandle = Pick<LexicalEditor, 'update' | 'getEditorState'>

export function applyAiBlockStatus(editor: AiEditorHandle, blockId: string, status: AiMeta['status']): void {
  editor.update(() => {
    const node = $findBlockNode(blockId)
    if (node?.getAiMeta()) node.setAiMeta({ ...node.getAiMeta()!, status })
  }, { tag: [HISTORIC_TAG, 'moqi-ai'], discrete: true })
}

export function insertAiBlockNode(editor: AiEditorHandle, block: Block, anchorId: string): void {
  editor.update(() => {
    const anchorNode = $findBlockNode(anchorId)
    if (!anchorNode) return
    const newNode = $createBlockNode(block)
    // 与领域落点保持一致：落进页面内部时挂到页面节点下，否则插在锚点之后。
    if (block.parent === anchorId) anchorNode.append(newNode)
    else anchorNode.insertAfter(newNode)
    newNode.selectEnd()
  }, { tag: [HISTORIC_TAG, 'moqi-ai'], discrete: true })
}

export function markAiBlockAccepted(editor: AiEditorHandle, blockId: string): void {
  editor.update(() => {
    const node = $findBlockNode(blockId)
    const meta = node?.getAiMeta()
    if (node && meta) node.setAiMeta({ ...meta, status: 'accepted' })
  }, { tag: [HISTORIC_TAG, 'moqi-ai'], discrete: true })
}
