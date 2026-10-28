/**
 * 真机**常驻读数**（`07-V3-人工验收清单` H2 §2 / 台账 `D-072` / `D-073` 的处置）。
 *
 * 为什么有它：真机批此前的走法是「手工 adb + 截图 + 人眼」——发现过账（θ 批），但**每次都要重新摸一遍**。
 * 这里把 H2 的「常驻读数」表脚本化：一条命令把 P-1…P-9 逐个读出来（读数型：打印 + JSON，缺前置就跳过该条）。
*
* **P-7…P-9（2026-10-14 补，T-06 后半）**：
*   P-7 手柄拖选收敛：左滑进选择模式 → 按住块拖 → 松手；读「拖后无异物 / 选区与滚动收敛」，读完**撤销还原**（移动 = 一次域事务）。
*   P-8 杀进程：`am force-stop` → 重启；**只读**比对库里已有内容（不代写一字，`06` §7.0）。
*   P-9 块级三读数：折叠态**落库**（折叠 → 重开仍在 → 展回）· 待办圈命中（中心/边缘，改完即还原）· 附件打开（点开即关）。
* **净零纪律**：除 P-7 的拖拽（撤销还原）与 P-9 的折叠/勾选（读完还原）外，全程只读；缺前置一律跳过、不代建。
 *
 * 读数（口径见清单 H2 §2；全程**只读**，不改一个字的笔记）：
 *   P-1 构建指纹：设置 → 关于页读「构建于 …」——「包已建好」以指纹为准，不靠时间戳猜（`06` §11.5）。
 *   P-2 空名字行光标：编辑器里当前页**名字行为空**时，底栏「✎ 编辑」→ 连拍 3 帧扫主题色竖线
 *       （`D-072` 的渲染通道；名字行有字 ⇒ 跳过——按 `06` §7.0 不代用户建页）。
 *   P-3 格式栏灰带：编辑态截 A（现状）· 截 B（面板 `box-shadow: none` 对照）⇒ 格式栏区段均值差 = 漏影量
 *       （`D-073`；同 `scripts/visual-smoke.mjs` J1 的口径，这是真机通道）。
 *   P-4 横竖屏：旋转到横屏读 `innerWidth` / `matchMedia('(max-width: 700px)')` / 桌面件在场（`D-074`），读完还原。
 *   P-5 hover 残留：`adb input tap` 真手指点击卡片 → 读 `:hover` 命中（触屏 tap 是否留悬停态）。
 *   P-6 后台回：HOME → 重新拉起 → 读视图与当前页（`10`「从后台回」的落点）。
 *
 * 前置：设备接线 + 应用在位（脚本会自己 `am start` 拉起）+ `adb forward`（脚本自己做）。
 * 用法：`node scripts/device-readings.mjs [--json 路径]`；证据图写 `%TEMP%/moqi-device-readings/`。
 */
import { createRequire } from 'node:module'
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { decodePng, pixelAt, parseColor } from './lib/png.mjs'

