/**
 * 桌面性能读数工具（0.6 性能批 ⓐ 的取证； 建档）。
 *
 * 它做什么：用**采样库副本**（`03` §11.5 的 `perf_fixture` 生成物，5000 块 / 200 页）起一台
 * 独立桌面实例（`MOQI_DATA_DIR` + 独立 `WEBVIEW2_USER_DATA_FOLDER` + WebView2 远调口），
 * 连**页面级 CDP**（与 `device-read.mjs` 同一套写法：Playwright 的 connectOverCDP 在 WebView 上
 * 不可用，所以直连裸 ws），量 `03` §11.1 的桌面四项：
 *
 *   1. 冷启动到可写（进程启动 → 首块渲染；**debug 构建**，口径 =「启动到能写」的代理读数）
 *   2. 输入到上屏（CDP 真按键 → 双 rAF 后读回文本；30 次取 p95）
 *   3. 进入页面到内容可见（点第一张卡片 → 正文首块可读）
 *   4. 滚动长列表（页面库滚 3 秒，`PerformanceObserver` 收 longtask；规模 = 本库 200 张卡）
 *
 * **它不是门禁**（不进 `pnpm check`）：读数要用时手动跑，数字登记进 `07-验收记录.md` 的性能基线区。
 *
 * 用法（Git Bash）：
 *   cd app
 *   node scripts/perf-read.mjs            # 默认 3 轮（冷启动取中位）
 *   node scripts/perf-read.mjs --runs 5
 *
 * 前置：① `app/src-tauri/target/debug/moqi-project-b-native.exe` 在；
 *      ② 采样库在 `app/fixtures/perf/project-b.sqlite3`（没有就跑 `perf_fixture` 生成器）——
 *         **生成后要「热」一次再量**：老 schema 首次打开要跑 A2 检索文本重算（同步挡启动，
 *         5000 块桌面 ~12s / 真机 ~20-30s，台账 `D-084`）。热法：起一次应用，轮询等
 *         `app_metadata` 出 `search-text-v` 且拼音覆盖 5000/5000 落库（任一台 sqlite 读取器；
 *         桌面 ~60s、真机 ~1-2min）。
 * **读数前先看空闲内存**（ 一条教训）：7.9GB 机只剩 1.8GB 空闲时，冷启动三轮量到
 * 57s/9.9s/4.0s——那组**不采信**；另清掉 `rustc` / `link.exe` 残留再跑。
 * 纪律：**只碰副本**（`%TEMP%`），真库与实验库都不做实验台（`06` §7.0）。
 *
 * **真机跑法（换库那一步照抄， 补——那天踩了坑）**：
 *   ① 备份：`run-as … md5sum project-b.sqlite3`，`exec-out run-as … cat >` 拉回本地并核 md5；
 *      **`snapshots/` 一起备**（那是用户自己的每日快照）。
 *   ② 停稳：`am force-stop` → **确认 `pidof` 为空**（有僵尸 renderer 时 `waitSocket` 会绕开它，见那里的头注）。
 *   ③ **清旁文件**：`run-as … rm -f project-b.sqlite3-journal -wal -shm`——`am force-stop` 是硬杀，
 *      留下热 journal 的话，下一次打开 SQLite 会**回滚**，把刚换进去的库覆盖掉（实测：换回真库后
 *      应用一启动就变回采样库，查了 40 分钟）。
 *   ④ 换库：`adb push` 到 `/data/local/tmp` → `run-as … cp` → `md5sum` 两边核。
 *   ⑤ 测：`--device`（`--profile` 也能用在真机上：同一套 CDP 剖析）。
 *   ⑥ 还原：停稳 → **清旁文件** → 推回备份 → `cp` → 核 md5 → 启动一次核对内容（截图看得到）。
 *   ⑦ 收尾：删掉批次里生成的当天快照（那是采样库的）、清 `/data/local/tmp` 的临时文件。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const resolveWs = () => {
  try { return require('ws') } catch { /* 往下找 */ }
  // workspace 布局下 .pnpm 在仓库根；新版 playwright-core 不再外挂 ws，两处都可能是空的
  for (const base of [process.cwd(), join(process.cwd(), '..')]) {
    const pnpmDir = join(base, 'node_modules', '.pnpm')
    if (existsSync(pnpmDir)) {
      const dir = readdirSync(pnpmDir).filter((name) => name.startsWith('ws@')).sort().pop()
      if (dir) return require(join(pnpmDir, dir, 'node_modules', 'ws'))
    }
  }
  // Node ≥22 内置 WebSocket（EventTarget）兜底：包成脚本用的 EventEmitter 形状（on/off/once/send/close）
  if (typeof globalThis.WebSocket === 'function') {
    const { EventEmitter } = require('node:events')
    return class WsShim extends EventEmitter {
      constructor(url) {
        super()
        const inner = new globalThis.WebSocket(url)
        inner.addEventListener('open', () => this.emit('open'))
        inner.addEventListener('message', (event) => this.emit('message', Buffer.from(event.data)))
        inner.addEventListener('error', (event) => this.emit('error', event))
        inner.addEventListener('close', () => this.emit('close'))
        this.close = () => inner.close()
        this.send = (data) => inner.send(data)
      }
    }
  }
  throw new Error('找不到 ws（pnpm 布局或 Node ≥22 内置 WebSocket 应有其一）')
}
const WebSocket = resolveWs()

const runs = Number((process.argv.find((a) => a.startsWith('--runs'))?.split('=')[1]) ?? 3)
const DEVICE = process.argv.includes('--device')
// 剖析模式（`03` §11.6 启动期同步计算审计的取证）：CDP 采样剖析，自耗时归因 + 1s 窗时间线。
// **默认关**——剖析本身有开销，官方读数不带它跑。
const PROFILE = process.argv.includes('--profile')
/** 纯 CSS 按需渲染的对照取证（性能批 ⓒ ③）：灌 N 张真卡克隆，开 / 关 `content-visibility` 各滚 3s。 */
const CSS_PROBE = process.argv.includes('--css-probe')
const CSS_PROBE_COUNT = Number((process.argv.find((a) => a.startsWith('--css-probe-cards'))?.split('=')[1]) ?? 1500)
/** 真窗口扫档（第 12 项「真窗口复核」＋ `R09-ACC-41` 的取证）：只走起应用 → 逐档量版面 → 截图，不量性能。 */
const SWEEP = process.argv.includes('--window-sweep')
/** 诊断走 stderr（不缓冲）：真机上「等不到首块」这种卡点，看得到它卡在哪一步才查得动。 */
const VERBOSE = process.argv.includes('--verbose')
const trace = (message) => { if (VERBOSE) console.error(`   · ${message}`) }
// 构建口径：debug 版 exe **不内嵌前端**，取源 = `tauri.conf.json` 的 devUrl（5173）——
// 那个口上跑的如果是 Vite dev 服务器，读数会变成 dev 模式（慢数倍）。release 版内嵌产物、
// 不依赖任何端口，也是门槛的判定口径（`03` §11.1）。默认 debug（快），`--release` 走 release。
const RELEASE = process.argv.includes('--release')
const PORT = Number(process.env.MOQI_PERF_PORT ?? 9333)
const ADB = process.env.MOQI_ADB ?? 'adb'
const PKG = 'com.moqi.projectb'
const RELEASE_DIR = RELEASE ? 'release' : 'debug'
const EXE = join(process.cwd(), 'src-tauri', 'target', RELEASE_DIR, 'moqi-project-b-native.exe')
const DEV_URL = 'http://localhost:5173'
const FIXTURE = join(process.cwd(), 'fixtures', 'perf', 'project-b.sqlite3')
const WORK = join(tmpdir(), 'moqi-perf-run')
const WEBVIEW = join(tmpdir(), 'moqi-perf-webview')

