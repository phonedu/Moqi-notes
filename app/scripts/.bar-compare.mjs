/** 格式栏 vs 选择栏 表面对比（不入库）：计算样式 + 底部条带截图 */
import { chromium } from 'playwright-core'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const UA = 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36'
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true, userAgent: UA })
const page = await ctx.newPage()
const sleep = (ms) => page.waitForTimeout(ms)
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.evaluate(() => localStorage.clear())
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text, parent, position, children = []) => ({ entityId: id, blockUid: uid, type, content: text ? [{ t: 'text', v: text }] : [], parent, children, position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now })
  const p1 = { ...mk('p1', 'pg0000001', 'text', '', null, 0, ['b1', 'b2', 'b3']), isObject: true, objectName: '对比页' }
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([p1, mk('b1', 'b00000001', 'text', '第一块甲', 'p1', 0), mk('b2', 'b00000002', 'text', '第二块乙', 'p1', 1), mk('b3', 'b00000003', 'text', '第三块丙', 'p1', 2)]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.editor-content .moqi-block', { timeout: 60000 })
await sleep(700)

// 进编辑态（双击第一块）→ 打字态 = .mbar 常驻格式栏
const b1 = await page.locator('.moqi-block[data-entity-id="b1"]').boundingBox()
await page.mouse.dblclick(b1.x + 60, b1.y + 10)
await sleep(700)
const mbarStyle = await page.evaluate(() => {
  const el = document.querySelector('.mbar')
  if (!el) return null
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  return { bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor + ' / bottom ' + cs.borderBottomWidth, shadow: cs.boxShadow.slice(0, 60), radius: cs.borderRadius, h: Math.round(r.height), top: Math.round(r.top) }
})
console.log('mbar：', JSON.stringify(mbarStyle))
await page.screenshot({ path: '../docs/screenshots/.cmp-mbar.png', clip: { x: 0, y: 640, width: 360, height: 140 } })

// 选择模式：左滑 b2 → 胶囊；再点 b3 → cap-select 选择栏
const b2 = await page.locator('.moqi-block[data-entity-id="b2"]').boundingBox()
const cdp = await page.context().newCDPSession(page)
const y = Math.round(b2.y + 12)
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(b2.x + 280), y, id: 1 }] })
for (const x of [250, 220, 190, 160, 130]) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] }); await sleep(40) }
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
await sleep(600)
const b3 = await page.locator('.moqi-block[data-entity-id="b3"]').boundingBox()
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(b3.x + 80), y: Math.round(b3.y + 12), id: 2 }] })
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
await sleep(700)
const capStyle = await page.evaluate(() => {
  const el = document.querySelector('.cap-select')
  if (!el) return null
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  return { bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor + ' / bottom ' + cs.borderBottomWidth, shadow: cs.boxShadow.slice(0, 60), radius: cs.borderRadius, h: Math.round(r.height), top: Math.round(r.top) }
})
console.log('cap-select：', JSON.stringify(capStyle))
await page.screenshot({ path: '../docs/screenshots/.cmp-capsule.png', clip: { x: 0, y: 560, width: 360, height: 220 } })
await browser.close()