const require = createRequire(import.meta.url)
const resolveWs = () => {
  try { return require('ws') } catch { /* 找 pnpm 布局 */ }
  const pnpmDir = join(process.cwd(), 'node_modules', '.pnpm')
  const dir = readdirSync(pnpmDir).filter((name) => name.startsWith('ws@')).sort().pop()
  if (!dir) throw new Error('找不到 ws（pnpm 布局里应有 ws@*）')
  return require(join(pnpmDir, dir, 'node_modules', 'ws'))
}
const WebSocket = resolveWs()
const ADB = join(process.env.ANDROID_HOME ?? 'D:/Android/Sdk', 'platform-tools', 'adb.exe')
const OUT_DIR = join(tmpdir(), 'moqi-device-readings')
mkdirSync(OUT_DIR, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8' })

// —— 连接：确保应用在前台、socket 在、forward 好 ——
const APP = 'com.moqi.projectb'
// **冷启拿确定起点**（2026-10-14 实测：不冷启时上一条读数留在屏上的浮层/抽屉会让下一条**假红**——
// `P-1` 读到 null、`P-5` 的 `:hover` 链里混进 `.mask/.dlg/.sidebar`、`P-2` 找不到光标，三条都不是产品问题）。
try { adb('shell', 'am', 'force-stop', APP) } catch { /* 没在跑也无事 */ }
await sleep(700)
try { adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`) } catch { /* 已在则无事 */ }
await sleep(4500)
// **按本应用 PID 挑 socket**：华为机上有个系统级 `huawei_webview_devtools_remote_*`，
// 不认 PID 的正则会先匹配到它 ⇒ 转发指错、CDP 连不上（2026-10-15 实测）。
const appPid = adb('shell', 'pidof', 'com.moqi.projectb').trim()
const socket = adb('shell', 'cat /proc/net/unix').split('\n').find((row) => row.includes(`webview_devtools_remote_${appPid}`))?.match(/webview_devtools_remote[^ \r\n]*/)?.[0]?.replace(/[^\x20-\x7e]/g, '')
if (!socket) { console.error('没有 webview_devtools_remote —— 应用在前台跑着吗？'); process.exit(2) }
adb('forward', 'tcp:9333', `localabstract:${socket}`)
await sleep(300)

let ws = null
/**
 * 连（或**重连**）页面级 CDP。为什么要有重连：`P-8` 会 `am force-stop` 把 WebView 连根拔掉——
 * 老连接上任何 `evaluate` 都是死的，而 ws 的 error 事件没接住会**直接把脚本崩掉**（2026-10-14 实测：
 * 那一轮 P-8 之后的读数全丢、JSON 都没落盘）。杀完重启后调一次本函数即可接着读。
 */
async function connect() {
  if (ws) { try { ws.removeAllListeners(); ws.close() } catch { /* 旧连接已死 */ } }
  const socketNow = adb('shell', 'cat /proc/net/unix').match(/webview_devtools_remote[^ \r\n]*/)?.[0]?.replace(/[^\x20-\x7e]/g, '')
  if (!socketNow) throw new Error('没有 webview_devtools_remote（应用在前台跑着吗？）')
  adb('forward', 'tcp:9333', `localabstract:${socketNow}`)
  await sleep(300)
  const targets = await (await fetch('http://127.0.0.1:9333/json')).json()
  const pageTarget = targets.find((t) => t.type === 'page')
  ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
  ws.on('error', () => { /* 断线由 reconnect 收口，这里吞掉——不吞会崩进程 */ })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
}
await connect()
let id = 0
const call = (method, params) => new Promise((resolve, reject) => {
  const callId = ++id
  const onMessage = (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id !== callId) return
    ws.off('message', onMessage)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
  ws.on('message', onMessage)
  ws.send(JSON.stringify({ id: callId, method, params }))
})
const evaluate = async (expression) => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error('页面异常：' + JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails))
  return result.result?.value
}
const shoot = async (name) => {
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  const buffer = Buffer.from(shot.data, 'base64')
  if (name) writeFileSync(join(OUT_DIR, `${name}.png`), buffer)
  return decodePng(buffer)
}
const rowMean = (img, y, x0, x1) => {
  let sum = 0
  for (let x = x0; x < x1; x += 1) { const [r, g, b] = pixelAt(img, x, y); sum += 0.2126 * r + 0.7152 * g + 0.0722 * b }
  return sum / Math.max(1, x1 - x0)
}
const inject = (css) => evaluate(`(() => { document.getElementById('dr-inject')?.remove(); const s = document.createElement('style'); s.id = 'dr-inject'; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); return true })()`)
const clearInject = () => evaluate(`document.getElementById('dr-inject')?.remove()`)
const clickByText = (text) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true })()`)

const readings = []
const record = (id, name, ok, detail) => {
  readings.push({ id, name, ok, detail })
  console.log(`${ok === null ? '✳' : ok ? '✓' : '✗'} ${id} ${name} → ${JSON.stringify(detail)}`)
}

