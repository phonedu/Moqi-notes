import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTextBlock, textContent, type Block } from '@moqi/editor'
import { DomainStore } from '../../src/application/store'
import { AiService } from '../../src/application/aiService'
import { OpenAICompatibleAIPort, StubAIPort, parseItems } from '../../src/adapters/ai'
import { validateBlockGraph } from '@moqi/editor'
import { aiSourceLabel, aiSourcePlan, resolveAiAnchor } from '@moqi/editor'

// T18 L 类（LTP）：黄金数据集 + 行为契约 + 快照回归 + 自动逻辑报告。
// 全部使用 StubAIPort，真实网络调用不进测试；确定性输入输出便于快照对比。

type GoldenSample = { id: string; name: string; scenario: string; notes: string[] }

// Node 20.10 (the supported desktop runtime) does not expose import.meta.dirname.
// Resolve from the module URL so the contract test works consistently in Node 20.x.
const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = resolve(HERE, '../../fixtures/golden_data')
const SNAPSHOT_PATH = resolve(HERE, '../../fixtures/snapshots/ai_golden.snapshot.json')
const REPORT_PATH = resolve(HERE, '../../fixtures/logic/ai-logic-report.md')

function writePreservingEol(path: string, content: string) {
  const eol = existsSync(path) && readFileSync(path, 'utf8').includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(path, content.replace(/\n/g, eol))
}

function loadGolden(): GoldenSample[] {
  return readdirSync(GOLDEN_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')) as GoldenSample)
}

function storeFromSample(sample: GoldenSample): DomainStore {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const blocks: Block[] = [page]
  sample.notes.forEach((text, index) => {
    const block = createTextBlock({ entityId: `s${index}`, blockUid: `s${index}000000`, text, parent: 'page' })
    blocks.push(block)
    page.children.push(block.entityId)
  })
  return new DomainStore(blocks)
}

function sourceIds(sample: GoldenSample): string[] {
  return sample.notes.map((_, index) => `s${index}`)
}

async function generate(sample: GoldenSample, action: 'summary' | 'actions', options: ConstructorParameters<typeof StubAIPort>[0]) {
  const store = storeFromSample(sample)
  const sources = sourceIds(sample)
  const service = new AiService(new StubAIPort(options))
  const result = await service.run(action, sources, sample.notes.join('\n'), new AbortController().signal)
  return { store, sources, result }
}

function insertProposal(store: DomainStore, sources: string[], action: 'summary' | 'actions', proposal: { items: string[]; status: 'complete' | 'needs-confirmation'; confidence?: number; request: { provider: string; model: string; requestedAt: number } }) {
  return store.insertAiResults({ sourceIds: sources, action, items: proposal.items, status: proposal.status, confidence: proposal.confidence, request: proposal.request })
}

test('L1: 黄金数据集覆盖正常路径、边界与困难场景', () => {
  const samples = loadGolden()
  assert.ok(samples.length >= 7, `黄金数据应≥7 条，当前 ${samples.length}`)
  for (const sample of samples) {
    assert.ok(sample.id && sample.name && sample.scenario, `样本字段缺失: ${sample.id}`)
    assert.ok(Array.isArray(sample.notes), `样本 notes 必须是数组: ${sample.id}`)
  }
  const ids = samples.map((sample) => sample.id)
  assert.deepEqual(ids, [...ids].sort(), '黄金数据必须按 id 稳定排序')
})

test('L2: 每段结果可溯源到来源素材，且不发明素材之外的内容', async () => {
  const samples = loadGolden().filter((sample) => sample.notes.length > 0)
  for (const sample of samples) {
    for (const action of ['summary', 'actions'] as const) {
      const { store, sources, result } = await generate(sample, action, { confidence: 0.9, status: 'complete' })
      assert.equal(result.ok, true)
      if (!result.ok) continue
      const blockIds = insertProposal(store, sources, action, result.proposal) ?? []
      if (blockIds.length === 0) continue
      const material = sample.notes.join('\n')
      for (const blockId of blockIds) {
        const block = store.get(blockId)!
        const meta = block.aiMeta!
        assert.ok(meta.sourceBlockIds.length > 0, `${sample.id} 结果缺少来源标注`)
        for (const sourceId of meta.sourceBlockIds) assert.ok(sources.includes(sourceId), `${sample.id} 来源越界: ${sourceId}`)
        const item = textContent(block).replace(/^（stub (?:总结|行动项)）/, '').trim()
        assert.ok(item.length > 0, `${sample.id} 生成了空内容`)
        assert.ok(material.includes(item), `${sample.id} 结果含素材之外的内容: ${item}`)
      }
    }
  }
})

test('L2: 流式生成逐段回调，最终提案与一元生成一致', async () => {
  const sample = loadGolden()[0]
  const store = storeFromSample(sample)
  const sources = [...store.snapshot().keys()]
  const service = new AiService(new StubAIPort({ items: ['第一段内容', '第二段内容', '第三段内容'], confidence: 0.9, status: 'complete' }))
  const deltas: string[] = []
  const result = await service.runStream('summary', sources, sample.notes.join('\n'), new AbortController().signal, (delta) => deltas.push(delta))
  assert.equal(result.ok, true)
  assert.ok(deltas.length > 1, '流式应产生多次增量，而不是一次性返回')
  if (!result.ok) return
  assert.equal(deltas.join(''), result.proposal.items.join('\n'))
})

test('L2: 停止流式保留已生成部分，不补全也不改写', async () => {
  const sample = loadGolden()[0]
  const store = storeFromSample(sample)
  const sources = [...store.snapshot().keys()]
  const full = '一段较长的生成内容用于中断测试'
  const service = new AiService(new StubAIPort({ items: [full], delayMs: 20, chunkSize: 2 }))
  const controller = new AbortController()
  let partial = ''
  const pending = service.runStream('summary', sources, sample.notes.join('\n'), controller.signal, (delta) => {
    partial += delta
    // 收到第一批增量后立刻停止，模拟用户点「■ 停止」。
    if (partial.length >= 2) controller.abort()
  })
  const result = await pending
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.cancelled, true)
  assert.ok(partial.length > 0, '中断前的增量必须已经落到调用方')
  assert.ok(full.startsWith(partial), '保留的必须是已生成部分')
})

