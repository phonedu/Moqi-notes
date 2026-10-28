/**
 * 渲染产物抽查门（visual smoke · `06` §7 · 判据来源 `13-偏差台账` `D-073` / `D-072`）。
 *
 * 为什么有它：`pnpm accept` 读的是 DOM / 声明值 / 几何——**「画出来没有」它看不见**。
 * 一天的三个真缺陷（D-071 图片真比例、D-072 空名字行光标、D-073 收起态面板阴影溢出）
 * 在值层全绿，全是渲染产物层的问题（`04` `R04-ACCEPT-7` 的动机）。
 *
 * 判据（三条，全部读**像素**，走 `scripts/lib/png.mjs` 解码截图）：
 *   J1 底缘灰带：compact 编辑态，格式栏（`.mbar`）上方的空白行不得比更上方背景更暗
 *                （旧病：收起态面板 `translateY(100%)` 停在视口下缘外仍画 `0 -10px 44px` 影）。
 *   J2 光标在场：底栏「✎ 编辑」进编辑态（**空名字行**，`D-072` 的场景），名字行左缘必须
 *                画得出光标竖线（按 `caret-color` 取色，连拍 3 帧防闪烁）。
 *   J3 右缘灰带：桌面档（1280），面板收起态，视口最右几列不得比其内侧更暗
 *                （旧病：桌面 `.side-panel` `translateX(100%)` 的 `--shadow-lg` 从右缘漏进）。
 *
 * 负例自测：`node scripts/visual-smoke.mjs --self-test` —— 对每条判据**注入旧病/抹掉产物**
 * （面板恢复可见、caret-color 透明），要求判据**转红**；转不红 = 判据没有鉴别力，自测失败。
 * （建法口径：`06` §7「先能红的真判据 + 负例自测、不先挂空 ID」。）
 *
 * 用法：`pnpm dev` 起着 → `node scripts/visual-smoke.mjs`（默认打 5173；`MOQI_URL` 可换）
 * 退出码：正常模式全绿 0 / 有红 1；自测模式全部转红 0 / 有判据转不红 1。
 * 证据：截图与报告写 `%TEMP%/moqi-visual-smoke/`（不入库）。
 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decodePng, pixelAt, parseColor } from './lib/png.mjs'

const URL = process.env.MOQI_URL ?? 'http://localhost:5173/'
const SELF_TEST = process.argv.includes('--self-test')
const OUT_DIR = join(tmpdir(), 'moqi-visual-smoke')
mkdirSync(OUT_DIR, { recursive: true })

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
page.setDefaultNavigationTimeout(60_000)
const sleep = (ms) => page.waitForTimeout(ms)
const reload = async () => {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(async () => { await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }) })
  await page.waitForSelector('.editor-content .moqi-block', { timeout: 60_000 })
}
const inject = (css) => page.evaluate((text) => {
  document.getElementById('vs-inject')?.remove()
  const style = document.createElement('style')
  style.id = 'vs-inject'
  style.textContent = text
  document.head.appendChild(style)
}, css)
const clearInject = () => page.evaluate(() => document.getElementById('vs-inject')?.remove())

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} → ${JSON.stringify(detail)}`)
}

/** 灰度行均值（跳过非不透明像素）。 */
const rowMean = (img, y, x0, x1) => {
  let sum = 0, n = 0
  for (let x = x0; x < x1; x += 1) {
    const [r, g, b] = pixelAt(img, x, y)
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b
    n += 1
  }
  return n ? sum / n : 0
}
const colMean = (img, x, y0, y1) => {
  let sum = 0, n = 0
  for (let y = y0; y < y1; y += 1) {
    const [r, g, b] = pixelAt(img, x, y)
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b
    n += 1
  }
  return n ? sum / n : 0
}

