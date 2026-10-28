import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { ICON_STROKE, Icon, iconStroke, type IconName } from '@moqi/editor'
import { PROPERTY_TYPE_META } from '../../src/ui/PropertyRows'

test('Icon renders rounded SVG geometry with an accessible label', () => {
  const markup = renderToStaticMarkup(<Icon name="search" label="搜索" />)
  assert.match(markup, /<svg/)
  assert.match(markup, /stroke-linecap="round"/)
  assert.match(markup, /stroke-linejoin="round"/)
  assert.match(markup, new RegExp(`stroke-width="${ICON_STROKE}"`))
  assert.match(markup, /aria-label="搜索"/)
})

test('PANEL-ICON-1 图标线宽使用统一令牌，圆角线帽保证圆润的观感', () => {
  assert.equal(ICON_STROKE, 2)
})

test('PANEL-ICON-1 线宽随尺寸补偿（2026-10-09 用户点名「太细了看不见」：2 只对 24 网格成立，12px 时物理线宽只剩 1px）', () => {
  // 两档判据：**≥18px 用 Lucide 标准 2**（大图标物理线宽天然更粗，不补偿）；
  // **≤17px 补偿**，物理线宽 `strokeWidth × size / 24` 落在 1.2–1.7px。
  for (const [size, expected] of [[30, 2], [18, 2], [16, 2.25], [15, 2.5], [14, 2.5], [13, 2.75], [12, 2.75], [11, 2.75]] as const) {
    assert.equal(iconStroke(size), expected, `${size}px 的线宽`)
    if (size >= 18) continue
    const physical = (iconStroke(size) * size) / 24
    assert.ok(physical >= 1.2 && physical <= 1.7, `${size}px 的物理线宽 ${physical.toFixed(2)} 落在 1.2–1.7`)
  }
  const markup = renderToStaticMarkup(<Icon name="more" size={12} decorative />)
  assert.match(markup, /stroke-width="2.75"/, '12px 图标渲染出补偿后的线宽')
})

test('decorative Icon is hidden from assistive technology', () => {
  const markup = renderToStaticMarkup(<Icon name="more" decorative />)
  assert.match(markup, /aria-hidden="true"/)
})

test('Icon includes the prototype shell controls in the local icon set', () => {
  for (const name of ['download', 'keyboard', 'moon', 'tag', 'help'] as const) {
    const markup = renderToStaticMarkup(<Icon name={name} label={name} />)
    assert.match(markup, /<svg/)
    assert.match(markup, new RegExp(`aria-label="${name}"`))
  }
})

test('Icon covers the prototype 三级工具栏与面板入口', () => {
  const names: IconName[] = [
    'menu', 'arrow-left', 'filter', 'grid', 'list-tree', 'panel-right', 'properties',
    'image', 'paperclip', 'embed',
    'graph', 'chart', 'expand', 'history', 'copy', 'file-copy', 'bold', 'italic',
    'strike', 'inline-code', 'highlight', 'brackets', 'hash', 'send', 'refresh',
    'restore', 'alert', 'star-filled', 'more-vertical', 'minus', 'list-numbered',
  ]
  for (const name of names) {
    const markup = renderToStaticMarkup(<Icon name={name} label={name} />)
    assert.match(markup, /<svg/, `${name} 必须输出 SVG`)
    assert.match(markup, new RegExp(`aria-label="${name}"`), `${name} 必须带可访问名称`)
  }
})

test('R09-PADD-2 属性类型的五个图标都在本地图标集里、互不复用（docs/08 §8 属性类型批，2026-10-08 T3）', () => {
  const icons = Object.values(PROPERTY_TYPE_META).map((meta) => meta.icon)
  assert.equal(new Set(icons).size, 5, '五个类型各一个图标——同一字形不许复用两次')
  for (const [type, meta] of Object.entries(PROPERTY_TYPE_META)) {
    const markup = renderToStaticMarkup(<Icon name={meta.icon} label={meta.label} />)
    assert.match(markup, /<svg/, `${type} 的图标 ${meta.icon} 必须输出 SVG`)
  }
})

test('窗口关闭按钮悬停使用语义危险色令牌', () => {
  const css = readFileSync(new URL('../../src/ui/app.css', import.meta.url), 'utf8')
  const closeHover = css.match(/\.wctl\.close:hover\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.match(closeHover, /background:\s*var\(--danger\)/)
})

test('WIN-SHELL-1 确认按钮同时隔离鼠标与指针按下事件，避免桌面外壳吞掉确认动作', () => {
  const source = readFileSync(new URL('../../src/ui/Dialogs.tsx', import.meta.url), 'utf8')
  const confirmButton = source.match(/<button[\s\S]*?confirmRef[\s\S]*?>[\s\S]*?\{confirmLabel\}[\s\S]*?<\/button>/)?.[0] ?? ''
  assert.match(confirmButton, /onMouseDown=\{\(event\) => event\.stopPropagation\(\)\}/)
  assert.match(confirmButton, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/)
  assert.match(confirmButton, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); onConfirm\(\) \}\}/)
})

test('手机格式栏六键与左滑胶囊同源：主条动作键全部用 Icon（2026-10-24 字阶与图标批）', () => {
  const source = readFileSync(new URL('../../../packages/editor/src/touch/MobileFmtBar.tsx', import.meta.url), 'utf8')
  for (const name of ['plus', 'heading', 'list', 'undo', 'redo', 'check'] as const) {
    assert.match(source, new RegExp(`<Icon name="${name}" size=\\{20\\}`), `主条缺少 ${name} 图标`)
  }
  // 主条不再以字形作为按钮内容（面板里的 B / I / S / U / ab 字形族不在此列）。
  const bar = source.match(/<div className=\{`mbar\$[\s\S]*?<\/div>/)?.[0] ?? ''
  assert.ok(bar.length > 0, '找不到主条 JSX')
  assert.doesNotMatch(bar, />\s*[＋TтAa≡☰↩↪✦✓]/, '主条仍残留字形按钮')
})
