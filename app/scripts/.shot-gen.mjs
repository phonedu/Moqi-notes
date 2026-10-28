/** 公开仓 README 截图生成（不入库）：合成种子数据，隔离浏览器 */
import { chromium } from 'playwright-core'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const sleep = (ms) => page.waitForTimeout(ms)
let page
const newPage = async (vp, mobile) => { page = await browser.newPage({ viewport: vp, hasTouch: mobile, isMobile: mobile }); return page }
const seed = () => page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text, parent, position, children = []) => ({ entityId: id, blockUid: uid, type, content: text ? [{ t: 'text', v: text }] : [], parent, children, position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now })
  const todo = (t) => ({ ...mk('', '', 'todo', t, 'p2', 0), checked: false })
  const p1 = { ...mk('p1', 'pg0000001', 'text', '', null, 0, ['h1', 'b1', 'b2']), isObject: true, objectName: '产品路线' }
  const p2 = { ...mk('p2', 'pg0000002', 'text', '', null, 1, ['t1', 't2', 't3']), isObject: true, objectName: '读书笔记' }
  const p3 = { ...mk('p3', 'pg0000003', 'text', '', null, 2, []), isObject: true, objectName: '周报' }
  const blocks = [
    pg1 = p1,
    { ...mk('h1', 'b10000001', 'heading2', '先把「带得走」做实', 'p1', 0) },
    { ...mk('b1', 'b10000002', 'text', '所有的 [[产品路线]] 都要能导出成标准 Markdown，[[读书笔记]] 里也要能引用回来', 'p1', 1) },
    { ...mk('b2', 'b10000003', 'todo', '整库 zip 导出 ＋ 从备份包恢复', 'p1', 2), checked: true },
    pg2 = p2,
    { ...mk('t1', 'b20000001', 'text', '多音字检索：「银行」和「行走」要都能按拼音命中', 'p2', 0) },
    { ...mk('t2', 'b20000002', 'todo', '把 12 周热力图做成统计页', 'p2', 1) },
    { ...mk('t3', 'b20000003', 'quote', '写下就能找到，找到就能带走；手机上也一样。', 'p2', 2) },
    pg3 = p3,
  ]
  const clean = (arr) => arr.map((b) => { const { pg1, pg2, pg3, ...rest } = b; return rest })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify(clean(blocks)))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
  localStorage.setItem('moqi-project-b:ui-prefs', JSON.stringify({ slashHintSeen: true }))
})
var pg1, pg2
const shot = async (path, clip) => { await page.screenshot({ path, ...(clip ? { clip } : {}) }) }

// ① 桌面 · 页面库（浅色）
await newPage({ width: 1280, height: 800 }, false)
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await seed()
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.editor-content .moqi-block', { timeout: 60000 })
await sleep(900)
await shot('../docs/screenshots/desktop-library-light.png')
console.log('shot 1 ✓')

// ② 桌面 · 编辑器深色
await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'dark'))
await sleep(500)
await shot('../docs/screenshots/desktop-editor-dark.png')
console.log('shot 2 ✓')
await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'light'))

// ③ 手机 · 首页页面库
const mob = await browser.newPage({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36' })
page = mob
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(400)
await seed()
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.lcard', { timeout: 60000 })
await sleep(700)
await shot('../docs/screenshots/mobile-home.png')
console.log('shot 3 ✓')

// ④ 手机 · 编辑
await page.evaluate(() => { document.querySelector('.lcard .bd-open')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
await sleep(700)
const blk = await page.locator('.editor-content .moqi-block').first().boundingBox()
await page.mouse.dblclick(blk.x + 80, blk.y + 10)
await sleep(600)
await shot('../docs/screenshots/mobile-edit.png')
console.log('shot 4 ✓')
await browser.close()
