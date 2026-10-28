import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainStore } from '../../src/application/store'
import { createTextBlock, textContent, type BlockMap, type BlockType } from '@moqi/editor'
import { planMarkdownExport } from '@moqi/editor'
import { parseMarkdownDocument, type OutlineDraft } from '@moqi/editor'
import { isStructuralCode, validateBlockGraph } from '@moqi/editor'

/**
 * **属性 / 模糊测试**（2026-10-11，`PROP-MD-1` / `PROP-STORE-1`）：不枚举用例，而是拿
 * **随机生成**的输入去打两条最容易出边界问题的链——
 *
 * - `PROP-MD-1`：随机块树 → 导出 `.md` → 导回来（`parseMarkdownDocument`）。属性 = **不丢字 /
 *   不添字 / 顺序不变**（文档序文本序列相等）。记号转义、续行缩进、嵌套这些"手写用例枚举不完"的
 *   组合，交给随机；种子固定 ⇒ 失败可复现（打印 seed 与 round）。
 * - `PROP-STORE-1`：随机操作序列（插入 / 类型转换 / 移动 / 撤销 / 重做）打进 `DomainStore`。
 *   属性 = **每一步之后结构性不变量都成立**（`validateBlockGraph` 过滤到结构性码后必须为空）。
 *
 * 为什么手写 RNG 不引依赖：项目对新增依赖谨慎（`pinyin-pro` 是因为词库不得不引）；一个 LCG +
 * 固定种子就够"可复现的随机"，失败时 seed 一贴就能重跑。
 *
 * 生成器尊重产品自己的不变量（不是抽查的漏网口）：**块内换行只允许出现在代码块**（`G-06` 裁决），
 * **缩进代码块不可辨**是互通册登记的固有边界 ⇒ 代码块只生成在顶层。
 */

/** 确定性随机（LCG）：同 seed 必得同一序列。 */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

function pick<T>(r: () => number, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)] as T
}

// ---------- PROP-MD-1：随机树 → 导出 → 导回，文本不丢 ----------

const MD_TYPES: BlockType[] = ['text', 'heading1', 'heading2', 'heading3', 'heading5', 'bullet', 'numbered', 'quote', 'todo']

/** 记号密集的字表：把转义 / 续行 / 前缀识别这些规则往死里撞。 */
const GLYPHS = [...'中文abc去', '#', '*', '_', '~', '`', '[', ']', '(', ')', '<', '>', '|', '\\', '-', '+', '.', '!', ':', ' ']

function randomText(r: () => number, maxLen: number, allowNewline: boolean): string {
  const length = Math.floor(r() * maxLen)
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out += r() < 0.04 && allowNewline ? '\n' : pick(r, GLYPHS)
  }
  return out
}

function randomOutline(r: () => number, depth: number): OutlineDraft[] {
  const count = Math.floor(r() * (depth === 0 ? 5 : 3))
  const drafts: OutlineDraft[] = []
  for (let index = 0; index < count; index += 1) {
    // 代码块只放顶层（缩进 / 引用里的围栏是互通册登记的固有边界）——其余类型任意层。
    const type = r() < 0.12 && depth === 0 ? 'code' : pick(r, MD_TYPES)
    drafts.push({
      type,
      text: randomText(r, 26, type === 'code'),
      children: depth < 2 && r() < 0.4 ? randomOutline(r, depth + 1) : [],
    })
  }
  return drafts
}

/** 文档序文本序列（过滤纯空——空块在导出侧合法地被跳过；丢了**非空**文字才会露馅）。 */
function flattenBlocks(blocks: BlockMap, rootId: string): string[] {
  const out: string[] = []
  const walk = (id: string): void => {
    const block = blocks.get(id)
    if (!block) return
    out.push(textContent(block))
    for (const child of block.children) walk(child)
  }
  walk(rootId)
  return out.filter((text) => text !== '')
}