/** 5173 的口由谁在服务：debug 版 exe 就从这取源，读数必须知道**是产物包还是 dev 服务器**。
 *  注意：raw `cargo build`（debug 或 release 都一样）**不内嵌前端**、一律连 devUrl(5173)；
 *  只有 `pnpm tauri build` 造的 exe 才内嵌产物。所以这里只给 debug 模式兜底，
 *  真实取源以**页内实况**为准（`measureOnce` 连上后的判定）。 */
let preview = null
async function ensureAssetsServer() {
  if (RELEASE) return 'release exe（内嵌与否随构建方式，页内实况判定）'
  const served = await fetch(DEV_URL, { signal: AbortSignal.timeout(2000) }).then((r) => r.text()).catch(() => null)
  if (served !== null) {
    if (served.includes('/@vite/client')) {
      console.error(`5173 上是 Vite dev 服务器——debug 版 exe 会连着它跑，读数等于 dev 模式（慢数倍）。\n关掉它，或改用 pnpm tauri build --no-bundle 造的 exe（内嵌产物）。`)
      process.exit(4)
    }
    return '5173 上的既有产物服务（外部启动）'
  }
  if (!existsSync(join(process.cwd(), 'dist', 'index.html'))) { console.error('缺 dist/index.html（先 pnpm build）'); process.exit(5) }
  preview = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'vite', 'preview', '--port', '5173', '--strictPort'], { stdio: 'ignore', shell: process.platform === 'win32' })
  for (let i = 0; i < 64; i += 1) {
    const ok = await fetch(DEV_URL, { signal: AbortSignal.timeout(2000) }).then(() => true).catch(() => false)
    if (ok) return '自起 vite preview（5173，产物包）'
    await new Promise((resolve) => setTimeout(resolve, 250)) /* 就地等待：此处先于模块级 sleep 声明执行 */
  }
  throw new Error('vite preview 起不来（5173 被占？）')
}