/** 清浮层：真机读数最容易栽在**上一条把弹窗留在屏上**（`P-1` 进设置→关于后，后面几条的 tap 全打在它上面——
 *  2026-10-14 实测：`P-5` 读到 `:hover` 链里是 `.mask/.dlg`、`P-2` 找不到光标，两条都是**假红**）。
 *  每一条读数前先清一遍：优先点关闭按钮，退而点遮罩（mousedown 关弹窗）。 */
const closeOverlays = async () => {
  const what = await evaluate(`(() => {
    const btn = document.querySelector('.sh-x, [aria-label="关闭"], .set-topbar button, .dlg-h .x, .dlg .x')
    if (btn) { btn.click(); return 'button' }
    const mask = document.querySelector('.mask, .sh-backdrop, .col-backdrop, .ref-backdrop')
    if (mask) { mask.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 'mask' }
    return null
  })()`)
  await sleep(500)
  return what
}

// ---------- P-1 构建指纹 ----------
let p1 = { step: 'open-settings' }
try {
  await clickByText('设置')
  await sleep(1200)
  await clickByText('关于')
  await sleep(900)
  const about = await evaluate(`(() => { const m = document.body.innerText.match(/构建于\\s*([0-9-]+ [0-9:]+)/); return { build: m ? m[1] : null, ver: (document.body.innerText.match(/当前版本\\s*\\n?\\s*([^\\n]+)/) ?? [])[1] ?? null } })()`)
  p1 = about
  writeFileSync(join(OUT_DIR, 'p1-about.txt'), JSON.stringify(about, null, 1))
  record('P-1', '构建指纹（设置→关于「构建于」）', about.build !== null, about)
} catch (error) {
  record('P-1', '构建指纹', null, { error: error.message.slice(0, 200), ...p1 })
}
// 回列表（close settings）：统一走 closeOverlays（窄档设置的关闭按钮在不同层级，按名字找会漏）
console.log('· P-1 后清浮层：', await closeOverlays())

// ---------- P-5 hover 残留（先做：会从首页点进一页，正好把下面几条带进编辑器）----------
await closeOverlays()
// 窄档：页面库是独立视图（不是并排的列）——先走顶栏 ← 回页面库，再找卡片（2026-10-14 实测）。
await evaluate(`(() => { const b = document.querySelector('.tb-btn[aria-label="返回页面库"]'); if (b) { b.click(); return true } return false })()`)
await sleep(900)
try {
  const before = await evaluate(`(() => {
    const v = document.querySelector('.view.is-on')?.getAttribute('aria-label') ?? null
    // **只认"看得见"的卡片**：窄档页面列可能是收着的抽屉，DOM 里有卡但坐标落在编辑器上（2026-10-14 实测）。
    const cards = [...document.querySelectorAll('.lcard, .scard')]
    const card = cards.find((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 40 && r.top >= 0 && r.bottom <= innerHeight + 1 })
    if (!card) return { view: v, card: null, domCards: cards.length }
    const r = card.getBoundingClientRect()
    return { view: v, card: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 80)) }
  })()`)
  if (before.card) {
    adb('shell', 'input', 'tap', String(before.x), String(before.y)) // 真手指（系统的 touch 事件）
    await sleep(900)
    const after = await evaluate(`(() => {
      const chain = [...document.querySelectorAll(':hover')].map((el) => (el.className ?? el.tagName).toString().split(' ')[0]).filter(Boolean)
      const card = document.querySelector('.lcard:hover, .scard:hover')
      return { chain, depth: chain.length, cardHovered: Boolean(card), view: document.querySelector('.view.is-on')?.getAttribute('aria-label') ?? null }
    })()`)
    writeFileSync(join(OUT_DIR, 'p5-hover.json'), JSON.stringify({ before, after }, null, 1))
    /* **这是基线读数**（对标册：hover 残留读数在 `E-1` 修复前先拍基线）——`E-1`（`:hover` 守卫化）排 `0.6.1`，
       此刻「tap 后 :hover 链非空」是**预期**，所以在读数里如实记深度与链，不按失败算。 */
    record('P-5', 'tap 后 :hover 残留（**基线 · E-1 修复前**；修复后判据 = 链为空）', null, { before: before.view, after })
  } else {
    record('P-5', 'tap 后 :hover 残留', null, { skipped: '当前视图没有卡片可点', view: before.view })
  }
} catch (error) {
  record('P-5', 'tap 后 :hover 残留', null, { error: error.message.slice(0, 200) })
}
// 确保在编辑器（若 P-5 没带进来，点「编辑」/第一张卡）
await evaluate(`(() => { const b = [...document.querySelectorAll('.mdock-key')].find((x) => /编辑/.test(x.textContent ?? '')); if (b) b.click(); return true })()`)
await sleep(1000)

