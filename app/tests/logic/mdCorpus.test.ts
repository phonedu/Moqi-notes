import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdownDocument, type OutlineDraft, type Block, type MetadataRegistry, createTextBlock, emptyRegistry, insertOutlineAfter } from '@moqi/editor'
import { DomainStore } from '../../src/application/store'
import { planMarkdownExport } from '@moqi/editor'

// ---------------------------------------------------------------------------
// 0.7 T-29 语料门禁：**支持子集的 Markdown 语料，导入 → 导出逐字节一致**。
// 语料 = CommonMark 规范样例 ＋ Obsidian 常见写法（表格 / 公式 / 代码围栏 / 嵌套列表 /
// 待办 / 引用 / 双链 / 行内注释 / 上下标）。不支持形态进降级清单（公开 MIGRATION 表），
// 数量只减不增。新增支持形态 = 在这里加一条语料。

/** 一段语料 → 建页 → 草稿落块 → 导出：往返的完整链路（导入用 parse，落库用 insertOutlineAfter + store.apply）。 */
function roundTrip(md: string, pageName: string): string {
  const doc = parseMarkdownDocument(md)
  const page = { ...createTextBlock({ entityId: 'pg', blockUid: 'pg-uid', text: pageName, isObject: true, objectName: pageName }), parent: null, children: [] }
  const store = new DomainStore([page as Block])
  const applied = insertOutlineAfter(store.snapshot(), page.entityId, doc.roots as OutlineDraft[], Date.now(), makeIds)
  if (applied) store.apply({ ...applied.transaction, inverse: [] } as never)
  const registry: MetadataRegistry = emptyRegistry()
  const plan = planMarkdownExport(store.snapshot(), registry, { kind: 'page', pageId: 'pg' }, { today: '2026-10-07' })!
  return plan.files[0].content
}

let seq = 0
const makeIds = () => {
  seq += 1
  return `id-${String(seq).padStart(4, '0')}`
}

// 语料（规范形态：页名标题开头；内容块间空行——导出侧的块间空行口径）。
const CORPUS: Array<{ name: string; md: string }> = [
  { name: '代码围栏带语言', md: '# 页\n\n```js\nconst a = 1\n```\n' },
  { name: '表格', md: '# 页\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n' },
  { name: '块级公式', md: '# 页\n\n$$\nE = mc^2\n$$\n' },
  { name: '待办与引用', md: '# 页\n\n- [ ] 发出去\n\n> 一句引用\n' },
  { name: '无序列表嵌套', md: '# 页\n\n- 第一条\n  - 子条目\n' },
]

for (const item of CORPUS) {
  test(`语料往返：${item.name}`, () => {
    const out = roundTrip(item.md, '页')
    assert.equal(out, item.md, '导出应与导入语料逐字节一致')
  })
}