test('L2: 结果作为新 Block 插入，来源原文与结构保持不变', async () => {
  for (const sample of loadGolden().filter((item) => item.notes.length > 0)) {
    const { store, sources, result } = await generate(sample, 'summary', { confidence: 0.9, status: 'complete' })
    assert.equal(result.ok, true)
    if (!result.ok) continue
    const project = () => JSON.stringify(sources.map((id) => {
      const block = store.get(id)!
      return { content: block.content, children: block.children, type: block.type, checked: block.checked, deleted: block.deleted }
    }))
    const before = project()
    const beforeChildren = [...store.get('page')!.children]
    insertProposal(store, sources, 'summary', result.proposal)
    assert.equal(project(), before, `${sample.id} 修改了来源原文`)
    assert.deepEqual(store.get('page')!.children.slice(0, beforeChildren.length), beforeChildren, `${sample.id} 改变了根级顺序`)
    assert.equal(validateBlockGraph(store.snapshot()).length, 0)
  }
})

test('L2: 总结产出单个 text Block，行动项产出多个连续且未完成的 todo Block', async () => {
  const sample = loadGolden().find((item) => item.id === '02_medium')!
  const summary = await generate(sample, 'summary', { confidence: 0.9, status: 'complete' })
  assert.equal(summary.result.ok, true)
  if (summary.result.ok) {
    const ids = insertProposal(summary.store, summary.sources, 'summary', summary.result.proposal) ?? []
    assert.equal(ids.length, 1)
    assert.equal(summary.store.get(ids[0])!.type, 'text')
    assert.equal(summary.store.get(ids[0])!.aiMeta!.action, 'summary')
  }

  const actions = await generate(sample, 'actions', { confidence: 0.9, status: 'complete' })
  assert.equal(actions.result.ok, true)
  if (actions.result.ok) {
    const ids = insertProposal(actions.store, actions.sources, 'actions', actions.result.proposal) ?? []
    assert.ok(ids.length >= 2)
    const parent = actions.store.get(ids[0])!.parent
    const siblings = actions.store.get(parent!)!.children
    const positions = ids.map((id) => siblings.indexOf(id)).sort((a, b) => a - b)
    assert.deepEqual(positions, positions.map((_, index) => positions[0] + index), '行动项必须连续')
    for (const id of ids) {
      assert.equal(actions.store.get(id)!.type, 'todo')
      assert.equal(actions.store.get(id)!.checked, false)
      assert.equal(actions.store.get(id)!.aiMeta!.action, 'actions')
    }
  }
})