if (!DEVICE) {
  if (!existsSync(EXE)) { console.error(`缺 exe：${EXE}（cargo build${RELEASE ? ' --release' : ''}）`); process.exit(2) }
  if (!existsSync(FIXTURE)) { console.error(`缺采样库：${FIXTURE}（先跑 perf_fixture 生成器，见 03 §11.5）`); process.exit(3) }

  // 采样库副本 + 独立 WebView 用户目录（真库永不做实验台，06 §7.0）
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  copyFileSync(FIXTURE, join(WORK, 'project-b.sqlite3'))
  const assets = await ensureAssetsServer()
  console.log(`构建口径：${RELEASE_DIR} · 资产来源：${assets}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return page
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('等不到 CDP 页（远调口没开？）')
}

function makeClient(ws) {
  let id = 0
  return (method, params) => new Promise((resolve, reject) => {
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
}

const evalIn = async (call, expression) => {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(`页内表达式抛错：${JSON.stringify(result.exceptionDetails).slice(0, 300)}`)
  return result.result?.value
}

/**
 * 装探针（桌面 / 真机共用）：`longtask` 观察器（主线程谁在堵）＋ `invoke` 计时（哪条 IPC 慢）。
 * **尽早装**（首块渲染之前），否则抓不到启动期的工作。
 *
 * `invoke` 的装法：直改赋值在注入属性不可写时**静默失效**（真机实测过 `patched=false`，`D-043` 的
 * 「哪条 IPC 慢」因此归因不了）。这里按三档尝试并把结果如实报回：
 * ① 直接赋值（代理对象会转发 ✔）→ ② `Object.defineProperty` 带 getter（属性 `configurable` 时可行 ✔）
 * → ③ 都装不上就回**属性描述符**（`writable` / `configurable`），下一批按描述符换路子（例如
 * `Object.defineProperty(window.__TAURI_INTERNALS__, ...)` 不行就走平台侧埋点），不再瞎猜。
 */
async function installProbe(call) {
  await evalIn(call, `(() => {
    window.__perfLong = []
    window.__perfInvokes = []
    window.__perfInvokeHow = '(未试)'
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__perfLong.push({ d: Math.round(e.duration), t: Math.round(e.startTime) }) }).observe({ entryTypes: ['longtask'] })
    } catch (error) { window.__perfLong.push({ d: -1, t: -1, error: String(error) }) }
    try {
      const internals = window.__TAURI_INTERNALS__
      if (internals && typeof internals.invoke === 'function') {
        const original = internals.invoke.bind(internals)
        const patched = async function patched(cmd, args, ...rest) {
          const t0 = performance.now()
          try { return await original(cmd, args, ...rest) }
          finally { window.__perfInvokes.push({ cmd, ms: Math.round(performance.now() - t0) }) }
        }
        internals.invoke = patched
        if (internals.invoke === patched) window.__perfInvokeHow = '赋值'
        else {
          try {
            Object.defineProperty(internals, 'invoke', { configurable: true, writable: true, value: patched })
            if (internals.invoke === patched) window.__perfInvokeHow = 'defineProperty'
          } catch (error) { window.__perfInvokeHow = 'defineProperty 失败：' + String(error) }
        }
        const d = Object.getOwnPropertyDescriptor(internals, 'invoke')
        window.__perfInvokePatched = internals.invoke === patched
        window.__perfInvokeDesc = d ? { writable: d.writable, configurable: d.configurable, get: typeof d.get } : (Object.getPrototypeOf(internals) ? '在原型上' : '无')
      } else {
        window.__perfInvokeHow = '没有 __TAURI_INTERNALS__'
      }
    } catch (error) { window.__perfInvokePatched = String(error) }
    return true
  })()`)
}

/** 读探针结果（与 `installProbe` 配对）。 */
async function readProbe(call) {
  return evalIn(call, `(() => {
    const longs = (window.__perfLong ?? []).slice().sort((a, b) => b.d - a.d)
    const invokes = (window.__perfInvokes ?? []).slice().sort((a, b) => b.ms - a.ms)
    const counts = {}
    for (const i of (window.__perfInvokes ?? [])) counts[i.cmd] = (counts[i.cmd] ?? 0) + 1
    return { longCount: longs.length, longTop: longs.slice(0, 8), invokeTop: invokes.slice(0, 6), invokeCounts: counts, invokePatched: window.__perfInvokePatched ?? null, invokeHow: window.__perfInvokeHow ?? null, invokeDesc: window.__perfInvokeDesc ?? null,
      // 代码分割的取证（性能批 ⓒ ①）：按需块「什么时候到」——它该在首帧之后（空闲预取），不挡首屏。
      lazyChunks: performance.getEntriesByType('resource').filter((e) => e.name.includes('/assets/pinyinSearch-') || e.name.includes('/assets/searchSubstring-')).map((e) => ({ file: e.name.split('/').pop(), at: Math.round(e.startTime), end: Math.round(e.responseEnd) })) }
  })()`)
}

/**
 * 剖析结果聚合：自耗时按「函数 @ 文件:行」求和（`timeDeltas` 单位 µs，`startTime` 是单调微秒）。
 * 另给 1 秒窗时间线——启动期的两簇停顿靠它分阶段归因（谁在 2s 挡、谁在 5s 挡）。
 */
function aggregateProfile(profile) {
  const { nodes, samples, timeDeltas, startTime } = profile
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const parentOf = new Map()
  for (const node of nodes) for (const child of node.children ?? []) parentOf.set(child, node.id)
  const shortUrl = (url) => (url ? url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('/').slice(-1)[0] : '(内建)')
  const keyOf = (node) => `${node.callFrame.functionName || '(匿名)'} @ ${shortUrl(node.callFrame.url)}:${node.callFrame.lineNumber + 1}:${(node.callFrame.columnNumber ?? 0) + 1}`
  const total = new Map()
  const windows = new Map()
  let t = startTime
  for (let i = 0; i < samples.length; i += 1) {
    const node = byId.get(samples[i])
    const delta = timeDeltas[i] ?? 0
    if (node) {
      const key = keyOf(node)
      total.set(key, (total.get(key) ?? 0) + delta)
      const w = Math.floor((t - startTime) / 1e6)
      const bucket = windows.get(w) ?? new Map()
      bucket.set(key, (bucket.get(key) ?? 0) + delta)
      windows.set(w, bucket)
    }
    t += delta
  }
  const top = (map, n) => [...map.entries()]
    .filter(([key]) => !/^\((idle|program|root|未加载)\)/.test(key))
    .sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([key, us]) => `${key} ${Math.round(us / 1000)}ms`)
  /** 压缩包认不出函数名：把**调用者**一并印出来，配合「行:列」从产物里取窗口文本对号。 */
  const callerSuffix = (key) => {
    const node = nodes.find((candidate) => keyOf(candidate) === key)
    const parent = node ? byId.get(parentOf.get(node.id)) : null
    return parent ? ` ←${parent.callFrame.functionName || '(匿名)'}@${parent.callFrame.lineNumber + 1}:${(parent.callFrame.columnNumber ?? 0) + 1}` : ''
  }
  const idle = [...total.entries()].filter(([key]) => /^\((idle|program)/.test(key)).reduce((sum, [, us]) => sum + us, 0)
  const timeline = [...windows.entries()].sort((a, b) => a[0] - b[0]).map(([w, bucket]) => `[${w}–${w + 1}s] ${top(bucket, 3).join(' · ')}`)
  return { overall: top(total, 10).map((line) => `${line}${callerSuffix(line.slice(0, line.lastIndexOf(' ')))}`), timeline, idleMs: Math.round(idle / 1000) }
}

/** 输入到上屏 p95（桌面 / 真机共用）：CDP 真按键 + 页内打点（keydown 捕获 → 双 rAF），不含 CDP 往返。 */
async function measureInput(call) {
  const focusTarget = await evalIn(call, `(() => {
    const block = document.querySelector('.editor-content .moqi-block:not([data-block-object="true"])') ?? document.querySelector('.moqi-block')
    const rect = block.getBoundingClientRect()
    return { x: Math.round(rect.left + 24), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await call('Input.dispatchMouseEvent', { type, x: focusTarget.x, y: focusTarget.y, button: 'left', clickCount: 1 })
  }
  await sleep(300)
  await evalIn(call, `(() => {
    window.__perfSamples = []
    document.addEventListener('keydown', function onKey() {
      const t0 = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => window.__perfSamples.push(performance.now() - t0)))
    }, { capture: true, once: false })
  })()`)
  for (let i = 0; i < 30; i += 1) {
    const key = String.fromCharCode(97 + (i % 26))
    await call('Input.dispatchKeyEvent', { type: 'keyDown', text: key, unmodifiedText: key, key })
    await call('Input.dispatchKeyEvent', { type: 'char', text: key, unmodifiedText: key, key })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key })
    await sleep(40)
  }
  const samples = (await evalIn(call, `window.__perfSamples`) ?? []).map((v) => Math.round(v)).sort((a, b) => a - b)
  return samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] : null
}

/** 真机模式（`--device`）：只量 `10` §十 / F6 的 Android 两项——冷启动（`am start -W` 的系统口径）
 *  与输入到上屏（同一套页内打点）。**前置**：应用已装、采样库已推到设备（见 `03` §11.5 跑法）。 */
