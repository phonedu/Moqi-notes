/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Block, BlockMap } from '../domain/block'
import type { EditorHost } from './host'

export type MemoryEditorHost = EditorHost & {
  /** 当前内存里的快照（副本）。 */
  read(): Block[]
  /** 已发生的落盘次数（验收 / demo 读数）。 */
  readonly writes: number
  reset(blocks?: Block[]): void
}

/**
 * 浏览器内存宿主（M3）：不碰 Tauri、不落盘，只保存一整份 Block[]。
 * 用于裸 React 页面、demo 与单测；真实宿主可以换成 SQLite / localStorage / 远端。
 */
export function createMemoryEditorHost(seed: Block[] | BlockMap = []): MemoryEditorHost {
  let blocks = clone(Array.isArray(seed) ? seed : [...seed.values()])
  let writes = 0

  const clipboardText = { value: '' }
  return {
    storage: {
      async load() {
        return blocks.length > 0 ? clone(blocks) : null
      },
      async save(next) {
        blocks = clone(next)
        writes += 1
      },
    },
    clipboard: {
      async writeText(text) { clipboardText.value = text },
      async readText() { return clipboardText.value },
    },
    read() { return clone(blocks) },
    get writes() { return writes },
    reset(next = []) {
      blocks = clone(next)
      writes = 0
    },
  }
}

function clone(blocks: Block[]): Block[] {
  return structuredClone(blocks)
}