test('L2: 矛盾样本保留两种陈述，不静默择一', async () => {
  const sample = loadGolden().find((item) => item.id === '03_conflict')!
  const { result } = await generate(sample, 'actions', { confidence: 0.9, status: 'complete' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.ok(result.proposal.items.some((item) => item.includes('本周五上线')), '丢失第一条陈述')
  assert.ok(result.proposal.items.some((item) => item.includes('推迟到下周上线')), '丢失第二条陈述')
})

test('L2: 低置信度或来源不足降级为 needs-confirmation', async () => {
  const sample = loadGolden().find((item) => item.id === '05_isolated')!

  const missing = await generate(sample, 'summary', { status: 'complete' })
  assert.equal(missing.result.ok, true)
  assert.equal(missing.result.ok ? missing.result.proposal.status : '', 'needs-confirmation', '无置信度必须降级')

  const low = await generate(sample, 'summary', { status: 'complete', confidence: 0.3 })
  assert.equal(low.result.ok ? low.result.proposal.status : '', 'needs-confirmation', '低置信度必须降级')

  const confident = await generate(sample, 'summary', { status: 'complete', confidence: 0.9 })
  assert.equal(confident.result.ok ? confident.result.proposal.status : '', 'complete')

  const explicit = await generate(sample, 'summary', { status: 'needs-confirmation', confidence: 0.9 })
  assert.equal(explicit.result.ok ? explicit.result.proposal.status : '', 'needs-confirmation', '显式降级必须保留')
})

test('L2: 来源缺失或失败时不产生任何结果，且不修改原文', async () => {
  const empty = loadGolden().find((item) => item.id === '07_missing')!
  const { store, sources, result } = await generate(empty, 'summary', { confidence: 0.9, status: 'complete' })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(insertProposal(store, sources, 'summary', result.proposal), null, '无来源必须 no-op')
  }
  assert.deepEqual(store.get('page')!.children, [], 'no-op 不得产生残留 Block')

  const failing = new AiService(new StubAIPort({ failWith: '模型不可用' }))
  const failed = await failing.run('summary', ['s0'], '内容', new AbortController().signal)
  assert.deepEqual(failed, { ok: false, cancelled: false, error: '模型不可用' })
  assert.equal(store.get('s0'), undefined, '失败不得写入新 Block')
})

async function snapshotRecords() {
  const records: Array<{ id: string; action: 'summary' | 'actions'; status: string; items: string[] }> = []
  for (const sample of loadGolden()) {
    for (const action of ['summary', 'actions'] as const) {
      const { result } = await generate(sample, action, { confidence: 0.9, status: 'complete' })
      if (result.ok) records.push({ id: sample.id, action, status: result.proposal.status, items: result.proposal.items })
    }
  }
  return records
}

test('L3: 黄金数据集输出与快照一致（有意变更需更新快照并记录原因）', async () => {
  const records = await snapshotRecords()
  const current = `${JSON.stringify(records, null, 2)}\n`
  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true })
  if (!existsSync(SNAPSHOT_PATH) || process.env.UPDATE_AI_SNAPSHOT === '1') {
    writePreservingEol(SNAPSHOT_PATH, current)
  }
  assert.equal(readFileSync(SNAPSHOT_PATH, 'utf8').replace(/\r\n/g, '\n'), current, 'L3 快照不一致：无意变更需修复，有意变更请设置 UPDATE_AI_SNAPSHOT=1 并记录原因')
})