async function measureDevice() {
  const adb = (args) => new Promise((resolve, reject) => {
    const child = spawn(ADB, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`adb ${args.join(' ')} → ${code}\n${out}`))))
  })

  const totals = []
  for (let i = 0; i < runs; i += 1) {
    await adb(['shell', 'am', 'force-stop', PKG])
    await sleep(1500)
    const out = await adb(['shell', 'am', 'start', '-W', '-n', `${PKG}/.MainActivity`])
    // 华为 ROM 只印 `WaitTime`（没有 `TotalTime`）—— 有 TotalTime 用 TotalTime，否则回退 WaitTime。
    // **注意**：这是系统口径（到 Activity 显示），不含 JS 起壳——门槛比较用下面的「到首块渲染」。
    const total = Number(/TotalTime:\s*(\d+)/.exec(out)?.[1] ?? /WaitTime:\s*(\d+)/.exec(out)?.[1] ?? 0)
    const metric = /TotalTime:/.test(out) ? 'TotalTime' : 'WaitTime'
    totals.push(total)
    console.log(`       冷启动第 ${i + 1} 轮：am start -W ${metric} = ${total}ms（系统口径，不含起壳）`)
    await sleep(2000)
  }

  // 冷启动·页内口径（与桌面同款代理）：进程起 → 首块渲染。含 adb/forward 搭建开销，两项分开印。
  await adb(['shell', 'am', 'force-stop', PKG])
  await sleep(1500)
  // 启动前就存在的远调口 = 僵尸 renderer（`force-stop` 杀不掉它，页面永远「加载中…」）——排除掉，
  // 只认这次启动新出现的口（见 `waitSocket` 的头注）。
  const staleSockets = new Set((await adb(['shell', `cat /proc/net/unix | grep -o 'webview_devtools_remote[^ ]*'`])).split('\n').map((line) => line.trim()).filter(Boolean))
  const t0 = Date.now()
  await adb(['shell', 'am', 'start', '-n', `${PKG}/.MainActivity`])
  const socket = await waitSocket(adb, PORT, staleSockets)
  await adb(['forward', `tcp:${PORT}`, `localabstract:${socket}`])
  const tForward = Date.now()
  let tBlock = null
  try {
    const page = await connect()
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const call = makeClient(ws)
    await call('Runtime.enable', {})
    await installProbe(call)
    if (PROFILE) { await call('Profiler.enable', {}); await call('Profiler.start', {}) }
    for (let i = 0; i < 1200; i += 1) {
      const info = await evalIn(call, `({ blocks: document.querySelectorAll('.moqi-block').length, inPage: Math.round(performance.now()) })`)
      if (info.blocks > 0) { tBlock = Date.now(); console.log(`       冷启动·页内：首块渲染时页内计时 ${info.inPage}ms`); break }
   // 每 5s 打一次页面实况：等不到首块时，先看清工具**连到了哪个页面**（ 加）。
      if (i % 100 === 99) {
        const where = await evalIn(call, `({ href: location.href, title: document.title, readyState: document.readyState, body: (document.body?.innerText ?? '').slice(0, 60) })`)
        console.log(`       （等待中 ${Math.round(info.inPage / 1000)}s：${where.href} · ${where.title} · ${where.readyState} · 正文「${where.body.replace(/\n/g, ' ')}」）`)
      }
      await sleep(50)
    }
  // 上限 60s（ 放宽）：采样库是**老库首次启动**场景——首帧前还要跑起始的载入 ＋ 自愈，
    // 拼音回填则与渲染并行（`D-042` 的复测正要看这一段）。20s 上限会把它误判成「等不到」。
    if (!tBlock) throw new Error('等不到首块渲染')
    const diag = await evalIn(call, `(() => {
      const block = document.querySelector('.editor-content .moqi-block:not([data-block-object="true"])') ?? document.querySelector('.moqi-block')
      const rect = block?.getBoundingClientRect()
      return {
        href: location.href,
        blocks: document.querySelectorAll('.moqi-block').length,
        cards: document.querySelectorAll('.lcard, .scard').length,
        rect: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
        viewport: { w: innerWidth, h: innerHeight },
        pageName: document.querySelector('.editor-content .moqi-block[data-block-object="true"]')?.textContent?.slice(0, 16) ?? null,
      }
    })()`)
    console.log(`       诊断：块 ${diag.blocks} · 卡 ${diag.cards} · 视口 ${diag.viewport.w}×${diag.viewport.h} · 首块 rect ${JSON.stringify(diag.rect)} · 页「${diag.pageName}」`)
    await measureInput(call)
    const stats = await evalIn(call, `(() => {
      const s = (window.__perfSamples ?? []).map((v) => Math.round(v)).sort((a, b) => a - b)
      if (!s.length) return null
      return { n: s.length, min: s[0], p50: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1], top3: s.slice(-3) }
    })()`)
    const focused = await evalIn(call, `document.activeElement?.tagName + '.' + (document.activeElement?.className ?? '').slice(0, 40)`)
    console.log(`       输入：${stats ? `${stats.n} 条 · min ${stats.min} · p50 ${stats.p50} · p95 ${stats.p95} · max ${stats.max} · 最大三条 ${JSON.stringify(stats.top3)}` : '无采样'} · 焦点 ${focused}`)
    const probe = await readProbe(call)
    console.log(`       探针·长任务：${probe.longCount} 条；最长 ${JSON.stringify(probe.longTop)}`)
    console.log(`       探针·IPC：patched=${probe.invokePatched}（${probe.invokeHow}）· 描述符 ${JSON.stringify(probe.invokeDesc)} · ${JSON.stringify(probe.invokeCounts)}；最慢 ${JSON.stringify(probe.invokeTop)}`)
    console.log(`       探针·按需块：${JSON.stringify(probe.lazyChunks ?? [])}`)
    if (PROFILE) {
      const agg = aggregateProfile((await call('Profiler.stop', {})).profile)
      console.log(`       剖析·自耗时前八：${agg.overall.slice(0, 8).join(' | ')}`)
      console.log(`       剖析·空转 ${agg.idleMs}ms`)
      for (const line of agg.timeline) console.log(`       剖析·${line}`)
    }
    ws.close()
    return { totals, inputP95: stats?.p95 ?? null, inputStats: stats, probe, socket, coldStartEndToEndMs: tBlock - t0, forwardSetupMs: tForward - t0 }
  } finally {
    await adb(['forward', '--remove', `tcp:${PORT}`]).catch(() => {})
  }
}

/**
 * 取 **活的** WebView 远调 socket（进程刚起时可能还没注册，轮询几轮）。
 *
 * 修（两个坑，都在真机上实测踩到）：
 * ① 可能同时挂着两个 `webview_devtools_remote_*`——**僵尸 renderer 的口**：`am force-stop` 杀不掉
 *    WebView 的 renderer 进程（它是 isolated uid），它会一直应答、页面永远停在「加载中…」。
 *    所以**启动前就存在的 socket 一律排除**（`stale`），只认这次启动新出现的。
 * ② 选口按**当前进程 pid**（socket 后缀 = 应用 pid——本应用 webview 在进程内，实测 pid 与后缀一致），
 *    选不出来再在非僵尸口里逐个探 `/json`（要看到 `tauri.localhost` 的页面）。
 */
