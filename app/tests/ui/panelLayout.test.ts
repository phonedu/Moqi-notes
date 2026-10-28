import assert from 'node:assert/strict'
import test from 'node:test'
import { exclusiveOverlays, listColumnOnOpen, onBreakpointCrossed, sidebarVisible, toggledSidebar } from '../../src/ui/panelLayout'

test('PANEL-INTENT-1 宽屏：可见性由用户意图决定（docs/09 §八）', () => {
  assert.equal(sidebarVisible({ narrow: false, collapsed: false, drawerOpen: false }), true)
  assert.equal(sidebarVisible({ narrow: false, collapsed: true, drawerOpen: false }), false)
})

test('窄屏：可见性是抽屉呈现，不跟意图走', () => {
  assert.equal(sidebarVisible({ narrow: true, collapsed: false, drawerOpen: false }), false, '意图是展开但抽屉没弹出 → 不占屏')
  assert.equal(sidebarVisible({ narrow: true, collapsed: true, drawerOpen: true }), true, '抽屉弹出即可见')
})

test('宽屏开关只切意图', () => {
  assert.deepEqual(toggledSidebar({ narrow: false, collapsed: false, drawerOpen: false }), { collapsed: true, drawerOpen: false })
  assert.deepEqual(toggledSidebar({ narrow: false, collapsed: true, drawerOpen: false }), { collapsed: false, drawerOpen: false })
})

test('窄屏开关切抽屉，并把意图一起记下（拖宽后照意图呈现）', () => {
  assert.deepEqual(toggledSidebar({ narrow: true, collapsed: true, drawerOpen: false }), { collapsed: false, drawerOpen: true })
  assert.deepEqual(toggledSidebar({ narrow: true, collapsed: false, drawerOpen: true }), { collapsed: true, drawerOpen: false })
})

test('跨断点只重置抽屉呈现，返回量里没有 collapsed', () => {
  const crossed = onBreakpointCrossed()
  assert.deepEqual(Object.keys(crossed), ['drawerOpen'], '断点不允许把 collapsed 带回来——那就是「悄悄改写状态」')
  assert.equal(crossed.drawerOpen, false, '进入窄屏时抽屉默认不弹出')
})

test('PANEL-INTENT-2 回归：宽屏折起侧栏 → 拖窄 → 拖宽，意图仍是折叠（旧实现会把它改成展开）', () => {
  let state = { narrow: false, collapsed: true, drawerOpen: false }
  state = { ...state, narrow: true, ...onBreakpointCrossed() }
  assert.equal(state.collapsed, true, '拖窄不改写意图')
  state = { ...state, narrow: false, ...onBreakpointCrossed() }
  assert.equal(state.collapsed, true, '拖回宽也不改写意图')
  assert.equal(sidebarVisible(state), false, '侧栏仍然是折起的')
})

test('PANEL-DRAWER-1 窄屏下打开抽屉并关掉 → 拖宽后侧栏保持关着', () => {
  let state = { narrow: true, collapsed: true, drawerOpen: false }
  const opened = toggledSidebar(state)
  state = { ...state, ...opened }
  assert.deepEqual(state, { narrow: true, collapsed: false, drawerOpen: true }, '打开抽屉 = 意图展开')
  state = { ...state, collapsed: true, drawerOpen: false } // 点遮罩 / 跳转收起抽屉
  state = { ...state, narrow: false, ...onBreakpointCrossed() }
  assert.equal(sidebarVisible(state), false, '用户关掉过，拖宽后不自己冒出来')
})

test('点开页面后页面列的意图：并排一栏就显示，抽屉就收起（docs/09 §八）', () => {
  assert.equal(listColumnOnOpen(true), false, '宽屏：点卡片 = 在右栏打开，把页面列显示出来')
  assert.equal(listColumnOnOpen(false), true, '窄屏 / 放不下三栏：收起抽屉，别盖住刚打开的那一页')
})

/**
 * D-017（2026-10-05）：**覆盖层互斥**——窄屏下侧栏抽屉 / 页面列抽屉 / 右侧面板同一时刻只留一个。
 *
 * 这条规则的来由是用户实测的那个场面：页面库抽屉开着 → 它头部的 🔍 → ⌘K → 「就这些问 AI」，
 * 面板确实开出来了，但开在遮罩底下——点面板的任何位置命中的都是遮罩（等于「把页面库关了」），
 * 于是看起来像「必须先收起页面库，AI 面板才能用」。
 */
test('OVERLAY-1 窄屏：开哪个覆盖层，其余两个都让位', () => {
  assert.deepEqual(exclusiveOverlays('panel', { sidebar: true, listColumn: true }), { drawerOpen: false, listColumnCollapsed: true, closePanels: false }, '开面板 → 收抽屉；面板之间不互斥（closePanels 为 false）')
  assert.deepEqual(exclusiveOverlays('sidebar', { sidebar: true, listColumn: true }), { drawerOpen: true, listColumnCollapsed: true, closePanels: true }, '开侧栏 → 收页面列与全部面板')
  assert.deepEqual(exclusiveOverlays('listColumn', { sidebar: true, listColumn: true }), { drawerOpen: false, listColumnCollapsed: false, closePanels: true }, '开页面列 → 收侧栏与全部面板')
})

test('OVERLAY-1b 900–1279px 这一段：侧栏不是抽屉、页面列是抽屉——开面板只收页面列（按一个「窄屏」写死会漏收它）', () => {
  assert.deepEqual(exclusiveOverlays('panel', { sidebar: false, listColumn: true }), { drawerOpen: false, listColumnCollapsed: true, closePanels: false })
  assert.deepEqual(exclusiveOverlays('panel', { sidebar: false, listColumn: false }), { drawerOpen: false, listColumnCollapsed: null, closePanels: false }, '宽屏：页面列是栏，不动它')
})

test('OVERLAY-2 宽屏：侧栏与页面列是并排的栏，只对面板保持互斥（listColumnCollapsed 不动）', () => {
  assert.deepEqual(exclusiveOverlays('panel', { sidebar: false, listColumn: false }), { drawerOpen: false, listColumnCollapsed: null, closePanels: false }, '宽屏开面板不收起页面列（它是栏不是覆盖层）')
  assert.deepEqual(exclusiveOverlays('sidebar', { sidebar: false, listColumn: false }), { drawerOpen: true, listColumnCollapsed: null, closePanels: true })
  assert.deepEqual(exclusiveOverlays('listColumn', { sidebar: false, listColumn: false }), { drawerOpen: false, listColumnCollapsed: false, closePanels: true })
})