test('L4: 生成 AI 逻辑报告（当前行为 + 契约检查表 + 快照）', async () => {
  const samples = loadGolden()
  const records = await snapshotRecords()
  const count = (id: string, action: 'summary' | 'actions') => records.find((record) => record.id === id && record.action === action)?.items.length ?? 0
  const lines = [
    '# AI 逻辑测试报告（L4，自动生成）',
    '',
    '> 由 `app/tests/logic/ai.contract.test.ts` 自动生成，请勿手工编辑。命令：`pnpm test` 或 `UPDATE_AI_SNAPSHOT=1 pnpm test`。',
    '',
    '## 当前行为',
    '',
    '| 样本 | 场景 | 输入 Blocks | 总结条数 | 行动项条数 | 状态 |',
    '|---|---|---|---|---|---|',
    ...samples.map((sample) => `| ${sample.id} | ${sample.scenario} | ${sample.notes.length} | ${count(sample.id, 'summary')} | ${count(sample.id, 'actions')} | ${records.find((record) => record.id === sample.id)?.status ?? '-'} |`),
    '',
    '## 契约检查表',
    '',
    '- [x] 每段结果可溯源到来源素材（`aiMeta.sourceBlockIds` 非空且属于输入来源）',
    '- [x] 不发明素材之外的内容（结果文本是来源文本的子串）',
    '- [x] 原文与根级结构保持不变',
    '- [x] 总结 = 单个 `text`；行动项 = 多个连续 `todo` 且 `checked=false`',
    '- [x] 矛盾样本保留两种陈述',
    '- [x] 低置信度 / 来源不足降级为 `needs-confirmation`',
    '- [x] 失败或来源缺失时不产生结果、不改原文',
    '',
    '## 快照',
    '',
    '`app/fixtures/snapshots/ai_golden.snapshot.json` 与本次运行输出一致。',
    '',
    '## 变更历史',
    '',
    '- 2026-09-24：首次建立，覆盖 7 条黄金样本与上述契约。',
    '',
  ].join('\n')
  mkdirSync(dirname(REPORT_PATH), { recursive: true })
  writePreservingEol(REPORT_PATH, lines)
  assert.ok(existsSync(REPORT_PATH))
})

test('L2: 来源是页面块本身时，AI 结果落进页面内部而不是成为新的根块', () => {
  // 种子里只有一个页面块（无子块）——这正是「页面块作为来源」的场景。
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '正文', isObject: true, objectName: '页面' })
  const store = new DomainStore([page])
  const ids = store.insertAiResults({ sourceIds: ['page'], action: 'summary', items: ['总结内容'], status: 'complete', confidence: 0.9 })
  assert.ok(ids && ids.length === 1)
  const inserted = store.get(ids[0])!
  assert.equal(inserted.parent, 'page', 'AI 结果必须是页面的子块')
  assert.deepEqual(store.get('page')!.children, ids, '页面 children 必须包含 AI 结果')
  assert.equal(store.snapshot().size, 2, '不应产生第三个根块')
  assert.deepEqual([...store.snapshot().values()].filter((block) => block.parent === null).map((block) => block.entityId), ['page'])
  assert.deepEqual(validateBlockGraph(store.snapshot()), [])
})

test('L2: 来源是页面子块时，AI 结果插在该子块之后（保持既有语义）', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', isObject: true, objectName: '页面' })
  const first = createTextBlock({ entityId: 'b1', blockUid: 'b1000001', text: '第一段', parent: 'page' })
  const second = createTextBlock({ entityId: 'b2', blockUid: 'b2000001', text: '第二段', parent: 'page' })
  page.children = ['b1', 'b2']
  const store = new DomainStore([page, first, second])
  const ids = store.insertAiResults({ sourceIds: ['b1'], action: 'summary', items: ['总结内容'], status: 'complete', confidence: 0.9 })!
  assert.equal(store.get(ids[0])!.parent, 'page')
  assert.deepEqual(store.get('page')!.children, ['b1', ids[0], 'b2'], '结果应紧跟来源子块')
})

test('L2: AI 结果落点按「选中块 > 光标块 > 正文最后一块」（R09-AIB-6）', () => {
  // 重新生成：原地更新那个块，不新建
  assert.equal(resolveAiAnchor({ targetBlockId: 'ai-1', selected: ['b1'], caretBlockId: 'b2', sources: ['b1', 'b2'] }), 'ai-1')
  // 按块多选：落在**最后选中的块**（不是光标块，也不是文章末尾）
  assert.equal(resolveAiAnchor({ selected: ['b1', 'b2'], caretBlockId: 'b3', sources: ['b1', 'b2'] }), 'b2')
 // 整篇问答 / 只有文字选区：落在**光标块**——读整篇不等于落在篇末（用户 实测）
  assert.equal(resolveAiAnchor({ selected: [], caretBlockId: 'b3', sources: ['b1', 'b2', 'b9'] }), 'b3')
  // 光标不在本页（调用方传 null）：回落到最后一个来源块
  assert.equal(resolveAiAnchor({ selected: [], caretBlockId: null, sources: ['b1', 'b2', 'b9'] }), 'b9')
})