async function waitSocket(adb, port, stale) {
  /** 硬超时：真机上实测过「转发成功但请求永不返回」的半开口（`AbortSignal` 也没兜住）——每一步都套 race，
   *  任何一步卡住就只是「这一口不可用」，不许把整轮测量拖死。 */
  const hardTimeout = (promise, ms, fallback) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))])
  const usable = async (socket, probePort) =>
    hardTimeout((async () => {
      try {
        trace(`usable(${socket}) → 转发 tcp:${probePort}`)
        await adb(['forward', `tcp:${probePort}`, `localabstract:${socket}`])
        const targets = await (await fetch(`http://127.0.0.1:${probePort}/json`, { signal: AbortSignal.timeout(1500) })).json()
        trace(`usable(${socket}) → ${targets.length} 个 target`)
        return targets.some((target) => target.type === 'page' && String(target.url).includes('tauri.localhost'))
      } catch (error) {
        trace(`usable(${socket}) 失败：${error.name} ${error.message}`)
        return false
      }
    })(), 4000, false).finally(() => { void hardTimeout(adb(['forward', '--remove', `tcp:${probePort}`]), 3000, null).catch(() => {}) })
  for (let round = 0; round < 40; round += 1) {
    const pid = (await adb(['shell', 'pidof', PKG])).trim().split(/\s+/)[0]
    const mine = pid ? `webview_devtools_remote_${pid}` : null
    trace(`waitSocket 第 ${round} 轮：pid=${pid ?? '—'} · mine=${mine ?? '—'} · stale=${[...stale].join(',') || '—'}`)
    if (mine && !stale.has(mine) && await usable(mine, port + 100)) return mine
    const sockets = [...new Set((await adb(['shell', `cat /proc/net/unix | grep -o 'webview_devtools_remote[^ ]*'`])).split('\n').map((line) => line.trim()).filter(Boolean))]
    for (const socket of sockets) if (!stale.has(socket) && socket !== mine && await usable(socket, port + 101)) return socket
    await sleep(500)
  }
  throw new Error('拿不到活的 webview 远调 socket（debug 包才有）')
}

/**
 * 纯 CSS 按需渲染的取证（`--css-probe`；性能批 ⓒ ③）：页面库在 200 卡规模上两种写法都是 60fps，
 * 量不出差别——触发点的意义在更大规模（`03` §11.4 第 3 行 >300 卡），所以**按触发规模合成对照**：
 * 把真卡 DOM 克隆灌到 N 张，同一段滚动分别在「开 / 关 `content-visibility: auto`」下各量一遍，
 * 报帧数、帧间隔 p95 与长任务。只动这一份在跑窗口的 DOM（克隆与覆盖样式跑完即撤）。
 */
async function cssProbe(call, count) {
  const open = await evalIn(call, `(() => {
    if (document.querySelector('.lib-stack')) return true
    return false
  })()`)
  if (!open) {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: '\\', code: 'Backslash', windowsVirtualKeyCode: 220, modifiers: 2 | 8 })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: '\\', code: 'Backslash', windowsVirtualKeyCode: 220, modifiers: 2 | 8 })
    await sleep(700)
  }
  /** 量一段：`cv` = 是否启用 content-visibility（用一条 !important 覆盖开关）。 */
  const run = async (cv) => evalIn(call, `(async () => {
    const list = document.querySelector('.lib-stack')
    if (!list) return { ok: false }
    let style = document.getElementById('perf-cv-probe')
    if (!style) { style = document.createElement('style'); style.id = 'perf-cv-probe'; document.head.append(style) }
    style.textContent = ${JSON.stringify(cv ? '.lcard, .scard { content-visibility: auto !important; contain-intrinsic-size: auto 190px !important; }' : '.lcard, .scard { content-visibility: visible !important; }')}
    const cards = [...list.querySelectorAll('.lcard, .scard')]
    for (const card of cards) { card.dataset.probeKeep = '1' }
    const proto = cards[0]
    const added = []
    if (proto) {
      for (let i = 0; i < ${count}; i += 1) {
        const clone = proto.cloneNode(true)
        clone.dataset.perfProbe = '1'
        clone.querySelector('h3') && (clone.querySelector('h3').textContent = '合成卡 ' + i)
        list.append(clone)
        added.push(clone)
      }
    }
    await new Promise((r) => requestAnimationFrame(r))
    // 预热一小段：先把「新卡的首次布局」付掉——要量的是**稳态滚动**每帧的代价，
    // 首次布局那一笔单独看（真应用里它就是「打开页面库」的代价）。
    list.scrollTop = 0
    const warmUntil = performance.now() + 400
    while (performance.now() < warmUntil) { list.scrollTop += 400; await new Promise((r) => requestAnimationFrame(r)) }
    const totalNow = list.querySelectorAll('.lcard, .scard').length
    const tasks = []
    const observer = new PerformanceObserver((entryList) => { for (const entry of entryList.getEntries()) tasks.push(Math.round(entry.duration)) })
    try { observer.observe({ entryTypes: ['longtask'] }) } catch { /* 老内核如实空着 */ }
    list.scrollTop = 0
    const until = performance.now() + 3000
    let frame = 0
    const frameTimes = []
    let last = performance.now()
    while (performance.now() < until) {
      list.scrollTop += 240
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 4) list.scrollTop = 0
      await new Promise((r) => requestAnimationFrame(r))
      const now = performance.now()
      frameTimes.push(now - last)
      last = now
      frame += 1
    }
    observer.disconnect()
    for (const clone of added) clone.remove()
    style.remove()
    const sorted = frameTimes.slice().sort((a, b) => a - b)
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0
    return { ok: true, total: totalNow, frames: frame, fps: +(frame / 3).toFixed(1), frameP95Ms: +p95.toFixed(1), longTasks: tasks.length, maxLongTaskMs: tasks.length ? Math.max(...tasks) : 0 }
  })()`)
  const off = await run(false)
  const on = await run(true)
  console.log(`       CSS 探针（${off.total ?? '?'} 张卡 · 3s 滚动）：关 content-visibility → ${off.frames} 帧（${off.fps}fps，帧间隔 p95 ${off.frameP95Ms}ms，长任务 ${off.longTasks} 条 / 最大 ${off.maxLongTaskMs}ms）· 开 → ${on.frames} 帧（${on.fps}fps，帧间隔 p95 ${on.frameP95Ms}ms，长任务 ${on.longTasks} 条 / 最大 ${on.maxLongTaskMs}ms）`)
  return { off, on }
}