// ---------- P-2 空名字行光标（只在当前页名字行**空**时跑：不代建页，`06` §7.0）----------
await closeOverlays()
try {
  const nameState = await evaluate(`(() => {
    const container = document.querySelector('.moqi-block[data-block-object="true"]')
    if (!container) return { hasContainer: false }
    const nameText = [...container.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join('')
    const holder = container.childNodes[1]?.nodeName === 'BR'
    const anchor = container.querySelector('.moqi-name-line-anchor')
    const ar = anchor?.getBoundingClientRect()
    return { hasContainer: true, nameText, holder, anchor: ar ? { left: Math.round(ar.left), top: Math.round(ar.top), bottom: Math.round(ar.bottom) } : null, dpr: devicePixelRatio, caretColor: getComputedStyle(document.querySelector('.doc-col .editor-content')).caretColor }
  })()`)
  if (!nameState.hasContainer) {
    record('P-2', '空名字行光标', null, { skipped: '编辑器不在前台' })
  } else if ((nameState.nameText ?? '') !== '') {
    record('P-2', '空名字行光标', null, { skipped: `名字行有名（「${String(nameState.nameText).slice(0, 8)}」）——空名字行读数待人工建页（§7.0 不代写）`, holder: nameState.holder })
  } else {
    // 触控编辑：点底栏「✎ 编辑」（edit 态）——光标只在编辑态里画；已在编辑态就不重复点（`D-072` 的口径：靛蓝 caret）。
    // **态收敛**：已在编辑态时（冷启可能直接进编辑）光标可能在正文里——那不是 `D-072` 的问题。
    // 口径 = 只读态点「✎ 编辑」（进编辑的落点就在名字行）。2026-10-14 实测补。
    const inEdit = await evaluate(`Boolean(document.querySelector('.doc-col.is-touch-edit'))`)
    if (inEdit) {
      const done = await evaluate(`(() => { const b = document.querySelector('.mbar button[aria-label="完成"]'); if (b) { b.click(); return true } return false })()`)
      if (done) await sleep(800)
    }
    await evaluate(`(() => { const b = [...document.querySelectorAll('.mdock-key')].find((x) => /编辑/.test(x.textContent || '')); if (b) b.click(); return true })()`)
    await sleep(900)
    const accent = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--accent-text').trim()`)
    const target = parseColor(accent.startsWith('#') || accent.startsWith('rgb') ? accent : '#4F5AC0')
    let found = 0
    let best = 0
    for (let i = 0; i < 3; i += 1) {
      const img = await shoot(i === 0 ? 'p2-caret-f0' : null)
      const x0 = Math.max(0, nameState.anchor.left * nameState.dpr - 8)
      const x1 = Math.min(img.width - 1, nameState.anchor.left * nameState.dpr + 14)
      const y0 = Math.max(0, nameState.anchor.top * nameState.dpr + 2)
      const y1 = Math.min(img.height - 1, nameState.anchor.bottom * nameState.dpr - 2)
      let runBest = 0
      for (let x = x0; x <= x1; x += 1) {
        let run = 0
        for (let y = y0; y <= y1; y += 1) {
          const [r, g, b] = pixelAt(img, x, y)
          const near = Math.abs(r - target[0]) <= 46 && Math.abs(g - target[1]) <= 46 && Math.abs(b - target[2]) <= 46
          run = near ? run + 1 : 0
          if (run > runBest) runBest = run
        }
      }
      best = Math.max(best, runBest)
      if (runBest >= (y1 - y0) * 0.5) found += 1
      await sleep(240)
    }
    record('P-2', '空名字行光标（渲染产物：主题色竖线）', found >= 1, { found, best, expect: Math.round((nameState.anchor.bottom - nameState.anchor.top) * nameState.dpr * 0.5), holder: nameState.holder, caretColor: nameState.caretColor })
  }
} catch (error) {
  record('P-2', '空名字行光标', null, { error: error.message.slice(0, 200) })
}