function flattenDrafts(drafts: OutlineDraft[]): string[] {
  const out: string[] = []
  const walk = (list: OutlineDraft[]): void => {
    for (const draft of list) {
      out.push(draft.text)
      walk(draft.children)
    }
  }
  walk(drafts)
  return out.filter((text) => text !== '')
}

/**
 * 比较口径：**非空白字符序列**。行首尾空白是 Markdown 行语义消化掉的东西（`-  )` 读回 `)`、
 * 行尾空格本就被 `trimEnd` 收掉）——那是既定的行语义，不是"丢字"；丢 / 添**非空白**字符才是。
 * 纯空白行同时被两侧过滤（空块合法跳过）。
 */
const visible = (entries: string[]): string[] => entries.map((text) => text.trim()).filter((text) => text !== '')

test('PROP-MD-1 随机块树 × 导出 → 导回：文本不丢、不添、顺序不变（24 棵随机树，种子固定）', () => {
  const SEED = 20261011
  const r = rng(SEED)
  for (let round = 0; round < 24; round += 1) {
    const store = new DomainStore([])
    const created = store.insertDocumentAsPage(randomOutline(r, 0), `属性页 ${round}`)
    assert.ok(created, `seed=${SEED} round=${round}：随机树建页失败`)
    const plan = planMarkdownExport(store.snapshot(), { properties: [], tags: [] }, { kind: 'page', pageId: created.pageId }, { today: '2026-10-11' })
    assert.ok(plan, `seed=${SEED} round=${round}：导出计划为空`)
    const markdown = plan.files[0]!.content
    const parsed = parseMarkdownDocument(markdown)
    // 页名走**页名通道**：导出把页面名写成 `# 名`，导入按设计把它摘成 `doc.name`（不是正文块）——
    // 所以回读序列 = 页名 ＋ 正文（`03` 与 `13-导入导出互通（Obsidian 对齐）` 的既定口径，不是这条属性要抓的丢字）。
    const roundTrip = parsed.name !== null ? [parsed.name, ...flattenDrafts(parsed.roots)] : flattenDrafts(parsed.roots)
    assert.deepEqual(
      visible(roundTrip),
      visible(flattenBlocks(store.snapshot(), created.pageId)),
      `seed=${SEED} round=${round}：往返文本序列不一致（丢字 / 添字 / 顺序变了）`,
    )
  }
})

// ---------- PROP-STORE-1：随机操作序列 × 结构性不变量 ----------

test('PROP-STORE-1 随机操作序列打进 DomainStore：每一步之后结构性不变量都成立（400 步，种子固定）', () => {
  const SEED = 424242
  const r = rng(SEED)
  const page = createTextBlock({ entityId: 'pg', blockUid: 'pg000001', text: '属性页', isObject: true, objectName: '属性页' })
  const store = new DomainStore([page])
  let counter = 0

  const liveIds = (): string[] => [...store.read().values()].filter((block) => !block.deleted).map((block) => block.entityId)

  for (let step = 0; step < 400; step += 1) {
    const ids = liveIds()
    const roll = r()
    if (roll < 0.45) {
      const anchor = pick(r, ids)
      store.insertOutline(anchor, [{ type: pick(r, MD_TYPES), text: `块${counter++}`, children: [] }])
    } else if (roll < 0.65) {
      const target = pick(r, ids)
      store.convertType(target, pick(r, MD_TYPES), [{ t: 'text', v: `改${counter++}` }])
    } else if (roll < 0.85) {
      const subject = pick(r, ids)
      const parent = pick(r, [null as string | null, ...ids])
      store.move(subject, parent, Math.floor(r() * 3))
    } else if (roll < 0.93) {
      store.undo()
    } else {
      store.redo()
    }
    const structural = validateBlockGraph(store.read()).filter((issue) => isStructuralCode(issue.code))
    assert.deepEqual(structural, [], `seed=${SEED} step=${step}：结构性不变量被随机序列打破`)
  }
})
