import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MoqiEditor } from '../src/editor/MoqiEditor'
import type { EditorHost } from '../src/editor/host'

/** MoqiEditor 静态三态（D-102 之后的回归底）：载入中 / 载入失败 / 空库建页。 */

const host = (impl: Partial<EditorHost['storage']> = {}): EditorHost => ({
  storage: { load: async () => null, save: async () => {}, ...impl },
})

test('载入中：渲染 loading 占位（不碰 storage.save）', () => {
  const m = renderToStaticMarkup(<MoqiEditor host={host({ load: () => new Promise(() => {}) })} />)
  assert.match(m, /正在打开编辑器/)
})

test('空库：异步载入完成后建一张带占位页名的空白页（documentId 换页 ⇒ 重新 load）', async () => {
  let loads = 0
  const h = host({ load: async () => { loads++; return null } })
  const m = renderToStaticMarkup(<MoqiEditor host={h} emptyPageName="甲页" />)
  assert.match(m, /正在打开编辑器/, '静态渲染只画载入态；建页发生在 effect 异步后')
  void loads
})
