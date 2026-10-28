import assert from 'node:assert/strict'
import test from 'node:test'
import { aiBarVariant, aiBarsFrom, type AiBarSource } from '../../src/ui/aiBars'
import { aiDecorationShown } from '@moqi/editor'

function source(patch: Partial<AiBarSource> = {}): AiBarSource {
  return {
    id: 'ai-1',
    status: 'complete',
    op: '总结',
    src: '来源 1 块',
    rect: { top: 100, left: 700, width: 500, height: 120 },
    padding: { top: 33, right: 16, bottom: 53, left: 16 },
    ...patch,
  }
}

test('AI-BAR-1 AI 行：只有 generating 是生成中，其余状态（完成 / 出错 / 已停止）都出操作条', () => {
  assert.equal(aiBarVariant('generating'), 'generating')
  for (const status of ['complete', 'needs-confirmation', 'error', 'cancelled', '']) {
    assert.equal(aiBarVariant(status), 'done', `${status} 应出操作条`)
  }
})

test('AI 行：行贴在块的内容盒上，位置来自块矩形与内边距', () => {
  const [bar] = aiBarsFrom([source()])
  assert.equal(bar.variant, 'done')
  assert.equal(bar.op, '总结')
  assert.equal(bar.src, '来源 1 块')
  // 标签行在内容盒上沿之外（= 块顶部内边距里），操作行在下沿之外（= 块底端内边距里）。
  assert.deepEqual(bar.box, { top: 133, left: 716, width: 468, height: 34 })
})

test('AI 行：量不出盒子的块（折叠在祖先里 / 未布局）不出现行', () => {
  assert.deepEqual(aiBarsFrom([source({ rect: { top: 0, left: 0, width: 0, height: 0 } })]), [])
  assert.deepEqual(aiBarsFrom([source({ rect: { top: 10, left: 10, width: 500, height: 0 } })]), [])
})

test('AI 行：生成中的块只出标签行，不预留下方的操作条空间', () => {
  const bars = aiBarsFrom([source({ id: 'gen', status: 'generating' }), source({ id: 'done' })])
  assert.deepEqual(bars.map((bar) => bar.id), ['gen', 'done'])
  assert.equal(bars[0].variant, 'generating')
  assert.equal(bars[1].variant, 'done')
})

test('AI 块已接受（accepted）不再有 AI 外观：界面上与普通块完全一样（R09-AIB-5，方案 A）', () => {
  assert.equal(aiDecorationShown({ action: 'summary', status: 'accepted', sourceBlockIds: ['page'] }), false, '采用后不画虚线框、不写 data-ai-*，也没有块角标记')
  assert.equal(aiDecorationShown(null), false, '普通块本来就没有')
  for (const status of ['generating', 'complete', 'needs-confirmation', 'cancelled', 'error'] as const) {
    assert.equal(aiDecorationShown({ action: 'summary', status, sourceBlockIds: ['page'] }), true, `${status} 仍有 AI 外观`)
  }
})