/**
 * 真窗口扫档（`--window-sweep`；第 12 项「真窗口复核」＋ `R09-ACC-41` 的取证）：
 * 用**真应用窗口**（不是浏览器通道）逐档改窗口宽度，每档截一张图 + 取一组版面事实
 * （档位命中、侧栏是否常驻、页面列是否在、标题条是否溢出、正文档位字号、能缩到多窄）。
 * 改窗口走 PowerShell 的 `user32!MoveWindow`（按 `devicePixelRatio` 换算成物理像素），
 * 缩到比最小宽度更窄时由系统 / 应用的最小尺寸钳住——**钳住多少正是要验的东西**（`R09-RESP-19`）。
 */
async function windowSweep(call, exePid) {
  const dpr = await evalIn(call, `window.devicePixelRatio`)
  const dir = join(tmpdir(), 'moqi-sweep')
  mkdirSync(dir, { recursive: true })
  /** 改窗口宽（物理像素）；`MoveWindow` 走 user32。 */
  const moveWindow = (physical) => new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-Command', `
      $sig = '[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);'
      $t = Add-Type -MemberDefinition $sig -Name Win -Namespace W -PassThru
      $p = Get-Process -Id ${exePid}
      [void]$t::MoveWindow($p.MainWindowHandle, 60, 60, ${physical}, 900, $true)
    `], { stdio: 'ignore' })
    ps.on('close', resolve)
    ps.on('error', resolve)
  })
  const results = []
  for (const logical of [360, 700, 800, 1100, 1400]) {
    // **收敛式**：PowerShell 进程的 DPI 感知与 WebView 的换算链实测差 ~23%，算不准就按实测比例再来一轮
    // （物理 → CSS 的链条不止 devicePixelRatio 一环；收敛到 ±4 CSS px 才算数）。
    let physical = Math.round(logical * dpr)
    let width = 0
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await moveWindow(physical)
      await sleep(700)
      width = await evalIn(call, `innerWidth`)
      if (Math.abs(width - logical) <= 4) break
      physical = Math.max(240, Math.round(physical * (logical / Math.max(width, 1))))
    }
    const facts = await evalIn(call, `({
      innerWidth: innerWidth,
      compact: matchMedia('(max-width: 700px)').matches,
      belowDesktop: matchMedia('(max-width: 899px)').matches,
      belowWide: matchMedia('(max-width: 1279px)').matches,
      sidebar: (() => { const el = document.querySelector('.sidebar'); if (!el) return '缺'; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return { 类: el.className, display: s.display, position: s.position, 宽: Math.round(r.width), 位移: Math.round(r.left) } })(),
      pageCol: (() => { const el = document.querySelector('.pagecol'); if (!el) return '缺'; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return { 类: el.className, display: s.display, 宽: Math.round(r.width) } })(),
      fsBody: getComputedStyle(document.documentElement).getPropertyValue('--fs-e').trim(),
      // 卡片内段落几何（**只说明几何**：D-044 那种「两行画在同一行」的图形重叠几何量不出来——
      // 判断要看同档的 2× 特写 card-＜宽＞.png）。
      card: (() => {
        const card = document.querySelector('.lcard, .scard')
        if (!card) return '缺'
        const ps = [...card.querySelectorAll('.cnt p')].slice(0, 4).map((p) => { const r = p.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) } })
        return { 卡高: Math.round(card.getBoundingClientRect().height), 段: ps, 相邻段几何相交: ps.some((p, i) => i > 0 && p.top < ps[i - 1].top + ps[i - 1].h - 1) }
      })(),
      titlebar: (() => { const el = document.querySelector('.wbar'); if (!el) return '缺'; return { scrollW: el.scrollWidth, clientW: el.clientWidth, 溢出: el.scrollWidth > el.clientWidth + 1 } })(),
      header: (() => { const el = document.querySelector('.view.is-on .tbar, .tbar'); if (!el) return '缺'; return { scrollW: el.scrollWidth, clientW: el.clientWidth, 溢出: el.scrollWidth > el.clientWidth + 1 } })(),
    })`)
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    const file = join(dir, `${logical}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    // 第一张卡片的 2× 特写（看小字号下的实像素：截图的缩略视图看不出是重叠还是错觉）。
    const cardBox = await evalIn(call, `(() => { const el = document.querySelector('.lcard, .scard'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.min(240, Math.round(r.height)) } })()`)
    if (cardBox) {
      const zoom = await call('Page.captureScreenshot', { format: 'png', clip: { ...cardBox, scale: 2 } })
      writeFileSync(join(dir, `card-${logical}.png`), Buffer.from(zoom.data, 'base64'))
      // 归因对照：把 ⓒ③ 的两条 CSS 关掉再拍一张（判断「两行文字画在同一行」是不是 `content-visibility` 引起）。
      await evalIn(call, `(() => { const s = document.createElement('style'); s.id = 'sweep-cv-off'; s.textContent = '.lcard, .scard { content-visibility: visible !important; contain-intrinsic-size: none !important }'; document.head.append(s); return true })()`)
      const off = await call('Page.captureScreenshot', { format: 'png', clip: { ...cardBox, scale: 2 } })
      writeFileSync(join(dir, `card-off-${logical}.png`), Buffer.from(off.data, 'base64'))
      await evalIn(call, `(() => { document.getElementById('sweep-cv-off')?.remove(); return true })()`)
    }
    results.push({ 目标: logical, ...facts, 图: file })
    const tier = facts.compact ? 'compact' : facts.belowDesktop ? 'tablet' : facts.belowWide ? 'desktop' : 'wide'
    console.log(`       扫档 目标 ${logical} → 实际 ${width} · 档 ${tier} · 侧栏 ${JSON.stringify(facts.sidebar)} · 页面列 ${JSON.stringify(facts.pageCol)} · 正文 ${facts.fsBody || '—'} · 标题条${facts.titlebar?.溢出 ? '**溢出**' : '不溢出'} · 顶栏${facts.header?.溢出 ? '**溢出**' : '不溢出'} · 卡片 ${JSON.stringify(facts.card)}`)
  }
  return { dpr, results }
}

/** 按 PID 树杀干净并等 CDP 口释放（：上轮实例没死透会占住 9333——
 *  下一轮 connect() 连到旧页，读数就悄悄变成「量上一轮」；实测一次卡死 15 分钟）。 */
async function killInstance(child) {
  try { child.kill() } catch { /* 已经死了 */ }
  const { execFileSync } = await import('node:child_process')
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* 已退出 */ }
  for (let i = 0; i < 40; i += 1) {
    const alive = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(500) }).then(() => true).catch(() => false)
    if (!alive) return
    await sleep(250)
  }
  console.error(`       警告：CDP ${PORT} 口 10s 未释放——下一轮读数可能失真`)
}