test('L2: 指定 anchorId 时 AI 结果落在该块之后（读整篇也落光标块，R09-AIB-6）', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const first = createTextBlock({ entityId: 'b1', blockUid: 'b1000001', text: '第一块', parent: 'page' })
  const middle = createTextBlock({ entityId: 'b2', blockUid: 'b2000001', text: '第二块', parent: 'page' })
  const last = createTextBlock({ entityId: 'b3', blockUid: 'b3000001', text: '第三块', parent: 'page' })
  page.children = ['b1', 'b2', 'b3']
  const store = new DomainStore([page, first, middle, last])
  // 来源是整篇（面板「基于本篇」），落点指定为**光标块**（第二块）
  const ids = store.insertAiResults({
    sourceIds: ['page'],
    action: 'summary',
    items: ['总结内容'],
    status: 'complete',
    confidence: 0.9,
    anchorId: 'b2',
  })
  assert.ok(ids && ids.length === 1)
  assert.equal(store.get(ids[0])!.parent, 'page', '结果落进页面内部')
  assert.deepEqual(store.get('page')!.children, ['b1', 'b2', ids[0], 'b3'], '结果插在光标块（第二块）之后，不是文章末尾')
  assert.deepEqual(validateBlockGraph(store.snapshot()), [])
})

test('L2: 入口 → 读什么：块选中 > 光标/文字选区所在块 > 整篇（R09-AIB-6）', () => {
  // 块工具栏 / 把手多选：读选中的块，落点也按「选中块」档位（byBlockSelection）
  assert.deepEqual(aiSourcePlan({ selectedBlocks: ['b1', 'b2'], caretBlockId: 'b9', pageId: 'page' }), { sourceIds: ['b1', 'b2'], scope: 'selection', byBlockSelection: true })
  // 文本选中工具栏：读「选中文字所在块」——不是整篇，也不是「选中了页面容器」
  assert.deepEqual(aiSourcePlan({ caretBlockId: 'b2', pageId: 'page' }), { sourceIds: ['b2'], scope: 'selection', byBlockSelection: false })
  // AI 助手面板「基于本篇」：读整篇（标签说「基于全篇」，不是「基于本段」）
  assert.deepEqual(aiSourcePlan({ pageId: 'page' }), { sourceIds: ['page'], scope: 'page', byBlockSelection: false })
  // 什么都没有（没光标、没整篇）：空声明，由调用方兜底
  assert.deepEqual(aiSourcePlan({}), { sourceIds: [], scope: 'page', byBlockSelection: false })
  // 口径与素材必须同源：整篇入口的标签读出来是「基于全篇」
  const plan = aiSourcePlan({ pageId: 'page' })
  assert.equal(aiSourceLabel({ sourceCount: plan.sourceIds.length, scope: plan.scope }), '基于全篇')
})

test('L2: 文本选区那一路的标签与落点', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const b1 = createTextBlock({ entityId: 'b1', blockUid: 'b1000001', text: '第一块', parent: 'page' })
  const b2 = createTextBlock({ entityId: 'b2', blockUid: 'b2000001', text: '第二块（选中这里的字）', parent: 'page' })
  const b3 = createTextBlock({ entityId: 'b3', blockUid: 'b3000001', text: '第三块', parent: 'page' })
  page.children = ['b1', 'b2', 'b3']
  const store = new DomainStore([page, b1, b2, b3])
  const plan = aiSourcePlan({ caretBlockId: 'b2', pageId: 'page' })
  assert.equal(aiSourceLabel({ sourceCount: plan.sourceIds.length, scope: plan.scope }), '基于本段')
  const anchor = resolveAiAnchor({ selected: plan.byBlockSelection ? plan.sourceIds : [], caretBlockId: 'b2', sources: plan.sourceIds })
  assert.equal(anchor, 'b2', '落点是选中文字所在块')
  const ids = store.insertAiResults({ sourceIds: plan.sourceIds, action: 'summary', items: ['总结内容'], status: 'complete', confidence: 0.9, anchorId: anchor, sourceScope: plan.scope })!
  assert.deepEqual(store.get('page')!.children, ['b1', 'b2', ids[0], 'b3'], '结果插在该块之后，不是文章末尾')
  assert.deepEqual(store.get(ids[0])!.aiMeta?.sourceBlockIds, ['b2'])
  assert.equal(store.get(ids[0])!.aiMeta?.sourceScope, 'selection')
})
test('L2: AI 块的来源文案说范围、不数块数（R09-AIB-7）', () => {
  assert.equal(aiSourceLabel({ sourceCount: 1, scope: 'selection' }), '基于本段')
  assert.equal(aiSourceLabel({ sourceCount: 3, scope: 'selection' }), '基于选中的 3 段')
  assert.equal(aiSourceLabel({ sourceCount: 12, scope: 'page' }), '基于全篇')
  assert.equal(aiSourceLabel({ sourceCount: 1 }), '基于本段', '缺省按选中口径')
})

