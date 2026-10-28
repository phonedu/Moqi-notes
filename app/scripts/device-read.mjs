/**
 * Android 真机读数工具（手机最小批 / A9 真机路径的取证，2026-10-08 建档）。
 *
 * 为什么这么写：Playwright 的 `connectOverCDP` 对 Android WebView **不支持**
 * （浏览器级端点缺 Browser 域：`Protocol error (Browser.setDownloadBehavior)`），
 * 所以这里直连**页面级** CDP（`/json` 里的 `webSocketDebuggerUrl`，用仓库里现成的 `ws`）。
 *
 * 前置（三步，Git Bash；设备侧路径要引号包住整条命令，否则被 MSYS 改写成 Windows 路径）：
 *   1. 装机应用在前台跑着（debug 构建：wry 在 Android 上开了 WebView 远调）
 *   2. `adb shell "cat /proc/net/unix | grep -o 'webview_devtools_remote[^ ]*' | head -1"`
 *   3. `adb forward tcp:9222 localabstract:<上一步的名字>`
 *
 * 用法：
 *   node scripts/device-read.mjs [out.json] [port]
 *
 * 读数（computed 值，与 dpr 无关）：
 *   - 排版档：`--fs-e` / `--lh-e` / `--colw`（手机上应是 15px / 1.7 / 100%）+ 页面名与正文字号；
 *   - 安全区：`body` 的 paddingTop / paddingBottom（设备上应 = 状态栏 / Home 条高度）；
 *   - 桌面件不上手机：`.wctl` 的 display（Android 上应 none）+ `body.is-android`；
 *   - 悬浮 FAB：存在性 / display / 宽高 / 右下距（**只有页面列（窄屏=抽屉）开着时它在**——`10` §4.1
 *     的「首页 FAB」在当前架构里落在这处，0.6 重排移动形态时随批复核）。
 *
 * 已知边界（2026-10-08 实测）：**锁屏不挡读数**（内文宽度/高度会是 0，computed 值照读），
 * 但挡 `pm install` 与 `screencap`（EMUI 安全锁）——装机与截图前先把设备解锁。
 */
import { createRequire } from 'node:module'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
/** `ws` 是传递依赖（不在 package.json）——直接解析不到就按 pnpm 布局找一个。 */
const resolveWs = () => {
  try { return require('ws') } catch { /* 往下找 */ }
  const pnpmDir = join(process.cwd(), 'node_modules', '.pnpm')
  const dir = readdirSync(pnpmDir).filter((name) => name.startsWith('ws@')).sort().pop()
  if (!dir) throw new Error('找不到 ws（构造版 CDP 需要它；pnpm 布局里应有 ws@*）')
  return require(join(pnpmDir, dir, 'node_modules', 'ws'))
}
const WebSocket = resolveWs()

const outPath = process.argv[2] ?? null
const port = Number(process.argv[3] ?? 9222)

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json().catch(() => {
  console.error(`连不上 http://127.0.0.1:${port}/json —— 先做「前置」三步（adb forward）。`)
  process.exit(2)
})
const page = targets.find((t) => t.type === 'page')
if (!page) { console.error('没有 page target（应用在前台跑着吗？）'); process.exit(3) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
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

const expression = `(() => {
  const root = getComputedStyle(document.documentElement)
  const body = getComputedStyle(document.body)
  const nameRow = document.querySelector('.editor-content .moqi-block[data-block-object="true"]')
  const textBlock = document.querySelector('.editor-content .moqi-block:not([data-block-object="true"])')
  const wctl = document.querySelector('.wctl')
  const fab = document.querySelector('.fab')
  const fabRect = fab ? fab.getBoundingClientRect() : null
  return JSON.stringify({
    title: document.title,
    view: document.querySelector('.view.is-on')?.getAttribute('aria-label') ?? null,
    innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio,
    isAndroid: document.body.classList.contains('is-android'),
    dataFs: document.documentElement.dataset.fs ?? null,
    dataLh: document.documentElement.dataset.lh ?? null,
    dataColw: document.documentElement.dataset.colw ?? null,
    fs: root.getPropertyValue('--fs-e').trim(),
    lh: root.getPropertyValue('--lh-e').trim(),
    colw: root.getPropertyValue('--colw').trim(),
    bodyPadTop: body.paddingTop, bodyPadBottom: body.paddingBottom,
    nameFont: nameRow ? getComputedStyle(nameRow).fontSize : null,
    nameLH: nameRow ? getComputedStyle(nameRow).lineHeight : null,
    textFont: textBlock ? getComputedStyle(textBlock).fontSize : null,
    textLine: textBlock ? getComputedStyle(textBlock).lineHeight : null,
    wctlDisplay: wctl ? getComputedStyle(wctl).display : null,
    fab: fab ? { display: getComputedStyle(fab).display, w: Math.round(fabRect.width), h: Math.round(fabRect.height), right: Math.round(innerWidth - fabRect.right), bottom: Math.round(innerHeight - fabRect.bottom) } : null,
  })
})()`

const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
const value = result.result?.value ?? JSON.stringify(result)
console.log(value)
if (outPath) writeFileSync(outPath, value)
ws.close()