// 种子：一个**空名字**页（J2 场景）+ 一块短正文（J1 的下半屏留白；J3 的编辑器在多列布局里）。
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.evaluate(() => localStorage.clear())
await page.evaluate(() => localStorage.setItem('moqi-project-b:ui-prefs', JSON.stringify({ slashHintSeen: true })))
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text, parent, position, children = []) => ({ entityId: id, blockUid: uid, type, content: text ? [{ t: 'text', v: text }] : [], parent, children, position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now })
  const pg = { ...mk('vs-page', 'vspage001', 'text', '', null, 0, ['vs-b1']), isObject: true, objectName: '' }
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([pg, mk('vs-b1', 'vsb1000001', 'text', '渲染产物抽查', 'vs-page', 0)]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await sleep(600)

// ---------- J3 右缘灰带（桌面 1280：pagecol 并排，最右几列应是背景）----------
const j3Measure = async () => {
  const shot = await page.screenshot()
  writeFileSync(join(OUT_DIR, `j3-${SELF_TEST ? 'inject' : 'base'}.png`), shot)
  const img = decodePng(shot)
  const w = img.width
  const y0 = 120, y1 = Math.min(img.height - 60, 840)
  let edge = 0, ref = 0
  for (let x = w - 6; x < w; x += 1) edge += colMean(img, x, y0, y1)
  for (let x = w - 26; x < w - 10; x += 1) ref += colMean(img, x, y0, y1)
  edge /= 6; ref /= 16
  return { edge: Math.round(edge * 10) / 10, ref: Math.round(ref * 10) / 10, darken: Math.round((ref - edge) * 10) / 10, w }
}
const j3 = await j3Measure()
const J3_LIMIT = 4
record('J3 屏幕右缘灰带（面板收起态不得从右缘漏影）', j3.darken <= J3_LIMIT, { ...j3, limit: J3_LIMIT })

if (SELF_TEST) {
  await inject('.side-panel { visibility: visible !important; }')
  await sleep(300)
  const j3bad = await j3Measure()
  await clearInject()
  record('J3 负例自测（面板恢复绘制 ⇒ 判据必须转红）', j3bad.darken > J3_LIMIT, j3bad)
  await sleep(200)
}

// ---------- compact 编辑态：J1 底缘灰带 + J2 光标在场 ----------
// 页面列按「意图」开成覆盖抽屉会盖住底栏（accept 同款前置）：先折叠意图，再缩窄。
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
await page.setViewportSize({ width: 360, height: 720 })
await sleep(700)
// 底栏「✎ 编辑」= `D-072` 的入口（activateTouchBlock → focusNameRow，空名字行）。
await page.locator('.mdock-key', { hasText: '编辑' }).click()
await sleep(600)
const editState = await page.evaluate(() => {
  const mbar = document.querySelector('.mbar')
  const r = mbar?.getBoundingClientRect()
  const selection = window.getSelection()
  let caretRect = null
  let caretColor = null
  try {
    if (selection && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      if (rect.height > 0) caretRect = { left: rect.left, top: rect.top, bottom: rect.bottom, height: rect.height }
    }
    const content = document.querySelector('.doc-col .editor-content')
    if (content) {
      const cs = getComputedStyle(content)
      caretColor = cs.caretColor === 'auto' ? cs.color : cs.caretColor
    }
    // 空名字行的 Range 矩形是空的（`D-072` 的落点形态）——改用名字行锚点盒当窗口：
    // 锚点零宽、高度 1lh，光标就画在它左右 ±2px 里。
    if (!caretRect) {
      const anchor = document.querySelector('.moqi-name-line-anchor')
      const ar = anchor?.getBoundingClientRect()
      if (ar && ar.height > 0) caretRect = { left: ar.left, top: ar.top, bottom: ar.bottom, height: ar.height, fromAnchor: true }
    }
  } catch { /* 读不到就走 anchor 兜底 */ }
  const anchorInfo = (() => {
    try {
      const s = window.getSelection()
      const node = s?.anchorNode
      return { type: node?.nodeType ?? null, isContainer: Boolean(node?.closest?.('.moqi-block[data-block-object="true"]')), offset: s?.anchorOffset ?? null }
    } catch { return null }
  })()
  return { mbarTop: r ? Math.round(r.top) : null, inner: window.innerHeight, caretRect, caretColor, anchorInfo, touchEdit: Boolean(document.querySelector('.doc-col.is-touch-edit')) }
})

/**
 * J1 读法（A/B）：灰带盖在**不透明的格式栏身上**（面板影子从下缘往上铺 54px，格式栏正好在这一段里），
 * 所以「同一画面内找干净参照」不可行——改用**对照注入**：截 A（现状）· 截 B（面板 `box-shadow: none`，
 * 只当测量对照、不改仓库）⇒ 逐行均值差 = 漏影量。修好后 A≡B（差 ≈ 0）；真实证据口径同台账
 * `D-073`（「运行时关影 ⇒ 全白」）。
 */
const j1StripMean = (img, top) => {
  let sum = 0, n = 0
  for (let y = top + 2; y <= top + 40; y += 1) { sum += rowMean(img, y, 8, img.width - 8); n += 1 }
  return sum / n
}
const j1Measure = async () => {
  const shotA = await page.screenshot()
  writeFileSync(join(OUT_DIR, `j1-${SELF_TEST ? 'inject' : 'base'}-a.png`), shotA)
  await inject('.side-panel { box-shadow: none !important; }')
  await sleep(200)
  const shotB = await page.screenshot()
  await clearInject()
  const imgA = decodePng(shotA)
  const imgB = decodePng(shotB)
  const top = editState.mbarTop
  const meanA = j1StripMean(imgA, top)
  const meanB = j1StripMean(imgB, top)
  return { leak: Math.round((meanB - meanA) * 10) / 10, mbarTop: top, inner: imgA.height }
}
const J1_LIMIT = 3
if (editState.mbarTop !== null && editState.touchEdit) {
  const j1 = await j1Measure()
  record('J1 格式栏灰带（compact 编辑态，收起态面板不得从底缘漏影）', j1.leak <= J1_LIMIT, { ...j1, limit: J1_LIMIT })
  if (SELF_TEST) {
    await inject('.side-panel { visibility: visible !important; }')
    await sleep(300)
    const j1bad = await j1Measure()
    await clearInject()
    record('J1 负例自测（面板恢复绘制 ⇒ 判据必须转红）', j1bad.leak > J1_LIMIT, j1bad)
    await sleep(200)
  }
} else {
  record('J1 格式栏灰带', false, { reason: '进不了 compact 编辑态（前置失败）', editState })
}

// J2：空名字行必须画得出光标——走 **screencast 帧**（2026-10-13 实测：`Page.captureScreenshot`
// 在 headless 下**完全不画 caret**（强制红 caret + 聚焦仿真都零像素）；`Page.startScreencast`
// 的帧带光标且有闪烁相位）。按 `caret-color` 取色扫竖线，多帧里 ≥1 帧命中即通过。
const cdp = await page.context().newCDPSession(page)
const caretFrames = async () => {
  const frames = []
  const onFrame = (event) => {
    frames.push(Buffer.from(event.data, 'base64'))
    cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
  }
  cdp.on('Page.screencastFrame', onFrame)
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  await sleep(1400)
  await cdp.send('Page.stopScreencast').catch(() => {})
  cdp.off('Page.screencastFrame', onFrame)
  if (frames.length > 0) writeFileSync(join(OUT_DIR, `j2-${SELF_TEST ? 'inject' : 'base'}-last.png`), frames[frames.length - 1])
  return frames
}
const scanCaret = (img, caretRect, caretColor) => {
  const target = parseColor(caretColor)
  const x0 = Math.max(0, Math.floor(caretRect.left) - 2)
  const x1 = Math.min(img.width - 1, Math.floor(caretRect.left) + 4)
  const y0 = Math.max(0, Math.floor(caretRect.top) + 1)
  const y1 = Math.min(img.height - 1, Math.ceil(caretRect.bottom) - 1)
  let best = 0
  for (let x = x0; x <= x1; x += 1) {
    let run = 0
    for (let y = y0; y <= y1; y += 1) {
      const [r, g, b] = pixelAt(img, x, y)
      const near = Math.abs(r - target[0]) <= 46 && Math.abs(g - target[1]) <= 46 && Math.abs(b - target[2]) <= 46
      run = near ? run + 1 : 0
      if (run > best) best = run
    }
  }
  return best
}
const caretPass = async () => {
  if (!editState.caretRect || !editState.caretColor) return { found: 0, frames: 0, reason: '读不到光标矩形 / 颜色', editState }
  const expected = Math.round(editState.caretRect.height * 0.6)
  let found = 0
  let best = 0
  const frames = await caretFrames()
  for (const frame of frames) {
    try {
      const img = decodePng(frame)
      const run = scanCaret(img, editState.caretRect, editState.caretColor)
      best = Math.max(best, run)
      if (run >= expected) found += 1
    } catch { /* 个别帧解码失败不致命 */ }
  }
  return { found, best, frames: frames.length, expected, caretColor: editState.caretColor, caretRect: editState.caretRect, anchor: editState.anchorInfo }
}
const j2 = await caretPass()
record('J2 光标在场（空名字行进编辑态 ⇒ screencast 帧里名字行左缘画出光标竖线）', j2.found >= 1, j2)
if (SELF_TEST) {
  await inject('* { caret-color: transparent !important; }')
  await sleep(250)
  const j2bad = await caretPass()
  await clearInject()
  record('J2 负例自测（caret-color 透明 ⇒ 判据必须转红）', j2bad.found === 0, { found: j2bad.found, best: j2bad.best, frames: j2bad.frames })
}

const reportPath = join(OUT_DIR, 'report.json')
writeFileSync(reportPath, JSON.stringify({ url: URL, selfTest: SELF_TEST, at: new Date().toISOString(), results, editState }, null, 1))
const failed = results.filter((r) => !r.ok).length
console.log(`\nvisual smoke（${SELF_TEST ? '负例自测' : '正常'}）：通过 ${results.length - failed}/${results.length}${failed ? ` · ${failed} 条未过` : ' · 全绿'} · 证据 ${OUT_DIR}`)
await browser.close()
process.exit(failed ? 1 : 0)
