import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sidebar } from '../../src/ui/Sidebar'
import type { TagSummary } from '../../src/ui/types'

/**
 * 侧栏标签行与它的 ⋯（docs/09 §6.8 `R09-TAG-1` / `R09-TAG-5`）。
 *
 * 用户实测 2026-09-30 报「⋯ 神秘消失」：查下来是**没有页面在用标签**——按 `R09-TAG-5`
 * 「无任何页面引用时自动从标签列表消失」，整块只剩占位，所以没有任何行、也就没有 ⋯。
 * 这里把两件事分开看住：
 * ① 渲染层：有标签的行必须带 ⋯ 按钮（无标签只有占位行）；
 * ② 样式层：⋯ **默认透明、行 hover（或行内聚焦）才显形**——这条只能在 CSS 里看，
 *   无头浏览器不触发 `:hover`（验收脚本量到 rowHovered=false，指针明明压在行上），
 *    所以用「CSS 契约」的形式把它钉住（与 `typography.test.ts` 同一套路）。
 */
const css = readFileSync(new URL('../../src/ui/app.css', import.meta.url), 'utf8')

function renderSidebar(tags: TagSummary[]): string {
  return renderToStaticMarkup(
    <Sidebar
      collapsed={false}
      view="editor"
      libraryActive
      starredActive={false}
      starCount={1}
      onOpenStarred={() => undefined}
      pageCount={1}
      tags={tags}
      activeTagId={null}
      trashCount={0}
      syncStatus={{ kind: 'synced', at: Date.now() }}
      theme="light"
      onOpenLibrary={() => undefined}
      onOpenTrash={() => undefined}
      onOpenSettings={() => undefined}
      onToggleTheme={() => undefined}
      onSelectTag={() => undefined}
      onTagMenu={() => undefined}
      onKeyboardHelp={() => undefined}
    />,
  )
}

test('R09-TAG-1 侧栏标签行：每个标签行都带 ⋯ 操作入口；没有标签时整段隐藏', () => {
  const withTag = renderSidebar([{ id: 't1', name: '测试标签', count: 2 }])
  assert.equal(withTag.includes('# 测试标签') || withTag.includes('测试标签'), true, '标签行要在')
  assert.equal(withTag.includes('tmore'), true, '标签行必须带 ⋯ 入口')
  assert.equal(withTag.includes('标签操作'), true, '⋯ 要有可读名字（aria-label）')

  const withoutTag = renderSidebar([])
  assert.equal(withoutTag.includes('tmore'), false, '没有标签时不该出现任何 ⋯')
  assert.equal(withoutTag.includes('还没有标签'), false, '没有标签时不写占位文案')
  assert.equal(withoutTag.includes('sb-tags'), false, '没有标签时整段隐藏')
})

test('R09-TAG-1 ⋯ 默认不显形、行 hover 或行内聚焦才出现（CSS 契约）', () => {
  const at = css.indexOf('.sb-tag .tmore {')
  assert.notEqual(at, -1, 'app.css 里找不到 .sb-tag .tmore 规则')
  const body = css.slice(at, css.indexOf('}', at))
  assert.ok(body.includes('opacity: 0'), '⋯ 默认必须是透明的（常显会让标签行很吵）')

  const revealAt = css.indexOf('.sb-tag:hover .tmore, .sb-tag:focus-within .tmore { opacity: 1; }')
  assert.notEqual(revealAt, -1, '找不到「行 hover / 行内聚焦才显形」这条规则——⋯ 会变成永远看不见')
})