// D-019（，顺着 E3 材料「换角度」那条格式破损查出来的）：解析行首列表符时**不能吃正文**。
// 旧正则 `[-*•]\s*` 允许列表符后跟**零个**空白 ⇒ 行首 `**能写**` → `*能写**`（E3 那条输出三行全中）、
// `1.5 倍` → `5 倍`、`2026.10.05` → `10.05`。口径：`-` / `*` / `•` 后必须跟空白；`数字.` 后不能跟数字。
test('D-019: parseItems —— 行首加粗 / 小数 / 日期不得被当成列表符吃掉，真列表符照常剥掉', () => {
  const cases: Array<[string, string]> = [
    // 保留：这些都是正文
    ['**能写**（0.2）：先解决「记下来」的基础动作', '**能写**（0.2）：先解决「记下来」的基础动作'],
    ['*斜体*开头的一行', '*斜体*开头的一行'],
    ['1.5 倍速播放', '1.5 倍速播放'],
    ['2026.10.05 的日记', '2026.10.05 的日记'],
    ['-5 度就是负五度', '-5 度就是负五度'],
    // 剥掉：模型自带的列表符 / 编号
    ['- 列表项', '列表项'],
    ['* 列表项', '列表项'],
    ['• 列表项', '列表项'],
    ['1. 编号项', '编号项'],
    ['2、编号项', '编号项'],
    ['10) 编号项', '编号项'],
  ]
  for (const [input, expected] of cases) assert.deepEqual(parseItems('polish', input), [expected], `单行被改坏：${input}`)
  // E3 材料原样复现：两条行首加粗 + 一条小数原样保留，真列表符照剥——修的是「吃正文」，不是「不剥符」
  assert.deepEqual(
    parseItems('reframe', '**能写**（0.2）\n1.5 倍速\n- 真列表项'),
    ['**能写**（0.2）', '1.5 倍速', '真列表项'],
  )
  // summary / ask 不拆行：整体 trim，不做行首剥符
  assert.deepEqual(parseItems('summary', '**加粗**\n原文'), ['**加粗**\n原文'])
})

// 提示词的唯一真源 = 下方 `SYSTEM_PROMPTS`。
test('D-094: AI 请求失败时透传服务端原文并按状态码给可操作指引（模型名写错不再只报裸状态码）', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify({ error: { message: 'Model Not Exist' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const port = new OpenAICompatibleAIPort({ baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: '不存在的模型' }, fetchImpl)
  const proposal = port.generate({ action: 'summary', text: '内容', sources: [] }, new AbortController().signal)
  await assert.rejects(proposal, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    assert.match(message, /HTTP 404/, '状态码要在')
    assert.match(message, /Model Not Exist/, '服务端原文要在（不猜原因，原文最可靠）')
    assert.match(message, /模型名/, '404/400 要给「检查模型名与服务地址」的指引')
    return true
  })
  // 401 = 密钥错，指引指向密钥
  const fetch401 = (async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })) as unknown as typeof fetch
  const port401 = new OpenAICompatibleAIPort({ baseUrl: 'https://api.example.com/v1', apiKey: 'bad', model: 'm' }, fetch401)
  await assert.rejects(port401.generate({ action: 'summary', text: '内容', sources: [] }, new AbortController().signal), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    assert.match(message, /密钥/, '401/403 要给「检查密钥」的指引')
    return true
  })
  // 非 JSON 错误体：只报状态码，不抛解析错
  const fetch500 = (async () => new Response('gateway timeout', { status: 500 })) as unknown as typeof fetch
  const port500 = new OpenAICompatibleAIPort({ baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm' }, fetch500)
  await assert.rejects(port500.generate({ action: 'summary', text: '内容', sources: [] }, new AbortController().signal), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    assert.match(message, /HTTP 500$/)
    assert.doesNotMatch(message, /Unexpected/, '非 JSON 响应体不得抛解析错误')
    return true
  })
})