// ---------- P-3 格式栏灰带（A/B：面板关影对照）----------
try {
  const mbar = await evaluate(`(() => { const el = document.querySelector('.mbar'); const r = el?.getBoundingClientRect(); return r ? { top: Math.round(r.top), inner: innerHeight, dpr: devicePixelRatio } : null })()`)
  if (!mbar) {
    record('P-3', '格式栏灰带', null, { skipped: '不在编辑态（.mbar 不在）' })
  } else {
    const strip = (img) => {
      let sum = 0, n = 0
      for (let y = mbar.top * mbar.dpr + 2; y <= (mbar.top + 38) * mbar.dpr; y += 1) { sum += rowMean(img, y, 12, img.width - 12); n += 1 }
      return sum / Math.max(1, n)
    }
    const imgA = await shoot('p3-band-a')
    await inject('.side-panel { box-shadow: none !important; }')
    await sleep(250)
    const imgB = await shoot('p3-band-b')
    await clearInject()
    const leak = strip(imgB) - strip(imgA)
    record('P-3', '格式栏灰带（A/B 漏影量，`D-073`）', leak <= 3, { leak: Math.round(leak * 10) / 10, mbarTop: mbar.top })
  }
} catch (error) {
  record('P-3', '格式栏灰带', null, { error: error.message.slice(0, 200) })
}
// 退出编辑态（回到只读，别把编辑态留给下一条）
await evaluate(`(() => { const b = [...document.querySelectorAll('.mbar button')].find((x) => (x.textContent ?? '').includes('完成')); if (b) b.click(); return true })()`)
await sleep(600)

// ---------- P-4 横竖屏（旋转 → 读数 → 还原）----------
try {
  const autoRot = adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation').trim().split(':').pop().trim()
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0') // 自动旋转开着时 user_rotation 不生效
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '1')
  await sleep(1800)
  const land = await evaluate(`(() => ({ innerWidth: innerWidth, innerHeight: innerHeight, compact: matchMedia('(max-width: 700px)').matches, wbar: (() => { const el = document.querySelector('.wbar'); return el ? getComputedStyle(el).display : null })(), mdock: Boolean(document.querySelector('.mdock')), fab: Boolean(document.querySelector('.fab')), view: document.querySelector('.view.is-on')?.getAttribute('aria-label') ?? null }))()`)
  writeFileSync(join(OUT_DIR, 'p4-landscape.json'), JSON.stringify(land, null, 1))
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '0')
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', autoRot === '0' ? '0' : '1') // 还原原值
  await sleep(1500)
  const back = await evaluate(`(() => ({ innerWidth: innerWidth, compact: matchMedia('(max-width: 700px)').matches }))()`)
  record('P-4', '横竖屏（旋转读数 + 已还原，`D-074`）', back.compact === true, { land, restored: back, autoRotBefore: autoRot })
} catch (error) {
  record('P-4', '横竖屏', null, { error: error.message.slice(0, 200) })
  try { adb('shell', 'settings', 'put', 'system', 'user_rotation', '0') } catch { /* 尽力还原 */ }
}