async function measureOnce({ warmup = false } = {}) {
  const started = Date.now()
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      MOQI_DATA_DIR: WORK,
      WEBVIEW2_USER_DATA_FOLDER: WEBVIEW,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: 'ignore',
  })
  try {
    const page = await connect()
    const pageAt = Date.now()
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const call = makeClient(ws)
    await call('Runtime.enable', {})
    await call('Page.enable', {})
    await installProbe(call) // 启动期同步工作清单（`03` §11.6）靠它的长任务读数
    if (PROFILE) { await call('Profiler.enable', {}); await call('Profiler.start', {}) }

    // 1) 冷启动：进程启动 → 首块渲染（可写代理）
  // **上限 120s（ 放宽，原 12s）**：老 schema 的采样库首次打开要跑**一次性迁移**
    // （A2 检索文本重算，5000 块一个事务，**同步挡在启动路径上**——见台账 `D-084`），
    // 量到的是「含迁移」的数；稳态读数请先把夹具热一次（`fixtures/perf/README` 的跑法）。
    let readyAt = 0
    for (let i = 0; i < 2400; i += 1) {
      const ready = await evalIn(call, `document.querySelectorAll('.moqi-block').length > 0`)
      if (ready) { readyAt = Date.now(); break }
      await sleep(50)
    }
    if (!readyAt) throw new Error('等不到首块渲染（已等 120s）')
    const coldStartMs = readyAt - started
    // 预热轮到此为止：它的目的只是把「每次调用重建 WORK ⇒ 首轮写两份每日/每周快照
  // （~19MB×2）＋ 冷缓存/杀软扫描」这些**一次性工件**付掉，读数不采信（
    // 实测：同日两组首轮 14536ms / 3589ms，而热轮 1850–2900ms）。
    if (warmup) return { coldStartMs, pageAtMs: Date.now() - started, inputP95: null, openMs: null, scroll: null, probe: null }
    if (coldStartMs > 12_000) console.log(`       注意：首块渲染等了 ${(coldStartMs / 1000).toFixed(1)}s —— 夹具可能是**未热**的老 schema（含一次性迁移，见台账 D-084）`)

    /** 页内实况判定取源：dev 服务器页（5173 + 无产物包 + vite 客户端）的读数**当场拒收**——
     *  它量的是 dev 模式（未压缩 + HMR + jsxDEV），跟交付物差数倍，收下来就是假读数。 */
    const source = await evalIn(call, `({
      href: location.href,
      viteDev: !!document.querySelector('script[src*="@vite/client"], script[src*="/@react-refresh"]'),
    })`)
    if (source.viteDev || (source.href.includes('5173') && !(await evalIn(call, `performance.getEntriesByType('resource').some((e) => e.name.includes('/assets/index-'))`)))) {
      console.error(`取源是 Vite dev 服务器（${source.href}）——这是 dev 模式读数，已拒收。\n用 \`pnpm tauri build --no-bundle\` 造的 exe（内嵌产物），或关掉 5173 上的 dev 服务器再跑。`)
      throw new Error('dev 模式读数已拒收')
    }

    // 诊断三件：位置 / 页面库卡数 / 块数——量之前先看清"验的是哪个界面"
    const diag = await evalIn(call, `({
      href: location.href,
      cards: document.querySelectorAll('.lcard, .scard').length,
      blocks: document.querySelectorAll('.moqi-block').length,
      pageName: document.querySelector('.editor-content .moqi-block[data-block-object="true"]')?.textContent?.slice(0, 20) ?? null,
      width: innerWidth, height: innerHeight,
      bodyClass: document.body.className,
      pagecol: document.querySelector('.pagecol')?.className ?? null,
      empty: document.querySelector('.pagecol-empty')?.textContent?.slice(0, 24) ?? null,
      sidebarOpen: document.querySelector('.sidebar')?.className ?? null,
      asset: (performance.getEntriesByType('resource').map((e) => e.name).find((name) => name.includes('/assets/index-') && name.endsWith('.js')) ?? '').split('/').pop() || null,
    })`)
    console.log(`       诊断：${diag.href} · 窗 ${diag.width}×${diag.height} · 卡 ${diag.cards} · 块 ${diag.blocks} · 当前页「${diag.pageName}」· 包 ${diag.asset ?? '（无）'}\n              pagecol=${diag.pagecol} · empty=${diag.empty} · sidebar=${diag.sidebarOpen} · body=${diag.bodyClass}`)

    if (SWEEP) {
      const sweep = await windowSweep(call, child.pid)
      ws.close()
      return { sweep, coldStartMs, diag }
    }

    // 2) 输入到上屏：CDP 真按键 + **页内**打点（keydown → 双 rAF）——量的是页内间隔，
    //    不含 CDP 往返；30 次取 p95。
    const inputP95 = await measureInput(call)

    // 3) 滚动长列表：**先把页面库打开**（900–1279 档页面列是抽屉，默认不在 DOM 里——
    //    1100 宽的默认窗口正落在这一档；快捷键照 `R09-KEY-4` = Ctrl+Shift+\）→ 滚 3 秒收 longtask
    if (!(await evalIn(call, `!!document.querySelector('.lib-stack')`))) {
      await call('Input.dispatchKeyEvent', {
        type: 'keyDown', key: '\\', code: 'Backslash', windowsVirtualKeyCode: 220,
        modifiers: 2 | 8, // Ctrl | Shift
      })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: '\\', code: 'Backslash', windowsVirtualKeyCode: 220, modifiers: 2 | 8 })
      await sleep(700)
    }
    const scroll = await evalIn(call, `(async () => {
      const list = document.querySelector('.lib-stack')
      if (!list) return { ok: false, cards: document.querySelectorAll('.lcard, .scard').length }
      const cards = document.querySelectorAll('.lcard, .scard').length
      const tasks = []
      const observer = new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) tasks.push(Math.round(entry.duration))
      })
      try { observer.observe({ entryTypes: ['longtask'] }) } catch { /* 老内核不支持就如实空着 */ }
      const until = performance.now() + 3000
      let frame = 0
      while (performance.now() < until) {
        list.scrollTop += 240
        if (list.scrollTop + list.clientHeight >= list.scrollHeight - 4) list.scrollTop = 0
        await new Promise((r) => requestAnimationFrame(r))
        frame += 1
      }
      observer.disconnect()
      const max = tasks.length ? Math.max(...tasks) : 0
      return { ok: true, cards, frames: frame, longTasks: tasks.length, maxLongTaskMs: max }
    })()`)

    // 4) 进入页面到内容可见：在**打开的页面库**里点另一张卡片的标题，等页名变成它（点后抽屉自动收起）
    const card = await evalIn(call, `(async () => {
      const current = document.querySelector('.editor-content .moqi-block[data-block-object="true"]')?.textContent ?? ''
      for (const card of document.querySelectorAll('.lcard, .scard')) {
        const title = card.querySelector('.bd-open h3, h3')?.textContent ?? ''
        if (!title || current.startsWith(title)) continue
        const target = card.querySelector('.bd-open') ?? card
        target.scrollIntoView({ block: 'center' })   // 滚动测试会把列表留在中途——先把它滚进可视区再取坐标
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const rect = target.getBoundingClientRect()
        if (rect.height < 4 || rect.left < 0 || rect.top < 0 || rect.bottom > innerHeight) continue
        return { x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2), title }
      }
      return null
    })()`)
    let openMs = null
    if (card) {
      const t0 = Date.now()
      for (const type of ['mousePressed', 'mouseReleased']) {
        await call('Input.dispatchMouseEvent', { type, x: card.x, y: card.y, button: 'left', clickCount: 1 })
      }
      for (let i = 0; i < 240; i += 1) {
        const name = await evalIn(call, `document.querySelector('.editor-content .moqi-block[data-block-object="true"]')?.textContent ?? ''`)
        if (name.startsWith(card.title)) { openMs = Date.now() - t0; break }
        await sleep(20)
      }
    }
    console.log(`       进页面：目标「${card?.title ?? '（没找到别的卡片）'}」→ ${openMs ?? '未到位'}ms · 滚动卡数 ${scroll?.cards ?? 0}`)

    if (CSS_PROBE) await cssProbe(call, CSS_PROBE_COUNT)

    const probe = await readProbe(call)
    console.log(`       探针·长任务：${probe.longCount} 条；最长 ${JSON.stringify(probe.longTop)}`)
    console.log(`       探针·IPC：patched=${probe.invokePatched}（${probe.invokeHow}）· 描述符 ${JSON.stringify(probe.invokeDesc)} · ${JSON.stringify(probe.invokeCounts)}；最慢 ${JSON.stringify(probe.invokeTop)}`)
    console.log(`       探针·按需块：${JSON.stringify(probe.lazyChunks ?? [])}`)

    if (PROFILE) {
      const agg = aggregateProfile((await call('Profiler.stop', {})).profile)
      console.log(`       剖析·自耗时前八：${agg.overall.slice(0, 8).join(' | ')}`)
      console.log(`       剖析·空转 ${agg.idleMs}ms`)
      for (const line of agg.timeline) console.log(`       剖析·${line}`)
    }

    ws.close()
    return { coldStartMs, pageAtMs: pageAt - started, inputP95, openMs, scroll, probe, asset: diag.asset }
  } finally {
    await killInstance(child)
  }
}

const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const results = []
if (DEVICE) {
  const device = await measureDevice()
  const outDir = join(tmpdir(), 'moqi-perf')
  mkdirSync(outDir, { recursive: true })
  const at = new Date().toISOString()
  const summary = {
    at,
    model: `真机 ${PKG} · 采样库 5000 块 / 200 页 · 冷启动口径 = am start -W TotalTime`,
    runs,
    coldStartMs: device.totals,
    inputP95Ms: device.inputP95,
    median: { coldStartMs: median(device.totals) },
  }
  const outPath = join(outDir, `perf-android-${at.replace(/[:.]/g, '-')}.json`)
  writeFileSync(outPath, JSON.stringify(summary, null, 1))
  console.log(`真机：冷启动中位 ${summary.median.coldStartMs}ms（${device.totals.join(' / ')}）· 输入到上屏 p95 ${device.inputP95}ms`)
  console.log(`报告：${outPath}`)
  process.exit(0)
}
if (!SWEEP) {
  console.log('预热轮（不采信）：先付掉每日快照与冷缓存的一次性工件，之后三轮才是稳态读数')
  const warm = await measureOnce({ warmup: true })
  console.log(`       预热轮首块 ${warm.coldStartMs}ms`)
}
for (let run = 1; run <= (SWEEP ? 1 : runs); run += 1) {
  const result = await measureOnce()
  results.push(result)
  if (SWEEP) break
  console.log(`第 ${run} 轮：冷启动 ${result.coldStartMs}ms（页 ${result.pageAtMs}ms）· 输入 p95 ${result.inputP95}ms · 进页面 ${result.openMs ?? '—'}ms · 长任务 ${result.scroll?.longTasks ?? '—'} 条（最大 ${result.scroll?.maxLongTaskMs ?? '—'}ms / ${result.scroll?.cards ?? '—'} 卡）`)
}
if (SWEEP) {
  const sweep = results[0]?.sweep
  const bad = (sweep?.results ?? []).filter((row) => row.titlebar?.溢出 || row.header?.溢出)
  console.log(`\n扫档结论：dpr=${sweep?.dpr ?? '?'} · ${sweep?.results?.length ?? 0} 档 · 溢出项 ${bad.length} 个${bad.length ? `（${bad.map((row) => row.目标).join('/')}）` : '——标题条与顶栏都不溢出 ✔'}`)
  console.log(`图在 ${join(tmpdir(), 'moqi-sweep')}`)
  preview?.kill()
  process.exit(bad.length ? 1 : 0)
}

const summary = {
  at: new Date().toISOString(),
  model: `${RELEASE_DIR} 构建 · 采样库 5000 块 / 200 页（副本）`,
  assets: results.map((r) => r.asset),
  runs,
  coldStartMs: results.map((r) => r.coldStartMs),
  inputP95Ms: results.map((r) => r.inputP95),
  openPageMs: results.map((r) => r.openMs),
  /** 启动期同步工作清单（`03` §11.6）的取证：每轮的长任务条数与最长几条（谁在堵主线程）。 */
  longTasks: results.map((r) => ({ count: r.probe?.longCount ?? null, top: r.probe?.longTop ?? null })),
  scroll: results.map((r) => r.scroll),
  median: {
    coldStartMs: median(results.map((r) => r.coldStartMs)),
    inputP95Ms: median(results.map((r) => r.inputP95)),
    openPageMs: median(results.map((r) => r.openMs ?? 0)),
  },
}
const outDir = join(tmpdir(), 'moqi-perf')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `perf-${summary.at.replace(/[:.]/g, '-')}.json`)
writeFileSync(outPath, JSON.stringify(summary, null, 1))
console.log(`中位：冷启动 ${summary.median.coldStartMs}ms · 输入 p95 ${summary.median.inputP95Ms}ms · 进页面 ${summary.median.openPageMs}ms`)
console.log(`报告：${outPath}`)
preview?.kill()