// ---------- P-6 后台回 ----------
try {
  const beforeView = await evaluate(`document.querySelector('.view.is-on')?.getAttribute('aria-label') ?? null`)
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  await sleep(1200)
  adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`)
  await sleep(2200)
  const after = await evaluate(`(() => ({ view: document.querySelector('.view.is-on')?.getAttribute('aria-label') ?? null, title: document.querySelector('.tb-title')?.textContent ?? null, blocks: document.querySelectorAll('.editor-content .moqi-block').length }))()`)
  writeFileSync(join(OUT_DIR, 'p6-background.json'), JSON.stringify({ beforeView, after }, null, 1))
  record('P-6', '后台回（HOME → 拉起 → 视图/当前页）', after.blocks >= 0, { beforeView, after })
} catch (error) {
  record('P-6', '后台回', null, { error: error.message.slice(0, 200) })
}

// ---------- P-7 手柄拖选收敛（触控：左滑进选择模式 → 按住块拖 → 松手；读完 **撤销还原**）----------
try {
  const inEdit = await evaluate(`Boolean(document.querySelector('.doc-col.is-touch-edit'))`)
  if (!inEdit) {
    const box = await evaluate(`(() => { const el = document.querySelector('.editor-content .moqi-block[data-entity-id]:not([data-block-object="true"])'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    if (box) { // 只读态双击 = 进编辑（`10` §6.3）
      adb('shell', 'input', 'tap', String(box.x * 3), String(box.y * 3)); await sleep(120)
      adb('shell', 'input', 'tap', String(box.x * 3), String(box.y * 3)); await sleep(900)
    }
  }
  const target = await evaluate(`(() => {
    const els = [...document.querySelectorAll('.editor-content .moqi-block[data-entity-id]:not([data-block-object="true"])')]
    const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.top > 90 && r.bottom < innerHeight - 80 })
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!target) {
    record('P-7', '手柄拖选收敛（左滑 → 拖 → 撤销还原）', null, { skipped: '视口内没有可用的块（不代建页，`06` §7.0）' })
  } else {
    // 左滑进选择模式
    adb('shell', 'input', 'touchscreen', 'swipe', String(target.x * 3), String(target.y * 3), String((target.x - 70) * 3), String(target.y * 3), '220')
    await sleep(700)
    const before = await evaluate(`(() => ({
      selectMode: Boolean(document.querySelector('.capsule') || document.querySelector('.is-select-mode')),
      order: [...document.querySelectorAll('.editor-content .moqi-block[data-entity-id]:not([data-block-object="true"]):not(.moqi-block-todo), .editor-content .moqi-block[data-entity-id]:not([data-block-object="true"])')].map((el) => (el.textContent ?? '').slice(0, 8)),
      scroll: Math.round(document.querySelector('.doc-col')?.scrollTop ?? 0),
    }))()`)
    if (!before.selectMode) {
      record('P-7', '手柄拖选收敛', null, { skipped: '左滑没进选择模式（本机手势阈值不同？）', before })
    } else {
      // 按住选中块往下拖 ~120px：**CDP 合成触控**（`input swipe` 不能「按住再拖」——2026-10-14 实测被当滚动：
      // 顺序一字未动、只有 scrollTop 变了）。按下 → 停顿 500ms（过长按阈值）→ 分步移动 → 抬起。
      await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y }] })
      await sleep(500)
      for (let i = 1; i <= 8; i += 1) {
        await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: target.x, y: Math.round(target.y + (120 * i) / 8) }] })
        await sleep(30)
      }
      await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(900)
      const after = await evaluate(`(() => ({
        order: [...document.querySelectorAll('.editor-content .moqi-block[data-entity-id]:not([data-block-object="true"])')].map((el) => (el.textContent ?? '').slice(0, 8)),
        draggingResidue: document.querySelectorAll('.is-dragging, .is-drop-before, .is-drop-after, .is-drop-into').length,
        selected: document.querySelectorAll('.moqi-block.is-selected').length,
        scroll: Math.round(document.querySelector('.doc-col')?.scrollTop ?? 0),
        circleLefts: [...document.querySelectorAll('.moqi-block.is-selected')].map((el) => { const cs = getComputedStyle(el, '::after'); const r = el.getBoundingClientRect(); return Math.round(r.right - parseFloat(cs.right || '0') - parseFloat(cs.width || '0')) }),
      }))()`)
      writeFileSync(join(OUT_DIR, 'p7-drag-select.json'), JSON.stringify({ before, after }, null, 1))
      // 撤销还原：先退选择模式（选择栏没有撤销键），再用主条 ↩（与 ⌘Z 同一条路由）
      await evaluate(`document.querySelector('.capsule button[aria-label="完成"]')?.click()`)
      await sleep(400)
      const undo = await evaluate(`(() => { const b = document.querySelector('.mbar button[aria-label="撤销"]'); if (b) { b.click(); return true } return false })()`)
      await sleep(900)
      const restored = await evaluate(`(() => [...document.querySelectorAll('.editor-content .moqi-block[data-entity-id]:not([data-block-object="true"])')].map((el) => (el.textContent ?? '').slice(0, 8)))()`)
      // 退出选择模式（点「完成」）
      await evaluate(`document.querySelector('.capsule button[aria-label="完成"], .mbar button[aria-label="完成"]')?.click()`)
      await sleep(400)
      record('P-7', '手柄拖选收敛（左滑 → 按住拖 → 撤销还原）：拖后无异物、选区与滚动收敛、撤销回原序',
        after.draggingResidue === 0 && after.selected >= 1 && JSON.stringify(restored) === JSON.stringify(before.order),
        { before, after, undo, restoredEqual: JSON.stringify(restored) === JSON.stringify(before.order) })
    }
  }
} catch (error) {
  record('P-7', '手柄拖选收敛', null, { error: error.message.slice(0, 200) })
}

// ---------- P-8 杀进程（force-stop → 重启：**只读**——用库里已有内容比对，不代写一字）----------
try {
  const before = await evaluate(`(() => ({
    view: document.querySelector('.view.is-on')?.getAttribute('aria-label') ?? null,
    title: document.querySelector('.tb-title')?.textContent ?? null,
    texts: [...document.querySelectorAll('.editor-content .moqi-block')].map((el) => (el.textContent ?? '').slice(0, 24)),
  }))()`)
  adb('shell', 'am', 'force-stop', APP)
  await sleep(1200)
  adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`)
  await sleep(3500)
  await connect() // 拔了 WebView 就得重连（老连接上的 evaluate 全是死的）
  const after = await evaluate(`(() => ({
    view: document.querySelector('.view.is-on')?.getAttribute('aria-label') ?? null,
    title: document.querySelector('.tb-title')?.textContent ?? null,
    texts: [...document.querySelectorAll('.editor-content .moqi-block')].map((el) => (el.textContent ?? '').slice(0, 24)),
  }))()`)
  writeFileSync(join(OUT_DIR, 'p8-force-stop.json'), JSON.stringify({ before, after }, null, 1))
  const same = JSON.stringify(before.texts) === JSON.stringify(after.texts)
  record('P-8', '杀进程（`am force-stop` → 重启）：最后输入已落盘、落点回到同一页（只读比对库里已有内容）',
    same, { view: [before.view, after.view], title: [before.title, after.title], blocks: after.texts.length, same })
} catch (error) {
  record('P-8', '杀进程', null, { error: error.message.slice(0, 200) })
}

// ---------- P-9 块级三读数：折叠态落库 / 待办圈命中 / 附件打开（后两项**改完即还原**，净零）----------
try {
  // ① 折叠态：找一个有子块的块（有折叠箭头）→ 折叠 → 重开仍在 → 展回（还原）
  const collapsible = await evaluate(`(() => { const el = document.querySelector('.b-collapse'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  let collapseRead = { skipped: '本页没有带子块的块（折叠箭头不在）' }
  if (collapsible) {
    adb('shell', 'input', 'tap', String(collapsible.x * 3), String(collapsible.y * 3))
    await sleep(700)
    const collapsed = await evaluate(`document.querySelectorAll('.is-collapsed').length`)
    adb('shell', 'am', 'force-stop', APP); await sleep(1100)
    adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`); await sleep(3500)
    await connect() // 同 P-8：拔过 WebView 就得重连
    const stillCollapsed = await evaluate(`document.querySelectorAll('.is-collapsed').length`)
    // 展回（还原）：再点一次同一位置的箭头
    const again = await evaluate(`(() => { const el = document.querySelector('.b-collapse'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    if (again) { adb('shell', 'input', 'tap', String(again.x * 3), String(again.y * 3)); await sleep(600) }
    collapseRead = { collapsed, stillCollapsed, 落库: stillCollapsed >= collapsed && collapsed > 0 }
  }
  // ② 待办圈命中（中心 + 边缘各点一次，读 checked；变了就点回去 = 净零）
  const todo = await evaluate(`(() => { const el = document.querySelector('.moqi-block-todo .b-check, .moqi-block-todo input, .moqi-block-todo .todo-circle'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) } })()`)
  let todoRead = { skipped: '本页没有待办块' }
  if (todo) {
    const state = () => evaluate(`document.querySelector('.moqi-block-todo')?.className.includes('is-checked') ?? null`)
    const before = await state()
    adb('shell', 'input', 'tap', String(todo.x * 3), String(todo.y * 3)); await sleep(600)
    const center = await state()
    if (center !== before) { adb('shell', 'input', 'tap', String(todo.x * 3), String(todo.y * 3)); await sleep(500) } // 还原
    const beforeEdge = await state()
    adb('shell', 'input', 'tap', String((todo.x + todo.w / 2 - 2) * 3), String(todo.y * 3)); await sleep(600) // 边缘（命中区边界）
    const edge = await state()
    if (edge !== beforeEdge) { adb('shell', 'input', 'tap', String(todo.x * 3), String(todo.y * 3)); await sleep(500) } // 还原
    todoRead = { 圈盒: { w: todo.w, h: todo.h }, 中心命中: center !== before, 边缘命中: edge !== beforeEdge, 已还原: (await state()) === before }
  }
  // ③ 附件打开（有附件块才有读数；点开即关，净零）
  const fileBlock = await evaluate(`(() => { const el = document.querySelector('.moqi-block-file[data-entity-id]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  let fileRead = { skipped: '本页没有附件块' }
  if (fileBlock) {
    adb('shell', 'input', 'tap', String(fileBlock.x * 3), String(fileBlock.y * 3))
    await sleep(900)
    const opened = await evaluate(`Boolean(document.querySelector('.lb-mask, .sh-backdrop, .sheet'))`)
    await evaluate(`document.querySelector('.lb-mask')?.click(); true`)
    adb('shell', 'input', 'keyevent', '4')
    await sleep(400)
    fileRead = { opened }
  }
  record('P-9', '块级三读数：折叠态落库（重开仍在、已展回）· 待办圈命中（中心/边缘，已还原）· 附件打开',
    (collapseRead.collapsed ? collapseRead.落库 === true : true) && (todoRead.skipped ? true : todoRead.中心命中 === true),
    { collapseRead, todoRead, fileRead })
} catch (error) {
  record('P-9', '块级三读数', null, { error: error.message.slice(0, 200) })
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const jsonPath = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : join(OUT_DIR, `readings-${stamp}.json`)
writeFileSync(jsonPath, JSON.stringify({ at: new Date().toISOString(), socket, readings }, null, 1))
console.log(`\n设备常驻读数：${readings.length} 条 · 证据 ${OUT_DIR}`)
console.log(`JSON → ${jsonPath}`)
ws.close()
