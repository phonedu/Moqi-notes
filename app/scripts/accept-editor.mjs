/**
 * 编辑器稳定性验收（`docs/04` §6 七项 + §10 回归矩阵 + 文档里写着的**正确用法**）。
 *
 * 为什么它在仓库里（用户口径 ）：「本来就是一个非常正确的用法，就因为我们修改完以后没跑过，
 * 导致了二次的重跑，非常的消耗时间」——所以正确用法必须**可执行**，而不是只写在文档里。
 *
 * 用法：
 *   pnpm dev            # 另开一个终端，或 pnpm tauri dev（浏览器通道用同一份源码）
 *   pnpm accept         # 默认打 http://localhost:5173，用本机 Edge 内核无头跑
 *   MOQI_URL=http://localhost:5199/ pnpm accept   # 指向别的 dev server（对照旧版本时很有用）
 *
 * 它只碰**浏览器 localStorage**（每轮先清空），不读写桌面端 SQLite：验证不污染用户数据。
 * 每条检查都要有机器可读的证据，报告写在 %TEMP%/moqi-acceptance/reports/editor-acceptance.json。
 *
 * 约定：**新增或修改任何编辑器能力时，必须同时在 `CHECKS` 里加一条它的正确用法**
 * （见 `docs/04` §6 的强制流程）。脚本会打印每项 PASS/FAIL 与非零退出码。
 */
import { chromium } from 'playwright-core'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { decodePng, pixelAt } from './lib/png.mjs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL = process.env.MOQI_URL ?? 'http://localhost:5173/'
/** 子集模式（@0 批准）：`MOQI_ONLY=<id 前缀>` 只跑匹配的 check；未设置 = 现有行为逐字不变。
 *  子集跑**不覆盖全量产物**（写 `editor-acceptance-only.json`、不写 `history/`）——否则会污染取证 diff 与历史清单。
 *  注意：子集模式**只隔离「判定与产物」**，各段刺激仍照跑 ⇒ 墙钟与全量相同（不是提速开关）。 */
const ONLY = process.env.MOQI_ONLY ?? ''
let skippedChecks = 0
const REPORT_DIR = join(tmpdir(), 'moqi-acceptance', 'reports')
mkdirSync(REPORT_DIR, { recursive: true })

const results = []
const errors = []
let failed = 0
const t0 = Date.now()
const startedAt = new Date().toISOString()
/** 预热读数（dev server 冷启动花掉的时间）——套件稳定性的第一条读数，进报告。 */
let warmupMs = 0
/** 相邻两条 check 的墙钟间隔也进报告：固定等待窗的大户会在报表里露出来（加固清单的依据）。 */
let lastCheckAt = t0
const check = (name, ok, evidence) => {
  if (ONLY !== '' && !name.startsWith(ONLY)) {
    // 仍求值（不影响后续步骤与证据），但不计入 pass/fail、也不更新 lastCheckAt（保持真实间隔）
    skippedChecks += 1
    console.log(`SKIP [${((Date.now() - t0) / 1000).toFixed(0)}s] ${name}`)
    return
  }
  if (!ok) failed += 1
  results.push({ name, ok, evidence, sincePrevMs: Date.now() - lastCheckAt })
  lastCheckAt = Date.now()
 // 前缀 = 从开跑到这一条的花费（秒）：负载下哪些段落被拖住了，看日志一眼能对账（ 补）。
  const at = `${((Date.now() - t0) / 1000).toFixed(0)}s`
  console.log(`${ok ? 'PASS' : 'FAIL'} [${at}] ${name}${ok ? '' : '  → ' + JSON.stringify(evidence).slice(0, 400)}`)
}

/**
 * 报告：最新一份固定写 `editor-acceptance.json`，同时按时间戳留一份历史（最近 40 份）。
 * 为什么要历史：只留最新会把「哪一轮挂的什么」冲掉； 还栽过「没看时间戳，
 * 把旧报告读成 149/149」。**看报告先看 at。**
 */
const writeReport = (extra = {}) => {
  const report = {
    url: URL, results, errors, at: new Date().toISOString(),
    startedAt, durationMs: Date.now() - t0, warmupMs, subset: ONLY || null, skippedChecks, ...extra,
  }
  const reportPath = join(REPORT_DIR, ONLY ? 'editor-acceptance-only.json' : 'editor-acceptance.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 1))
  if (!ONLY) {
    const historyDir = join(REPORT_DIR, 'history')
    mkdirSync(historyDir, { recursive: true })
    writeFileSync(join(historyDir, `accept-${report.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 1))
    const files = readdirSync(historyDir).filter((f) => f.endsWith('.json')).sort()
    for (const stale of files.slice(0, Math.max(0, files.length - 40))) rmSync(join(historyDir, stale))
  }
  return { report, reportPath }
}

/** 半路崩也要留证据（套件稳定性立项，）：以前脚本崩掉什么都不写，报告目录还是上一轮的。
    ESM 顶层 await 抛错走的是 uncaughtException（ 实测：只挂 unhandledRejection 接不住）、
    裸 Promise 走 unhandledRejection——两个都接。 */
const writeCrashReport = (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  errors.push(`脚本中断：${message}`)
  let path = '(写不出)'
  try { path = writeReport({ aborted: true }).reportPath } catch { /* 写不出就算了 */ }
  console.error(`\n脚本中断在半路：${message}`)
  console.error(`已写「中断残报告」（含中断点前跑完的 ${results.length} 条；at 与 finishedAt 见报告）→ ${path}`)
  process.exit(2)
}
process.on('unhandledRejection', writeCrashReport)
process.on('uncaughtException', writeCrashReport)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
// 稳定性（）：默认 30s 在冷启动 / 负载下会假红——本轮实测连着四轮挂了四个**不同**的项目
// （PAGENAME-* / D-003 / BLOCK-19/20 / REF-DANGLE），都不是功能坏。先把**动作**超时抬到 60s（导航那条原本就是 60s），
// 再让首次导航吃一次「等 dev server 编译完」的余量。
page.setDefaultTimeout(60000)
// 导航层加固（套件稳定性立项，）：Playwright 默认导航超时 30s——机器忙时一次
// reload / 首载就可能超，症状是**整轮崩在半路、没有报告**（口径里的「负载下首次页面加载
// 30 秒超时」）。放宽到 60s；超时重试在下面的 reload() / gotoApp() 里。
page.setDefaultNavigationTimeout(60_000)
page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 200)))
const sleep = (ms) => page.waitForTimeout(ms)

/** 领域真值：块图（文本 / 类型 / 父子 / 删除标记）。落盘有 220ms 同步 + 600ms 节拍，改完至少等 1.2s 再读。 */
const graph = () => page.evaluate(() => JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').map((b) => ({
  id: b.entityId.slice(0, 6),
  type: b.type,
  text: (b.content ?? []).map((f) => f.v).join(''),
  parent: b.parent ? b.parent.slice(0, 6) : null,
  kids: b.children.length,
  del: Boolean(b.deleted),
})))
const live = async () => (await graph()).filter((b) => !b.del)
const domTexts = () => page.evaluate(() => [...document.querySelectorAll('.editor-content .moqi-block')].map((b) => (b.textContent ?? '').trim()))
const offsetInBlock = () => page.evaluate(() => {
  const selection = window.getSelection()
  let node = selection?.anchorNode ?? null
  if (node && node.nodeType === 3) node = node.parentElement
  return { inBody: Boolean(node?.closest?.('.moqi-block')), offset: selection?.anchorOffset ?? -1, active: (document.activeElement?.className ?? '').toString().slice(0, 24) }
})
const toast = () => page.evaluate(() => document.querySelector('.notice')?.textContent ?? null)
const saveState = () => page.evaluate(() => document.querySelector('.sb-sync .stxt')?.textContent ?? null)

/** 点击某个块（文本匹配：先精确、再前缀、再包含；优先最内层块）。 */
const clickBlock = async (text, which = 'last') => {
  const box = await page.evaluate(([needle, mode]) => {
    const all = [...document.querySelectorAll('.editor-content .moqi-block')]
    const hits = all.filter((b) => { const t = (b.textContent ?? '').trim(); return t === needle || t.startsWith(needle) || t.includes(needle) })
    const leaves = hits.filter((b) => b.querySelector('.moqi-block') === null)
    const pool = leaves.length > 0 ? leaves : hits
    const el = mode === 'first' ? pool[0] : pool[pool.length - 1]
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const rect = el.getBoundingClientRect()
    return { x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2) }
  }, [text, which])
  if (!box) throw new Error(`找不到块：${text}`)
  await page.mouse.click(box.x, box.y)
  await sleep(280)
  return box
}
/** 光标弄到块内第 target 个字符（Home 在真实点击后不保证立刻生效，按键后核对偏移）。 */
const caretTo = async (target) => {
  await page.keyboard.press('Home')
  await sleep(150)
  for (let i = 0; i < target; i += 1) { await page.keyboard.press('ArrowRight'); await sleep(60) }
  return (await offsetInBlock()).offset
}
const depthOf = (text) => page.evaluate((needle) => {
  const el = [...document.querySelectorAll('.editor-content .moqi-block')].reverse().find((b) => (b.textContent ?? '').trim().startsWith(needle))
  if (!el) return null
  let depth = 0
  let parent = el.parentElement
  while (parent && !parent.classList.contains('editor-content')) { if (parent.classList.contains('moqi-block')) depth += 1; parent = parent.parentElement }
  return depth
}, text)
/** 块图自洽：活跃块不能留在数据里却不在界面上（parent 指向活跃父块、父块 children 里有它）。 */
const graphIssues = (blocks) => {
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const issues = []
  for (const b of blocks) {
    if (b.parent === null) continue
    const parent = byId.get(b.parent)
    if (!parent) issues.push(`${b.id} 的父块不在活跃图里`)
  }
  return issues
}

/** 负载下首载就绪的等待窗：15000 在机器忙时不够（编辑器渲染晚于它 = 整轮崩在半路）。 */
const NAV_READY_MS = 30_000

/**
 * 读点加固（套件稳定性立项，）：**固定等待窗在机器忙时会飘**——落盘有 220ms 防抖
 * ＋600ms 节拍，负载下都会往后拖，固定 sleep 之后读到旧态，单项就红了（连续四轮挂在四个
 * 不同项目：PAGENAME-* → D-003 → BLOCK-19/20 → REF-DANGLE，都是这一类）。
 * 规则：**读存档的读点要轮询到「应有的事实」为止**（有界超时；超时返回最后一次读到的值，
 * 证据里能看出卡在哪一步）。固定 sleep 只作动作之间的节拍，不再作为读点的依据。
 */
const poll = async (read, ok, { timeout = 8000, step = 200, label = '条件' } = {}) => {
  const until = Date.now() + timeout
  let value = await read()
  while (!ok(value) && Date.now() < until) {
    await sleep(step)
    value = await read()
  }
  if (!ok(value)) console.log(`  （轮询超时：${label}，等了 ${timeout}ms，读到 ${JSON.stringify(value).slice(0, 160)}）`)
  return value
}

/** 导航层加固：超时重试 3 次（中间给 dev server 一口气）。 */
const reload = async () => {
  for (let attempt = 1; ; attempt += 1) {
    try { await page.reload({ waitUntil: 'domcontentloaded' }); return }
    catch (error) {
      if (attempt >= 3) throw new Error(`reload 连续 ${attempt} 次失败（${error.message}）——先按 06 §4.1.1 重启 dev server 再跑`)
      console.log(`  （reload 超时，第 ${attempt} 次重试）`)
      await page.waitForTimeout(1500)
    }
  }
}
const gotoApp = async () => {
  for (let attempt = 1; ; attempt += 1) {
    try { await page.goto(URL, { waitUntil: 'domcontentloaded' }); return }
    catch (error) {
      if (attempt >= 3) throw new Error(`打开 ${URL} 连续 ${attempt} 次失败（${error.message}）——dev server 没起或正在重启`)
      console.log(`  （goto 超时，第 ${attempt} 次重试）`)
      await page.waitForTimeout(1500)
    }
  }
}

// ---------- 预热：先把 dev server 冷启动那一次吃掉，并留读数 ----------
// vite 冷启动（首次请求才编译）在机器忙时可能几十秒——以前这件事撞在半路 = 「整轮超时、
// 没有报告」。预热失败 = 环境问题，立刻停并说清怎么修，不跑到一半才崩。
{
  const warmStart = Date.now()
  try {
    await gotoApp()
    await page.waitForSelector('.editor-content .moqi-block', { timeout: 90_000 })
  } catch (error) {
    console.error(`\n预热失败：${error.message}`)
    console.error(`先确认 dev server 已在 ${URL} 起来（pnpm dev 或 scripts/start-verification.ps1），再重跑 pnpm accept。`)
    await browser.close()
    process.exit(2)
  }
  warmupMs = Date.now() - warmStart
  console.log(`预热完成：${warmupMs} ms（含 dev server 冷启动；套件稳定性的第一条读数）`)
}

// ---------- 准备：干净页面 + 一段文字 ----------
// 打完**自检**：清空 localStorage 后 reload 到编辑器可交互之间有一个窗口，抢在它之前点击会丢字
// （ 两次偶发：`reset()` 之后第一段没打进去，后面的 `clickBlock('第一段')` 直接抛错）。
// 这里等首帧稳一下、打完确认，不成就重来一次——种子不牢，后面每条检查都是假的。
const reset = async () => {
  await gotoApp()
  await page.evaluate(() => localStorage.clear())
  // `R09-FMT-7` 的首次一次性提示（T6 ①b）会在这时候弹 toast，挡住早期点击：除了它自己那条检查，
  // 其余检查一律预置「已经看过」。**默认看过**是这里的口径——单条检查自己清掉偏好再验。
  await page.evaluate(() => localStorage.setItem('moqi-project-b:ui-prefs', JSON.stringify({ slashHintSeen: true })))
  await reload()
  await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
  await sleep(400)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const box = await page.evaluate(() => {
      const el = document.querySelector('.editor-content .moqi-block')
      const rect = el.getBoundingClientRect()
      return { x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2) }
    })
    await page.mouse.click(box.x, box.y)
    await sleep(300)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('第一段')
    await sleep(1350)
    const seeded = await page.evaluate(() => document.querySelector('.editor-content .moqi-block')?.textContent?.includes('第一段') === true)
    if (seeded) return
    console.log(`reset：第 ${attempt} 次种子没打进去，重试`)
    await reload()
    await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
    await sleep(500)
  }
  throw new Error('reset：连续 3 次没把「第一段」打进第一个块——验收无法继续')
}
await reset()

// ---------- 侧栏统计（`R09-PRIN-13` / `SIDE-STATS-1`）----------
const statsRead = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('.sb-heat-day')]
  const top = (selector) => document.querySelector(selector)?.getBoundingClientRect().top ?? null
  return {
    present: Boolean(document.querySelector('.sb-stats')),
    cells: cells.length,
    levels: cells.map((cell) => cell.getAttribute('data-level')),
    figures: [...document.querySelectorAll('.sb-figure')].map((el) => (el.textContent ?? '').trim()),
    weekdays: document.querySelectorAll('.sb-heat-weekday').length,
    months: [...document.querySelectorAll('.sb-heat-month')].map((el) => (el.textContent ?? '').trim()).filter(Boolean),
    label: document.querySelector('.sb-heat')?.getAttribute('aria-label') ?? null,
    figuresTop: top('.sb-figures'),
    heatTop: top('.sb-heat'),
    navTop: top('.sb-nav'),
  }
})
check('SIDE-STATS-1 侧栏统计区：统计三格在热力图之前、热力图在页面库之前；84 个热力格、左侧七行星期、下方月份、数字有值、至少一格有活跃度',
  statsRead.present === true && statsRead.cells === 84 && statsRead.figures.length === 3
  && statsRead.figures.every((text) => /[0-9]/.test(text)) && statsRead.levels.every((level) => /^[0-4]$/.test(level ?? ''))
  && statsRead.levels.some((level) => level !== '0') && /近 12 周/.test(statsRead.label ?? '')
  && statsRead.weekdays === 7 && statsRead.months.length > 0
  && statsRead.figuresTop !== null && statsRead.heatTop !== null && statsRead.navTop !== null
  && statsRead.figuresTop < statsRead.heatTop && statsRead.heatTop < statsRead.navTop,
  statsRead)

// ---------- §6-1 开头 / 中间 / 结尾 Enter ----------
await clickBlock('第一段')
const atStart = await caretTo(0)
await page.keyboard.press('Enter')
await sleep(1350)
let blocks = await live()
check('BLOCK-ENTER-1 开头 Enter：原文成块、容器留空、光标在新块', atStart === 0
  && blocks.some((b) => b.text === '第一段' && b.parent !== null)
  && blocks.some((b) => b.text === '' && b.parent === null), { atStart, blocks, dom: await domTexts() })

await clickBlock('第一段')
const atMid = await caretTo(2)
await page.keyboard.press('Enter')
await sleep(1350)
const split = (await live()).map((b) => b.text)
check('BLOCK-ENTER-2 中间 Enter：切成两块、不复制文字', atMid === 2 && split.includes('第一') && split.includes('段'), { atMid, split })

await clickBlock('段')
await page.keyboard.press('End')
await sleep(200)
await page.keyboard.press('Enter')
await sleep(400)
await page.keyboard.type('尾')
await sleep(1350)
check('BLOCK-ENTER-3 结尾 Enter：新块可继续输入', (await live()).some((b) => b.text === '尾'), { blocks: (await live()).map((b) => b.text) })

// ---------- §6-2 空块连续 Enter ----------
await clickBlock('尾')
await page.keyboard.press('End')
await sleep(200)
for (let i = 0; i < 3; i += 1) { await page.keyboard.press('Enter'); await sleep(450) }
await sleep(1350)
blocks = await live()
check('BLOCK-ENTER-4 空块连续 Enter：连续生成空块、不动其他块', blocks.filter((b) => b.text === '').length >= 3 && blocks.some((b) => b.text === '尾'), { blocks: blocks.map((b) => b.text) })

// ---------- §6-3 删除后重写：旧文字不复活 ----------
await clickBlock('尾')
await page.keyboard.press('End')
await sleep(200)
await page.keyboard.press('Backspace')
await sleep(300)
await page.keyboard.type('新写的')
await sleep(400)
await page.keyboard.press('Enter')
await sleep(400)
await page.keyboard.type('第二行')
await sleep(1500)
const rewritten = (await live()).map((b) => b.text)
check('BLOCK-ENTER-5 删除后重写：新内容覆盖旧快照、旧文字不复活', rewritten.includes('新写的') && rewritten.includes('第二行') && !rewritten.includes('尾'), rewritten)

// ---------- §6-4 保存延迟期间继续输入 / 点击 ----------
await clickBlock('第二行')
await page.keyboard.press('End')
await sleep(150)
await page.keyboard.type('快速输入')
await clickBlock('新写的')
await page.keyboard.press('End')
await page.keyboard.type('也不丢')
await sleep(2000)
const survived = (await live()).map((b) => b.text)
check('LIFECYCLE-SAVE-2 保存延迟期间继续输入与点击：不回滚、全部落盘', survived.some((t) => t.includes('快速输入')) && survived.some((t) => t.includes('也不丢')), { survived, save: await saveState() })

// ---------- §6-5 刷新后一致 ----------
const beforeReload = (await live()).map((b) => `${b.type}:${b.text}:${b.parent ?? 'root'}`).sort()
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(1500)
const afterReload = (await live()).map((b) => `${b.type}:${b.text}:${b.parent ?? 'root'}`).sort()
check('LIFECYCLE-LOAD-1 刷新后正文 / 顺序 / 类型 / 层级一致', JSON.stringify(beforeReload) === JSON.stringify(afterReload), { beforeReload, afterReload })

// ---------- §6-6 IME / 斜杠菜单 ----------
await clickBlock('新写的也不丢')
await page.keyboard.press('End')
await sleep(150)
const session = await page.context().newCDPSession(page)
await session.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
await sleep(250)
const duringIme = await page.evaluate(() => ({ menu: Boolean(document.querySelector('.slash-menu')), blocks: document.querySelectorAll('.editor-content .moqi-block').length }))
await session.send('Input.insertText', { text: '中' })
await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
await sleep(1400)
await session.detach()
check('BLOCK-IME-1 IME 组合：不拆块、不弹菜单、提交后写入一次', !duringIme.menu && (await live()).some((b) => b.text.includes('中')), { duringIme, blocks: (await live()).map((b) => b.text) })

await caretTo(0)
await page.keyboard.type('/')
await sleep(700)
const menuOpen = await page.evaluate(() => Boolean(document.querySelector('.slash-menu')))
await page.keyboard.press('Escape')
await sleep(500)
const menuClosed = await page.evaluate(() => !document.querySelector('.slash-menu'))
await page.keyboard.press('Backspace')
await sleep(1400)
check('BLOCK-SLASH-1 斜杠菜单：能打开、Esc 关闭、触发词可删除（无残留）', menuOpen && menuClosed && !(await live()).some((b) => b.text.includes('/')), { menuOpen, menuClosed, blocks: (await live()).map((b) => b.text) })

// ---------- §6-7 结构操作后撤销 / 重做 ----------
await clickBlock('新写的')
const d0 = await depthOf('新写的')
await page.keyboard.press('Tab')
await sleep(1400)
const d1 = await depthOf('新写的')
await page.keyboard.press('Control+z')
await sleep(1500)
const d2 = await depthOf('新写的')
await page.keyboard.press('Control+Shift+z')
await sleep(1500)
const d3 = await depthOf('新写的')
check('BLOCK-TAB-2 结构操作：缩进 → ⌘Z 复原 → ⇧⌘Z 重做，之后仍可保存', d1 === d0 + 1 && d2 === d0 && d3 === d1, { d0, d1, d2, d3, save: await saveState() })

// ---------- 正确用法：换文档 = 文档格式归零（04 §1） ----------
await clickBlock('新写的')
await page.keyboard.press('End')
await page.keyboard.press('Control+a')
await page.keyboard.press('Control+b')   // 光标处开加粗
await sleep(500)
const boldBefore = await page.evaluate(() => document.querySelectorAll('.editor-content strong').length)
await page.keyboard.press('Control+n')   // 新建页面 = 新文档
await sleep(1600)
const boldAfter = await page.evaluate(() => document.querySelectorAll('.editor-content strong').length)
check('LIFECYCLE-NEW-2 新建页面：行内格式归零（上一篇的加粗不带过去）', boldBefore >= 1 && boldAfter === 0, { boldBefore, boldAfter })

// ---------- 正确用法：空列表项不塌行（09 §五 data-own-line） ----------
await page.evaluate(() => {
  const key = 'moqi-project-b:blocks'
  const blocks = JSON.parse(localStorage.getItem(key) ?? '[]')
  const page = blocks.find((b) => b.parent === null)
  const target = blocks.find((b) => !b.isObject && !b.deleted && b.entityId !== page.entityId)
  if (!target) return
  target.type = 'numbered'
  target.content = []
  const child = blocks.find((b) => b.parent === page.entityId && b.entityId !== target.entityId)
  if (child) { child.parent = target.entityId; target.children = [child.entityId]; page.children = [target.entityId] }
  localStorage.setItem(key, JSON.stringify(blocks))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(1500)
const geometry = await page.evaluate(() => [...document.querySelectorAll('.editor-content .moqi-block')].map((el) => {
  const rect = el.getBoundingClientRect()
  return { type: el.dataset.blockType, ownLine: el.dataset.ownLine ?? null, text: (el.textContent ?? '').trim().slice(0, 6), top: Math.round(rect.top), bottom: Math.round(rect.bottom) }
}))
const emptyItem = geometry.find((g) => g.type === 'numbered')
// 子块 = 位于编号块**下方**的第一个有文字的块（容器也在 geometry 里，别选到它）
const childOfEmpty = geometry
  .filter((g) => g.type === 'text' && (g.text?.length ?? 0) > 0 && g.top > (emptyItem?.top ?? 0))
  .sort((a, b) => a.top - b.top)[0]
// 子块是父块的 DOM 子孙，盒子套在里面是正常的；要判定的是「子块不压在父块自己那一行上」——
// 父块自己那一行 = 上内边距 5 + 一行行高（1lh，正文 28px）≈ 33px。
const ownLineBottom = emptyItem ? emptyItem.top + 33 : 0
check('BLOCK-LINE-1 空列表项：块保留自己那一行（编号不与子块重叠）',
  emptyItem?.ownLine === 'missing' && Boolean(childOfEmpty) && childOfEmpty.top >= ownLineBottom - 2,
  { geometry, ownLineBottom })

// ---------- 正确用法：行尾 ＋ 落盘父块的子级（04 §2） ----------
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(1500)
check('LIFECYCLE-LOAD-2 重载后块图自洽（没有留在数据里却不在界面上的块）', graphIssues(await live()).length === 0, graphIssues(await live()))
check('全程无未捕获异常', errors.length === 0, errors)

// ---------- 正确用法：输入文字的撤销 / 重做（04 §5； 用户实测的缺陷点） ----------
// 曾经的写法问 `CAN_UNDO_COMMAND` 决定归属，而 Lexical 0.51 的旧版 HistoryPlugin 不应答这个查询命令，
// 于是 ⌘Z 永远走领域：字撤不掉、反倒撤掉更早的结构动作。这条检查专门看住它。
await clickBlock('新写的')
await page.keyboard.press('End')
await sleep(200)
await page.keyboard.type('甲乙')
await sleep(1400)
const typedText = (await live()).map((b) => b.text).join('|')
await page.keyboard.press('Control+z')
await sleep(1300)
const afterUndoOnce = (await live()).map((b) => b.text).join('|')
await page.keyboard.press('Control+Shift+z')
await sleep(1300)
const afterRedo = (await live()).map((b) => b.text).join('|')
check('UNDO-TYPE-1 输入文字后 ⌘Z 撤掉刚敲的字、⇧⌘Z 再重做',
  typedText.includes('甲乙') && !afterUndoOnce.includes('甲乙') && afterRedo.includes('甲乙'),
  { typedText, afterUndoOnce, afterRedo })

// ---------- 正确用法：菜单浮层压过抽屉（09 §八；「卡片 ⋯ 点了没反应」的回归点） ----------
// 窄屏下页面列是抽屉（--z-drawer），卡片 ⋯ 的菜单生在抽屉内部，必须画在抽屉之上（--z-popover）。
// 断错层级时菜单照常出现在 DOM 里，但被抽屉盖住 —— 用户看到的就是「点了没反应」。
await page.setViewportSize({ width: 1100, height: 900 })
await page.waitForTimeout(600)
const moreBox = await page.evaluate(() => {
  const b = document.querySelector("button.pmore")
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})
if (!moreBox) { results.push({ name: "PANEL-Z-1 卡片 ⋯ 菜单压过抽屉", ok: false, evidence: "窄屏没有 pmore 按钮" }); failed += 1 }
else {
  await page.mouse.click(moreBox.x, moreBox.y)
  await sleep(700)
  const look = await page.evaluate(() => {
    const pop = document.querySelector(".pop")
    if (!pop) return { ok: false, why: "菜单没有出现" }
    const r = pop.getBoundingClientRect()
    const hit = document.elementFromPoint(Math.round(r.left + Math.min(60, r.width / 2)), Math.round(r.top + 14))
    return { ok: Boolean(hit?.closest?.(".pop")), popZ: getComputedStyle(pop).zIndex, hitCls: (hit?.className ?? "").toString().slice(0, 30) }
  })
  check("PANEL-Z-1 卡片 ⋯ 菜单压在抽屉之上（点得到菜单项）", look.ok === true, look)
  await page.keyboard.press("Escape")
  await sleep(300)
}
await page.setViewportSize({ width: 1280, height: 900 })
await page.waitForTimeout(600)

// ---------- 正确用法：滚动时装饰层跟着走（04 §7；AI 标签行「飘起来」的回归点） ----------
// 装饰层（把手 / ＋ / 折叠 / 待办 / AI 标签与操作行）用的是**视口坐标**，
// 滚动后必须重新测量；监听挂在错误的元素上就会「文字飘起来」。这里直接量块与标记的相对位置。
await clickBlock("新写的")
const markerDelta = async () => page.evaluate(() => {
  const handle = document.querySelector(".block-rail .b-handle")
  const id = handle?.closest("[data-marker-for]")?.dataset.markerFor
  const block = id ? document.querySelector("[data-entity-id=\"" + id + "\"]") : null
  if (!handle || !block) return null
  const h = handle.getBoundingClientRect(); const b = block.getBoundingClientRect()
  return Math.round((h.top + h.height / 2) - (b.top + 14))
})
const scroller = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".doc-col")].find((x) => x.scrollHeight > x.clientHeight + 4)
  return el ? true : false
})
const deltaBefore = await markerDelta()
await page.evaluate(() => { const el = [...document.querySelectorAll(".doc-col")].find((x) => x.scrollHeight > x.clientHeight + 4); if (el) el.scrollTop += 200 })
await sleep(900)
const deltaAfter = await markerDelta()
await page.evaluate(() => { const el = [...document.querySelectorAll(".doc-col")].find((x) => x.scrollHeight > x.clientHeight + 4); if (el) el.scrollTop -= 200 })
await sleep(600)
check("PANEL-OVERLAY-1 滚动后装饰层跟着块走（相对位置不变；AI 标签行不「飘」）",
  !scroller || (deltaBefore !== null && deltaAfter !== null && deltaBefore === deltaAfter),
  { scroller, deltaBefore, deltaAfter })

// ---------- 正确用法：编辑器里多出来的块会被同步收敛回领域（04 §2， 回归点） ----------
// 用户实际踩到的链路：编辑器里删块（镜像成领域删除）→ Lexical 撤销把块带回编辑器 → 领域侧没有它。
// 以前适配器在这里抛异常，把唯一的收敛通路堵死（表现：回车没反应）。这条检查专门看住「能自愈」。
await clickBlock("新写的");
const healTargetId = (await live()).find((b) => b.text.startsWith("新写的"))?.id ?? null;
await page.evaluate((id) => {
  const key = "moqi-project-b:blocks";
  const blocks = JSON.parse(localStorage.getItem(key) ?? "[]");
  const victim = blocks.find((b) => b.entityId.startsWith(id));
  if (!victim) return;
  const parent = blocks.find((b) => b.entityId === victim.parent);
  if (parent) parent.children = parent.children.filter((c) => c !== victim.entityId);
  victim.parent = null;
  localStorage.setItem(key, JSON.stringify(blocks));
}, healTargetId);
await sleep(1500);
await clickBlock("新写的");
await page.keyboard.press("End");
await sleep(200)
await page.keyboard.type("补");
await sleep(1600);
const healed = await live();
check("BLOCK-SYNC-1 领域里缺的块由同步补回（编辑器里有的块永远能读回领域，不抛异常）",
  healed.some((b) => b.id === (healTargetId ?? "").slice(0, 6)) || healed.some((b) => b.text.includes("新写的")),
  { healTargetId, blocks: healed.map((b) => b.text) })

// ---------- W2：折叠入口对**所有有子块的块**开放（`R09-BLOCK-7` 裁决；`BLOCK-COLLAPSE-1/2/3`）----------
// 旧口径只给 H1–H3：项目符号 / 待办这些带孩子的内容块**没法折叠**。这里播一个「非标题 + 有子块」，
// 验三件：① hover 出箭头（无子块的块不出）；② 收起后子块隐藏、箭头**常显**（不靠 hover）、点得回；
// ③ 块菜单里「折叠 / 展开」项同样放宽（没子块的块不给这一项）。
await page.evaluate(() => localStorage.clear())
// 与 `reset()` 同口径：一次性斜杠提示预置「已看过」，防它弹出来挡点击。
await page.evaluate(() => localStorage.setItem('moqi-project-b:ui-prefs', JSON.stringify({ slashHintSeen: true })))
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
/** 块**自己那一行**的中心：包围盒中心不行——有子块时盒高含子树，中心落在子块上（hover 会记到子块）。
    公式与 `blockMarkers.ownLineCenter` 同源：padding-top + 行高一半。 */
const ownLinePoint = (entityId) => page.evaluate((id) => {
  const el = document.querySelector(`.editor-content .moqi-block[data-entity-id="${id}"]`)
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  const st = getComputedStyle(el)
  const pad = parseFloat(st.paddingTop || '0') || 0
  return { x: Math.round(r.left + 40), y: Math.round(r.top + pad + parseFloat(st.lineHeight) / 2) }
}, entityId)
const hoverBlock = async (entityId) => {
  const point = await ownLinePoint(entityId)
  if (!point) throw new Error(`找不到块：${entityId}`)
  await page.mouse.move(point.x, point.y)
  await sleep(420)
}
/** `data-marker-for` 挂在 `.block-rail` 容器上，按钮 `.b-collapse` 是它的子元素。 */
const arrowState = (entityId) => page.evaluate((id) => {
  const arrow = document.querySelector(`.block-rail[data-marker-for="${id}"] .b-collapse`)
  return { present: Boolean(arrow), label: arrow?.getAttribute('aria-label') ?? null }
}, entityId)
/** 播种「非标题但有子块」：项目符号 ← 文本子块；再放一个没有子块的普通块作对照。
    页上带一条自定义属性——后面 `PANEL-HIT-1` 要量属性行 ⋯ 的触达尺寸（它只在自定义属性行上渲染）。 */
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text, parent, position, children, isObject = false, objectName = null, extra = {}) => ({
    entityId: id, blockUid: uid, type, content: text ? [{ t: 'text', v: text }] : [], parent, children, position,
    collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null,
    isObject, objectName, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [],
    aiMeta: null, created: now, modified: now, ...extra,
  })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    mk('w2-p', 'w2page01', 'text', 'W2 折叠页', null, 0, ['w2-b', 'w2-loose'], true, 'W2 折叠页', { properties: [{ defId: 'd-hit1', type: 'text', value: '进行中' }] }),
    mk('w2-b', 'w2b00001', 'bullet', '带子块的项目符号', 'w2-p', 0, ['w2-c']),
    mk('w2-c', 'w2c00001', 'text', '子块正文', 'w2-b', 0, []),
    mk('w2-loose', 'w2l00001', 'text', '没有子块的普通块', 'w2-p', 1, []),
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [{ id: 'd-hit1', name: '状态', type: 'text', created: now }], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block[data-entity-id="w2-b"]', { timeout: NAV_READY_MS })
await sleep(1000)
await hoverBlock('w2-b')
const bulletArrow = await arrowState('w2-b')
await hoverBlock('w2-loose')
const looseArrow = await arrowState('w2-loose')
// ② 收起：子块隐藏、箭头常显（移开鼠标仍在）、再点回来
await hoverBlock('w2-b')
await page.locator('.block-rail[data-marker-for="w2-b"] .b-collapse').click()
await sleep(600)
const collapsedChild = await page.evaluate(() => {
  const child = document.querySelector('.editor-content .moqi-block[data-entity-id="w2-c"]')
  return child ? getComputedStyle(child).display : null
})
await page.mouse.move(10, 10)
await sleep(450)
const arrowAfterLeave = await arrowState('w2-b')
await page.locator('.block-rail[data-marker-for="w2-b"] .b-collapse').click()
await sleep(600)
const expandedChild = await page.evaluate(() => {
  const child = document.querySelector('.editor-content .moqi-block[data-entity-id="w2-c"]')
  return child ? getComputedStyle(child).display : null
})
// ③ 块菜单：有子块的非标题块给「折叠」项；没有子块的块不给
const menuItemsOf = async (entityId) => {
  // 同 hover：必须在块**自己那一行**右键，locator 默认点盒中心（有子块时点到子块上）。
  const point = await ownLinePoint(entityId)
  if (!point) throw new Error(`找不到块：${entityId}`)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await sleep(450)
  const items = await page.evaluate(() => [...document.querySelectorAll('.pop[role="menu"] button')].map((b) => (b.textContent ?? '').trim()))
  await page.keyboard.press('Escape')
  await sleep(300)
  return items
}
const menuOnBullet = await menuItemsOf('w2-b')
const menuOnLoose = await menuItemsOf('w2-loose')
const hasCollapseItem = (items) => items.some((t) => t === '折叠' || t === '展开')
check('BLOCK-COLLAPSE-1 / BLOCK-COLLAPSE-2 / BLOCK-COLLAPSE-3 折叠入口对所有有子块的块开放：① 非标题块（项目符号）hover 出箭头、无子块的块不出；② 收起后子块隐藏、箭头常显且点得回；③ 块菜单「折叠 / 展开」项同样放宽',
  bulletArrow.present && (bulletArrow.label === '收起子树')
  && looseArrow.present === false
  && collapsedChild === 'none' && arrowAfterLeave.present && arrowAfterLeave.label === '展开子树'
  && expandedChild !== 'none' && expandedChild !== null
  && hasCollapseItem(menuOnBullet) && !hasCollapseItem(menuOnLoose),
  { bulletArrow, looseArrow, collapsedChild, arrowAfterLeave, expandedChild, menuOnBullet, menuOnLoose })

// ---------- D 批（第 7 项）：触达尺寸测量（`R04-TOOL-6`；`PANEL-HIT-1`）----------
// 口径：桌面点击目标 ≥32×32。量的办法是从按钮**视觉盒中心**向四个方向逐像素 `elementFromPoint`，
// 走到「不再是这个按钮」为止——量到的是 ::after 外扩后的**真实可达区域**，不是 CSS 里写了多少。
// 块标记族顺带验 `R09-BLOCK-5/7`：视觉盒 22×32 不动、点击区 32×42。
const hitExtent = (selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  const cx = Math.round(r.left + r.width / 2)
  const cy = Math.round(r.top + r.height / 2)
  const own = (x, y) => { const t = document.elementFromPoint(x, y); return Boolean(t && (t === el || el.contains(t))) }
  const walk = (dx, dy) => { let n = 0; while (n < 80 && own(cx + dx * (n + 1), cy + dy * (n + 1))) n += 1; return n }
  const left = walk(-1, 0); const right = walk(1, 0); const up = walk(0, -1); const down = walk(0, 1)
  return { visual: [Math.round(r.width), Math.round(r.height)], hit: [left + right + 1, up + down + 1] }
}, selector)
await hoverBlock('w2-b')
const hitCollapse = await hitExtent('.block-rail[data-marker-for="w2-b"] .b-collapse')
const hitHandle = await hitExtent('.block-rail[data-marker-for="w2-b"] .b-handle')
const hitPlus = await hitExtent('.block-rail[data-marker-for="w2-b"] .b-plus')
const hitTopBtn = await hitExtent('.topbar .tb-btn')
// 卡片 ⋯ 借一次页面库往返；属性行 ⋯ 在属性摘要条展开后的自定义属性行上（这一页带一条「状态」）
await page.evaluate(() => { const el = [...document.querySelectorAll('.sb-nav')].find((x) => (x.textContent ?? '').includes('页面库')); if (el) el.click() })
await sleep(1000)
const hitCardMore = await hitExtent('.pmore')
await page.locator('.bd-open').first().click()
await sleep(1000)
await page.evaluate(() => document.querySelector('.prop-brief')?.click())
await sleep(800)
const hitRowMore = await hitExtent('.pe-more')
const min32 = (m) => Boolean(m) && m.hit[0] >= 32 && m.hit[1] >= 32
check('PANEL-HIT-1 触达尺寸：桌面点击目标 ≥32×32（块标记族 32×42 / 顶栏按钮 / 卡片 ⋯ / 属性行 ⋯；视觉盒不动、::after 外扩）',
  min32(hitCollapse) && min32(hitHandle) && min32(hitPlus) && min32(hitTopBtn) && min32(hitCardMore) && min32(hitRowMore),
  { hitCollapse, hitHandle, hitPlus, hitTopBtn, hitCardMore, hitRowMore })

// ---------- W6 · 软换行口径（`R04-ENTER-5`；`ENTER-NOLINEBREAK-1/2/3`）----------
// 软换行从根上取消（用户裁决 ）：**块内换行只允许出现在代码块**。四条：
// ① Shift+Enter 与 Enter 同义（拆块，不留换行符）；② Ctrl+O 同义（macOS 上那是 Lexical 的
// 「插入换行」默认键，输入侧先手拦）；③ 多行无记号纯文本粘贴按行建块、⌘Z 一次退整批；
// ④ 边界：多行**贴进代码块**不拆块——字面 `\n` 进正文（落库），`\r\n` 归一成 `\n`。
await reset()
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text, parent, position, children = [], extra = {}) => ({
    entityId: id, blockUid: uid, type, content: text ? [{ t: 'text', v: text }] : [], parent, children, position,
    collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null,
    isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [],
    aiMeta: null, created: now, modified: now, ...extra,
  })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    mk('w6p', 'w6page01', 'text', 'W6 页', null, 0, ['w6txt', 'w6cod'], { isObject: true, objectName: 'W6 页' }),
    mk('w6txt', 'w6txt0001', 'text', '普通段落', 'w6p', 0),
    mk('w6cod', 'w6cod0001', 'code', 'const a = 1', 'w6p', 1),
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block[data-entity-id="w6txt"]', { timeout: NAV_READY_MS })
await sleep(1000)
const kidsOf = (blocks, parent) => blocks.filter((b) => b.parent === parent).map((b) => `${b.type}:${b.text}`)
// ① Shift+Enter 拆块（普通块；不留换行符）
await clickBlock('普通段落')
await page.keyboard.press('End')
await sleep(200)
await page.keyboard.press('Shift+Enter')
const shiftSplit = await poll(() => live(), (blocks) => kidsOf(blocks, 'w6p').length === 3, { label: 'Shift+Enter 拆出新块' })
// ② Ctrl+O 同义
await page.keyboard.press('End')
await sleep(200)
await page.keyboard.press('Control+o')
const ctrlOSplit = await poll(() => live(), (blocks) => kidsOf(blocks, 'w6p').length === 4, { label: 'Ctrl+O 拆出新块' })
// ③ 多行无记号粘贴 → 按行建块；⌘Z 一次退整批
const countBefore3 = (await live()).length
await page.evaluate(async () => { await navigator.clipboard.writeText('甲行\n乙行\n丙行') })
await page.keyboard.press('Control+v')
const pasted = await poll(() => live(), (blocks) => blocks.some((b) => b.text === '乙行'), { label: '多行粘贴落成块' })
await page.keyboard.press('Control+z')
const undoneAll = await poll(() => live(), (blocks) => blocks.length === countBefore3, { label: '⌘Z 一次退整批' })
// ④ 多行贴进代码块：不拆块、字面 `\n` 落库（`\r\n` 归一）
await clickBlock('const a = 1')
await page.keyboard.press('End')
await sleep(200)
await page.evaluate(async () => { await navigator.clipboard.writeText('line1\r\nline2') })
await page.keyboard.press('Control+v')
const codePaste = await poll(() => live(), (blocks) => (blocks.find((b) => b.id === 'w6cod')?.text ?? '').includes('line2'), { label: '代码块字面换行落库' })
check('ENTER-NOLINEBREAK-1 / ENTER-NOLINEBREAK-2 / ENTER-NOLINEBREAK-3 软换行从根上取消：Shift+Enter 与 Ctrl+O 与 Enter 同义（拆块、不留换行符）· 多行无标记纯文本粘贴按行建块（⌘Z 一次退整批）· 多行贴进代码块不拆块（字面 `\\n` 落库、`\\r\\n` 归一）',
  kidsOf(shiftSplit, 'w6p').length === 3 && !shiftSplit.some((b) => b.text.includes('\n'))
  && kidsOf(ctrlOSplit, 'w6p').length === 4 && !ctrlOSplit.some((b) => b.text.includes('\n'))
  && pasted.some((b) => b.text === '甲行') && pasted.some((b) => b.text === '乙行') && pasted.some((b) => b.text === '丙行')
  && undoneAll.length === countBefore3
  && codePaste.find((b) => b.id === 'w6cod')?.text === 'const a = 1line1\nline2'
  && !codePaste.some((b) => b.text.includes('\r'))
  && kidsOf(codePaste, 'w6p').length === 4,
  { shift3: kidsOf(shiftSplit, 'w6p'), ctrl4: kidsOf(ctrlOSplit, 'w6p'), pasted3: pasted.filter((b) => ['甲行', '乙行', '丙行'].includes(b.text)).map((b) => b.text), afterUndo: undoneAll.length, codeText: codePaste.find((b) => b.id === 'w6cod')?.text })

// ---------- W6 · 代码块内 Enter = 换行（`R04-ENTER-6`；`ENTER-CODEBLOCK-1/2/3`；机制 A）----------
// 裁决：块内换行只允许出现在代码块——Enter = 换行（编辑器里插 `LineBreakNode` 渲染 `<br>`，
// 适配器序列化成 `\n` 落库）；**空行再按 = 退出代码块**（空块转 text；非空块收掉尾随换行后
// 新建 text 块）。这条同时钉住机制 A 的核心：换行后**光标真的前进**——打字的字落在下一行，
// 而不是落在换行之前（那正是「`\n` 直接写文本节点」那条路做不到的事）。
await reset()
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text, parent, position, children = [], extra = {}) => ({
    entityId: id, blockUid: uid, type, content: text ? [{ t: 'text', v: text }] : [], parent, children, position,
    collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null,
    isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [],
    aiMeta: null, created: now, modified: now, ...extra,
  })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    mk('a6p', 'a6page01', 'text', '代码页', null, 0, ['a6txt', 'a6cod', 'a6emp'], { isObject: true, objectName: '代码页' }),
    mk('a6txt', 'a6txt001', 'text', '普通段落', 'a6p', 0),
    mk('a6cod', 'a6cod001', 'code', 'const a = 1', 'a6p', 1),
    mk('a6emp', 'a6emp001', 'code', '', 'a6p', 2),
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block[data-entity-id="a6cod"]', { timeout: NAV_READY_MS })
await sleep(1000)
const codeTextOf = async () => (await live()).find((b) => b.id === 'a6cod')?.text ?? ''
// ① Enter = 换行；打字的字落在下一行（光标前进）
await clickBlock('const a = 1')
await page.keyboard.press('End')
await sleep(200)
await page.keyboard.press('Enter')
const lineBreak = await poll(() => codeTextOf(), (text) => text === 'const a = 1\n', { label: '回车插入换行' })
await page.keyboard.type('X')
const typedNextLine = await poll(() => codeTextOf(), (text) => text === 'const a = 1\nX', { label: '打字落在下一行' })
// ② 尾空行再按 = 退出：收掉尾随换行、其后新建 text 块、光标进新块
await page.keyboard.press('Enter')
await poll(() => codeTextOf(), (text) => text === 'const a = 1\nX\n', { label: '第二行再插换行' })
await page.keyboard.press('Enter')
const exitStripped = await poll(() => codeTextOf(), (text) => text === 'const a = 1\nX', { label: '退出：收掉尾随换行' })
await page.keyboard.type('B')
const caretInNew = await poll(() => live(), (blocks) => blocks.some((b) => b.text === 'B' && b.parent === 'a6p'), { label: '光标进新块' })
const kidsAfterExit = kidsOf(caretInNew, 'a6p')
// ③ 重载后 `\n` 与 `<br>` 都在（适配器往返）
await reload()
await page.waitForSelector('.editor-content .moqi-block[data-entity-id="a6cod"]', { timeout: NAV_READY_MS })
await sleep(900)
const reloadedCode = await codeTextOf()
const reloadedBreaks = await page.evaluate(() => document.querySelector('.editor-content .moqi-block[data-entity-id="a6cod"]')?.querySelectorAll('br').length ?? 0)
// ④ 空代码块 Enter → 转 text
await page.locator('.editor-content .moqi-block[data-entity-id="a6emp"]').click()
await sleep(300)
await page.keyboard.press('Enter')
const emptyConverted = await poll(() => live(), (blocks) => blocks.find((b) => b.id === 'a6emp')?.type === 'text', { label: '空代码块转 text' })
// ⑤ 普通块不受影响：Enter 仍拆块、不留换行符
const beforeTxt = kidsOf(await live(), 'a6p').length
await clickBlock('普通段落')
await page.keyboard.press('End')
await sleep(200)
await page.keyboard.press('Enter')
const textSplit = await poll(() => live(), (blocks) => kidsOf(blocks, 'a6p').length === beforeTxt + 1, { label: '普通块 Enter 拆块' })
check('ENTER-CODEBLOCK-1 / ENTER-CODEBLOCK-2 / ENTER-CODEBLOCK-3 代码块内 Enter = 换行（`\\n` 落库、重载后 `<br>` 仍在、光标前进）· 空行再按 = 退出（空块转 text / 非空块收尾后新建 text 块）· 普通块与行内代码不受影响（Enter 仍拆块）',
  lineBreak === 'const a = 1\n' && typedNextLine === 'const a = 1\nX'
  && exitStripped === 'const a = 1\nX' && kidsAfterExit.includes('text:B')
  && reloadedCode === 'const a = 1\nX' && reloadedBreaks >= 1
  && emptyConverted.find((b) => b.id === 'a6emp')?.type === 'text'
  && kidsOf(textSplit, 'a6p').length === beforeTxt + 1
  // 普通块拆出来的块不许带换行符（**代码块除外**——它的 `\n` 正是本批的合法形态）。
  && !textSplit.some((b) => b.type !== 'code' && b.text.includes('\n')),
  { lineBreak, typedNextLine, exitStripped, kidsAfterExit, reloadedCode, reloadedBreaks, emptyType: emptyConverted.find((b) => b.id === 'a6emp')?.type, textKids: kidsOf(textSplit, 'a6p') })

// ---------- 正确用法：缩进块上两次 Enter 退出缩进（04 §3） ----------
// 场景按文档与用户口径重建（干净的 页首 + 三个同级子块），层级一律从**领域图**读：
// DOM 文本匹配会把祖先块一起算进来，测到的不是同一个块。
const depthById = async (id) => {
  const blocks = await live()
  const byId = new Map(blocks.map((b) => [b.id, b]))
  let depth = 0
  let cursor = byId.get(id)
  while (cursor?.parent) { depth += 1; cursor = byId.get(cursor.parent) }
  return depth
}
const idByText = async (text) => (await live()).find((b) => b.text === text)?.id ?? null
await reset()
await page.keyboard.press('Enter')
await sleep(1400)
await page.keyboard.type('乙')
await sleep(1400)
await page.keyboard.press('Enter')
await sleep(1400)
await page.keyboard.type('丙')
await sleep(1400)
await page.keyboard.press('Enter')
await sleep(1400)
await page.keyboard.type('丁')
await sleep(1500)
const bingId = await idByText('丙')
const depthBefore = await depthById(bingId)
await clickBlock('丙')
await page.keyboard.press('Tab')
await sleep(1400)
const depthIndented = await depthById(bingId)
await clickBlock('丙')
await page.keyboard.press('End')
await sleep(250)
await page.keyboard.press('Enter')          // 生成同缩进的空块
await sleep(1400)
const emptyBlock = (await live()).filter((b) => b.text === '')
const emptyDepths = await Promise.all(emptyBlock.map((b) => depthById(b.id)))
await page.keyboard.press('Enter')          // 空块再 Enter → 退出缩进
await sleep(1400)
const outdentDepths = await Promise.all(emptyBlock.map((b) => depthById(b.id)))
const indented = Math.max(...emptyDepths, 0)
const outdented = Math.max(...outdentDepths, 0)
check('BLOCK-ENTER-6 缩进块上两次 Enter：空块退出缩进（层级回落一级）',
  depthIndented === depthBefore + 1 && indented === depthIndented && outdented === depthIndented - 1,
  { depthBefore, depthIndented, emptyDepths, outdentDepths, toast: await toast() })

// ---------- 正确用法：页面名 = 正文首行（04 §3；标题控件已删除） ----------
await reset()
const noTitleWidget = await page.evaluate(() => document.querySelectorAll(".doc-title-input").length)
await clickBlock("第一段")
await page.keyboard.press("End")
await sleep(200)
await page.keyboard.type("改名试")
const renamed = await poll(
  () => page.evaluate(() => ({
    card: (document.querySelector(".lcard.cur h3, .scard.cur h3")?.textContent ?? "").trim(),
    stored: (JSON.parse(localStorage.getItem("moqi-project-b:blocks") ?? "[]").find((b) => b.isObject && !b.deleted) ?? {}).objectName ?? null,
  })),
  (s) => Boolean(s.stored) && s.stored.includes("改名试") && s.card === s.stored,
  { label: "卡片与存档同步到「改名试」" },
)
check("PAGENAME-RENAME-7 页面名 = 正文首行：无标题控件，卡片与存档同步",
  noTitleWidget === 0 && Boolean(renamed.stored) && renamed.card === renamed.stored && renamed.stored.includes("改名试"),
  { noTitleWidget, renamed })

// ---------- 旧标题控件的每个毛病，在新形态（页面名 = 正文首行）下逐条重测 ----------
// 用户口径：「有没有测过我们前面标题控件出现的那些问题，同步在我们这个里面测试呢？」
// 旧毛病：点不进去 / 改不了字 / 光标只能停在开头 / 选不中文字 / Esc 反而改名 / 提交后光标消失。
await reset()
await clickBlock("第一段")
await page.keyboard.press("End")
await sleep(200)
const caretLanded = await offsetInBlock()
check("PAGENAME-OPEN-1 点首行光标能落进去（不再是「点不进去的标题」）", caretLanded.inBody === true, caretLanded)

const beforeType = (await live()).find((b) => b.parent === null)?.text ?? ""
await page.keyboard.type("补字")
const afterType = await poll(
  async () => (await live()).find((b) => b.parent === null)?.text ?? "",
  (text) => text.includes("补字") && text !== beforeType,
  { label: "首行出现「补字」" },
)
check("PAGENAME-RENAME-8 首行打字能改（名字随之同步）", afterType.includes("补字") && afterType !== beforeType, { beforeType, afterType })

await page.keyboard.press("Home")
await sleep(200)
const atHome = await offsetInBlock()
await page.keyboard.press("ArrowRight")
await page.keyboard.press("ArrowRight")
await sleep(200)
const moved = await offsetInBlock()
check("PAGENAME-OPEN-2 光标能在首行里移动（不是被按死在开头）", atHome.offset === 0 && moved.offset === 2, { atHome, moved })

await page.keyboard.down("Shift")
await page.keyboard.press("ArrowRight")
await page.keyboard.press("ArrowRight")
await page.keyboard.up("Shift")
await sleep(300)
const selected = await page.evaluate(() => { const s = window.getSelection(); return s && !s.isCollapsed ? (s.focusOffset - s.anchorOffset) : 0 })
check("PAGENAME-OPEN-3 首行文字能选中（不再「选不中」）", selected >= 2, { selected })

const nameBeforeEsc = await page.evaluate(() => (JSON.parse(localStorage.getItem("moqi-project-b:blocks") ?? "[]").find((b) => b.isObject && !b.deleted) ?? {}).objectName ?? null)
await page.keyboard.press("Escape")
await sleep(600)
const afterEsc = await page.evaluate(() => ({
  name: (JSON.parse(localStorage.getItem("moqi-project-b:blocks") ?? "[]").find((b) => b.isObject && !b.deleted) ?? {}).objectName ?? null,
  dialog: document.querySelectorAll(".dlg").length,
}))
check("PAGENAME-RENAME-5 首行按 Esc 不改名、不弹窗（旧控件是「Esc 反而改名」）", afterEsc.dialog === 0 && afterEsc.name === nameBeforeEsc, { nameBeforeEsc, ...afterEsc })

// ---------- 首行 = 页面名 的行为矩阵（用户逐条点名要测） ----------
// 名字是派生值，所以「光标在开头/中间/末尾时按 Delete/Backspace/Enter」都必须让名字跟着首行走。
const pageNameOf = () => page.evaluate(() => (JSON.parse(localStorage.getItem("moqi-project-b:blocks") ?? "[]").find((b) => b.isObject && !b.deleted) ?? {}).objectName ?? null)

// ① 末尾 Backspace：名字少一个字符
await reset()
await clickBlock("第一段")
await page.keyboard.press("End")
await sleep(200)
const nameBeforeBackspace = await poll(pageNameOf, (name) => name !== null, { timeout: 4000, label: "种子页名已落盘" })
await page.keyboard.press("Backspace")
const expectedAfterBackspace = nameBeforeBackspace === null ? null : nameBeforeBackspace.slice(0, -1)
const nameAfterBackspace = await poll(
  pageNameOf,
  (name) => name !== null && name === expectedAfterBackspace,
  { label: `名字变成「${expectedAfterBackspace}」` },
)
check("PAGENAME-RENAME-1 首行末尾 Backspace：名字跟着少一个字符", Boolean(nameBeforeBackspace) && nameAfterBackspace === nameBeforeBackspace.slice(0, -1), { nameBeforeBackspace, nameAfterBackspace })

// ② 中间 Enter：容器保留前半（= 名字），后半成为新块
await reset()
await clickBlock("第一段")
await caretTo(1)
await page.keyboard.press("Enter")
const splitState = await poll(
  () => page.evaluate(() => {
    const blocks = JSON.parse(localStorage.getItem("moqi-project-b:blocks") ?? "[]")
    const page = blocks.find((b) => b.isObject && !b.deleted)
    const kids = blocks.filter((b) => b.parent === page?.entityId && !b.deleted)
    return { name: page?.objectName ?? null, texts: kids.map((b) => (b.content ?? []).map((f) => f.v).join("")) }
  }),
  (s) => s.name === "第" && s.texts.includes("一段"),
  { label: "中间 Enter 落盘（名字「第」+ 子块「一段」）" },
)
check("PAGENAME-RENAME-2 首行中间 Enter：名字 = 前半，后半成为子块", splitState.name === "第" && splitState.texts.includes("一段"), splitState)

// ③ 开头 Enter：首行被拆空 → 占位「未命名页面」，原文字进子块
await reset()
await clickBlock("第一段")
await caretTo(0)
await page.keyboard.press("Enter")
const headState = await poll(
  () => page.evaluate(() => {
    const blocks = JSON.parse(localStorage.getItem("moqi-project-b:blocks") ?? "[]")
    const page = blocks.find((b) => b.isObject && !b.deleted)
    return { name: page?.objectName ?? null, kids: blocks.filter((b) => b.parent === page?.entityId && !b.deleted).map((b) => (b.content ?? []).map((f) => f.v).join("")) }
  }),
  (s) => s.name === "未命名页面" && s.kids.includes("第一段"),
  { label: "开头 Enter 落盘（名字回落 + 原文进子块）" },
)
check("PAGENAME-RENAME-3 首行开头 Enter：名字回落「未命名页面」，原文进子块", headState.name === "未命名页面" && headState.kids.includes("第一段"), headState)

// ④ 开头 Delete：名字少第一个字符
await reset()
await clickBlock("第一段")
await caretTo(0)
await page.keyboard.press("Delete")
const delState = await poll(
  () => page.evaluate(() => ({
    name: (JSON.parse(localStorage.getItem("moqi-project-b:blocks") ?? "[]").find((b) => b.isObject && !b.deleted) ?? {}).objectName ?? null,
    firstLine: (document.querySelector(".editor-content .moqi-block")?.textContent ?? "").trim(),
  })),
  (s) => s.name === "一段",
  { label: "开头 Delete 落盘（名字「一段」）" },
)
check("PAGENAME-RENAME-4 首行开头 Delete：名字跟着少第一个字符", delState.name === "一段", delState)

// ⑤ 末尾 Enter：名字不变，首行下方新建一个空块、光标进新块（04 §3.1 行为矩阵第 2 行）
await reset()
await clickBlock("第一段")
await page.keyboard.press("End")
await sleep(200)
const nameBeforeTailEnter = await poll(pageNameOf, (name) => name !== null, { timeout: 4000, label: "种子页名已落盘" })
await page.keyboard.press("Enter")
const tailState = await poll(
  () => page.evaluate(() => {
    const blocks = JSON.parse(localStorage.getItem("moqi-project-b:blocks") ?? "[]")
    const page = blocks.find((b) => b.isObject && !b.deleted)
    const sel = window.getSelection(); let node = sel?.anchorNode
    if (node && node.nodeType === 3) node = node.parentElement
    return {
      name: page?.objectName ?? null,
      kids: blocks.filter((b) => b.parent === page?.entityId && !b.deleted).map((b) => (b.content ?? []).map((f) => f.v).join("")),
      caretText: node?.closest?.(".moqi-block")?.textContent ?? null,
    }
  }),
  (s) => s.kids.includes("") && s.caretText === "",
  { label: "末尾 Enter 落盘（新建空块 + 光标进新块）" },
)
check("PAGENAME-RENAME-9 首行末尾 Enter：名字不变，下方新建空块、光标进新块",
  tailState.name === nameBeforeTailEnter && tailState.kids.includes("") && tailState.caretText === "",
  { nameBeforeTailEnter, tailState })

// ---------- 正确用法：新建页面直接写第一行 = 页面名（04 §3.1；用户实测场景） ----------
await reset()
await page.evaluate(() => { const b = document.querySelector("button.col-new"); if (b) b.click() })
const newPageState = await poll(
  () => page.evaluate(() => {
    const sel = window.getSelection(); let node = sel?.anchorNode
    if (node && node.nodeType === 3) node = node.parentElement
    // 台账 `D-072` 的**落点形态**：空名字行的光标必须在名字行锚点**之后**（DOM (容器,1)、行盒持有者 br 之前）——
    // 锚点之前的 (容器,0) 在 Android WebView 画不出光标（真机试验场实证）；负例：把落点改回锚点之前 ⇒ 这里必红。
    const container = document.querySelector('.editor-content .moqi-block[data-block-object="true"]')
    return {
      blocks: document.querySelectorAll(".editor-content .moqi-block").length,
      caretInContainer: node?.closest?.(".moqi-block")?.dataset.blockObject === "true",
      anchorIsContainer: Boolean(container) && sel?.anchorNode === container,
      anchorOffset: sel?.anchorOffset ?? null,
      holderRight: container ? container.childNodes[1]?.nodeName === 'BR' : null,
    }
  }),
  (s) => s.blocks === 1 && s.caretInContainer === true,
  { label: "新建页面就绪（一个块 + 光标在名字行）" },
)
await page.keyboard.type("新页名")
const namedState = await poll(
  () => page.evaluate(() => ({
    nameLine: (document.querySelector(".editor-content .moqi-block[data-block-object=\"true\"]")?.textContent ?? "").trim(),
    card: (document.querySelector(".lcard.cur h3, .scard.cur h3")?.textContent ?? "").trim(),
  })),
  (s) => s.nameLine === "新页名" && s.card === "新页名",
  { label: "新页名同步到名字行与卡片" },
)
check("PAGENAME-NEW-1 新建页面：光标就在页面名那一行，直接打字即成页名（`D-072` 落点形态：锚点之后、行盒持有者之前）",
  newPageState.blocks === 1 && newPageState.caretInContainer && namedState.nameLine === "新页名" && namedState.card === "新页名"
  && newPageState.anchorIsContainer === true && newPageState.anchorOffset === 1 && newPageState.holderRight === true,
  { newPageState, namedState })

// ---------- 名字行必须是一个「能落光标」的位置（04 §3.1 R04-NAME-11） ----------
// 用户实测（）：名字行为空时（空页面 / 名字被删光 / 首行文字被拆走），容器自己那一行
// 没有落脚点，Lexical 的归一化把光标下压进第一个子块 —— 点占位没反应、打字写进下面的块、
// 删光名字光标掉到下一个块开头。修法是名字行锚点（见 src/editor/blockNode.ts）。
const clickNameRow = async () => {
  const box = await page.evaluate(() => {
    const el = document.querySelector(".editor-content .moqi-block[data-block-object=\"true\"]")
    el.scrollIntoView({ block: "center" })
    const rect = el.getBoundingClientRect()
    return { x: Math.round(rect.left + 45), y: Math.round(rect.top + 16) }
  })
  await page.mouse.click(box.x, box.y)
  await sleep(320)
}
const nameRowState = () => page.evaluate(() => {
  const selection = window.getSelection()
  let node = selection?.anchorNode ?? null
  if (node && node.nodeType === 3) node = node.parentElement
  const container = document.querySelector(".editor-content .moqi-block[data-block-object=\"true\"]")
  const table = JSON.parse(localStorage.getItem("moqi-project-b:blocks") ?? "[]")
  const page = table.find((b) => b.isObject && !b.deleted)
  return {
    caretOnNameRow: node?.closest?.(".moqi-block")?.dataset.blockObject === "true",
    name: page?.objectName ?? null,
    kids: table.filter((b) => b.parent === page?.entityId && !b.deleted).map((b) => (b.content ?? []).map((f) => f.v).join("")),
    rowHeight: container ? Math.round(container.getBoundingClientRect().height) : 0,
    anchorHeight: (() => { const a = document.querySelector(".moqi-name-line-anchor"); return a ? Math.round(a.getBoundingClientRect().height) : 0 })(),
    lineHeight: container ? Math.round(parseFloat(getComputedStyle(container).lineHeight)) : 0,
    containerFontSize: container ? getComputedStyle(container).fontSize : null,
    placeholder: container ? getComputedStyle(container, "::before").content : null,
  }
})
/** 造一页：名字 + 一个子块，然后把名字删光（名字行为空、下面还有内容）。 */
const pageWithEmptyNameRow = async () => {
  await reset()
  await clickBlock("第一段")
  await page.keyboard.press("End")
  await sleep(150)
  await page.keyboard.press("Enter")
  await sleep(700)
  await page.keyboard.type("子块")
  await sleep(900)
  await clickNameRow()
  await page.keyboard.press("End")
  await sleep(150)
  for (let i = 0; i < 3; i += 1) { await page.keyboard.press("Backspace"); await sleep(140) }
  await sleep(900)
}

await pageWithEmptyNameRow()
const afterErase = await nameRowState()
await page.keyboard.type("补名")
const retyped = await poll(
  nameRowState,
  (s) => s.name === "补名" && s.kids.join("|") === "子块",
  { label: "补名落盘（名字行接着打字仍是页名）" },
)
check("PAGENAME-RENAME-10 删光页名：光标留在名字行（不掉进下一个块），接着打字仍是页面名",
  afterErase.caretOnNameRow && afterErase.name === "未命名页面" && String(afterErase.placeholder).includes("未命名页面")
  && retyped.name === "补名" && retyped.kids.join("|") === "子块",
  { afterErase, retyped })

await pageWithEmptyNameRow()
await clickBlock("子块")
await clickNameRow()
const clickedNameRow = await nameRowState()
await page.keyboard.type("点进来")
const afterClickType = await poll(
  nameRowState,
  (s) => s.name === "点进来" && s.kids.includes("子块"),
  { label: "点占位后打字落盘（名字「点进来」）" },
)
check("PAGENAME-NEW-4 点「未命名页面」占位：光标落到名字行，打字成页面名（不再写进下面的块）",
  clickedNameRow.caretOnNameRow && String(clickedNameRow.placeholder).includes("未命名页面") && clickedNameRow.rowHeight >= 24
  && afterClickType.name === "点进来" && afterClickType.kids.includes("子块"),
  { clickedNameRow, afterClickType })

// 新建页面：光标在名字行且空名字行只有一行（占位是行内内容，不再单独占一个块盒）
await reset()
await page.evaluate(() => { const b = document.querySelector("button.col-new"); if (b) b.click() })
const freshRow = await poll(
  nameRowState,
  (s) => s.caretOnNameRow && s.anchorHeight >= 24,
  { label: "新页面名字行就绪（光标在名字行 + 锚点撑行）" },
)
check("PAGENAME-NEW-5 新建页面：光标在名字行，名字行一行高（D-095：行盒以文字主导、锚点随字号），占位不占块盒",
  freshRow.caretOnNameRow && String(freshRow.placeholder).includes("未命名页面")
  && freshRow.anchorHeight >= 24 && freshRow.lineHeight >= 24,
  freshRow)

// ---------- 名字行 ↔ 第一个子块那处接缝的键盘跨越（04 §3.1 R04-NAME-12） ----------
// 名字行锚点（零宽）既是落点也是第一个子块的「上一个节点」，四条键 + Home/End 必须显式补回来。
const caretWhere = () => page.evaluate(() => {
  const selection = window.getSelection()
  let node = selection?.anchorNode ?? null
  const kind = node?.nodeType === 3 ? "text" : node ? "elem" : "none"
  if (node && node.nodeType === 3) node = node.parentElement
  const block = node?.closest?.(".moqi-block")
  return { onNameRow: block?.dataset.blockObject === "true", kind, offset: selection?.anchorOffset ?? -1, text: (block?.textContent ?? "").slice(0, 10) }
})
/** 造「名字 第一段 + 一个子块 子块」。 */
const pageWithChild = async () => {
  await reset()
  await clickBlock("第一段")
  await page.keyboard.press("End")
  await sleep(150)
  await page.keyboard.press("Enter")
  await sleep(700)
  await page.keyboard.type("子块")
  await sleep(1000)
}

// ① 名字行末尾 End：光标落到名字文字末尾（锚点会把它算到锚点之后），Backspace 一次删一个字
await pageWithChild()
await clickNameRow()
await page.keyboard.press("End")
await sleep(250)
const endCaret = await caretWhere()
const nameBeforeDel = (await nameRowState()).name
await page.keyboard.press("Backspace")
const expectedAfterDel = nameBeforeDel === null ? null : String(nameBeforeDel).slice(0, -1)
const nameAfterDel = await poll(
  async () => (await nameRowState()).name,
  (name) => name !== null && name === expectedAfterDel,
  { timeout: 6000, label: `名字行末尾 Backspace 落到「${expectedAfterDel}」` },
)
check("PAGENAME-RENAME-11 名字行末尾 End + Backspace：第一下就删掉最后一个字（不再被锚点后的空位置吃掉）",
  endCaret.onNameRow && nameAfterDel === String(nameBeforeDel).slice(0, -1), { endCaret, nameBeforeDel, nameAfterDel })

// ② 第一块行首 Backspace / ←：光标上到名字行（文字不动）
await pageWithChild()
await clickBlock("子块")
const childStart = await caretTo(0)
await page.keyboard.press("Backspace")
await sleep(700)
const upBackspace = await caretWhere()
const stateAfterBackspace = await nameRowState()
await clickBlock("子块")
await caretTo(0)
await page.keyboard.press("ArrowLeft")
await sleep(700)
const upLeft = await caretWhere()
check("PAGENAME-CROSS-1 第一块行首 Backspace / ←：光标上到名字行（不动文字）",
  childStart === 0 && upBackspace.onNameRow && upLeft.onNameRow
  && stateAfterBackspace.name === "第一段" && stateAfterBackspace.kids.join("|") === "子块",
  { childStart, upBackspace, upLeft, stateAfterBackspace })

// ③ 名字行末尾 Delete / →：光标下到第一块行首（不把文字并进名字）
await pageWithChild()
await clickNameRow()
await page.keyboard.press("End")
await sleep(250)
await page.keyboard.press("ArrowRight")
await sleep(600)
const downRight = await caretWhere()
await clickNameRow()
await page.keyboard.press("End")
await sleep(250)
await page.keyboard.press("Delete")
await sleep(700)
const downDelete = await caretWhere()
const stateAfterDelete = await nameRowState()
check("PAGENAME-CROSS-2 名字行末尾 Delete / →：光标下到第一块行首（文字不并进来）",
  downRight.onNameRow === false && downRight.offset === 0 && downDelete.onNameRow === false && downDelete.offset === 0
  && stateAfterDelete.name === "第一段" && stateAfterDelete.kids.join("|") === "子块",
  { downRight, downDelete, stateAfterDelete })

// ④ 第一块为空时 Backspace：按「空块合并」并掉它，光标留在名字行
await pageWithChild()
await clickBlock("子块")
await page.keyboard.press("Home")
await sleep(200)
await page.keyboard.down("Shift")
await page.keyboard.press("End")
await page.keyboard.up("Shift")
await sleep(200)
await page.keyboard.press("Backspace") // 只清空这一块（Ctrl+A 是全文档选中，不能用来清块）
await sleep(1400)
const emptiedRow = await nameRowState()
await page.keyboard.press("Backspace") // 空块上的 Backspace = 合并掉它
await sleep(1500)
const afterMerge = await nameRowState()
check("PAGENAME-CROSS-3 第一块为空时 Backspace：按「空块合并」并掉它，光标留在名字行",
  emptiedRow.kids.length === 1 && emptiedRow.kids[0] === "" && afterMerge.kids.length === 0
  && afterMerge.caretOnNameRow && afterMerge.name === "第一段",
  { emptiedRow, afterMerge })

// ⑤ 名字行排版（对齐原型 .doc-title）：只作用于名字行，不泄漏给子块
await pageWithChild()
const titleType = await page.evaluate(() => {
  const container = document.querySelector(".editor-content .moqi-block[data-block-object=\"true\"]")
  const child = container?.querySelector(".moqi-block")
  const pick = (el) => { const cs = getComputedStyle(el); return { size: cs.fontSize, weight: cs.fontWeight, line: cs.lineHeight } }
  return { container: pick(container), child: child ? pick(child) : null }
})
// 字阶批：页面标题 2× / 行高 1.2（标准档 17 × 2 = 34px / 40.8px）；子块仍是正文 17px（行高 1.7 = 28.9px）
const near = (value, target, tol = 0.15) => Math.abs(parseFloat(value ?? "NaN") - target) <= tol
check("PAGENAME-NEW-6 名字行排版 = 页面标题（2× / 700 / 行高 1.2，标准档 = 34px），且子块排版不被继承",
  near(titleType.container.size, 17 * 2) && titleType.container.weight === "700" && near(titleType.container.line, 17 * 2 * 1.2)
  && titleType.child?.size === "17px" && titleType.child?.weight === "400" && titleType.child?.line === "28.9px",
  titleType)

await reset()
await sleep(600)

// ---------- 主题两轴与排版三轴（13-视觉批设计（已归档） §2/§3；08 令牌）----------
// 设置里切主题 / 浅深 / 字号 / 列宽 → <html> 的 data-* 与样式当场变、重开记得。
await page.evaluate(() => {
  localStorage.setItem('moqi-project-b:ui-prefs', JSON.stringify({ slashHintSeen: true, themeId: 'default', mode: 'light', fontSize: 'normal', lineHeight: 'normal', columnWidth: 'normal' }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
const appearanceRead = () => page.evaluate(() => {
  const root = document.documentElement
  const cs = getComputedStyle(root)
  // 量正文块（.moqi-block-text 是正文类型的类，与嵌套层级无关）；容器标题那行不是它。
  // 量编辑区容器自身（font-size: var(--fs-e)）：它一定在，且直接反映字号档。
  const block = document.querySelector('.editor-content')
  return {
    theme: root.dataset.theme ?? null, mode: root.dataset.mode ?? null, fs: root.dataset.fs ?? null,
    bg: cs.getPropertyValue('--bg').trim(), accent: cs.getPropertyValue('--accent').trim(),
    bodyFont: block ? getComputedStyle(block).fontSize : null,
    // 列宽断言用**轴变量**（1280 视口下三栏并排够不到 800，量宽度会误判）。
    colw: cs.getPropertyValue('--colw').trim(),
  }
})
const appearanceDefault = await appearanceRead()
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('设置'))?.click() })
await sleep(700)
// 设置改左分栏（R09-SET-17）：控件在自己的分区页里——先切到「外观」。
await page.evaluate(() => { [...document.querySelectorAll('.set-nav button')].find((b) => (b.textContent ?? '').includes('外观'))?.click() })
await sleep(400)
await page.evaluate(() => {
  const select = document.querySelector('select[aria-label="主题"]')
  if (select) { select.value = 'warm-paper'; select.dispatchEvent(new Event('change', { bubbles: true })) }
})
await sleep(500)
await page.evaluate(() => {
  const press = (label, group) => {
    const seg = [...document.querySelectorAll('.seg')].find((el) => el.getAttribute('aria-label') === group)
    const button = seg ? [...seg.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label) : null
    button?.click()
  }
  press('深色', '浅深'); press('特大', '正文字号'); press('宽', '正文列宽')
})
await sleep(800)
const appearanceSwitched = await appearanceRead()
const appearancePrefs = await page.evaluate(() => JSON.parse(localStorage.getItem('moqi-project-b:ui-prefs') ?? '{}'))
// 设置页里量不到编辑区（没挂载）：先关弹窗回编辑器量字号 / 列宽，再重开验记忆。
await page.keyboard.press('Escape')
await sleep(600)
const appearanceInEditor = await appearanceRead()
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
const appearanceReopened = await appearanceRead()
check('THEME-1…4 / R09-SET-15 主题两轴与排版三轴：设置里切主题 / 浅深 / 字号 / 列宽 → data-theme / data-mode / data-fs 与样式当场生效；回编辑器字号与列宽跟着变；重开仍记得',
  appearanceDefault.theme === 'default' && appearanceDefault.mode === 'light'
    && appearanceSwitched.theme === 'warm-paper' && appearanceSwitched.mode === 'dark' && appearanceSwitched.fs === 'xlarge'
    && appearanceSwitched.bg === '#292826' && appearanceSwitched.accent === '#C0875A'
    && appearanceInEditor.bodyFont === '21px' && appearanceInEditor.colw === '800px'
    && appearancePrefs.themeId === 'warm-paper' && appearancePrefs.mode === 'dark' && appearancePrefs.fontSize === 'xlarge' && appearancePrefs.columnWidth === 'wide'
    && appearanceReopened.theme === 'warm-paper' && appearanceReopened.bodyFont === '21px',
  { appearanceDefault, appearanceSwitched, appearanceInEditor, appearancePrefs, appearanceReopened })

// ---------- L4 切换矩阵：关键元素的 computed 值必须跟着令牌走（钉死色扫描；`08` §7.1 的第三层） ----------
// 为什么在这一层：`check-theme-usage` 只读 CSS **文本**（写了哪条 var）；文本全对也可能被 inline style、
//   覆盖规则或写死的值盖掉——**只有渲染结果**能证明「这一格的主题确实落到了这个元素身上」。反过来，
//   值层/引用层也抓不到「颜色不随主题变」这类错，三层的分工就是 文本对 / 值对 / 渲染对。
// 怎么拨：直接改 `<html>` 的 data-theme / data-mode 逐格读（不重开、不碰 preferences——`THEME-1…4` 已管那条通路）。
//   每一格都比「元素 computed 值」与「同一条令牌现算的值」（探针 span 解析 `var(--x)`），共 20 套 × 浅深 = 40 格。
//  **拨之前先关掉过渡**：同步循环里没有帧，带 `transition: background` 的元素会一直停在旧主题的值上（
//   首跑就是这么假红的：`.lcard` 40 格全报同一个旧色）。关过渡只影响"读值的时机"，不改颜色语义。
// 防呆：① 选择器缺席点名（`missing`）——元素改名会让这一项变红而不是静默缩水；② `cells` 下限按对数 × 40 卡死，
//   防「只剩两对在跑也算绿」；③ 主题清单从 `uiPrefs` 的 `THEMES` 现读（加主题不用改这里）。
const sweepMatrix = (pairs) => page.evaluate(async (pairs) => {
  const { THEMES } = await import('/src/ui/uiPrefs.ts')
  const root = document.documentElement
  const frozen = document.createElement('style')
  frozen.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }'
  document.head.appendChild(frozen)
  const probe = document.createElement('span')
  probe.style.position = 'absolute'
  probe.style.left = '-9999px'
  document.body.appendChild(probe)
  const resolve = (token, prop) => { probe.style[prop] = `var(${token})`; return getComputedStyle(probe)[prop] }
  const saved = { theme: root.dataset.theme ?? '', mode: root.dataset.mode ?? '' }
  const mismatches = []
  const missing = []
  const distinct = {}
  let cells = 0
  for (const { id } of THEMES) for (const mode of ['light', 'dark']) {
    root.dataset.theme = id
    root.dataset.mode = mode
    void root.offsetHeight // 逼样式重算，别读到上一格的缓存
    for (const [selector, prop, token] of pairs) {
      const el = document.querySelector(selector)
      if (!el) { if (!missing.includes(selector)) missing.push(selector); continue }
      const actual = getComputedStyle(el)[prop]
      const expected = resolve(token, prop)
      cells += 1
      if (actual !== expected) mismatches.push(`${id}/${mode} ${selector} ${prop}=${actual} ≠ var(${token})=${expected}`)
      const key = `${selector} ${prop}`
      distinct[key] = distinct[key] ?? []
      if (!distinct[key].includes(actual)) distinct[key].push(actual)
    }
  }
  root.dataset.theme = saved.theme
  root.dataset.mode = saved.mode
  probe.remove()
  frozen.remove()
  return { themes: THEMES.length, cells, mismatches: mismatches.slice(0, 8), mismatchCount: mismatches.length, missing, distinct: Object.fromEntries(Object.entries(distinct).map(([k, v]) => [k, v.length])) }
}, pairs)

// 编辑器一轮：底 / 正文 / 侧栏带 / 两条栏面（都是常驻元素，不依赖操作状态）。
// `.sb-nav:not(.is-active)`：侧栏导航里**没被选中**的那一条（选中那条的色是 `--ink-t`，归下面页面库一轮测）。
const editorSweep = await sweepMatrix([
  ['body', 'backgroundColor', '--bg'],
  ['body', 'color', '--text'],
  ['.sidebar', 'backgroundColor', '--side-bg'],
  ['.topbar', 'backgroundColor', '--panel'],
  ['.sb-foot .sb-tag', 'color', '--text-2'],
])
// 页面库一轮：补**选中态填充**那一对（accent 家族最贵的一对：D-033 那一类错就死在它上面）。
await page.evaluate(() => { [...document.querySelectorAll('.sb-nav')].find((b) => (b.textContent ?? '').includes('页面库'))?.click() })
await sleep(800)
const librarySweep = await sweepMatrix([
  ['body', 'backgroundColor', '--bg'],
  ['.sidebar', 'backgroundColor', '--side-bg'],
  ['.sb-nav.is-active', 'backgroundColor', '--accent-soft'],
  ['.sb-nav.is-active', 'color', '--accent-text'],
  ['.lcard', 'backgroundColor', '--panel'],
])
check('THEME-5 / L4 切换矩阵：20 套 × 浅深逐格拨 data-theme / data-mode，关键元素 computed 值必须等于同一条令牌的现算值（无钉死色；编辑器 5 对 + 页面库 5 对，选择器缺席也算红）',
  editorSweep.mismatchCount === 0 && librarySweep.mismatchCount === 0
    && editorSweep.missing.length === 0 && librarySweep.missing.length === 0
    && editorSweep.cells >= 5 * 40 && librarySweep.cells >= 5 * 40,
  { editorSweep, librarySweep })

// ---------- 页面名链路（用户点名：新建 / 生成 / 删除 / 还原 / 复制 整条链都要走） ----------
// ① 空名字行必须「看得见」：容器自己那行有高度，空时显示占位「未命名页面」
await reset()
await page.evaluate(() => { const b = document.querySelector("button.col-new"); if (b) b.click() })
const nameLine = await poll(
  () => page.evaluate(() => {
    const container = document.querySelector(".editor-content .moqi-block[data-block-object=\"true\"]")
    if (!container) return null
    const rect = container.getBoundingClientRect()
    const placeholder = getComputedStyle(container, "::before").content
    return { height: Math.round(rect.height), placeholder, ownLine: container.dataset.ownLine ?? null }
  }),
  (s) => s !== null && s.height >= 24 && String(s.placeholder).includes("未命名页面"),
  { label: "空名字行就绪（有高度 + 占位）" },
)
check("PAGENAME-NEW-3 空名字行看得见（有高度 + 占位「未命名页面」）",
  Boolean(nameLine && nameLine.height >= 24 && String(nameLine.placeholder).includes("未命名页面")),
  nameLine)

// ② 写名 → 删除 → 回收站还原 → 名字还在
await page.keyboard.type("链条页")
const written = await poll(
  () => page.evaluate(() => ({ stored: (JSON.parse(localStorage.getItem("moqi-project-b:blocks") ?? "[]").find((b) => b.isObject && !b.deleted) ?? {}).objectName ?? null })),
  (s) => s.stored === "链条页",
  { label: "存档出现「链条页」" },
)
const moreBtn = await page.evaluate(() => { const card = document.querySelector(".lcard.cur, .scard.cur") ?? document.querySelector(".lcard, .scard"); const b = card?.querySelector("button.pmore"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })
let restoredName = null
if (moreBtn) {
  await page.mouse.click(moreBtn.x, moreBtn.y); await sleep(800)
  const trashItem = await page.evaluate(() => { const el = [...document.querySelectorAll(".pop button")].find((x) => /回收站/.test(x.textContent ?? "")); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })
  if (trashItem) {
    await page.mouse.click(trashItem.x, trashItem.y); await sleep(1000)
    const confirmBtn = await page.evaluate(() => { const el = [...document.querySelectorAll(".dlg button")].find((x) => /移入回收站|移到回收站/.test(x.textContent ?? "")); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })
    if (confirmBtn) { await page.mouse.click(confirmBtn.x, confirmBtn.y); await sleep(1600) }
    // 进回收站，恢复它
    await page.evaluate(() => { const el = [...document.querySelectorAll("button, a")].find((x) => (x.textContent ?? "").trim().startsWith("回收站")); if (el) el.click() })
    await sleep(1400)
    const restoreBtn = await page.evaluate(() => { const el = [...document.querySelectorAll("button")].find((x) => /恢复/.test(x.textContent ?? "")); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })
    if (restoreBtn) { await page.mouse.click(restoreBtn.x, restoreBtn.y); await sleep(1800) }
    await page.evaluate(() => { const el = [...document.querySelectorAll("button, a")].find((x) => (x.textContent ?? "").includes("返回")); if (el) el.click() })
    await sleep(1400)
    restoredName = await poll(
      () => page.evaluate(() => {
        const names = JSON.parse(localStorage.getItem("moqi-project-b:blocks") ?? "[]").filter((b) => b.isObject && !b.deleted).map((b) => b.objectName)
        return { names }
      }),
      (s) => s.names.includes("链条页"),
      { timeout: 6000, label: "还原后页名回到存档" },
    )
  }
}
check("PAGENAME-DELETE-1 ｜ PAGENAME-RESTORE-1 写名 → 删除 → 还原：名字还在（不回落占位）",
  Boolean(restoredName && restoredName.names.includes("链条页")),
  { written, restoredName })

await reset()

// ---------- 正确用法：面板开关只住在原生栏（09 §十四 图标归属） ----------
// 归属域分层：顶栏（原生栏）只放面板开关，面板与视图内部只放内容。
// 设置 / 回收站 这些视图的头部曾经各复制了一份侧栏开关（用户实测 ：返回按钮旁边多一个图标）。
const chromeCounts = async () => page.evaluate(() => {
  const inWbar = [...document.querySelectorAll(".wbar button")].filter((b) => (b.getAttribute("aria-label") ?? "").includes("侧栏")).length
  const on = document.querySelector(".view.is-on")
  const inView = on ? [...on.querySelectorAll("button")].filter((b) => (b.getAttribute("aria-label") ?? "").includes("侧栏")).length : -1
  return { inWbar, inView }
})
const editorChrome = await chromeCounts()
const goView = async (label) => {
  await page.evaluate((text) => { const el = [...document.querySelectorAll("button, a")].find((x) => (x.textContent ?? "").trim() === text); if (el) el.click() }, label)
  await sleep(900)
}
const viewChecks = []
viewChecks.push({ view: "编辑器", ...editorChrome })
viewChecks.push({ view: "回收站", ...(await (async () => {
  // 侧栏那颗带计数徽章（'回收站' + 数字），精确等值匹配不上——按 includes 点。
  await page.evaluate(() => { [...document.querySelectorAll('.sidebar button')].find((b) => (b.textContent ?? '').includes('回收站'))?.click() })
  await sleep(900)
  return chromeCounts()
})()) })
// 设置不再是视图（`R09-SET-16`）：它是居中模态——查它的**弹窗头部**同样没有侧栏开关副本，
// 且模态不改视图（`.view.is-on` 仍是编辑器）。开关走 ⌘,（`SET-OPEN-1`）。
await page.keyboard.press('Control+,')
await sleep(700)
const settingsModal = await page.evaluate(() => {
  const dlg = document.querySelector('.set-dlg')
  return {
    open: Boolean(dlg),
    inModalHead: dlg ? [...dlg.querySelectorAll('.dlg-h button')].filter((b) => (b.getAttribute('aria-label') ?? '').includes('侧栏')).length : -1,
    viewOn: document.querySelector('.view.is-on')?.getAttribute('aria-label') ?? null,
  }
})
await page.keyboard.press('Escape')
await sleep(500)
viewChecks.push({ view: "设置（弹窗）", inWbar: 1, inView: settingsModal.inModalHead })
check("PANEL-OWNER-1 侧栏开关只在原生栏：视图头部与设置弹窗头部都不复制一份（设置已改居中模态，`R09-SET-16`）",
  viewChecks.every((r) => r.inView === 0) && viewChecks.every((r) => r.inWbar === 1) && settingsModal.viewOn === '回收站',
  { viewChecks, settingsModal })
// 回编辑器（模态已用 Esc 关掉）：侧栏「页面库」那颗（`.sb-nav` 一族）。
await page.evaluate(() => { [...document.querySelectorAll('.sidebar button')].find((b) => (b.textContent ?? '').includes('页面库'))?.click() })
await sleep(600)

// ---------- 页面库 → 卡片菜单 → 移入回收站 ----------
// 确认按钮必须在桌面外壳的 mousedown / pointerdown 事件存在时仍可触发，
// 否则真实窗口里会表现为「弹窗能打开，但移入回收站点了没效果」。
await page.evaluate(() => localStorage.clear())
await reload()
await page.waitForSelector('.lcard, .scard', { timeout: NAV_READY_MS })
const deleteCard = page.locator('.lcard, .scard').first()
await deleteCard.locator('button.pmore').click()
await page.locator('.pop button').filter({ hasText: '移至回收站' }).click()
const deleteDialog = page.getByRole('dialog')
const confirmTrash = page.getByRole('button', { name: '移入回收站' })
const dialogReady = await deleteDialog.count() === 1 && await confirmTrash.isEnabled()
await confirmTrash.click()
await sleep(350)
const deleteToast = await toast()
check('LIB-MENU-2 页面库卡片确认移入回收站：按钮可点击、弹窗关闭、执行后不再弹提示',
  dialogReady && await page.getByRole('dialog').count() === 0 && deleteToast === null,
  { dialogReady, dialogCount: await page.getByRole('dialog').count(), toast: deleteToast })

// ---------- 列表卡的摘要与标签行不许重叠（用户实测 ；09 §五 列表卡） ----------
// 卡片是固定高的 flex 列：摘要要按剩余空间截断，标签行永远在摘要下方。造一页「标题 + 多行正文 + 两个标签」最苛刻。
await page.evaluate(() => {
  const now = Date.now()
  const page1 = { entityId: 'card-page', blockUid: 'cardpage1', type: 'text', content: [{ t: 'text', v: '带标签的页面' }], parent: null, children: ['card-b1', 'card-b2', 'card-b3'], position: 0, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: true, objectName: '带标签的页面', properties: [], tags: ['card-t1', 'card-t2'], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now }
  const body = (id, text, position) => ({ entityId: id, blockUid: `cardb000${position}`, type: 'text', content: [{ t: 'text', v: text }], parent: 'card-page', children: [], position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([page1, body('card-b1', '这是正文第一段，用来撑出卡片里的摘要内容，看看标签行会不会被压住。', 0), body('card-b2', '第二段内容，继续把卡片撑满，检查四段结构的排版。', 1), body('card-b3', '第三段用来把摘要顶过三行：摘要从子块起算、不再重复页面名（2026-10-10 视觉批 ⓓ），三行容量要靠正文本身撑出来，附带验证截断落在行边界。', 2)]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [{ id: 'card-t1', name: '测试标签', created: now, modified: now }, { id: 'card-t2', name: '第二个标签', created: now, modified: now }] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(1400)
await page.evaluate(() => { const el = [...document.querySelectorAll('button, a')].find((x) => (x.textContent ?? '').trim() === '页面库'); if (el) el.click() })
await sleep(1200)
const cardBox = await page.evaluate(() => {
  const card = document.querySelector('.lcard')
  if (!card) return null
  const rect = (sel) => { const el = card.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) } }
  const title = card.querySelector('h3')
  return {
    card: rect('.hd') ? Math.round(card.getBoundingClientRect().height) : null,
    title: title ? { top: Math.round(title.getBoundingClientRect().top), bottom: Math.round(title.getBoundingClientRect().bottom) } : null,
    summary: rect('.cnt'), cwrap: rect('.cwrap'), tags: rect('.atrow'), expb: rect('.expb'),
    expandRow: Boolean(card.querySelector('.expand-row')),
    expandText: card.querySelector('.expb')?.textContent ?? null,
  // ：截断改**直接截断**（`-webkit-line-clamp` 截在行边界），**不再有渐隐遮罩**——
    // 所以这里同时读 class 与 `::after` 的 background-image（渐隐层必须不存在）。
    clampClass: card.querySelector('.cnt')?.className ?? '',
    clampLines: card.querySelector('.cnt') ? getComputedStyle(card.querySelector('.cnt')).webkitLineClamp : null,
    fadeLayer: card.querySelector('.cnt') ? getComputedStyle(card.querySelector('.cnt'), '::after').backgroundImage : null,
  // 盒子高度必须**恰好三行**（ 视觉批 ⓓ）：`-webkit-box` 在 flex 子项里会被浏览器降级成
    // `flow-root`，`line-clamp` 随之静默失效，只剩 `overflow: hidden` 按盒子高度硬切——盒子比三行高就是
    // 「半行残字」。旧断言只查 `clamp=3`（computed 值照样是 3）与 `h >= 68`（3.4 行也满足），抓不到。
    lineHeight: card.querySelector('.cnt') ? getComputedStyle(card.querySelector('.cnt')).lineHeight : null,
  }
})
check('LIB-CARD-1 列表卡：128px、两行直接截断、无渐隐 / 无展开 / 无属性行',
  Boolean(cardBox) && cardBox.cwrap === null && cardBox.summary !== null && cardBox.tags === null && cardBox.expb === null
  && Math.abs((cardBox.card ?? 0) - 128) <= 1
  && cardBox.title.bottom <= cardBox.summary.top
  && String(cardBox.clampClass).includes('clamp') && String(cardBox.clampClass).includes('is-fade') === false
  && cardBox.clampLines === '2' && (cardBox.fadeLayer === 'none' || cardBox.fadeLayer === null)
  && Math.abs(cardBox.summary.h - 2 * parseFloat(cardBox.lineHeight ?? '0')) <= 1.5
  && cardBox.expandRow === false && cardBox.expandText === null,
  cardBox)

// ---------- 三色分块体系（§一 铁律 + §六 验收）：三带从 y=0 贯通、交界零竖线、标题栏在主列内部 ----------
// 三列各占一色、单向阶梯（侧栏最深 → 页面库居中 → 编辑区最白）；标题栏不是第四条带——
// 它只在主列内部（40px、`--panel`），☰/▣ 落位在主列左缘（即页面库交界处）。
const bands = await page.evaluate(() => {
  const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { top: Math.round(r.top), left: Math.round(r.left), h: Math.round(r.height), bg: cs.backgroundColor, L: Math.round(lum(cs.backgroundColor)), vBorders: [cs.borderLeftWidth, cs.borderRightWidth] }
  }
  const wbar = document.querySelector('.wbar')
  const edCol = document.querySelector('.ed-col')
  const toggle = document.querySelector('.wbar .tb-btn')
  return {
    sidebar: box('.sidebar'), pagecol: box('.pagecol'), panel: box('.ed-col'), wbar: box('.wbar'),
    // 标题栏**不得住在任何视图子树里**——它要覆盖全部视图（回收站 / 设置下窗口三键必须照样可点，
  // 实测过一次「挂在编辑视图里 ⇒ 另外两个视图整条标题栏消失」）。
    wbarOutsideViews: wbar ? ![...document.querySelectorAll('section.view')].some((v) => v.contains(wbar)) : false,
    wbarLeftVsPanel: wbar && edCol ? Math.round(wbar.getBoundingClientRect().left - edCol.getBoundingClientRect().left) : null,
    wctl: document.querySelectorAll('.wctl').length,
    toggleLeftInMainCol: toggle && edCol ? Math.round(toggle.getBoundingClientRect().left - edCol.getBoundingClientRect().left) : null,
  }
})
check('三色分块体系：三带从 y=0 贯通（顶部无横向断带）、交界零竖线、明度阶梯单向（侧栏 < 页面库 < 编辑区）、标题栏只在主列 40px（不落在任何视图子树里）且 ☰/▣ 落在主列左缘',
  bands.sidebar !== null && bands.pagecol !== null && bands.panel !== null && bands.wbar !== null
  && bands.sidebar.top === 0 && bands.pagecol.top === 0
  && [...bands.sidebar.vBorders, ...bands.pagecol.vBorders].every((w) => w === '0px')
  && bands.sidebar.L < bands.pagecol.L && bands.pagecol.L < bands.panel.L
  && bands.wbarOutsideViews && bands.wbar.h === 40 && bands.wbar.top === 0 && Math.abs(bands.wbarLeftVsPanel ?? 99) <= 2
  && bands.wctl === 3 && bands.toggleLeftInMainCol !== null && bands.toggleLeftInMainCol >= 0 && bands.toggleLeftInMainCol <= 12,
  bands)

// ---------- 行内引用不吃相邻输入：链接文字首尾不留空白（04 §1 R04-CARET-5） ----------
await reset()
// D-014（）之后「本篇」不再是合法目标，而种子库只有一页 ⇒ 先补一页当目标。
// 这一步不测引用本身，只保证这条用例测的是**引用边上打字**，而不是「候选为空」。
await page.evaluate(() => {
  const now = Date.now()
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
  blocks.push({
    entityId: 'reftype-target', blockUid: 'rttarget01', type: 'text', content: [{ t: 'text', v: '参考页' }],
    parent: null, children: [], position: 99, collapsed: false, checked: false, deleted: false, deletedAt: null,
    prevParent: null, prevIndex: null, isObject: true, objectName: '参考页', properties: [], tags: [],
    blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now,
  })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify(blocks))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(500)
await clickBlock('第一段')
await page.keyboard.press('End')
await sleep(150)
await page.keyboard.press('Enter')
await sleep(600)
await page.keyboard.type('[[')
await sleep(900)
await page.keyboard.press('Enter')
await sleep(900)
// 记下候选插入后的链接文字（D-014 之后候选里只剩上面补的那一页「参考页」）
const refLabel = await page.evaluate(() => document.querySelector('.moqi-inline-ref')?.textContent ?? null)
await page.keyboard.type(' 后面的话')
await sleep(1600)
const refAfterType = await page.evaluate(() => {
  const span = document.querySelector('.moqi-inline-ref')
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => !b.deleted)
  const refs = blocks.flatMap((b) => (b.content ?? []).filter((f) => f.t === 'inline-ref').map((f) => f.v))
  const spanText = span?.textContent ?? null
  return { spanText, refs, spanTrimmed: spanText === null ? null : spanText === spanText.trim() }
})
check('REF-TYPE-1 行内引用：边上打字不进链接（下划线 / 背景不跟着空格长）',
  Boolean(refLabel) && refAfterType.spanText === refLabel && refAfterType.spanTrimmed === true
  && refAfterType.refs.length === 1 && refAfterType.refs[0] === refLabel,
  { refLabel, ...refAfterType })
await reset()

// ---------- AI 块「采用」之后的样子（docs/09 §6.11 R09-AIB-5，用户 裁决方案 A） ----------
// 采用后块**没有任何 AI 外观**：虚线框、标签行、操作条、行容器、悬停提示全没有（与普通块一模一样），
// 而 `aiMeta` 留在数据里（来源与操作类型「保留至采用或丢弃」）；撤销一次回到「待采用」。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position, extra) => ({ entityId: id, blockUid: uid, type: 'text', content: [{ t: 'text', v: text }], parent, children: [], position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now, ...extra })
  const page1 = { ...mk('acc-page', 'accpage1', '采用测试页', null, 0, {}), isObject: true, objectName: '采用测试页', children: ['acc-src', 'acc-ai'] }
  const src = mk('acc-src', 'accsrc01', '正文第一段', 'acc-page', 0, {})
  const ai = mk('acc-ai', 'accai001', '待采用的结果', 'acc-page', 1, { aiMeta: { action: 'summary', status: 'complete', sourceBlockIds: ['acc-src'], sourceScope: 'page' } })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([page1, src, ai]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.ai-block-bar[data-marker-for="acc-ai"]', { timeout: NAV_READY_MS })
await sleep(600)
const beforeAccept = await page.evaluate(() => {
  const el = document.querySelector('[data-entity-id="acc-ai"]')
  return { frame: el?.classList.contains('ai-block') ?? null, status: el?.dataset.aiStatus ?? null }
})
await page.locator('.ai-block-bar[data-marker-for="acc-ai"] button.ok').click()
await sleep(1200)
const acceptedState = await page.evaluate(() => {
  const el = document.querySelector('[data-entity-id="acc-ai"]')
  const saved = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').find((b) => b.entityId === 'acc-ai')?.aiMeta ?? null
  return {
    frame: el ? el.classList.contains('ai-block') : null,
    bar: document.querySelectorAll('.ai-block-bar[data-marker-for="acc-ai"]').length,
    bars: document.querySelectorAll('.ai-block-bar').length,
    attrs: ['aiStatus', 'aiOp', 'aiSrc', 'aiAccepted'].filter((key) => key in (el?.dataset ?? {})),
    title: el?.getAttribute('title') ?? null,
    status: saved?.status ?? null,
    scope: saved?.sourceScope ?? null,
    sources: Array.isArray(saved?.sourceBlockIds) ? saved.sourceBlockIds.length : null,
    action: saved?.action ?? null,
  }
})
check('R09-AIB-5 采用 → 界面与普通块一模一样：没有虚线框 / 行容器 / data-ai-* / 悬停提示，来源与状态留在数据里',
  beforeAccept.frame === true && beforeAccept.status === 'complete'
  && acceptedState.frame === false && acceptedState.bar === 0 && acceptedState.bars === 0
  && acceptedState.attrs.length === 0 && acceptedState.title === null
  && acceptedState.status === 'accepted' && acceptedState.scope === 'page' && acceptedState.sources === 1 && acceptedState.action === 'summary',
  { beforeAccept, ...acceptedState })

// 读点加固（，AIB-5 在属性面板批的同轮全量里红过一次；隔离复现 3/3 绿 ⇒ 读点 flake）：
// ⌘Z 之后**轮询到「应有的事实」**（虚线框回来 + 数据回到 complete），不是固定 sleep 后读；
// 一次没生效（键被吞 / 时序）再按一次——两次读的是**同一目标状态**，所以不会叠撤。
const readAcceptUndo = () => page.evaluate(() => {
  const el = document.querySelector('[data-entity-id="acc-ai"]')
  const bar = document.querySelector('.ai-block-bar[data-marker-for="acc-ai"]')
  const saved = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').find((b) => b.entityId === 'acc-ai')?.aiMeta ?? null
  return { frame: el ? el.classList.contains('ai-block') : null, variant: bar?.dataset.aiVariant ?? null, hasAcceptButton: Boolean(bar?.querySelector('button.ok')), status: saved?.status ?? null }
})
const undoAcceptOnce = async () => {
  await page.mouse.move(300, 300)
  await page.keyboard.press('Control+z')
  return poll(readAcceptUndo, (s) => s.frame === true && s.status === 'complete', { label: '采用撤销回到待采用', timeout: 4000 })
}
let acceptedUndoState = await undoAcceptOnce()
if (acceptedUndoState.frame !== true) acceptedUndoState = await undoAcceptOnce()
check('R09-AIB-5 采用可撤销：⌘Z 一次回到「待采用」（虚线框与采用键都回来）',
  acceptedUndoState.frame === true && acceptedUndoState.variant === 'done' && acceptedUndoState.hasAcceptButton === true
  && acceptedUndoState.status === 'complete',
  acceptedUndoState)

// ---------- AI 结果落点（docs/09 §6.11 R09-AIB-6、§6.10 R09-TXBAR-2）----------
// 用户实测 ：「选文本后 AI 生成的块不是在选中文字的块后面，直接生成到文档后面；
// 三种范围全显示基于本段」。根因：入口只传一个 string[]，由「数组非空」反推口径与落点档位，
// 于是「整篇」被当成「选中了页面容器」。
// **AI 结果块在调用模型之前就落地**（先落生成中占位块，再流式写入），所以配置一个够不到的
// 端点也能真实观察落点与标签——不需要真模型，也不花额度。
const seedAiPage = async (baseUrl = 'http://127.0.0.1:9/v1') => {
  // 种完**验一次**、不成就重来（最多 3 次）：落盘队列的防抖写会在导航前一刻把旧状态刷回 localStorage，
 // 新种子被旧块列表盖掉、reload 后上一段用例留下的 AI 块还活着（ 浸泡第 1 遍实测：
  // AI-STOP-1 ④ 的 `aiBlockState` 读到旧块（完成态、无停止钮）→ 误报；同轮第 2 遍绿）。
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.evaluate((url) => {
      const now = Date.now()
      const mk = (id, uid, text, parent, position, extra) => ({ entityId: id, blockUid: uid, type: 'text', content: [{ t: 'text', v: text }], parent, children: [], position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now, ...extra })
      const page1 = { ...mk('ai-page', 'aipage01', 'AI 落点测试页', null, 0, {}), isObject: true, objectName: 'AI 落点测试页', children: ['ai-b1', 'ai-b2', 'ai-b3'] }
      localStorage.setItem('moqi-project-b:blocks', JSON.stringify([page1, mk('ai-b1', 'aib00001', '第一段文字', 'ai-page', 0, {}), mk('ai-b2', 'aib00002', '第二段文字 这里要被选中', 'ai-page', 1, {}), mk('ai-b3', 'aib00003', '第三段文字', 'ai-page', 2, {})]))
      localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
      localStorage.setItem('moqi-project-b:ai-config', JSON.stringify({ baseUrl: url, apiKey: 'acceptance', model: 'deepseek-chat' }))
    }, baseUrl)
    await reload()
    await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
    await sleep(900)
    const seeded = await page.evaluate(() => {
      const text = document.querySelector('.editor-content')?.innerText ?? ''
      return {
        ok: text.includes('第一段文字') && text.includes('第三段文字'),
        // 残留的 AI 块（上一段用例留下的）会让 `aiBlockState` 读到旧块——必须清零才算种干净。
        leftovers: document.querySelectorAll('.moqi-block[data-ai-status]').length,
      }
    })
    if (seeded.ok && seeded.leftovers === 0) return
    console.log(`seedAiPage：第 ${attempt} 次没种干净（残留 AI 块 ${seeded.leftovers}）——重来`)
  }
  throw new Error('seedAiPage：连续 3 次没把种子铺干净——验收无法继续')
}
/** 结果块落在哪个位置上：读页面 children 的顺序 + 新块的口径与标签。 */
const aiLanding = () => page.evaluate(() => {
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => !b.deleted)
  const page1 = blocks.find((b) => b.isObject)
  const order = page1.children.map((id) => (blocks.find((b) => b.entityId === id)?.aiMeta ? '[AI]' : id.replace('ai-', '')))
  const generated = blocks.find((b) => b.aiMeta)
  const el = generated ? document.querySelector(`[data-entity-id="${generated.entityId}"]`) : null
  return { order, scope: generated?.aiMeta?.sourceScope ?? null, sources: generated?.aiMeta?.sourceBlockIds ?? null, domSrc: el?.dataset.aiSrc ?? null }
})
/** 光标进第二块并选中前三个字（键盘选取，最稳）。 */
const selectTextInSecondBlock = async () => {
  const box = await page.evaluate(() => {
    const leaves = [...document.querySelectorAll('.editor-content .moqi-block')].filter((b) => b.querySelector('.moqi-block') === null)
    const el = leaves.find((b) => (b.textContent ?? '').startsWith('第二段文字'))
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }
  })
  await page.mouse.click(box.x, box.y)
  await sleep(300)
  await page.keyboard.press('Home')
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowRight')
  await sleep(500)
}

await seedAiPage()
await selectTextInSecondBlock()
let aiMenuOpen = false
for (let i = 0; i < 3 && !aiMenuOpen; i += 1) {
  const spot = await page.evaluate(() => {
    const button = document.querySelector('[aria-label="AI 指令"]')
    if (!button) return null
    const rect = button.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })
  if (spot) {
    await page.mouse.click(spot.x, spot.y)
    await sleep(400)
    aiMenuOpen = await page.evaluate(() => document.querySelectorAll('.pop[aria-label="AI 指令"]').length > 0)
  }
}
const selectionText = await page.evaluate(() => window.getSelection()?.toString() ?? null)

// ---------- 未实现的 AI 指令必须**看得见地**标注版本（docs/09 §十二 R09-SCOPE-17）----------
// 用户实测 ：「界面都做出来了，功能还没有出来」。此前两处只靠 tooltip 说明，
// 而六宫格的禁用态只把 12.5px 的文字调灰、29px 的主题色图标块原样不动 —— 看上去整排都能点。
// 这一条就是那条规则的执行者：**未实现项必须禁用 + 带可见的「后续版本」标注**。
// V2c：六项指令全部实现 ⇒ 未实现清单为空。规则 R09-SCOPE-17 仍然在，只是它的数据变了：
// **将来**再加未实现的指令时，把名字放回 AI_TODO_OPS，下面两条断言会立刻要求「禁用 + 可见标注」。
const AI_TODO_OPS = []
const AI_DONE_OPS = ['润色', '总结', '扩写', '提取行动', '反问我', '换角度']
/** 读一组 AI 指令按钮的真实状态与视觉（标注是否可见、禁用项的图标颜色与可用项是否可辨）。 */
const readAiOps = (selector) => page.evaluate(({ selector, todoLabels, doneLabels }) => {
  const nodes = [...document.querySelectorAll(selector)]
  if (nodes.length === 0) return null
  return nodes.map((node) => {
    const text = node.textContent ?? ''
    const label = text.replace(/后续版本/g, '').trim()
    const icon = node.querySelector('.gi, .mi')
    return {
      label,
      kind: todoLabels.includes(label) ? 'todo' : doneLabels.includes(label) ? 'done' : 'other',
      disabled: node.disabled,
      marked: text.includes('后续版本'),
      iconColor: icon ? getComputedStyle(icon).color : null,
    }
  })
}, { selector, todoLabels: AI_TODO_OPS, doneLabels: AI_DONE_OPS })
/** 通用判据：四项未实现都禁用+标注，两项已实现不标注。图标可辨只在六宫格判（菜单里都是中性色）。 */
const checkAiOps = (name, ops) => {
  const todo = (ops ?? []).filter((o) => o.kind === 'todo')
  const done = (ops ?? []).filter((o) => o.kind === 'done')
  check(`${name}：未实现的指令（当前 0 项）都禁用并标注「后续版本」，已实现的 ${AI_DONE_OPS.length} 项都不标注`,
    todo.length === AI_TODO_OPS.length && done.length === AI_DONE_OPS.length
    && todo.every((o) => o.disabled && o.marked)
    && done.every((o) => !o.disabled && !o.marked),
    { ops })
  return { todo, done }
}
const popoverOps = await readAiOps('.pop[aria-label="AI 指令"] button')
checkAiOps('R09-SCOPE-17 AI 指令菜单', popoverOps)

if (aiMenuOpen) {
  await page.locator('.pop[aria-label="AI 指令"] button').filter({ hasText: '总结' }).first().click()
  await sleep(2400)
}
const textToolbarLanding = await aiLanding()
check('R09-AIB-6 文本工具栏 AI：结果落在「选中文字所在块」之后（不是文末），标签「基于本段」',
  selectionText !== null && selectionText.length > 0 && aiMenuOpen
  && textToolbarLanding.order.join(',') === 'b1,b2,[AI],b3'
  && textToolbarLanding.scope === 'selection' && textToolbarLanding.sources?.length === 1
  && textToolbarLanding.domSrc === '基于本段',
  { selectionText, aiMenuOpen, ...textToolbarLanding })

await seedAiPage()
await selectTextInSecondBlock()
const panelOpened = await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') ?? '').includes('AI 助手'))
  if (button) button.click()
  return Boolean(button)
})
await sleep(900)
const gridOps = await readAiOps('.aip-grid button')
const { todo: gridTodo, done: gridDone } = checkAiOps('R09-SCOPE-17 AI 助手面板六宫格', gridOps)
check('R09-SCOPE-17 六宫格六项全部可用、没有任何一项带「后续版本」标注（V2c：四项新指令已实现）',
  gridTodo.length === 0 && gridDone.length === 6 && gridDone.every((o) => !o.marked && !o.disabled),
  { todoCount: gridTodo.length, doneLabels: gridDone.map((o) => o.label) })
const quickClicked = await page.evaluate(() => {
  const scope = [...document.querySelectorAll('.sidepanel, .panel, aside')].find((p) => (p.textContent ?? '').includes('基于本篇'))
  const button = [...(scope ?? document).querySelectorAll('button')].find((b) => (b.textContent ?? '').trim().includes('总结'))
  if (button) button.click()
  return Boolean(button)
})
await sleep(2400)
const panelLanding = await aiLanding()
check('R09-AIB-6 面板六宫格（基于本篇，产出型）：读整篇（来源 = 整棵子树 ≥ 4 块，D-018 回归）但落在光标那一块之后，标签「基于全篇」',
  panelOpened && quickClicked
  && panelLanding.order.join(',') === 'b1,b2,[AI],b3'
  && panelLanding.scope === 'page' && panelLanding.domSrc === '基于全篇'
  && Array.isArray(panelLanding.sources) && panelLanding.sources.length >= 4,
  { panelOpened, quickClicked, ...panelLanding })

// R09-AIPANEL-3c（ 用户裁决「③+②」）：改写型只作用于**一段**——重载后既没有光标也没有选区，
// 「润色 / 扩写 / 换角度」必须**禁用并写明原因**（宫格下方的范围说明行），产出型三项照旧可用。
await seedAiPage()
await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') ?? '').includes('AI 助手'))
  if (button) button.click()
})
await sleep(900)
const gatedOps = await readAiOps('.aip-grid button')
const scopeNote = await page.evaluate(() => (document.querySelector('.aip-scope-note')?.textContent ?? '').replace(/\s+/g, ' ').trim())
check('R09-AIPANEL-3c 改写型（润色 / 扩写 / 换角度）没有目标时禁用并写明原因；产出型三项照旧可用；范围说明写在宫格下方',
  gatedOps !== null
  && ['润色', '扩写', '换角度'].every((label) => gatedOps.some((o) => o.label === label && o.disabled))
  && ['总结', '提取行动', '反问我'].every((label) => gatedOps.some((o) => o.label === label && !o.disabled))
  && scopeNote.includes('选中'),
  { gatedOps, scopeNote })

// ---------- AI 运行时（docs/11：AI-STREAM-1 / AI-STOP-1 / AI-ERROR-1 / AI-REGEN-1 / AI-UNDO-1）----------
// 上面几条只验「块落在哪」——端点够不到也能验（占位块先落地）。这一组要验**跑起来的样子**：
// 流式写回、点停止、失败、重新生成，以及「一次生成只占一个撤销步」这条契约（`04` §5 / `11` AI-UNDO-1）。
// 所以起一个**本机 SSE stub**（accept 进程内，随机端口）：不碰真模型、不花额度、结果可控。
// 三种模式：stream = 分片流完（80ms/片）；slow = 慢速流完（300ms/片，给「生成中」留出可观察窗口）；
// hold = 发一片后挂起（供「收到一半再停」）；silent = 一个字都不发（供「空内容停止」）；fail = 直接 500。
//
// 台词里固定带三条「解析不能吃」的行（D-019，）：行首 `**加粗**`、小数 `1.5 倍速`、日期
// `2026.10.05 记`——它们经 `parseItems` 逐行剥离后必须原样保留；真吃字时 `savedText === AI_TEXT`
// 会立刻红（旧正则把三行分别吃成 `*加粗**开头` / `5 倍速` / `10.05 记`）。首片不带换行，
// 供 hold 模式「收到一半」的断言逐字比对。
const AI_CHUNKS = ['**加粗**开头', '\n1.5 倍速', '\n2026.10.05 记', '\n正文收尾']
const AI_TEXT = AI_CHUNKS.join('')
/** DOM 文本判据：`aiBlockState` 的 innerText 会把空白折叠成空格，多行全文对应折叠后的形态。 */
const AI_DOM_TEXT = AI_TEXT.replace(/\s+/g, ' ').trim()
const aiStub = { mode: 'stream' }
const aiServer = createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
  if (aiStub.mode === 'fail') { res.writeHead(500, { ...cors, 'Content-Type': 'application/json' }); res.end('{"error":{"message":"stub 500"}}'); return }
  res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const send = (text) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
  if (aiStub.mode === 'hold') { send(AI_CHUNKS[0]); return }
  if (aiStub.mode === 'silent') return
  let at = 0
  const timer = setInterval(() => {
    if (at < AI_CHUNKS.length) { send(AI_CHUNKS[at]); at += 1; return }
    clearInterval(timer)
    res.write('data: [DONE]\n\n')
    res.end()
  }, aiStub.mode === 'slow' ? 300 : 80)
  req.on('close', () => clearInterval(timer))
})
await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve))
const aiStubUrl = `http://127.0.0.1:${aiServer.address().port}/v1`

/** 面板路径发起一次「总结」：读整篇，落点在光标块 / 正文最后一块之后。 */
const runPanelSummary = async () => {
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') ?? '').includes('AI 助手'))
    if (button) button.click()
    return Boolean(button)
  })
  await sleep(700)
  const clicked = await page.evaluate(() => {
    const scope = [...document.querySelectorAll('.sidepanel, .panel, aside')].find((p) => (p.textContent ?? '').includes('基于本篇'))
    const button = [...(scope ?? document).querySelectorAll('button')].find((b) => (b.textContent ?? '').trim().includes('总结'))
    if (button) button.click()
    return Boolean(button)
  })
  return opened && clicked
}
/**
 * AI 块此刻的真实样子。**中间态以 DOM 为准**：流式阶段的写回走镜像、落盘由队列合并，
 * 存档（localStorage）通常要等这次生成结束才更新——只读存档会看不到「生成中」（ 实测）。
 * 所以：状态 / 正文 / 块数取 DOM（`data-ai-status` 由 decorateAi 写），存档值只当「最终是否落盘」的佐证。
 */
const aiBlockState = () => page.evaluate(() => {
  const domBlocks = [...document.querySelectorAll('.moqi-block[data-ai-status]')].map((el) => ({
    id: el.dataset.entityId ?? null,
    status: el.dataset.aiStatus ?? null,
    text: (el.innerText ?? '').replace(/\s+/g, ' ').trim(),
  }))
  const first = domBlocks[0] ?? null
  const bar = first ? document.querySelector(`.ai-block-bar[data-marker-for="${first.id}"]`) : null
  const saved = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => !b.deleted)
  const record = first ? saved.find((b) => b.entityId === first.id) : null
  return {
    id: first?.id ?? null,
    domStatus: first?.status ?? null,
    domText: first?.text ?? '',
    variant: bar?.dataset.aiVariant ?? null,
    hasStop: Boolean(bar?.querySelector('button.ai-stop')),
    domCount: domBlocks.length,
    /** 生成条上的操作标签（「润色」这类，读的是界面）。 */
    opTag: (bar?.querySelector('.op-tag')?.textContent ?? null),
    /** 存档里记的动作（域真值：证明走的是哪一条指令）。 */
    savedAction: record?.aiMeta?.action ?? null,
    savedStatus: record?.aiMeta?.status ?? null,
    savedText: record ? (record.content ?? []).map((f) => f.v ?? '').join('') : '',
    savedCount: saved.filter((b) => b.aiMeta).length,
    toast: document.querySelector('.notice')?.textContent ?? null,
  }
})
/** 轮询到某个状态为止（流式与落盘都有节拍，固定 sleep 会飘）。 */
const waitForAi = async (ok, timeout = 10000) => {
  const until = Date.now() + timeout
  for (;;) {
    const state = await aiBlockState()
    if (ok(state) || Date.now() > until) return state
    await sleep(200)
  }
}

// ① 流式生成：先「生成中」（带 ■ 停止）→ 流完转完成态，正文等于模型返回的全文
//   完成态的状态值按 `resolveAiStatus` 是 `needs-confirmation`：stub 不带置信度，无置信度一律按「需人工确认」（降级）。
aiStub.mode = 'slow'
await seedAiPage(aiStubUrl)
const streamStarted = await runPanelSummary()
const sawGenerating = await waitForAi((s) => s.domStatus === 'generating' && s.hasStop === true, 8000)
const streamed = await waitForAi((s) => s.domStatus === 'needs-confirmation' && s.savedText === AI_TEXT, 12000)
check('AI-STREAM-1 流式生成：先落「生成中」占位块（带 ■ 停止），流完转完成态并落盘，正文等于模型返回的全文（此前无网——这一条起本机 SSE stub；台词含行首加粗/小数/日期，顺带压 D-019）',
  streamStarted && sawGenerating.domStatus === 'generating' && sawGenerating.hasStop === true
  && sawGenerating.variant === 'generating'
  && streamed.domStatus === 'needs-confirmation' && streamed.domText === AI_DOM_TEXT
  && streamed.savedStatus === 'needs-confirmation' && streamed.savedText === AI_TEXT,
  { streamStarted, sawGenerating, streamed })

// ② 一次生成只占一个撤销步：流式中间态走镜像（`applyMirror`），⌘Z 一次撤掉整块
await page.keyboard.press('Control+z')
const undone = await waitForAi((s) => s.id === null && s.savedCount === 0, 8000)
check('AI-UNDO-1 一次生成只占一个撤销步：⌘Z 一次撤掉整块（流式中间态不占栈）（此前无网）',
  undone.id === null && undone.domCount === 0 && undone.savedCount === 0,
  { before: streamed, after: undone })

// ③ 停止（已收到部分）：保留已生成部分进完成态
aiStub.mode = 'hold'
await seedAiPage(aiStubUrl)
const holdStarted = await runPanelSummary()
const holding = await waitForAi((s) => s.hasStop === true && s.domText.length > 0, 10000)
await page.locator('.ai-block-bar[data-ai-variant="generating"] button.ai-stop').click()
const stoppedPartial = await waitForAi((s) => s.domStatus === 'complete', 10000)
check('AI-STOP-1 生成中点停止（已收到部分）：保留已生成部分进完成态，不再弹提示（此前无网）',
  holdStarted && holding.domText.length > 0 && stoppedPartial.domStatus === 'complete'
  && stoppedPartial.domText === AI_CHUNKS[0] && stoppedPartial.toast === null,
  { holdStarted, holding, stopped: stoppedPartial })

// ④ 停止（一个字都没收到）：进「已取消」并给占位提示
aiStub.mode = 'silent'
await seedAiPage(aiStubUrl)
await runPanelSummary()
const silentGenerating = await waitForAi((s) => s.hasStop === true, 8000)
await page.locator('.ai-block-bar[data-ai-variant="generating"] button.ai-stop').click()
const stoppedEmpty = await waitForAi((s) => s.domStatus === 'cancelled', 10000)
check('AI-STOP-1 生成中一个字都还没收到就停止：块进「已取消」并显示占位提示（此前无网）',
  silentGenerating.hasStop === true && stoppedEmpty.domStatus === 'cancelled'
  && stoppedEmpty.domText.includes('已停止，未生成内容'),
  { silentGenerating, stoppedEmpty })

// ④a-bis D-003（ 用户裁决）：**丢弃 AI 块不进回收站**——回收站是「用户内容」的保险，
// AI 草稿不是用户写的。判据：点丢弃后正文里没了、回收站计数**没变**、存档里那行也真没了。
aiStub.mode = 'stream'
await seedAiPage(aiStubUrl)
await runPanelSummary()
await waitForAi((s) => s.domStatus === 'needs-confirmation' && s.domText.length > 0, 10000)
const trashBefore = await page.evaluate(() => [...document.querySelectorAll('.sb-foot button')].map((b) => (b.textContent ?? '').trim()).find((t) => t.includes('回收站')) ?? null)
const discardSpot = await page.evaluate(() => {
  const ops = document.querySelector('[aria-label="AI 块操作"]')
  const button = [...(ops?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('丢弃'))
  if (!button) return null
  button.click()
  return true
})
// 丢弃不可逆：动作前先过确认弹窗（ 零提示批）
await page.locator('.dlg-f button', { hasText: '丢弃' }).click()
// 读点改轮询（套件稳定性立项，）：丢弃是「真删」，落盘在 220+600ms 节拍之后，
// 原来的固定 900ms 窗口在机器忙时会先读到旧态（这项 挂过一轮）。
const afterDiscard = await poll(
  () => page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
    return {
      trash: [...document.querySelectorAll('.sb-foot button')].map((b) => (b.textContent ?? '').trim()).find((t) => t.includes('回收站')) ?? null,
      aiBlocksLeft: rows.filter((b) => b.aiMeta).length,
      deleteRowsForAi: rows.filter((b) => b.aiMeta && b.deleted).length,
    }
  }),
  (s) => s.aiBlocksLeft === 0 && s.deleteRowsForAi === 0,
  { timeout: 8000, label: 'AI 块真删完成（存档里既无活行也无删行）' },
)
check('D-003 丢弃 AI 块：先过确认弹窗；正文里没了、**回收站里也没有**（真删而非软删，回收站计数不变）（此前无网）',
  discardSpot === true && trashBefore !== null && afterDiscard.trash === trashBefore
  && afterDiscard.aiBlocksLeft === 0 && afterDiscard.deleteRowsForAi === 0,
  { trashBefore, discardSpot, afterDiscard })

// ④b V2c：四项新指令（润色 / 扩写 / 反问我 / 换角度）与「总结」走同一条链路——
// 用面板六宫格的「润色」真跑一次：生成中的块 → 流完 → 块上写的是模型返回的正文，操作标签是「润色」。
// R09-AIPANEL-3c（）：改写型只作用于**一段** ⇒ 先把光标放进第二块再开面板——
// 没有目标时「润色」是禁用的（禁用态本身由上面那条用例验）。
aiStub.mode = 'stream'
await seedAiPage(aiStubUrl)
const caretInSecondBlock = await page.evaluate(() => {
  const leaves = [...document.querySelectorAll('.editor-content .moqi-block')].filter((b) => b.querySelector('.moqi-block') === null)
  const el = leaves.find((b) => (b.textContent ?? '').startsWith('第二段文字'))
  if (!el) return null
  const rect = el.getBoundingClientRect()
  return { x: Math.round(rect.left + 20), y: Math.round(rect.top + rect.height / 2) }
})
if (caretInSecondBlock) { await page.mouse.click(caretInSecondBlock.x, caretInSecondBlock.y); await sleep(400) }
await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') ?? '').includes('AI 助手'))
  if (button) button.click()
})
await sleep(700)
// R09-AIPANEL-3c 的另一半：**能跑时也要说清作用在哪**（范围说明常驻在宫格下方）。
const polishScopeNote = await page.evaluate(() => (document.querySelector('.aip-scope-note')?.textContent ?? '').replace(/\s+/g, ' ').trim())
const polishClicked = await page.evaluate(() => {
  const scope = [...document.querySelectorAll('.sidepanel, .panel, aside')].find((p) => (p.textContent ?? '').includes('基于本篇'))
  const button = [...(scope ?? document).querySelectorAll('button')].find((b) => (b.textContent ?? '').trim().includes('润色'))
  if (button) button.click()
  return Boolean(button)
})
const polished = await (async () => {
  const until = Date.now() + 12000
  for (;;) {
    const state = await aiBlockState()
    if (state.domStatus === 'needs-confirmation' && state.savedText === AI_TEXT) return state
    if (Date.now() > until) return state
    await sleep(250)
  }
})()
// R09-AIPANEL-3c（）：改写型**只读一段**——来源是光标所在的那一块，面板不再整篇送进去；
// 「整篇 = 整棵子树」的回归断言在上面「面板六宫格（基于本篇）」的**总结**项里（D-018）。
const polishedSources = await page.evaluate(() => {
  const rows = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
  const generated = rows.filter((b) => b.aiMeta && b.aiMeta.action === 'polish').pop()
  return generated?.aiMeta?.sourceBlockIds?.length ?? 0
})
check('R09-AIPANEL-3 / R09-AIPANEL-3c 四项新指令走同一条链路：面板点「润色」→ 生成中的 AI 块 → 流完落正文（操作标签是「润色」），**来源是光标所在的一段**（改写型不再进整篇），**正文三行样本原样保留**（行首加粗 / 小数 / 日期，D-019 回归），范围说明写着「作用于本段」',
  polishClicked === true && polished.domStatus === 'needs-confirmation'
  && polished.savedText === AI_TEXT && polished.domText === AI_DOM_TEXT
  && (polished.opTag ?? '') === '润色' && polished.savedAction === 'polish'
  && polishedSources === 1 && polishScopeNote.includes('作用于本段'),
  { polishClicked, caretInSecondBlock, polished, polishedSources, polishScopeNote })

// ⑤ 失败：进失败态、正文写明原因、toast 给「重试」
aiStub.mode = 'fail'
await seedAiPage(aiStubUrl)
await runPanelSummary()
const failedState = await waitForAi((s) => s.domStatus === 'error' && (s.toast ?? '').includes('重试'), 10000)
check('AI-ERROR-1 端点返回 500：块进失败态、正文写明失败原因、toast 给「重试」（此前无网）',
  failedState.domStatus === 'error' && failedState.domText.includes('生成失败')
  && (failedState.toast ?? '').includes('重试'),
  { failed: failedState })

// ⑥ 重新生成：就地重跑同一块（不新增块）
aiStub.mode = 'stream'
const regenId = failedState.id
await page.locator('.ai-block-bar[data-ai-variant="done"] .ai-ops button').filter({ hasText: '重新生成' }).click()
const regenerated = await waitForAi((s) => s.domStatus === 'needs-confirmation' && s.domText === AI_DOM_TEXT, 12000)
check('AI-REGEN-1 重新生成就地重跑：块 id 不变、从失败态流到完成（不新增块）（此前无网）',
  regenId !== null && regenerated.id === regenId && regenerated.domCount === 1 && regenerated.domText === AI_DOM_TEXT,
  { regenId, regenerated })


// ---------- 浮层跟随与可见性（docs/09 §6.9 R09-BEDIT-9）----------
// 用户实测 ：「[[ 和 (( 出来的菜单遇到了前面斜杠菜单同样的问题：移动页面，双链面板不随页面滚动」，
// 并特意提醒「别又生成让页面浮到格式栏和窗口上面的代码」。两条要一起看：
// ① 位置每帧由块算出（缓存在打开那一刻 → 滚动后停在原地）；② 锚点块滚进头部底下就**不画**
// （浮层是 --z-popover，高于 --z-sticky，跟上去就会浮在格式栏之上）。
// 浮层段自检（）：上一段（AI 运行时）的收官写入可能压过刚种下的 localStorage——
// 本段只种一次时三连复跑在同一处超时（菜单页没进来、叶子数不够）。改成种完自检、不成重种重载
// （同 `reset()` 的自检口径；换来的现象记录见本行背景：同一处 15s 超时三连）。
const seedMenuBlocks = () => page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position) => ({ entityId: id, blockUid: uid, type: 'text', content: [{ t: 'text', v: text }], parent, children: [], position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now })
  const kids = Array.from({ length: 24 }, (_, i) => `m-b${String(i + 1).padStart(2, '0')}`)
  const page1 = { ...mk('menu-page', 'menupage', '菜单跟随测试页', null, 0), isObject: true, objectName: '菜单跟随测试页', children: kids }
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([page1, ...kids.map((id, i) => mk(id, `menub${String(i + 1).padStart(3, '0')}`, `第 ${i + 1} 段内容，用来把页面撑长`, 'menu-page', i))]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
for (let attempt = 1; ; attempt += 1) {
  await seedMenuBlocks()
  await reload()
  await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
  await sleep(900)
  const seeded = await page.evaluate(() => (document.body.textContent ?? '').includes('菜单跟随测试页'))
  if (seeded) break
  if (attempt >= 3) throw new Error('浮层段：连续 3 次没把菜单测试页种进去（上一段的收官写入压种子？）')
  console.log(`浮层段：第 ${attempt} 次种子没站稳，重种`)
}

/** 光标进第 index 个叶子块行尾（斜杠触发词要求块首或空格后，块首要另外按 Home）。 */
const caretIntoLeaf = async (index, home = false) => {
 // 套件稳定性（）：块还没渲染够时读 `leaves[index]` 会拿 undefined、抛
  // 「Cannot read properties of undefined (reading 'scrollIntoView')」——这是负载下的**竞态**，
  // 不是功能坏（07-V3-验收记录里登记过一次）。改成先等到第 index 个叶子块出现再点。
  await page.waitForFunction((i) => {
    const leaves = [...document.querySelectorAll('.editor-content .moqi-block')].filter((b) => b.querySelector('.moqi-block') === null)
    return leaves.length > i
  }, index, { timeout: 15_000 })
  const box = await page.evaluate((i) => {
    const leaves = [...document.querySelectorAll('.editor-content .moqi-block')].filter((b) => b.querySelector('.moqi-block') === null)
    const el = leaves[i]
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }
  }, index)
  await page.mouse.click(box.x, box.y)
  await sleep(250)
  await page.keyboard.press(home ? 'Home' : 'End')
  await sleep(150)
}
/** 菜单与锚点块的距离（菜单顶 − 块底）；`present` 为假表示浮层没画（这正是滚出视口时要的结果）。 */
const menuDelta = (ariaLabel, index) => page.evaluate(([label, i]) => {
  const menu = document.querySelector(`.slash-menu[aria-label="${label}"]`)
  const leaves = [...document.querySelectorAll('.editor-content .moqi-block')].filter((b) => b.querySelector('.moqi-block') === null)
  const block = leaves[i]
  const view = document.querySelector('.doc-col')?.getBoundingClientRect() ?? null
  const rect = block?.getBoundingClientRect() ?? null
  return {
    present: Boolean(menu),
    delta: menu && rect ? Math.round(menu.getBoundingClientRect().top - rect.bottom) : null,
    blockBottom: rect ? Math.round(rect.bottom) : null,
    viewTop: view ? Math.round(view.top) : null,
    menuAboveHeader: menu ? Boolean(view && menu.getBoundingClientRect().top < view.top) : false,
  }
}, [ariaLabel, index])
const scrollDoc = (dy) => page.evaluate((delta) => { const el = document.querySelector('.doc-col'); if (el) el.scrollTop += delta }, dy)

await caretIntoLeaf(2)
await page.keyboard.type('[[')
await sleep(700)
const refFollowBefore = await menuDelta('对象双链', 2)
await scrollDoc(120)
await sleep(500)
const refFollowAfter = await menuDelta('对象双链', 2)
await scrollDoc(900)
await sleep(600)
const refOut = await menuDelta('对象双链', 2)
await page.keyboard.press('Escape')
await sleep(300)
// (( 是同一个组件、另一条触发词：一起测，避免「只修了 [[」
await caretIntoLeaf(6)
await page.keyboard.type('((')
await sleep(700)
const blockFollowBefore = await menuDelta('块双链', 6)
await scrollDoc(120)
await sleep(500)
const blockFollowAfter = await menuDelta('块双链', 6)
check('R09-BEDIT-9 双链菜单（[[ 与 ((）跟着正文滚动：与锚点块的距离恒定，且不越到头部之上',
  refFollowBefore.present && refFollowAfter.present
  && refFollowBefore.delta === 4 && refFollowAfter.delta === 4 && refFollowAfter.menuAboveHeader === false
  && blockFollowBefore.present && blockFollowAfter.present
  && blockFollowBefore.delta === 4 && blockFollowAfter.delta === 4 && blockFollowAfter.menuAboveHeader === false,
  { refFollowBefore, refFollowAfter, blockFollowBefore, blockFollowAfter })
check('R09-BEDIT-9 锚点块滚进头部底下：双链浮层不画（不浮在格式栏 / 窗口栏之上）',
  refOut.present === false,
  refOut)
await page.keyboard.press('Escape')
await sleep(300)

await caretIntoLeaf(4, true)
await page.keyboard.type('/')
await sleep(700)
const slashFollowBefore = await menuDelta('斜杠菜单', 4)
await scrollDoc(120)
await sleep(500)
const slashFollowAfter = await menuDelta('斜杠菜单', 4)
await scrollDoc(900)
await sleep(600)
const slashOut = await menuDelta('斜杠菜单', 4)
check('R09-BEDIT-9 斜杠菜单同一条通路：跟随滚动，滚出正文带即不画',
  slashFollowBefore.present && slashFollowAfter.present
  && slashFollowBefore.delta === 4 && slashFollowAfter.delta === 4
  && slashFollowAfter.menuAboveHeader === false && slashOut.present === false,
  { slashFollowBefore, slashFollowAfter, slashOut })
await page.keyboard.press('Escape')
await sleep(300)

// ---------- 宿主默认右键菜单必须被关掉（docs/09 §三 R09-SHELL-2，用户实测 ）----------
// 桌面外壳里右键弹出「刷新 / 检查 / 另存为」是漏出来的 WebView2 行为。这里用真实右键事件量
// `defaultPrevented`：真机上的系统菜单不在 DOM 里，量它是否被拦是唯一可直接观测的判据。
const rightClickPrevented = async (spot) => {
  await page.evaluate(() => { window.__ctxPrevented = null; document.addEventListener('contextmenu', (event) => { window.__ctxPrevented = event.defaultPrevented }, { once: true }) })
  await page.mouse.click(spot.x, spot.y, { button: 'right' })
  await sleep(300)
  return page.evaluate(() => window.__ctxPrevented)
}
const blockSpot = await page.evaluate(() => {
  const el = document.querySelector('.editor-content .moqi-block')
  const rect = el.getBoundingClientRect()
  return { x: Math.round(rect.left + 60), y: Math.round(rect.top + rect.height / 2) }
})
const sidebarSpot = await page.evaluate(() => {
  const el = document.querySelector('.sb-tags') ?? document.querySelector('.sidebar')
  const rect = el.getBoundingClientRect()
  return { x: Math.round(rect.left + 40), y: Math.round(rect.bottom - 6) }
})
const ctxOnBlock = await rightClickPrevented(blockSpot)
const ctxOnSidebar = await rightClickPrevented(sidebarSpot)
check('R09-SHELL-2 宿主默认右键菜单被关掉：正文与侧栏右键都不弹浏览器菜单',
  ctxOnBlock === true && ctxOnSidebar === true,
  { ctxOnBlock, ctxOnSidebar })

// ---------- 侧栏标签行与它的 ⋯（docs/09 §6.8 R09-TAG-1 / R09-TAG-5）----------
// 用户实测 报「⋯ 神秘消失」：查下来是**没有页面在用标签**，按 R09-TAG-5
// 「无任何页面引用时自动从标签列表消失」整块只剩占位——不是按钮坏了。
// 这条检查把两件事一起看住：有引用 ⇒ 行在、hover 出 ⋯、点开有三项操作；无引用 ⇒ 只有占位。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position, extra) => ({ entityId: id, blockUid: uid, type: 'text', content: [{ t: 'text', v: text }], parent, children: [], position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now, ...extra })
  const tagged = { ...mk('tag-page', 'tagpage1', '带标签的页面', null, 0, {}), isObject: true, objectName: '带标签的页面', children: ['tag-b1'], tags: ['tag-t1'] }
  const plain = { ...mk('plain-page', 'plainpage', '没有标签的页面', null, 1, {}), isObject: true, objectName: '没有标签的页面', children: [] }
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([tagged, plain, mk('tag-b1', 'tagb0001', '正文', 'tag-page', 0, {})]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [{ id: 'tag-t1', name: '测试标签', created: now, modified: now }, { id: 'tag-unused', name: '没人用的标签', created: now, modified: now }] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
const tagRowState = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.sb-tag')].filter((el) => el.querySelector('.tmore'))
  return {
    texts: rows.map((el) => (el.textContent ?? '').trim()),
    hasUnused: (document.querySelector('.sb-tags')?.textContent ?? '').includes('没人用的标签'),
  }
})
const tagRowBox = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.sb-tag')].find((el) => el.querySelector('.tmore'))
  if (!row) return null
  const rect = row.getBoundingClientRect()
  return { x: Math.round(rect.left + 20), y: Math.round(rect.top + rect.height / 2) }
})
let tagMore = null
if (tagRowBox) {
  // 先挪开再挪进来：hover 需要一次「位置真的变了」的移动（同坐标连发不触发）
  await page.mouse.move(tagRowBox.x + 300, tagRowBox.y + 120)
  await sleep(120)
  await page.mouse.move(tagRowBox.x, tagRowBox.y)
  await sleep(500)
  const spot = await page.evaluate(() => {
    const more = [...document.querySelectorAll('.sb-tag')].find((el) => el.querySelector('.tmore'))?.querySelector('.tmore')
    if (!more) return null
    const rect = more.getBoundingClientRect()
    const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2))
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      // 行在 hover 态（判据用 :hover 本身；opacity 有 transition，采样会读到中间值）
      rowHovered: Boolean(document.querySelector('.sb-tag:hover')),
      opacity: getComputedStyle(more).opacity,
      topEl: hit ? hit.tagName + '.' + String(hit.className).slice(0, 30) : null,
      stackAtPointer: document.elementsFromPoint(Math.round(rect.left - 170), Math.round(rect.top + 14)).slice(0, 3).map((el) => el.tagName + '.' + String(el.className).slice(0, 24)),
    }
  })
  if (spot) {
    await page.mouse.click(spot.x, spot.y)
    await sleep(500)
    const menu = await page.evaluate(() => {
      const pop = document.querySelector('.pop')
      return pop ? { label: pop.getAttribute('aria-label'), items: [...pop.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim().split('（')[0]) } : null
    })
    tagMore = { spot, menu }
  }
}
// 判据只取可稳定观测的三条：行只在被引用时出现、行里带 ⋯、点开有三项操作。
// 「⋯ 默认透明、hover 才显形」不在这里断言——无头浏览器不触发 :hover（实测 rowHovered 恒为 false，
// 而指针明明压在行上、栈里也没有遮挡），那条改由 CSS 契约单测看护（tests/ui/tagRow.test.tsx）。
check('R09-TAG-1 侧栏标签行：有页面在用才出行，行里带 ⋯，点开有重命名 / 合并 / 移除三项',
  tagRowState.texts.join('|') === '#测试标签1' && tagRowState.hasUnused === false
  && Boolean(tagMore?.menu)
  && tagMore.menu.label === '#测试标签 标签操作'
  && ['重命名', '合并到…', '从所有页面移除'].every((label) => tagMore.menu.items.includes(label)),
  { tagRowState, tagMore })

// ---------- 列表：回车续项、空项退出、项首 Backspace 退出、序号与标记（docs/09 §五 R09-BLOCK-30/31）----------
// 用户实测 ：「有序和无序列表，回车不能继续列表，只能是新建块」＋「有序列表的数字…有问题」
// （数字的真问题是标记画在 ::after 上、而 ::after 排在块子树之后，带子编号的项读到被子项加过的计数器）。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text2, parent, position, children = []) => ({ entityId: id, blockUid: uid, type, content: [{ t: 'text', v: text2 }], parent, children, position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now })
  const page1 = { ...mk('lv-page', 'lvpage01', 'text', '列表检查', null, 0, ['n1', 'n2', 't1', 'n3', 'u1']), isObject: true, objectName: '列表检查' }
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    page1,
    mk('n1', 'n1n1n1n1', 'numbered', '第一条', 'lv-page', 0),
    mk('n2', 'n2n2n2n2', 'numbered', '第二条', 'lv-page', 1, ['n2x']),
    mk('n2x', 'n2xn2xn2', 'numbered', '第二条的子条', 'n2', 0),
    mk('t1', 't1t1t1t1', 'text', '中间一段普通文字', 'lv-page', 2),
    mk('n3', 'n3n3n3n3', 'numbered', '另一段的第一条', 'lv-page', 3),
    mk('u1', 'u1u1u1u1', 'bullet', '一级', 'lv-page', 4, ['u2']),
    mk('u2', 'u2u2u2u2', 'bullet', '二级', 'u1', 0, ['u3']),
    mk('u3', 'u3u3u3u3', 'bullet', '三级', 'u2', 0, ['u4']),
    mk('u4', 'u4u4u4u4', 'bullet', '四级', 'u3', 0, ['u5']),
    mk('u5', 'u5u5u5u5', 'bullet', '五级', 'u4', 0),
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)

const listLabels = () => page.evaluate(() => [...document.querySelectorAll('.editor-content .moqi-block[data-entity-id]')].map((el) => {
  const after = getComputedStyle(el, '::after')
  const type = el.dataset.blockType
  if (type !== 'numbered' && type !== 'bullet') return null
  return {
    id: el.dataset.entityId,
    type,
    ordinal: el.dataset.ordinal ?? null,
    label: after.content,
    round: after.borderRadius,
    w: after.width,
    h: after.height,
    hollow: after.backgroundColor === 'rgba(0, 0, 0, 0)',
  }
}).filter(Boolean))
const listLabels2 = await listLabels()
const byId = (id) => listLabels2.find((row) => row.id === id)
const levels = ['u1', 'u2', 'u3', 'u4', 'u5'].map(byId)
check('R09-BLOCK-30 编号序号按「同级相邻同类型」分段：普通文字后重新从 1，缩进层也各自从 1 开始',
  byId('n1')?.ordinal === '1' && byId('n2')?.ordinal === '2'
  && byId('n2x')?.ordinal === '1' && byId('n2x')?.label === '"1."'
  && byId('n3')?.ordinal === '1',
  listLabels2)

check('R09-BLOCK-31 无序标记按层级换形：实心圆点 / 空心圆点 / 实心方块 / 空心方块 / 五级起回到实心圆点',
  levels[0]?.round === '99px' && levels[0].hollow === false && levels[0].w === '6px'
  && levels[1]?.round === '99px' && levels[1].hollow === true
  && levels[2]?.round === '1px' && levels[2].hollow === false
  && levels[3]?.round === '1px' && levels[3].hollow === true
  && levels[4]?.round === '99px' && levels[4].hollow === false,
  levels)

// 回车续列表 → 空项回车退出列表 → 项首 Backspace 退出列表
const typeList = () => page.evaluate(() => {
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
  const page1 = blocks.find((b) => b.isObject)
  return page1.children.map((id) => { const b = blocks.find((x) => x.entityId === id); return b.type + ':' + (b.content ?? []).map((f) => f.v).join('').slice(0, 6) })
})
const clickLeaf = async (needle) => {
 // 找不到块不再抛（：负载下一次 `.getBoundingClientRect` of undefined 把整轮崩了）——
  // 轮询等它出现，等不到就返回 false，让当条断言红、后面的条目继续跑。
  const box = await poll(
    () => page.evaluate((t) => {
      const el = [...document.querySelectorAll('.editor-content .moqi-block')].find((b) => (b.textContent ?? '').trim().startsWith(t))
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }
    }, needle),
    (value) => value !== null,
    { timeout: 3000, label: `块「${needle}」出现` },
  )
  if (!box) return false
  await page.mouse.click(box.x, box.y)
  await sleep(250)
  return true
}
// 光标必须落在**行尾**才谈得上「回车续出下一项」。这一步原来靠「点块内 60px 处 + 按 End」，
// 实测会闪（End 偶尔赶不上 → 回车从行中拆开，`numbered:第一` / `numbered:条`，
// 一天里闪了两次）。改成点**行尾那一段空白**（那里没有字，Lexical 会把光标放到行末）再按一次 End 双保险。
const listEndBox = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.editor-content .moqi-block')].find((b) => (b.textContent ?? '').trim().startsWith('第一条'))
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.right - 8), y: Math.round(r.top + r.height / 2) }
})
await page.mouse.click(listEndBox.x, listEndBox.y)
await sleep(300)
await page.keyboard.press('End')
await sleep(150)
await page.keyboard.press('Enter')
await sleep(1300)
const afterContinue = await typeList()
// 续出来的空项就落在「第一条」下一位，类型仍是 numbered
const continueAt = afterContinue.indexOf('numbered:')
const continued = continueAt >= 0 && continueAt === afterContinue.indexOf('numbered:第一条') + 1
await page.keyboard.press('Enter')
await sleep(1300)
const afterExit = await typeList()
check('R04-ENTER-4 列表回车：接着建同类型的空列表项；空项再按一次回车 → 退出列表（变普通文本块）',
  // 同一位上：先续出 numbered 空项，再按一次回车它就地变成 text（退出列表，不新建块）
  continued && afterExit[continueAt] === 'text:' && afterExit.length === afterContinue.length,
  { continueAt, afterContinue, afterExit })

await clickLeaf('另一段的第一条')
await page.keyboard.press('Home')
await sleep(150)
await page.keyboard.press('Backspace')
await sleep(1300)
const afterBackspace = await typeList()
check('R04-ENTER-4 列表项行首 Backspace：先退出列表（变普通块），不把两项并成一个',
  afterBackspace.includes('text:另一段的第一') && !afterBackspace.some((row) => row.startsWith('numbered:') && row.includes('另一段')),
  afterBackspace)

// ── V2b: 页面置顶与星标（`PIN` / `STAR`，docs/11 §3.17 / §3.18）────────────
// 自建自清：造 6 个页面（前 5 个置顶，撑满上限；第 2 个同时星标），
// 验排序 / 上限 / 快捷取消 / 落盘，跑完由下面的 reset 之外的收尾交给进程退出。
await page.evaluate(() => {
  const now = Date.now()
  const pageBlock = (i, pinned, starred) => ({
    entityId: `acc-p${i}`, blockUid: `acc-p${i}-uid`, type: 'text',
    content: [{ t: 'text', v: `验收页 ${i}` }], parent: null, children: [`acc-b${i}`],
    position: i - 1, collapsed: false, checked: false,
    deleted: false, deletedAt: null, prevParent: null, prevIndex: null,
    blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [],
    isObject: true, objectName: `验收页 ${i}`,
    pinned, starred, tags: [], properties: [], aiMeta: null,
    created: now - (20 - i) * 1000, modified: now - (20 - i) * 1000,
  })
  const childBlock = (i) => ({
    entityId: `acc-b${i}`, blockUid: `acc-b${i}-uid`, type: 'text',
    content: [{ t: 'text', v: `验收页 ${i} 的正文` }], parent: `acc-p${i}`, children: [],
    position: 0, collapsed: false, checked: false,
    deleted: false, deletedAt: null, prevParent: null, prevIndex: null,
    blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [],
    isObject: false, objectName: null,
    pinned: false, starred: false, tags: [], properties: [], aiMeta: null,
    created: now, modified: now,
  })
  localStorage.setItem(
    'moqi-project-b:blocks',
    JSON.stringify([1, 2, 3, 4, 5, 6].flatMap((i) => [pageBlock(i, i <= 5, i === 2), childBlock(i)])),
  )
})
await reload()
await page.waitForSelector('.lcard', { timeout: NAV_READY_MS })
await sleep(700)

const cardOrder = await page.$$eval('.lcard', (els) =>
  els.map((el) => el.textContent?.match(/验收页 (\d)/)?.[1] ?? '?'),
)
const pinnedFlag = () => page.evaluate(() =>
  JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
    .filter((b) => b.isObject && b.pinned)
    .map((b) => b.entityId)
    .sort(),
)

check('PIN-ORDER-1 置顶页排在页面库最前，组内保持原顺序',
  cardOrder.length === 6 && cardOrder.join('') === '123456',
  { cardOrder })

// 置顶的可见面：头部时间之前有「已置顶」标记（只排到前面的话看不出置顶区到哪结束）
const pinMarks = await page.$$eval('.lcard .hd .ppin', (els) => els.map((el) => el.textContent?.trim()))
check('PIN-MARK-1 置顶页在卡片头部时间之前显示「已置顶」',
  pinMarks.length === 5 && pinMarks.every((text) => text === '已置顶'),
  { pinMarks })

check('STAR-CARD-1 已星标的卡片头部出现 ★（快捷取消入口，R09-CARD-3）',
  (await page.$$('.pstar')).length === 1,
  { stars: (await page.$$('.pstar')).length })

// 取消星标：点卡片头部的 ★
await page.locator('.pstar').first().click()
await sleep(1500)
const starredAfter = await page.$$('.pstar')
check('STAR-CLEAR-1 点卡片头部 ★ 即取消星标，并且落盘',
  starredAfter.length === 0
    && (await page.evaluate(() =>
      JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => b.starred).length)) === 0,
  { stars: starredAfter.length })

// 上限：已置顶 5 个时，第 6 个的 ⋯ 菜单里「置顶」置灰
await page.locator('.lcard', { hasText: '验收页 6' }).first().locator('.pmore').click()
await sleep(320)
const pin6 = await page.locator('.pop button').first().evaluate((el) => ({
  disabled: el.disabled,
  text: (el.textContent ?? '').replace(/\s+/g, ''),
}))
check('PIN-LIMIT-1 已置顶 5 个时「置顶」置灰并说明上限（界面是第一道防线）',
  pin6.disabled === true && pin6.text.includes('5'),
  pin6)
await page.keyboard.press('Escape')
await sleep(220)

// 取消置顶：动态文案 + 落盘只动这一个
await page.locator('.lcard', { hasText: '验收页 2' }).first().locator('.pmore').click()
await sleep(320)
const cancelLabel = await page.locator('.pop button').first().textContent()
await page.locator('.pop button', { hasText: '取消置顶' }).click()
await sleep(1500)
const pinnedLeft = await pinnedFlag()
check('PIN-CLEAR-1 已置顶的页面菜单文案是「取消置顶」；取消后只动它自己',
  (cancelLabel ?? '').includes('取消置顶') && pinnedLeft.length === 4 && !pinnedLeft.includes('acc-p2'),
  { cancelLabel: (cancelLabel ?? '').replace(/\s+/g, ''), pinnedLeft })

// ── V2b: 回收站的「从本机彻底删除」（`LIFECYCLE-PURGE-*`，docs/03 §14.5 层 2）────
// 自建自清：造 2 个页面（一个带子块）→ 删带子块的那个进回收站 → 彻底删除 →
// 断言整棵子树从库里物理消失、另一个还在。
await page.evaluate(() => {
  const mk = (entityId, name, parent = null, children = []) => ({
    entityId, blockUid: `${entityId}-uid`, type: 'text',
    content: [{ t: 'text', v: name }], parent, children,
    position: 0, collapsed: false, checked: false,
    deleted: false, deletedAt: null, prevParent: null, prevIndex: null,
    blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [],
    isObject: parent === null, objectName: parent === null ? name : null,
    pinned: false, starred: false, tags: [], properties: [], aiMeta: null,
    created: 1000, modified: 1000,
  })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    mk('acc-t1', '待彻底删除', null, ['acc-t1-kid']),
    mk('acc-t1-kid', '它的子块', 'acc-t1'),
    mk('acc-t2', '留着的页面'),
  ]))
})
await reload()
await page.waitForSelector('.lcard', { timeout: NAV_READY_MS })
await sleep(700)
const idsInStore = () => page.evaluate(() =>
  JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').map((b) => b.entityId).sort())

// 卡片 ⋯ → 移至回收站 → 确认
await page.locator('.lcard', { hasText: '待彻底删除' }).first().locator('.pmore').click()
await sleep(300)
await page.locator('.pop button', { hasText: '移至回收站' }).click()
await sleep(320)
await page.locator('button', { hasText: '移入回收站' }).last().click()
await sleep(1400)
const softDeleted = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => b.deleted).map((b) => b.entityId))
check('LIFECYCLE-PURGE-1 层 1：移入回收站是软删除——行还在库里，只是 deleted=1',
  // 整棵子树 = 页面 + 它的子块 = 2 行，都还在库里（物理删除发生在层 2）
  softDeleted.length === 2 && softDeleted.includes('acc-t1') && softDeleted.includes('acc-t1-kid'),
  { softDeleted })

// 侧栏 → 回收站 → 彻底删除 → 确认
await page.locator('button', { hasText: '回收站' }).first().click()
await sleep(600)
await page.locator('button', { hasText: '彻底删除' }).first().click()
await sleep(350)
const purgeDialogText = (await page.locator('.dlg, [role="dialog"]').first().textContent() ?? '').replace(/\s+/g, '')
check('R09-TRASH-6 彻底删除先确认，文案是「从本机彻底删除」并说明跨端含义',
  purgeDialogText.includes('从本机彻底删除') && purgeDialogText.includes('不可恢复') && purgeDialogText.includes('只从这台设备删除'),
  { purgeDialogText: purgeDialogText.slice(0, 120) })

await page.locator('button', { hasText: '彻底删除' }).last().click()
await sleep(1700)
const afterPurge = await idsInStore()
check('LIFECYCLE-PURGE-1 层 2：彻底删除后整棵子树从库里物理消失，没删的页面不受影响',
  !afterPurge.includes('acc-t1') && !afterPurge.includes('acc-t1-kid') && afterPurge.includes('acc-t2'),
  { afterPurge })

// 保留期到期 → 载入时自动从本机彻底删除（`R09-TRASH-3` 的「到期」那一半）
await page.evaluate(() => {
  const long = 40 * 24 * 60 * 60 * 1000
  const mk = (entityId, name, deleted, deletedAt) => ({
    entityId, blockUid: `${entityId}-uid`, type: 'text',
    content: [{ t: 'text', v: name }], parent: null, children: [],
    position: 0, collapsed: false, checked: false,
    deleted, deletedAt, prevParent: null, prevIndex: null,
    blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [],
    isObject: true, objectName: name, pinned: false, starred: false,
    tags: [], properties: [], aiMeta: null,
    created: Date.now() - long, modified: Date.now() - long,
  })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    mk('acc-exp', '早就过期了', true, Date.now() - long),
    mk('acc-live', '还活着的页面', false, null),
  ]))
})
await reload()
await page.waitForSelector('.lcard', { timeout: NAV_READY_MS })
await sleep(1400)
const afterExpiry = await idsInStore()
check('LIFECYCLE-PURGE-4 回收站保留期到期 → 载入时自动从本机彻底删除，没过期的不动',
  !afterExpiry.includes('acc-exp') && afterExpiry.includes('acc-live'),
  { afterExpiry })

// ── V2b: 变更日志的地基（`SYNC-QUEUE-1`，docs/03 §14.2）─────────────────────
// 这一组锁住一件事：**真实编辑之后，变更日志里真的有东西**。
// 此前 `oplog` / `transaction_history` / `device_id` 三样只存在于设计文档里，没有任何代码写它们。
await page.evaluate(() => localStorage.clear())
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
const deviceIdAtStart = await page.evaluate(() => localStorage.getItem('moqi-project-b:device-id'))
check('SYNC-QUEUE-1 设备身份在启动时就定下来（同步的游标与冲突定序按它走）',
  typeof deviceIdAtStart === 'string' && deviceIdAtStart.length > 8,
  { deviceIdAtStart })

await page.locator('.editor-content .moqi-block').first().click()
await sleep(220)
await page.keyboard.type('变更日志地基')
await sleep(2200) // 220ms 镜像 + 600ms 节拍 + 余量
const changeLog = await page.evaluate(() => JSON.parse(localStorage.getItem('moqi-project-b:transactions') ?? '[]'))
const lastChange = changeLog.at(-1)
check('SYNC-QUEUE-1 真实编辑之后变更日志里有事务：带逆操作、设备身份与库里一致',
  changeLog.length > 0
    && lastChange?.deviceId === deviceIdAtStart
    && typeof lastChange?.inverseJson === 'string' && lastChange.inverseJson.length > 2
    && (lastChange?.operations?.length ?? 0) > 0,
  {
    count: changeLog.length,
    deviceIdMatches: lastChange?.deviceId === deviceIdAtStart,
    inverseLength: lastChange?.inverseJson?.length ?? 0,
    operations: lastChange?.operations?.length ?? 0,
  })

// ── V2b: 远端改动要刷新「当前打开着的」编辑器（`SYNC-REFRESH-1`，docs/11 §3.15）──────
// 清单 C 在真实窗口逮到：远端改动进了领域与库、页名也重算了，**正文一动不动**——
// 因为同步的 apply 只做 store.apply + persist，没走 reloadFromStore（所有本地动作都会走）。
// 浏览器通道把共享目录映射到 localStorage：`moqi-sync-dir:<目录>:<设备>` = 该设备那份 jsonl。
await page.evaluate(() => localStorage.clear())
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)

// ① 填同步位置（设置 → 同步位置）；配好就会先走一轮
await page.locator('.sb-foot button', { hasText: '设置' }).click()
await sleep(320)
await page.evaluate(() => { [...document.querySelectorAll('.set-nav button')].find((b) => (b.textContent ?? '').includes('同步'))?.click() })
await sleep(400)
await page.locator('#set-sync-dir').fill('accept-sync-dir')
await sleep(800)

// ② 回编辑器，点进正文写一句（顺带排上「落盘后延后 2 秒」的那一轮同步）
// 设置是居中模态（R09-SET-16）：遮罩挡住侧栏（这是对的）——用 Esc 关弹窗回编辑器，视图本来没离开过。
await page.keyboard.press('Escape')
await sleep(420)
await page.locator('.editor-content .moqi-block').first().click()
await sleep(220)
await page.keyboard.type('本机先写')
// 等「220ms 镜像 + 600ms 节拍」把本机这次编辑写进持久层，否则下面按文本找不到目标块
await sleep(1400)

// ③ 扮演「另一台设备」：往共享目录里追加一条针对当前块的 update（时间戳比本机那次晚）
const remoteText = '远端后来改的'
const injected = await page.evaluate((text) => {
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
  const target = blocks.find((b) => (b.content ?? []).map((f) => f.v).join('').includes('本机先写'))
    ?? blocks.find((b) => b.isObject) // 兜底：种子页的根块
  if (!target) return null
  const line = JSON.stringify({
    deviceId: 'other-device',
    seq: 1,
    opId: 'op-remote-1',
    created: Date.now() + 60000, // 晚于本机刚才那次编辑 → 按「后写者胜」应当被应用
    opJson: JSON.stringify({ type: 'update', opId: 'op-remote-1', blockId: target.entityId, changes: { content: [{ t: 'text', v: text }] } }),
  })
  localStorage.setItem('moqi-sync-dir:accept-sync-dir:other-device', JSON.stringify([line]))
  return target.entityId.slice(0, 6)
}, remoteText)

// ④ 等那一轮同步（落盘后延后 2 秒）+ 余量
await sleep(5000)
const editorTextAfterRemote = await page.locator('.editor-content').innerText()
check('SYNC-REFRESH-1 远端改动要刷新当前打开着的编辑器（不是只在库里变）',
  injected !== null && editorTextAfterRemote.includes(remoteText),
  { injected, editorText: editorTextAfterRemote.replace(/\n+/g, ' | ').slice(0, 120) })

// ── V2b 收口期用户实测的四个界面问题（）──────────────────────────────
// ① 卡片 ⋯ 菜单在页面库滚动时不跟也不收（位置被缓存在打开那一刻）；
// ② 页面列折叠再展开时列表回到开头（滚动位置没有跨卸载保留）；
// ③ 有序 / 无序列表的标记比首行文字高（编号 −5px、圆点 −2px）；
// ④ 快速滚动时 AI 行与块标记上下抖动（`position: fixed` + 视口坐标，合成器滚动不等主线程）。
// ①③④ 是同一族问题的三个面：**位置是派生视图数据**（`R09-BEDIT-9`），不能缓存在打开那一刻。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text2, parent, position, children = [], extra = {}) => ({ entityId: id, blockUid: uid, type, content: [{ t: 'text', v: text2 }], parent, children, position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now, ...extra })
  const page1 = { ...mk('fx-page', 'fxpage01', 'text', '标记与浮层检查', null, 0, ['fx-n1', 'fx-n2', 'fx-u1', 'fx-u2', 'fx-u3']), isObject: true, objectName: '标记与浮层检查' }
  // 另造 14 张卡片：页面库要够长才滚得动（滚动位置与浮层跟随都要有行程）
  const filler = Array.from({ length: 14 }, (_, index) => ({ ...mk(`fx-f${index}`, `fxf${String(index).padStart(5, '0')}`, 'text', `第 ${index + 1} 张卡片`, null, index + 1), isObject: true, objectName: `第 ${index + 1} 张卡片` }))
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    page1, ...filler,
    mk('fx-n1', 'fxn1n1n1', 'numbered', '编号一', 'fx-page', 0),
    mk('fx-n2', 'fxn2n2n2', 'numbered', '编号二', 'fx-page', 1, ['fx-n2x']),
    mk('fx-n2x', 'fxn2xn2x', 'numbered', '编号二的子项', 'fx-n2', 0),
    mk('fx-u1', 'fxu1u1u1', 'bullet', '一级圆点', 'fx-page', 2, ['fx-u2']),
    mk('fx-u2', 'fxu2u2u2', 'bullet', '二级圆点', 'fx-u1', 0, ['fx-u3']),
    mk('fx-u3', 'fxu3u3u3', 'bullet', '三级方块', 'fx-u2', 0),
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)

// ③ 列表标记与首行文字的中线
// 伪元素没有自己的 rect，只能用 computed style 拼边框盒：`border-box` 时 computed height 就是边框盒高；
// `content-box` 时还要加上下边框。盒子中线 = top + 边框盒高 / 2（正文首行中线 = padding-top + 半行高）。
const markerAlignment = await page.evaluate(() => [...document.querySelectorAll('.editor-content .moqi-block[data-entity-id]')]
  .filter((el) => el.dataset.blockType === 'numbered' || el.dataset.blockType === 'bullet')
  .map((el) => {
    const own = getComputedStyle(el)
    const after = getComputedStyle(el, '::after')
    const border = parseFloat(after.borderTopWidth) || 0
    const contentHeight = parseFloat(after.height) || 0
    const borderBoxHeight = after.boxSizing === 'border-box' ? contentHeight : contentHeight + 2 * border
    const firstLineCenter = (parseFloat(own.paddingTop) || 0) + parseFloat(own.lineHeight) / 2
    const markerCenter = (parseFloat(after.top) || 0) + borderBoxHeight / 2
    return { id: el.dataset.entityId, type: el.dataset.blockType, delta: Math.round((markerCenter - firstLineCenter) * 10) / 10 }
  }))
check('R09-BLOCK-31 列表标记与首行文字同一条中线（编号 / 圆点都不许偏高）',
  markerAlignment.length >= 5 && markerAlignment.every((row) => Math.abs(row.delta) <= 0.6),
  { rows: markerAlignment })

// ② 页面列折叠 → 再展开：列表要停在上次的位置
const columnToggle = page.locator('button[aria-label^="页面列表"]')
const columnOpen = async () => (await page.evaluate(() => document.querySelector('.lib-stack') !== null))
if (!(await columnOpen())) { await columnToggle.click(); await sleep(500) } // 先确保列是开的
await page.evaluate(() => { const s = document.querySelector('.lib-stack'); if (s) s.scrollTop = 300 })
await sleep(300)
const scrolledTo = await page.evaluate(() => document.querySelector('.lib-stack')?.scrollTop ?? null)
await columnToggle.click() // 折叠（组件整体卸载）
await sleep(400)
await columnToggle.click() // 再展开
await sleep(600)
const restored = await page.evaluate(() => document.querySelector('.lib-stack')?.scrollTop ?? null)
check('R09-LIB-9 页面列折叠再展开，列表停在上次的位置（滚动位置跨卸载保留）',
  scrolledTo !== null && restored !== null && Math.abs(restored - scrolledTo) <= 4,
  { scrolledTo, restored })

// ① 卡片 ⋯ 菜单的三条关闭路径（用户实测 ：滚动既不收也不跟、点按钮也关不掉）
await page.evaluate(() => { const s = document.querySelector('.lib-stack'); if (s) s.scrollTop = 300 })
await sleep(300)
const menuCardIndex = await page.evaluate(() => {
  const stack = document.querySelector('.lib-stack')
  const band = stack.getBoundingClientRect()
  const middle = (band.top + band.bottom) / 2
  const candidates = [...stack.querySelectorAll('.lcard')]
    .map((card, index) => ({ index, rect: card.querySelector('.pmore')?.getBoundingClientRect() ?? null }))
    .filter(({ rect }) => rect && rect.top > band.top + 30 && rect.bottom < band.bottom - 30)
  if (candidates.length === 0) return -1
  candidates.sort((left, right) => Math.abs(left.rect.top - middle) - Math.abs(right.rect.top - middle))
  return candidates[0].index
})
const cardMenuOpen = () => page.evaluate(() => document.querySelector('.pop[role="menu"]') !== null)
let menuStates = null
if (menuCardIndex >= 0) {
  const pmore = page.locator('.lcard').nth(menuCardIndex).locator('.pmore')
  await pmore.click(); await sleep(400)
  const opened = await cardMenuOpen()
  await pmore.click(); await sleep(400) // 再点触发元素 = 收起
  const closedByTrigger = await cardMenuOpen()
  await pmore.click(); await sleep(400) // 第三次 = 重新打开
  const reopened = await cardMenuOpen()
  await page.evaluate((step) => { const s = document.querySelector('.lib-stack'); if (s) s.scrollTop += step }, 24)
  await sleep(400)
  const closedByScroll = await cardMenuOpen()
  menuStates = { opened, closedByTrigger, reopened, closedByScroll }
}
check('R09-BEDIT-9 卡片 ⋯ 菜单：点开、再点触发元素收起、滚动列表收起（用户预期的三条关闭路径）',
  menuCardIndex >= 0 && menuStates !== null
    && menuStates.opened === true && menuStates.closedByTrigger === false
    && menuStates.reopened === true && menuStates.closedByScroll === false,
  { menuCardIndex, ...(menuStates ?? {}) })
await page.evaluate(() => { const s = document.querySelector('.lib-stack'); if (s) s.scrollTop = 0 })

// ④ 块标记 / AI 行的滚动跟随：**同步读**——滚动一落，标记就要跟着内容走，不能等下一帧
await page.locator('.editor-content .moqi-block').first().click()
await sleep(200)
await page.locator('.editor-content .moqi-block').nth(1).hover()
await sleep(400)
const decorationFollow = await page.evaluate(() => {
  const scroller = document.querySelector('.doc-col')
  const rail = document.querySelector('.block-rail')
  if (!scroller || !rail) return null
  const id = rail.dataset.markerFor
  const block = document.querySelector(`.moqi-block[data-entity-id="${id}"]`)
  if (!block) return null
  const deltaBefore = rail.getBoundingClientRect().top - block.getBoundingClientRect().top
  const was = scroller.scrollTop
  scroller.scrollTop = was + 80
  const deltaAfter = rail.getBoundingClientRect().top - block.getBoundingClientRect().top
  scroller.scrollTop = was
  return { position: getComputedStyle(rail).position, deltaBefore, deltaAfter }
})
check('R09-BEDIT-9 块标记按内容坐标画（`position: absolute`，滚动后相对块的位置同步不变）',
  decorationFollow !== null && decorationFollow.position === 'absolute'
    && Math.abs(decorationFollow.deltaAfter - decorationFollow.deltaBefore) <= 1,
  decorationFollow ?? { reason: 'no rail (hover 没出标记)' })

// ④b 块标记的**水平**落点：把手在最左（−22）、＋ 在最右（−30，落在块内沿）
// —— 实测：坐标转换只换了 top/left，靠右锚定的 ＋ 跑到块右边缘外 522px。
const markerHorizontals = await page.evaluate(() => {
  const scroller = document.querySelector('.doc-col')
  const grab = (kind) => {
    const rail = document.querySelector(`.block-rail[data-marker-kind="${kind}"]`)
    if (!rail) return null
    const block = document.querySelector(`.moqi-block[data-entity-id="${rail.dataset.markerFor}"]`)
    if (!block) return null
    return Math.round(rail.getBoundingClientRect().left - block.getBoundingClientRect().left)
  }
  const grip = document.querySelector('.block-rail[data-marker-kind="handle"]')
  const gripBlock = grip ? document.querySelector(`.moqi-block[data-entity-id="${grip.dataset.markerFor}"]`) : null
  return {
    scrollLeft: scroller?.scrollLeft ?? null,
    handleFromLeft: grab('handle'),
    plusFromRight: (() => {
      const rail = document.querySelector('.block-rail[data-marker-kind="plus"]')
      if (!rail) return null
      const block = document.querySelector(`.moqi-block[data-entity-id="${rail.dataset.markerFor}"]`)
      // 比的是**定位层（rail）的左边缘**：几何是 `left = 块右边缘 − 30`（盒子宽 22，所以右边缘落在块内 8px 处）。
      return block ? Math.round(rail.getBoundingClientRect().left - block.getBoundingClientRect().right) : null
    })(),
    blockWidth: gripBlock ? Math.round(gripBlock.getBoundingClientRect().width) : null,
  }
})
check('R09-BEDIT-9 块标记的水平落点：把手贴块左（−22），＋ 压在块右内沿（−30）',
  markerHorizontals.handleFromLeft !== null && Math.abs(markerHorizontals.handleFromLeft + 22) <= 2
    && markerHorizontals.plusFromRight !== null && Math.abs(markerHorizontals.plusFromRight + 30) <= 2,
  markerHorizontals)

// ②b 编辑器浮层不许跨视图残留（用户实测 ：开着块菜单切到设置，菜单还悬浮在设置页上）
await page.locator('.editor-content .moqi-block').first().click()
await sleep(250)
await page.locator('button[aria-label="更多"]').click() // 编辑器 … 菜单（挂在所有视图之外，视口坐标）
await sleep(400)
const floatOpened = await page.evaluate(() => document.querySelectorAll('.pop[role="menu"]').length)
await page.locator('.sb-foot button', { hasText: '设置' }).click()
await sleep(600)
const floatOnSettings = await page.evaluate(() => ({
  // 设置 0.6 起是居中模态：遮罩挡住侧栏（这是对的），所以用 Esc 关，不能点 .sb-nav。
  modal: Boolean(document.querySelector('.set-dlg')),
  pops: document.querySelectorAll('.pop').length,
}))
await page.keyboard.press('Escape')
await sleep(600)
const floatBackInEditor = await page.evaluate(() => document.querySelectorAll('.pop').length)
check('R09-BEDIT-9 / FLOAT-VIEW-1 编辑器浮层按视图门住：打开设置弹窗（居中模态）时浮层立刻收干净、关掉也不自己冒出来',
  floatOpened === 1 && floatOnSettings.modal === true && floatOnSettings.pops === 0 && floatBackInEditor === 0,
  { floatOpened, floatOnSettings, floatBackInEditor })

// ── 分隔线（ 用户实测：线该在块的中线、分割线该是一整个块；有字的块转过去正文不能留/丢）──
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text, parent, position, children = []) => ({ entityId: id, blockUid: uid, type, content: text ? [{ t: 'text', v: text }] : [], parent, children, position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now })
  const page1 = { ...mk('dv-page', 'dvpage001', 'text', '分隔线检查', null, 0, ['dv-a', 'dv-b', 'dv-c']), isObject: true, objectName: '分隔线检查' }
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    page1,
    mk('dv-a', 'dvaaaaaa1', 'text', '上面一段', 'dv-page', 0),
    mk('dv-b', 'dvbbbbbb1', 'text', '这一块有字要转分隔线', 'dv-page', 1),
    mk('dv-c', 'dvcccccc1', 'divider', '', 'dv-page', 2),
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(800)

// ① 几何：分隔线占一整块（≥38px），线画在块的中线上
const dividerGeometry = await page.evaluate(() => {
  const el = document.querySelector('.editor-content .moqi-block[data-block-type="divider"]')
  if (!el) return null
  const after = getComputedStyle(el, '::after')
  return {
    height: Math.round(el.getBoundingClientRect().height),
    lineTop: after.top,
    lineHeight: after.height,
    lineColor: after.backgroundColor,
    lineWidth: after.width === 'auto' ? null : after.width,
  }
})
// ①b 渲染产物层（`R04-ACCEPT-7` 补层 · 台账 `D-071`~`D-073` 的同一课）：上面读的是 ::after 的**声明值**，
// 线「画出来没有、横跨块宽没有」只有像素知道——块元素截图 → `scripts/lib/png.mjs` 解码 → 逐行找线带。
const dividerRender = await (async () => {
  const el = page.locator('.editor-content .moqi-block[data-block-type="divider"]').first()
  if ((await el.count()) === 0) return null
  const img = decodePng(await el.screenshot())
  const bg = pixelAt(img, 2, 2)
  const rows = []
  for (let y = 0; y < img.height; y += 1) {
    let diff = 0
    for (let x = 0; x < img.width; x += 1) {
      const [r, g, b] = pixelAt(img, x, y)
      if (Math.abs(r - bg[0]) > 12 || Math.abs(g - bg[1]) > 12 || Math.abs(b - bg[2]) > 12) diff += 1
    }
    if (diff > img.width * 0.5) rows.push({ y, wide: diff })
  }
  const band = rows.length > 0 ? { first: rows[0].y, last: rows[rows.length - 1].y, maxWide: Math.max(...rows.map((r) => r.wide)) } : null
  return { w: img.width, h: img.height, lineRows: rows.length, band, center: band ? (band.first + band.last) / 2 : null, midline: img.height / 2 }
})()
check('R09-BLOCK-33 分隔线占一整块且线在中线（不再是 1px 的线）；**渲染产物**：线真画出来、横跨块宽（像素扫）',
  dividerGeometry !== null && dividerGeometry.height >= 38 && dividerGeometry.lineHeight === '1px'
    && Math.abs(parseFloat(dividerGeometry.lineTop) - dividerGeometry.height / 2) <= 1
    && dividerGeometry.lineColor !== 'rgba(0, 0, 0, 0)'
    && dividerRender !== null && dividerRender.lineRows >= 1 && dividerRender.lineRows <= 3 /* 是「线」不是整块填充 */
    && Math.abs(dividerRender.center - dividerRender.midline) <= 2 /* 线在中线（画出来的那一行） */
    && dividerRender.band.maxWide >= dividerRender.w - 4 /* 横跨块宽 */,
  { geometry: dividerGeometry, render: dividerRender ?? { reason: '没有分隔线块' } })

// ② 有字的块 → 分隔线：正文挪到紧随其后的新块（线上不留、编辑器里看得见）
const textBox = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.editor-content .moqi-block')].find((x) => (x.textContent ?? '').includes('这一块有字要转分隔线') && !x.querySelector(':scope > .moqi-block'))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return [Math.round(r.left + 40), Math.round(r.top + r.height / 2)]
})
if (textBox) {
  await page.mouse.click(textBox[0], textBox[1])
  await sleep(300)
  await page.locator('button[aria-label^="块类型"]').click()
  await sleep(400)
  await page.locator('.pop button', { hasText: '分隔线' }).click()
  await sleep(1600)
}
const afterConvert = await page.evaluate(() => ({
  store: JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((x) => !x.deleted).map((x) => ({ id: x.entityId.slice(0, 5), type: x.type, text: (x.content ?? []).map((f) => f.v).join('') })),
  dom: [...document.querySelectorAll('.editor-content .moqi-block')].map((el) => ({ id: (el.dataset.entityId ?? '').slice(0, 5), type: el.dataset.blockType, text: (el.textContent ?? '').trim().slice(0, 12) })),
}))
const converted = afterConvert.store.filter((row) => row.text === '这一块有字要转分隔线')
const dividerNow = afterConvert.store.find((row) => row.id === 'dv-b')
check('TYPE-DIVIDER-1 有字的块转分隔线：正文挪到紧随其后的新块，线上不留正文（也不重复）',
  dividerNow?.type === 'divider' && dividerNow.text === '' && converted.length === 1 && converted[0].id !== 'dv-b'
    && afterConvert.dom.some((row) => row.type === 'divider' && row.id === 'dv-b')
    && afterConvert.dom.some((row) => row.text === '这一块有字要转分隔线' && row.id !== 'dv-b'),
  { dividerNow, converted, dom: afterConvert.dom })

// ---------- 块类型菜单：标题 1 **补回**（ 用户裁决，`W4` G-E03）----------
// `R09-FMT-2` / `R09-EDIT-3`：页面标题 = 容器名字行、**不参与正文级别**——正文 H1–H6 完整可用；
// 菜单（`Aa ▾` / 块菜单「转换为▸」/ 斜杠菜单同源）含「标题 1」。
await page.locator('button[aria-label^="块类型"]').click()
await sleep(400)
const typeMenuLabels = await page.evaluate(() => [...document.querySelectorAll('.pop button')].map((b) => (b.textContent ?? '').replace(/[▸▾]/g, '').trim()))
await page.keyboard.press('Escape')
await sleep(250)
check('R09-FMT-2 块类型菜单含「标题 1」（2026-10-10 裁决：正文 H1–H6 完整可用、页面标题 = 容器名字行）：标题 1–6 与其余类型都在',
  typeMenuLabels.length > 0
    && typeMenuLabels.some((label) => label.includes('标题 1'))
    && ['标题 1', '标题 2', '标题 6', '正文', '引用', '待办', '代码', '无序列表', '有序列表', '分隔线'].every((label) => typeMenuLabels.some((item) => item.includes(label))),
  { typeMenuLabels })

// ③ 老数据自愈：线上带着正文的分隔线，载入时把正文挪到下面
await page.evaluate(() => {
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
  const legacy = blocks.find((b) => b.entityId === 'dv-c')
  if (legacy) legacy.content = [{ t: 'text', v: '老数据留在线上的正文' }]
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify(blocks))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
const healedBlocks = await page.evaluate(() => JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
  .filter((x) => !x.deleted)
  .map((x) => ({ id: x.entityId.slice(0, 5), type: x.type, text: (x.content ?? []).map((f) => f.v).join('') })))
const legacyDivider = healedBlocks.find((row) => row.id === 'dv-c')
check('STORE-HEAL-3 载入自愈：分隔线上的正文挪到紧随其后的新块（旧数据不再卡在线上）',
  legacyDivider?.type === 'divider' && legacyDivider.text === ''
    && healedBlocks.some((row) => row.text === '老数据留在线上的正文' && row.id !== 'dv-c'),
  { legacyDivider, healed: healedBlocks.slice(-4) })

// ── 体检 · 表征测试（，治理第 2~3 周）──────────────────────────────
// 热点 `ui/EditorShell.tsx`（3750 行 / churn 第一）的**对外行为**里，这几处此前没有任何自动化锁住：
// `pnpm accept` 85 项与 269 个单测把"数据面"罩得很密，缺口都在**外壳交互**上。表征测试**只锁现状**
// ——不判对错，只保证"改坏了要红"（治理手册 §3.3：热点模块补齐行为快照，才允许进入还债 / 重构）。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text, parent, position, children = []) => ({ entityId: id, blockUid: uid, type, content: text === null ? [] : [{ t: 'text', v: text }], parent, children, position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now })
  const pageA = { ...mk('sh-a', 'sha000001', 'text', '外壳检查 A', null, 0, ['sh-a1', 'sh-a2', 'sh-a3']), isObject: true, objectName: '外壳检查 A' }
  const pageB = { ...mk('sh-b', 'shb000001', 'text', '外壳检查 B', null, 1, ['sh-b1']), isObject: true, objectName: '外壳检查 B' }
  const refBlock = mk('sh-a2', 'sha200002', 'text', null, 'sh-a', 1)
  refBlock.content = [{ t: 'text', v: '去 ' }, { t: 'inline-ref', v: '[[外壳检查 B]]', ref: { kind: 'object', targetId: 'sh-b' } }]
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    pageA, pageB,
    mk('sh-a1', 'sha100001', 'text', '这一块有苹果', 'sh-a', 0),
    refBlock,
    mk('sh-a3', 'sha300003', 'text', '第二处苹果在这里', 'sh-a', 2),
    mk('sh-b1', 'shb100001', 'text', 'B 页的正文', 'sh-b', 0),
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(800)

// ① ⌘F 页内查找：结构 / 实时计数 / ↵ 循环 / 无结果空态 / Esc 关闭
await page.keyboard.press('Control+f')
await sleep(450)
const findOpened = await page.evaluate(() => {
  const dialog = document.querySelector('.dlg[aria-label="页内查找"]')
  if (!dialog) return null
  return {
    header: (dialog.querySelector('.dlg-h')?.textContent ?? '').replace(/\s+/g, ''),
    input: Boolean(dialog.querySelector('[aria-label="页内查找关键词"]')),
    emptyHint: (dialog.querySelector('.fd-empty')?.textContent ?? '').replace(/\s+/g, '').slice(0, 12),
  }
})
await page.locator('[aria-label="页内查找关键词"]').fill('苹果')
await sleep(450)
const findHits = await page.evaluate(() => ({
  count: (document.querySelector('.fd-cnt')?.textContent ?? '').replace(/\s+/g, ''),
  items: [...document.querySelectorAll('.fd-item')].map((el) => (el.textContent ?? '').replace(/\s+/g, '').slice(0, 12)),
}))
await page.keyboard.press('Enter') // ↵ = 下一处
await sleep(350)
const findCycled = await page.evaluate(() => [...document.querySelectorAll('.fd-item')].findIndex((el) => el.classList.contains('is-active')))
await page.locator('[aria-label="页内查找关键词"]').fill('这个词不存在')
await sleep(450)
const findNoHit = await page.evaluate(() => (document.querySelector('.fd-empty')?.textContent ?? '').replace(/\s+/g, ''))
await page.keyboard.press('Escape')
await sleep(350)
const findClosed = await page.evaluate(() => document.querySelector('.dlg[aria-label="页内查找"]') === null)
check('SHELL-FIND-1 页内查找：⌘F 打开、实时计数、↵ 循环、无结果空态、Esc 关闭（此前无网）',
  findOpened !== null && findOpened.input && findOpened.header.includes('页内查找') && findOpened.emptyHint.includes('输入关键词')
    && findHits.count.includes('2') && findHits.items.length === 2 && findCycled === 1
    && findNoHit.includes('本页没有包含') && findClosed === true,
  { findOpened, findHits, findCycled, findNoHit: findNoHit.slice(0, 40), findClosed })

// ② 专注模式：⌘⇧F 进入（正文之外收起、退出键在）、Esc 退出恢复
await page.keyboard.press('Control+Shift+f')
await sleep(450)
const focusOn = await page.evaluate(() => ({
  flag: document.body.classList.contains('is-focus'),
  sidebar: (() => { const el = document.querySelector('.sidebar'); if (!el) return 'missing'; const style = getComputedStyle(el); return style.opacity === '0' || style.marginLeft.startsWith('-') ? 'hidden' : 'shown' })(),
  exitButton: [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('退出专注')),
}))
await page.keyboard.press('Escape')
await sleep(450)
const focusOff = await page.evaluate(() => ({ flag: document.body.classList.contains('is-focus') }))
check('SHELL-FOCUS-1 专注模式：⌘⇧F 进入（侧栏收起、退出键在）、Esc 退出恢复（此前无网）',
  focusOn.flag === true && focusOn.sidebar === 'hidden' && focusOn.exitButton === true && focusOff.flag === false,
  { focusOn, focusOff })

// ---------- 常驻格式栏已退役（ 减法批）----------
const noFmtbar = await page.evaluate(() => document.querySelector('.fmtbar') === null)
check('R09-FMT-4/7/21 常驻格式栏已退役：界面没有常驻格式栏，行内格式走选中浮条 / 快捷键（此前无网）',
  noFmtbar === true, { noFmtbar })

// ③ 行内引用跨页跳转：切到目标页 + 定位到目标块（闪烁高亮）
const refBox = await page.evaluate(() => {
  const el = document.querySelector('.moqi-inline-ref')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
})
if (refBox) await page.mouse.click(refBox[0], refBox[1])
await sleep(600)
const jumped = await page.evaluate(() => ({
  text: (document.querySelector('.editor-content')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 24),
  flashed: Boolean(document.querySelector('.moqi-block.is-flash')),
}))
check('SHELL-JUMP-1 点行内引用跨页跳转：切到目标页并滚动定位（闪烁高亮）（此前无网）',
  refBox !== null && jumped.text.includes('B 页的正文') && jumped.flashed === true,
  { refBox, jumped })

// ④ 多选与批量（此前无网）：把手单击选中 / ⌘+单击加选 / 飞行条计数 / 批量删除一步撤销
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text, parent, position, children = []) => ({ entityId: id, blockUid: uid, type, content: [{ t: 'text', v: text }], parent, children, position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    { ...mk('ms-page', 'mspage001', 'text', '多选检查', null, 0, ['ms-a', 'ms-b', 'ms-c', 'ms-d']), isObject: true, objectName: '多选检查' },
    mk('ms-a', 'msaaaaaa1', 'text', '第一块', 'ms-page', 0),
    mk('ms-b', 'msbbbbbb1', 'text', '第二块', 'ms-page', 1),
    mk('ms-c', 'mscccccc1', 'text', '第三块', 'ms-page', 2),
    mk('ms-d', 'msdddddd1', 'text', '第四块', 'ms-page', 3),
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(800)
// 把第 index 个正文块 hover 出来，再点它的把手（可带修饰键）。
// 把手按 `data-marker-for` 认领目标块：选中态下别的块的标记仍在 DOM 里，
// 取「文档里第一个 handle」会点到上一次选中的那块（ 实测：第二次点成了取消选中）。
const clickHandle = async (index, modifiers = []) => {
  const box = await page.evaluate((i) => {
    const blocks = [...document.querySelectorAll('.editor-content .moqi-block')].filter((el) => !el.querySelector(':scope > .moqi-block'))
    const el = blocks[i]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { at: [Math.round(r.left + 60), Math.round(r.top + r.height / 2)], id: el.dataset.entityId ?? null }
  }, index)
  if (!box?.id) return false
  await page.mouse.move(box.at[0], box.at[1])
  // 把手是 hover 后才渲染的装饰层：原来等固定 350ms 再读一次，负载下没出来就当没点到
 // （读点加固，）——改成等它出现，出现不了再返回 false。
  const handle = await poll(
    () => page.evaluate((id) => {
      const el = document.querySelector(`.block-rail[data-marker-kind="handle"][data-marker-for="${id}"]`)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
    }, box.id),
    (value) => Array.isArray(value),
    { timeout: 3000, step: 150, label: `第 ${index} 块的把手出现` },
  )
  if (!handle) return false
  for (const key of modifiers) await page.keyboard.down(key)
  await page.mouse.click(handle[0], handle[1])
  for (const key of modifiers) await page.keyboard.up(key)
  await sleep(400)
  return true
}
const flybarState = () => page.evaluate(() => ({
  flybar: document.querySelector('.flybar') !== null,
  count: (document.querySelector('.flybar .fb-count')?.textContent ?? '').replace(/\s+/g, ''),
}))
await clickHandle(0)
const singleSelect = await flybarState()
await clickHandle(2, ['Control'])
const multiSelect = await flybarState()
const selectedClass = await page.evaluate(() => document.querySelectorAll('.moqi-block.is-selected').length)
// 批量删除 → 一步撤销（真值读存档：软删的块留在图里，按 deleted 过滤出「活着的」）
const liveIds = () => page.evaluate(() => JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => !b.deleted).map((b) => b.entityId).sort())
const hasAll = (list, ids) => ids.every((id) => list.includes(id))
await page.locator('.flybar button[aria-label="删除"]').click()
// 多块删除先过确认（ 安全确认批）
await page.locator('.dlg-f button', { hasText: '删除块' }).click()
// 读点轮询（）：删与撤都是异步链，负载下固定窗会读到旧态。
const afterDelete = await poll(liveIds, (ids) => !ids.includes('ms-a') && !ids.includes('ms-c') && ids.includes('ms-b'), { label: '批量删除落库' })
await page.keyboard.press('Control+z')
const afterUndo = await poll(liveIds, (ids) => hasAll(ids, ['ms-a', 'ms-c', 'ms-page']), { label: '⌘Z 一步撤回批量删除' })
check('SHELL-SELECT-1 多选与批量：把手单击选中、⌘+单击加选（飞行条显示「已选 2 块」）、批量删除一步撤销（此前无网）',
  singleSelect.flybar === true && singleSelect.count === '' && multiSelect.count.includes('2') && selectedClass === 2
    && !afterDelete.includes('ms-a') && !afterDelete.includes('ms-c')
    && afterDelete.includes('ms-b') && afterDelete.includes('ms-page')
    && afterUndo.includes('ms-a') && afterUndo.includes('ms-c') && afterUndo.includes('ms-page'),
  { singleSelect, multiSelect, selectedClass, afterDelete, afterUndo })

// ⑤ 范围选择与取消（此前无网）：⇧+单击选一整段 / Esc 清空且不产生事务
await clickHandle(0)
await clickHandle(3, ['Shift'])
const rangeState = await flybarState()
const rangeSelected = await page.evaluate(() => document.querySelectorAll('.moqi-block.is-selected').length)
await page.keyboard.press('Escape')
await sleep(400)
const afterCancel = await page.evaluate(() => ({
  flybar: document.querySelector('.flybar') !== null,
  selected: document.querySelectorAll('.moqi-block.is-selected').length,
}))
// 「取消选择不产生 transaction」的界面判据：Esc 之后紧跟一次 ⌘Z，图必须原地不动
const beforeUndo = await liveIds()
await page.keyboard.press('Control+z')
await sleep(1000)
const afterUndoIdle = await liveIds()
check('SHELL-SELECT-2 范围选择与取消：⇧+单击选一整段（「已选 4 块」）、Esc 清空且不产生事务（此前无网）',
  rangeState.flybar === true && rangeState.count.includes('4') && rangeSelected === 4
    && afterCancel.flybar === false && afterCancel.selected === 0
    && JSON.stringify(afterUndoIdle) === JSON.stringify(beforeUndo),
  { rangeState, rangeSelected, afterCancel, beforeUndo, afterUndoIdle })

// ---------- 块浮动工具栏与块菜单（docs/09 §6.2 R09-BEDIT-1 / R09-BEDIT-5 / R09-BEDIT-10/11）----------
await clickHandle(0)
await sleep(300)
const flybarShape = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('.flybar button')].map((button) => button.getAttribute('aria-label'))
  return { more: labels.includes('更多块操作'), ai: labels.includes('AI 指令'), copy: labels.includes('复制') }
})
await page.evaluate(() => { document.querySelector('.flybar button[aria-label="AI 指令"]')?.click() })
await sleep(250)
const aiMenuShape = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.pop button')]
  return {
    count: items.length,
    disabled: items.filter((button) => button.disabled).length,
    hasLater: items.some((button) => (button.textContent ?? '').includes('后续版本')),
    hasPanel: items.some((button) => (button.textContent ?? '').includes('打开 AI 助手')),
  }
})
await page.keyboard.press('Escape')
await sleep(250)
check('R09-BEDIT-1/5 块浮动工具栏：AI 是六项下拉 + 打开 AI 助手（V2c 已交付全部六项，无禁用项、无「后续版本」标注）；复制已从条上摘出（进块菜单）',
  flybarShape.ai === true && flybarShape.more === true && flybarShape.copy === false
    && aiMenuShape.count === 7 && aiMenuShape.disabled === 0 && aiMenuShape.hasLater === false && aiMenuShape.hasPanel === true,
  { flybarShape, aiMenuShape })

const blockMenuLabels = () => page.evaluate(() => [...document.querySelectorAll('.pop button')].map((button) => (button.textContent ?? '').replace(/[▸▾]/g, '').trim()))
await page.evaluate(() => { document.querySelector('.flybar button[aria-label="更多块操作"]')?.click() })
await sleep(250)
const menuFromDots = await blockMenuLabels()
await page.keyboard.press('Escape')
await sleep(300)
await page.keyboard.press('Escape')
await sleep(300)
const rightClickPoint = await page.evaluate(() => {
  const element = document.querySelector('.moqi-block[data-entity-id]:not([data-block-object="true"])')
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return [Math.round(rect.left + 40), Math.round(rect.top + rect.height / 2)]
})
if (rightClickPoint) await page.mouse.click(rightClickPoint[0], rightClickPoint[1], { button: 'right' })
await sleep(300)
const menuFromRight = await blockMenuLabels()
await page.keyboard.press('Escape')
await sleep(250)
check('R09-BEDIT-10/11 块菜单：`⋯ 更多` 与右键块体打开**同一份清单**（含 转换为 / 复制 / 创建副本 / 复制为块引用 / 剪切 / 删除；块菜单不列「属性」项，「AI ▸」与浮动栏重复 2026-10-08 移除）',
  menuFromDots.length > 0 && JSON.stringify(menuFromDots) === JSON.stringify(menuFromRight)
    && ['复制', '创建副本', '复制为块引用', '剪切', '删除'].every((label) => menuFromDots.some((item) => item.includes(label)))
    && menuFromDots.every((label) => !label.includes('属性')
      && !label.includes('AI')),
  { menuFromDots, menuFromRight })

// ---------- 块上移 / 下移与块选中态删除键（docs/09 §6.2 R09-BEDIT-12、§九 R09-KEY-20/22）----------
const domOrder = () => page.evaluate(() => [...document.querySelectorAll('.editor-content .moqi-block')]
  .filter((el) => !el.querySelector(':scope > .moqi-block'))
  .map((el) => (el.textContent ?? '').trim().slice(0, 4)))
/** 轮询到期望顺序（领域事务 → 镜像 → 重排是异步链，固定 sleep 会读到中间态）。
    超时 5s→10s（）：负载下一次撤回/重排被拖到 5s 之外就误判成「没生效」。 */
const waitOrder = async (expected, timeout = 10_000) => {
  const start = Date.now()
  for (;;) {
    const current = await domOrder()
    if (JSON.stringify(current) === JSON.stringify(expected)) return current
    if (Date.now() - start > timeout) return current
    await sleep(150)
  }
}
await seedAiPage()
await sleep(700)
const orderBefore = await domOrder()
const ORDER_UP = [orderBefore[1], orderBefore[0], orderBefore[2]]
await clickLeaf('第二段')
await page.keyboard.press('Control+Shift+ArrowUp')
const orderAfterUp = await waitOrder(ORDER_UP)
await page.keyboard.press('Control+z')
const orderUndone = await waitOrder(orderBefore)
check('R09-BEDIT-12 / R09-KEY-20 块上移：⌘⇧↑ 与上一块换位（同级内），⌘Z 一步还原',
  orderBefore.length === 3
    && JSON.stringify(orderAfterUp) === JSON.stringify(ORDER_UP)
    && JSON.stringify(orderUndone) === JSON.stringify(orderBefore),
  { orderBefore, orderAfterUp, orderUndone })

await clickLeaf('第一段')
await page.keyboard.press('Control+Shift+ArrowUp')
await sleep(800)
const orderBoundary = await domOrder()
check('R09-BEDIT-12 到边界 no-op：第一块按 ⌘⇧↑ 原地不动（跨层级仍走拖拽 / 缩进）',
  JSON.stringify(orderBoundary) === JSON.stringify(orderBefore),
  { orderBoundary })

await clickHandle(0)
await clickHandle(1, ['Shift'])
await page.keyboard.press('Backspace')
// 多块删除先过确认（ 安全确认批）
await page.locator('.dlg-f button', { hasText: '删除块' }).click()
const orderAfterDelete = await waitOrder([orderBefore[2]])
await page.keyboard.press('Control+z')
const orderRestored = await waitOrder(orderBefore)
check('R09-KEY-22 块选中态 ⌫：删掉选中的 2 块，⌘Z 全部回来',
  JSON.stringify(orderAfterDelete) === JSON.stringify([orderBefore[2]])
    && JSON.stringify(orderRestored) === JSON.stringify(orderBefore),
  { orderAfterDelete, orderRestored })

// ---------- 剪贴板三件（docs/09 §九 R09-KEY-21 / §6.2 R09-BEDIT-10）----------
// 真读系统剪贴板：无头 Edge 里要显式授权（accept 用默认 context，权限也得单独给）。
// 注意：本文件顶部的 `URL` 是目标地址字符串（不是 globalThis.URL），origin 只能自己剪。
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL.replace(/\/+$/, '') })
const readClipboard = () => page.evaluate(async () => {
  try { return await navigator.clipboard.readText() } catch (error) { return `READ-FAIL:${error.message}` }
})

await clickHandle(1)
await page.evaluate(() => { document.querySelector('.flybar button[aria-label="更多块操作"]')?.click() })
// 菜单/剪贴板都是异步链（菜单要先画出来、剪贴板在命令 handler 里写）——读点轮询（）。
const openedRef = await poll(
  () => page.evaluate((text) => {
    const button = [...document.querySelectorAll('.pop button')].find((b) => (b.textContent ?? '').includes(text))
    if (!button) return false
    button.click()
    return true
  }, '复制为块引用'),
  (clicked) => clicked === true,
  { timeout: 3000, label: '块菜单里的「复制为块引用」' },
)
const refClipboard = await poll(readClipboard, (text) => text.startsWith('((') && text.endsWith('))'), { timeout: 5000, label: '剪贴板写进 ((块引用))' })
check('R09-BEDIT-10 / R09-KEY-21 复制为块引用：块菜单写进系统剪贴板的是 ((块名))（不动文档）',
  openedRef && refClipboard.startsWith('((') && refClipboard.endsWith('))') && refClipboard.includes(orderBefore[1].slice(0, 4))
    && JSON.stringify(await domOrder()) === JSON.stringify(orderBefore),
  { openedRef, refClipboard })

// 块选中态直接按 ⌘C（复制不动选区，所以选区还在）→ 剪贴板换成纯文本
await page.keyboard.press('Control+c')
const plainClipboard = await poll(readClipboard, (text) => text.includes('第二段文字'), { timeout: 5000, label: '⌘C 后的剪贴板' })
check('R09-KEY-21 块选中态 ⌘C：剪贴板换成块的正文文本（不带动手稿的 (( )) 包装）',
  plainClipboard.includes('第二段文字') && !plainClipboard.includes('((') && !plainClipboard.includes('[['),
  { plainClipboard })

// 选区还在（⌘C 不清选区）→ ⌘X：同形态文本进剪贴板 + 块从文档删掉 + ⌘Z 一步全回来
await page.keyboard.press('Control+x')
const cutClipboard = await poll(readClipboard, (text) => text.includes('第二段文字'), { timeout: 5000, label: '⌘X 后的剪贴板' })
const orderAfterCut = await waitOrder([orderBefore[0], orderBefore[2]])
await page.keyboard.press('Control+z')
const orderAfterCutUndo = await waitOrder(orderBefore)
check('R09-KEY-21 块选中态 ⌘X：文本进剪贴板、块从文档删掉、⌘Z 一步全回来',
  cutClipboard === plainClipboard
    && JSON.stringify(orderAfterCut) === JSON.stringify([orderBefore[0], orderBefore[2]])
    && JSON.stringify(orderAfterCutUndo) === JSON.stringify(orderBefore),
  { cutClipboard, plainClipboard, orderAfterCut, orderAfterCutUndo })

// ---------- 待办勾选态保留（docs/04 §4 D11）与页面容器守卫（D13 的界面第一道）----------
// D11：勾选态**保留**（数据留、界面无痕、转回即还原）。以前转出 todo 就清零，转换不可逆。
const idsInDoc = () => page.evaluate(() => [...document.querySelectorAll('.editor-content .moqi-block')]
  .filter((el) => !el.querySelector(':scope > .moqi-block')).map((el) => el.dataset.entityId ?? ''))
const storeField = (id, field) => page.evaluate(([blockId, key]) => {
  const block = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').find((b) => b.entityId === blockId)
  return block ? block[key] : null
}, [id, field])
const convertToType = async (label) => {
  await page.locator('button[aria-label^="块类型"]').click()
  await sleep(350)
  await page.locator('.pop button', { hasText: label }).click()
  await sleep(1300)
}
// 复选框按钮是管轨里的内层 `.b-check`（外层 `.block-rail` 只是定位盒，点它不触发）。
const checkMarkerOf = (id) => page.evaluate((blockId) => {
  const el = document.querySelector(`.block-rail[data-marker-kind="check"][data-marker-for="${blockId}"] .b-check`)
  return el ? el.classList.contains('is-checked') : null
}, id)

const idsBeforeTodo = await idsInDoc()
await clickLeaf('第二段')
await convertToType('待办')
const todoId = idsBeforeTodo[1]
/** 轮询 store 字段到期望值（同 `waitOrder` 的既有做法）：负载下「镜像 → 落库」会被拖过固定等待窗
 * （ 实测：591s 的加载轮里这条在 1300ms 窗内读到转换前的值 → 误报一次）。
 *  超时返回最后一次读数——断言照旧，真没收敛还是红，只是不把「慢」误判成「没生效」。 */
const waitField = async (id, field, expected, timeout = 8000) => {
  const start = Date.now()
  for (;;) {
    const value = await storeField(id, field)
    if (value === expected || Date.now() - start > timeout) return value
    await sleep(200)
  }
}
await waitField(todoId, 'type', 'todo')
await page.evaluate((blockId) => { document.querySelector(`.block-rail[data-marker-kind="check"][data-marker-for="${blockId}"] .b-check`)?.click() }, todoId)
await sleep(900)
const checkedAfterTick = await waitField(todoId, 'checked', true)
await convertToType('正文')
const backToText = { checked: await storeField(todoId, 'checked'), type: await waitField(todoId, 'type', 'text'), marker: await checkMarkerOf(todoId) }
await convertToType('待办')
await waitField(todoId, 'type', 'todo')
const restoredTodo = { checked: await storeField(todoId, 'checked'), marker: await checkMarkerOf(todoId) }
check('BLOCK-TYPE-6 / D11 待办勾选态保留：转出待办后复选框消失但勾选留在数据里，转回待办即还原（此前转出即清零）',
  checkedAfterTick === true
    && backToText.type === 'text' && backToText.checked === true && backToText.marker === null
    && restoredTodo.type !== 'text' && restoredTodo.checked === true && restoredTodo.marker === true,
  { checkedAfterTick, backToText, restoredTodo })

// D13 的界面第一道：页面名那一行是页面容器，右键不出块菜单（域层守卫由 test:D13 锁）
// 页面容器那一行的矩形把**所有子块**都包进去，取垂直中点会点到子块——必须取它自己那一行（顶部）。
const containerPoint = await page.evaluate(() => {
  const el = document.querySelector('.moqi-block[data-block-object="true"]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return [Math.round(r.left + 40), Math.round(r.top + 12)]
})
if (containerPoint) await page.mouse.click(containerPoint[0], containerPoint[1], { button: 'right' })
await sleep(300)
const popCountOnContainer = await page.evaluate(() => document.querySelectorAll('.pop').length)
check('BLOCK-TYPE-7 / BLOCK-DRAG-4 / D13 页面容器不给块菜单（界面第一道；域层守卫由 test:BLOCK-TYPE-7 / BLOCK-DRAG-4 锁：转换 / 下移都拒）',
  containerPoint !== null && popCountOnContainer === 0,
  { containerPoint, popCountOnContainer })

// ---------- 下划线（docs/09-桌面端交互规范 §6.10 R09-TXBAR-12 / §九 R09-KEY-24，0.5）----------
// 六件套：两个行内工具栏各多一颗 U，⌘U 与按钮同一个入口，可指向「选中的文字 / 接下来输入的字」，⌘Z 一步撤。
await seedAiPage()
const underlineToolbars = await page.evaluate(() => ({
  toolbar: Boolean(document.querySelector('.txtbar [aria-label="下划线（⌘U）"]')),
}))
// 选中「第二段文字」的前 3 个字 → 点格式栏的 U → 选区上出现 .tx-u
const underlineBox = await page.evaluate(() => {
  const leaves = [...document.querySelectorAll('.editor-content .moqi-block')].filter((b) => b.querySelector('.moqi-block') === null)
  const el = leaves.find((b) => (b.textContent ?? '').startsWith('第二段文字'))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }
})
if (underlineBox) {
  await page.mouse.click(underlineBox.x, underlineBox.y)
  await sleep(300)
  await page.keyboard.press('Home')
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowRight')
  await sleep(400)
}
const textToolbarOn = await page.evaluate(() => Boolean(document.querySelector('.txtbar [aria-label="下划线（⌘U）"]')))
await page.evaluate(() => { document.querySelector('.txtbar [aria-label="下划线（⌘U）"]')?.click() })
// 落盘是 220ms 镜像 + 600ms 拍子：读 store 前等足一拍。
await sleep(1500)
const underlineApplied = await page.evaluate(() => ({
  marked: [...document.querySelectorAll('.editor-content .tx-u')].map((el) => el.textContent),
  pressed: document.querySelector('.txtbar [aria-label="下划线（⌘U）"]')?.getAttribute('aria-pressed') ?? null,
  stored: JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
    .some((b) => (b.content ?? []).some((f) => (f.marks ?? []).some((m) => m.type === 'underline'))),
}))
await page.keyboard.press('Control+z')
await sleep(1200)
const underlineAfterUndo = await page.evaluate(() => ({
  marked: document.querySelectorAll('.editor-content .tx-u').length,
  stored: JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
    .some((b) => (b.content ?? []).some((f) => (f.marks ?? []).some((m) => m.type === 'underline'))),
}))
// ⌘U 同一个入口：再选中一次，用键盘开关
if (underlineBox) {
  await page.mouse.click(underlineBox.x, underlineBox.y)
  await sleep(250)
  await page.keyboard.press('Home')
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowRight')
  await sleep(300)
}
await page.keyboard.press('Control+u')
await sleep(700)
const underlineAfterKey = await page.evaluate(() => [...document.querySelectorAll('.editor-content .tx-u')].map((el) => el.textContent))
// §6.10 的「多出来的格式要能同时看得见」：再加一条删除线，计算样式里两条线都在。
await page.keyboard.press('Control+Shift+s')
await sleep(700)
const underlineCombo = await page.evaluate(() => {
  const el = document.querySelector('.editor-content .tx-u.tx-s')
  return el ? getComputedStyle(el).textDecorationLine.replace(/\s+/g, ' ').trim() : null
})
// 斜杠菜单「行内」组也有它（与格式栏同源：R09-FMT-1 的镜像）
await page.keyboard.press('Escape')
await sleep(300)
await page.keyboard.press('End')
await page.keyboard.type(' /下划')
await sleep(700)
const slashHasUnderline = await page.evaluate(() => [...document.querySelectorAll('.slash-menu-item')].some((el) => (el.textContent ?? '').includes('下划线')))
await page.keyboard.press('Escape')
await sleep(300)
await page.keyboard.press('Backspace')
await sleep(800)
check('R09-TXBAR-12 / R09-KEY-24 下划线：选中浮条有 U、⌘U 与按钮同一入口（选中文字真出 .tx-u 且落进 marks）、⌘Z 一步撤、斜杠「行内」组同源',
  textToolbarOn
    && underlineApplied.marked.join('') === '第二段' && underlineApplied.pressed === 'true' && underlineApplied.stored
    && underlineAfterUndo.marked === 0 && underlineAfterUndo.stored === false
    && underlineAfterKey.join('') === '第二段'
    && underlineCombo === 'underline line-through'
    && slashHasUnderline,
  { underlineToolbars, textToolbarOn, underlineApplied, underlineAfterUndo, underlineAfterKey, underlineCombo, slashHasUnderline })

// ---------- 块引用悬空提示（docs/09 §6.13 R09-DANGLE-1/2）----------
// 删一个被别的块引用的块：删除照常完成（不弹窗），随后 toast 报「N 处引用」；撤销 → 一步回来。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position, extra) => ({
    entityId: id, blockUid: uid, type: 'text', content: [{ t: 'text', v: text }], parent, children: [],
    position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null,
    isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [],
    objectBackRefs: [], aiMeta: null, created: now, modified: now, ...extra,
  })
  const page1 = { ...mk('dg-page', 'dgpage01', '悬空测试页', null, 0), isObject: true, objectName: '悬空测试页', children: ['dg-a', 'dg-b'] }
  const a = mk('dg-a', 'dga00001', '这一块会被引用', 'dg-page', 0)
  const b = mk('dg-b', 'dgb00001', '这里引用了上一块 ', 'dg-page', 1, {
    content: [{ t: 'text', v: '这里引用了上一块 ' }, { t: 'inline-ref', v: '这一块会被引用', ref: { kind: 'block', targetId: 'dg-a' } }],
    blockRefs: [{ targetBlockId: 'dg-a', fromBlockId: 'dg-b', type: 'link' }],
  })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([page1, a, b]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
const dangleHandleClicked = await clickHandle(0)
await page.keyboard.press('Backspace')
// 读点全走轮询（套件稳定性立项，）：删除事务与 toast 都在 220+600ms 节拍之后，
// 负载下固定窗（原 1000ms / 1200ms）会先读到旧态——这项 挂过 148/149 的那一条。
const afterDangleDelete = await poll(
  () => page.evaluate(() => ({
    toast: document.querySelector('.notice')?.textContent ?? null,
    gone: !JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').some((b) => b.entityId === 'dg-a' && !b.deleted),
  })),
  (s) => s.gone === true && s.toast === null,
  { timeout: 8000, label: '删除落盘且不弹提示' },
)
await page.keyboard.press('Control+z')
const afterDangleUndo = await poll(
  () => page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
    return {
      restored: rows.some((b) => b.entityId === 'dg-a' && !b.deleted),
      refIntact: rows.find((b) => b.entityId === 'dg-b')?.blockRefs?.some((r) => r.targetBlockId === 'dg-a') === true,
    }
  }),
  (s) => s.restored === true && s.refIntact === true,
  { timeout: 8000, label: '⌘Z 一步复原（块与引用原样）' },
)
check('REF-DANGLE-1/2 删除被引用的块：照常删掉（不弹提示）；⌘Z 一步回来',
  dangleHandleClicked && afterDangleDelete.gone && afterDangleDelete.toast === null
  && afterDangleUndo.restored && afterDangleUndo.refIntact,
  { dangleHandleClicked, ...afterDangleDelete, ...afterDangleUndo })

// ---------- 链接别名（docs/09 §6.13 R09-ALIAS-1/2/3）----------
// 手打 `[[页面|别名` → 插入的链接显示「别名」（数据仍是 v + targetId）；悬停 500ms 的速览卡多一行
// 「实际指向：<真实页名>」；原生 title = 完整语法。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position, extra) => ({
    entityId: id, blockUid: uid, type: 'text', content: [{ t: 'text', v: text }], parent, children: [],
    position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null,
    isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [],
    objectBackRefs: [], aiMeta: null, created: now, modified: now, ...extra,
  })
  // 别名测试页排第一（应用首屏打开第一页），省掉点卡片那一步。
  const target = { ...mk('al-target', 'altarget1', '目标页面', null, 1), isObject: true, objectName: '目标页面', children: ['al-body'] }
  const body = mk('al-body', 'albody001', '目标页的正文', 'al-target', 0)
  const home = { ...mk('al-home', 'alhome001', '别名测试页', null, 0), isObject: true, objectName: '别名测试页', children: ['al-line'] }
  const line = mk('al-line', 'alline001', '这里引用： ', 'al-home', 0)
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([target, body, home, line]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
const aliasTarget = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.editor-content .moqi-block')].find((b) => (b.textContent ?? '').trim().startsWith('这里引用'))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }
})
if (aliasTarget) {
  await page.mouse.click(aliasTarget.x, aliasTarget.y)
  await sleep(300)
  await page.keyboard.press('End')
  await page.keyboard.type('[[目标页面|那边那页')
  await sleep(600)
  await page.keyboard.press('Enter')
  await sleep(1200)
}
const aliasDom = await page.evaluate(() => {
  const link = document.querySelector('.editor-content [data-ref-target="al-target"]')
  return link ? { text: (link.textContent ?? '').trim(), title: link.getAttribute('title') } : null
})
const aliasStore = await page.evaluate(() => JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
  .find((b) => b.entityId === 'al-line')?.content ?? null)
// 悬停 500ms → 速览卡
let aliasPeek = null
if (aliasDom) {
  const box = await page.evaluate(() => {
    const el = document.querySelector('.editor-content [data-ref-target="al-target"]')
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })
  await page.mouse.move(box.x, box.y)
  await sleep(900)
  aliasPeek = await page.evaluate(() => {
    const card = document.querySelector('.peek')
    if (!card) return null
    return { title: card.querySelector('.pk-t')?.textContent ?? null, alias: card.querySelector('.pk-alias')?.textContent ?? null }
  })
  await page.mouse.move(5, 5)
  await sleep(300)
}
check('REF-ALIAS-1/2/3 链接别名（只做显示）：手打 [[页面|别名 插入后正文显示别名、数据仍是 v + targetId；速览卡多一行「实际指向：目标页面」；title = [[目标页面|那边那页]]',
  aliasDom !== null && aliasDom.text === '那边那页'
    && Array.isArray(aliasStore) && JSON.stringify(aliasStore).includes('那边那页') && JSON.stringify(aliasStore).includes('al-target')
    && aliasPeek !== null && (aliasPeek.alias ?? '').includes('目标页面')
    && aliasDom.title === '[[目标页面|那边那页]]',
  { aliasDom, aliasStore, aliasPeek })

// ---------- 外部链接（docs/09-桌面端交互规范 §6.13 R09-ELINK-1…4）----------
// 种子：一个只有一段正文的页面（首屏页）。三入口开同一个对话框；校验禁用；写入 = 一个 link 片段。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position, extra) => ({
    entityId: id, blockUid: uid, type: 'text', content: [{ t: 'text', v: text }], parent, children: [],
    position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null,
    isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [],
    objectBackRefs: [], aiMeta: null, created: now, modified: now, ...extra,
  })
  const home = { ...mk('el-home', 'elhome01', '链接测试页', null, 0), isObject: true, objectName: '链接测试页', children: ['el-line'] }
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([home, mk('el-line', 'elline01', '去看文档', 'el-home', 0)]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
  localStorage.setItem('moqi-project-b:ui-prefs', JSON.stringify({ slashHintSeen: true }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)

// window.open 打桩：点链接要能看出「调的是系统浏览器（新窗口）」，而不是内嵌。
// 装在 reload **之后**——reload 会清掉页面上的桩。
await page.evaluate(() => {
  window.__opened = []
  window.open = (url, target) => { window.__opened.push([url, target]); return { closed: false, focus() {} } }
})

const elinkDialogOpen = () => page.evaluate(() => Boolean(document.querySelector('.dlg[aria-label="插入外部链接"]')))
const elinkBtnState = () => page.evaluate(() => {
  const button = [...document.querySelectorAll('.dlg-f button')].find((b) => b.textContent === '确定')
  return { disabled: button?.disabled ?? null, note: document.querySelector('.dlg-note')?.textContent ?? null }
})
const elinkClickLine = async (edge = 'end') => {
  const box = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.editor-content .moqi-block')].find((b) => (b.textContent ?? '').startsWith('去看文档'))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }
  })
  if (box) {
    await page.mouse.click(box.x, box.y)
    await sleep(300)
    await page.keyboard.press(edge === 'start' ? 'Home' : 'End')
    await sleep(200)
  }
  return Boolean(box)
}
const elinkClickDialogConfirm = () => page.evaluate(() => {
  const button = [...document.querySelectorAll('.dlg-f button')].find((b) => b.textContent === '确定')
  button?.click()
})

// ① 斜杠菜单「行内 · 外部链接」是**家**（R09-ELINK-1）：干净状态里点开、选中、开对话框。
// 触发位用「块首」——「块首 / 空格后」都是合法触发位，块首不依赖文本尾部有没有空格。
const elinkLineReady = await elinkClickLine('start')
// 打字过滤到一条再回车选中——菜单条目多时最后一条会掉到视口外（点坐标点不到）。
await page.keyboard.type('/外部')
await sleep(700)
const elinkSlashHasLink = await page.evaluate(() => [...document.querySelectorAll('.slash-menu-item')].some((el) => (el.textContent ?? '').includes('外部链接')))
await page.keyboard.press('Enter')
await sleep(900)
const elinkDialogFromSlash = await elinkDialogOpen()
// ② Esc 取消 = 不留痕；再从 ⌘L 开**同一个**对话框（镜像入口），顺便验校验：不合法 → 确定禁用 + 写明原因
await page.keyboard.press('Escape')
await sleep(500)
const elinkStillText = await page.evaluate(() => JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
  .find((b) => b.entityId === 'el-line')?.content.map((f) => f.t).join(',') ?? null)
await elinkClickLine('end')
await page.keyboard.press('Control+l')
await sleep(600)
const elinkDialogFromKey = await elinkDialogOpen()
await page.locator('.dlg .inp').nth(1).fill('example.com')
await sleep(300)
const elinkInvalid = await elinkBtnState()
await page.locator('.dlg .inp').nth(1).fill('https://example.com/docs')
await sleep(300)
const elinkValid = await elinkBtnState()
// ③ 写进去：文字留空 → 地址原文兜底；渲染成 .el + data-url
if (elinkDialogFromKey) await elinkClickDialogConfirm()
await sleep(1300)
const elinkDom = await page.evaluate(() => {
  const el = document.querySelector('.editor-content .el')
  return el ? { text: (el.textContent ?? '').trim(), url: el.dataset.url ?? null } : null
})
const elinkStore = await page.evaluate(() => JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
  .find((b) => b.entityId === 'el-line')?.content ?? null)
check('REF-ELINK-1/2/3 外部链接（斜杠「行内 · 外部链接」是家、⌘L 是镜像，同一对话框）：取消不留痕；地址不合法时确定禁用并写明原因；写入 = 一个 link 片段、正文渲染 .el + data-url',
  elinkLineReady && elinkSlashHasLink && elinkDialogFromSlash && elinkStillText === 'text'
    && elinkDialogFromKey
    && elinkInvalid.disabled === true && (elinkInvalid.note ?? '').length > 0
    && elinkValid.disabled === false
    && elinkDom !== null && elinkDom.url === 'https://example.com/docs' && elinkDom.text === 'https://example.com/docs'
    && Array.isArray(elinkStore) && elinkStore.some((f) => f.t === 'link' && f.url === 'https://example.com/docs'),
  { elinkLineReady, elinkSlashHasLink, elinkDialogFromSlash, elinkStillText, elinkDialogFromKey, elinkInvalid, elinkValid, elinkDom, elinkStore })

// ④ 点击链接 → 调 window.open（不内嵌 webview）；粘贴纯 URL → 当场变链接、⌘Z 一次撤干净
const elinkBox = await page.evaluate(() => {
  const el = document.querySelector('.editor-content .el')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})
if (elinkBox) { await page.mouse.click(elinkBox.x, elinkBox.y); await sleep(600) }
const elinkOpened = await page.evaluate(() => window.__opened ?? [])
await elinkClickLine('end')
await page.evaluate(async () => { await navigator.clipboard.writeText('https://example.org/raw') })
await page.keyboard.press('Control+v')
await sleep(1200)
const elinkPasted = await page.evaluate(() => [...document.querySelectorAll('.editor-content .el')].map((el) => el.dataset.url))
await page.keyboard.press('Control+z')
await sleep(1200)
const elinkUndone = await page.evaluate(() => ({
  links: [...document.querySelectorAll('.editor-content .el')].map((el) => el.dataset.url),
  text: [...document.querySelectorAll('.editor-content .moqi-block')].map((b) => b.textContent ?? '').join('|'),
}))
// [文字](url) 语法文本不转换（R09-ELINK-4 的另一半）
await page.evaluate(async () => { await navigator.clipboard.writeText('[文档](https://example.net/x)') })
await page.keyboard.press('Control+v')
await sleep(1200)
const elinkSyntax = await page.evaluate(() => ({
  links: [...document.querySelectorAll('.editor-content .el')].map((el) => el.dataset.url),
  text: [...document.querySelectorAll('.editor-content .moqi-block')].map((b) => b.textContent ?? '').join('|'),
}))
check('REF-ELINK-3/4 点击外部链接调 window.open（不内嵌）；粘贴纯 URL 当场变链接、⌘Z 一次撤干净（不留半截地址）；[文字](url) 语法文本按普通文本进来',
  elinkOpened.length === 1 && elinkOpened[0][0] === 'https://example.com/docs'
    && elinkPasted.includes('https://example.org/raw')
    && !elinkUndone.links.includes('https://example.org/raw') && !elinkUndone.text.includes('https://example.org/raw')
    && elinkSyntax.links.length === 1 && elinkSyntax.text.includes('[文档](https://example.net/x)'),
  { elinkOpened, elinkPasted, elinkUndone, elinkSyntax })

// 清场：Esc 两下 + 断言没有任何浮层留下（后面的检查要点真实鼠标，遮罩会挡掉）。
await page.keyboard.press('Escape')
await sleep(300)
await page.keyboard.press('Escape')
await sleep(400)
const elinkClean = await page.evaluate(() => ({
  dialog: document.querySelectorAll('.dlg').length,
  slash: document.querySelectorAll('.slash-menu').length,
}))
check('REF-ELINK 收尾清场：跑完这条检查不留对话框 / 斜杠菜单（浮层遮罩会挡掉后面的真实点击）',
  elinkClean.dialog === 0 && elinkClean.slash === 0, elinkClean)

// ---------- 一次性提示已退役（ 零提示批）----------
const toastText = () => page.evaluate(() => document.querySelector('.notice')?.textContent ?? null)
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
const hintToast = await toastText()
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
const hintToastSecondRun = await toastText()
check('R09-FMT-7 一次性提示已退役：有内容的首开也不弹提示（R09-STATE-5 零提示）',
  hintToast === null && hintToastSecondRun === null,
  { hintToast, hintToastSecondRun })

// ---------- Esc 逐层退出（docs/09 §九 R09-KEY-13）----------
// 顺序是规则：浮层（菜单 / 弹窗自己接）→ 侧栏面板（AI → 引用 → 属性 → 摘要）→ 选区 → 专注模式。
// 规则本体在 `src/ui/useOverlays.ts` 的 `escapeTarget`（有单测）；这里锁**界面路径**。
await seedAiPage()
await clickHandle(0)
const escSelectionFirst = await flybarState()
await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') ?? '').includes('AI 助手'))
  if (button) button.click()
})
await sleep(700)
const escPanelOpen = await page.evaluate(() => Boolean(document.querySelector('.side-panel.aip.is-open')))
const escRead = () => page.evaluate(() => ({
  panel: Boolean(document.querySelector('.side-panel.aip.is-open')),
  flybar: Boolean(document.querySelector('.flybar')),
  selected: document.querySelectorAll('.moqi-block.is-selected').length,
  focus: document.body.classList.contains('is-focus'),
}))
await page.keyboard.press('Escape')
await sleep(450)
const escAfterPanel = await escRead()
await page.keyboard.press('Escape')
await sleep(450)
const escAfterSelection = await escRead()
await page.keyboard.press('Escape')
await sleep(350)
const escAfterNothing = await escRead()
check('R09-KEY-13 Esc 逐层退出（面板 → 选区 → 无事）：先关 AI 助手面板（选区留着），再清选区，第三下不再动别的（此前无网）',
  escSelectionFirst.flybar === true && escPanelOpen === true
  && escAfterPanel.panel === false && escAfterPanel.flybar === true
  && escAfterSelection.flybar === false && escAfterSelection.selected === 0
  && escAfterNothing.selected === 0 && escAfterNothing.focus === false,
  { escSelectionFirst, escPanelOpen, escAfterPanel, escAfterSelection, escAfterNothing })

// 专注模式下侧栏与面板不可见：不能由它们消费 Esc ⇒ 先清选区、再退专注
await seedAiPage()
await clickHandle(0)
await page.keyboard.press('Control+Shift+f')
await sleep(500)
const focusWithSelection = await escRead()
await page.keyboard.press('Escape')
await sleep(450)
const focusAfterSelection = await escRead()
await page.keyboard.press('Escape')
await sleep(450)
const focusAfterExit = await escRead()
check('R09-KEY-13 专注模式下的顺序：Esc 先清选区（专注还在），再退专注模式（此前无网）',
  focusWithSelection.focus === true && focusWithSelection.flybar === true
  && focusAfterSelection.focus === true && focusAfterSelection.flybar === false
  && focusAfterExit.focus === false,
  { focusWithSelection, focusAfterSelection, focusAfterExit })

// 弹窗是模态的：它不会跨视图残留，判据是**遮罩接管了外边那一下**——
// 打开 ⌘/ 速查后点侧栏「设置」：第一下只关弹窗（点击落在遮罩上）、视图不动，第二下才切过去。
// （ 实测确认；同族的菜单残留是另一回事：菜单不挡别处，必须由「离开编辑器就清掉」收拾。）
await seedAiPage()
await page.keyboard.press('Control+/')
await sleep(600)
const dialogOpenBeforeSwitch = await page.evaluate(() => document.querySelectorAll('.dlg[role="dialog"]').length)
const settingsSpot = await page.evaluate(() => {
  const button = [...document.querySelectorAll('.sb-foot button')].find((b) => (b.textContent ?? '').includes('设置'))
  if (!button) return null
  const rect = button.getBoundingClientRect()
  const x = Math.round(rect.left + rect.width / 2)
  const y = Math.round(rect.top + rect.height / 2)
  return { x, y, onTop: document.elementFromPoint(x, y)?.className ?? null }
})
await page.mouse.click(settingsSpot.x, settingsSpot.y)
await sleep(800)
const afterFirstClick = await page.evaluate(() => ({
  dialogs: document.querySelectorAll('.dlg[role="dialog"]').length,
  view: [...document.querySelectorAll('section')].find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })?.getAttribute('aria-label') ?? null,
}))
await page.mouse.click(settingsSpot.x, settingsSpot.y)
await sleep(800)
const afterSecondClick = await page.evaluate(() => ({
  // 第二下打开的是设置**弹窗**（居中模态）：view 仍是编辑器——模态不改视图。
  modal: Boolean(document.querySelector('.set-dlg')),
  view: [...document.querySelectorAll('section')].find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })?.getAttribute('aria-label') ?? null,
}))
await page.keyboard.press('Escape')
await sleep(600)
check('R09-BEDIT-9 弹窗遮罩接管外边那一下：⌘/ 速查打开时点侧栏「设置」→ 先关弹窗、视图不动，再点才切过去（⇒ 弹窗不会跨视图残留）',
  dialogOpenBeforeSwitch === 1 && (settingsSpot?.onTop ?? '').includes('mask')
  && afterFirstClick.dialogs === 0 && afterFirstClick.view === '编辑器' && afterSecondClick.modal === true && afterSecondClick.view === '编辑器',
  { dialogOpenBeforeSwitch, settingsSpot, afterFirstClick, afterSecondClick })

// ---------- V2c：有来源问答（docs/11 的问答行；范围 = 检索命中的 Block，答案里点得回来源）----------
// 走的是真 AI 通路：复用上面那个本机 SSE stub（够不到端点时块也会先落地，但这一条要**真的回答**）。
aiStub.mode = 'stream'
await seedAiPage(aiStubUrl)
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position) => ({ entityId: id, blockUid: uid, type: 'text', content: [{ t: 'text', v: text }], parent, children: [], position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now, pinned: false, starred: false })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    { ...mk('qa-page', 'qapage01', '问答测试页', null, 0), isObject: true, objectName: '问答测试页', children: ['qa-b1', 'qa-b2', 'qa-b3'] },
    mk('qa-b1', 'qab10001', '第一段：双链笔记的用法', 'qa-page', 0),
    mk('qa-b2', 'qab20002', '第二段：双链要注意什么', 'qa-page', 1),
    mk('qa-b3', 'qab30003', '第三段：无关内容', 'qa-page', 2),
  ]))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
// ⌘K 搜「双链」→ 两个块命中 → 「就这些问 AI」把这次命中当范围
await page.keyboard.press('Control+k')
await sleep(450)
await page.locator('[aria-label="搜索关键词"]').fill('双链')
await sleep(700)
const askHitCount = await page.evaluate(() => document.querySelectorAll('.sr-row').length)
const askButtonState = await page.evaluate(() => {
  const button = document.querySelector('.sr-ask')
  return button ? { text: (button.textContent ?? '').trim(), disabled: button.disabled } : null
})
await page.locator('.sr-ask').click()
await sleep(700)
const scopePanel = await page.evaluate(() => ({
  searchClosed: document.querySelector('.dlg[aria-label="全局搜索"]') === null,
  panelOpen: Boolean(document.querySelector('.side-panel.aip.is-open')),
  modeText: (document.querySelector('.aip-inbar .mode')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  // D-016①：头部不再说「基于本篇」，它说的是**存入哪**
  destinationText: (document.querySelector('.aip-dest .ctx')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
}))
await page.locator('[aria-label="向 AI 提问"]').fill('这两段说了什么')
await page.keyboard.press('Enter')
const qaAnswer = await (async () => {
  const until = Date.now() + 10000
  for (;;) {
    const state = await page.evaluate(() => {
      const message = document.querySelector('.aip-msg.is-ai')
      if (!message) return null
      return {
        head: (message.textContent ?? '').replace(/s+/g, ' ').slice(0, 70),
        text: (message.querySelector('.bub')?.textContent ?? '').replace(/s+/g, ' ').trim(),
        chips: [...message.querySelectorAll('.aip-src-chip')].map((el) => (el.textContent ?? '').trim()),
      }
    })
    // 等**正文写完**再取值：chips 在回答一开始就在（回答对象带着 sourceIds 先创建），拿它当完成判据
  // 会取到半截文本（ 实测：等到「这是一段」就往下跑了——时序不稳，不是功能坏）。
    if (state && state.text === AI_CHUNKS.join('') && state.chips.length > 0) return state
    if (Date.now() > until) return state
    await sleep(300)
  }
})()
// D-016②：跨页提问的落点**默认「新建一页」**，按钮上写着落点；点它 → 建页与结果同一事务，
// 并且把用户带到那一页（否则结果落在别处，看不见）。页名取问句前 12 字（`aiAnswerPageName`）。
const insertSpot = await page.evaluate(() => {
  const card = document.querySelector('.aip-msg.is-ai')
  const button = [...(card?.querySelectorAll('.acts button') ?? [])].find((el) => (el.textContent ?? '').includes(' ↘'))
  return button ? { text: (button.textContent ?? '').trim() } : null
})
await page.locator('.aip-msg.is-ai .acts button').first().click()
await sleep(1400)
const landedInNewPage = await page.evaluate(() => {
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => !b.deleted)
  const page = blocks.find((b) => b.isObject && (b.objectName ?? '').startsWith('问 AI：'))
  const answer = page ? blocks.find((b) => b.parent === page.entityId) : null
  return {
    insertButtonText: null,
    newPageName: page?.objectName ?? null,
    answerInside: answer ? (answer.content ?? []).map((f) => f.v).join('') : null,
    editorShowsNewPage: (document.querySelector('.view.is-on .moqi-block')?.textContent ?? '').includes('问 AI：'),
    // 打开一页按既有语义会收起右侧面板（`openPage`）——存成新页 = 把用户带到那一页，面板随之收起
    panelClosedAfterJump: document.querySelector('.side-panel.aip.is-open') === null,
    sourceLabelKept: answer?.aiMeta?.sourceBlockIds?.length ?? 0,
  }
})
// 重开面板：这一场对话还在（回答与来源 chip 都留着）——顺便给下面的 chip 跳转备好条件
await page.locator('.topbar [aria-label="AI 助手"]').click()
await sleep(700)
const conversationKept = await page.evaluate(() => ({
  panelOpen: Boolean(document.querySelector('.side-panel.aip.is-open')),
  answers: document.querySelectorAll('.aip-msg.is-ai').length,
  chips: document.querySelectorAll('.aip-src-chip').length,
}))
// 点来源 chip → 跳到那一块（面板收起 + 闪烁）
await page.locator('.aip-src-chip').first().click()
await sleep(800)
const sourceJump = await page.evaluate(() => ({
  panelClosed: document.querySelector('.side-panel.aip.is-open') === null,
  flashed: Boolean(document.querySelector('.moqi-block.is-flash')),
}))
check('SEARCH-QA-1 有来源问答：⌘K 命中的块当范围（面板写明范围与落点）、答案的来源 chips 就是那几块、点 chip 跳回原文、落点默认「新建一页」并落到那一页（此前无网）',
  askHitCount === 2 && askButtonState !== null && askButtonState.disabled === false
  && scopePanel.searchClosed === true && scopePanel.panelOpen === true && scopePanel.modeText.includes('检索命中的 2 块')
  && scopePanel.destinationText.includes('存入：新建一页')
  && qaAnswer !== null && qaAnswer.head.includes('检索命中的 2 块') && qaAnswer.text === AI_CHUNKS.join('')
  && qaAnswer.chips.length === 2 && qaAnswer.chips.every((label) => label.includes('双链'))
  && insertSpot !== null && insertSpot.text === '存成新页 ↘'
  && landedInNewPage.newPageName === '问 AI：这两段说了什么'
  && landedInNewPage.answerInside === AI_CHUNKS.join('') && landedInNewPage.editorShowsNewPage === true
  && landedInNewPage.panelClosedAfterJump === true && landedInNewPage.sourceLabelKept === 2
  && conversationKept.panelOpen === true && conversationKept.answers === 1 && conversationKept.chips === 2
  && sourceJump.panelClosed === true && sourceJump.flashed === true,
  { askHitCount, askButtonState, scopePanel, qaAnswer, insertSpot, landedInNewPage, conversationKept, sourceJump })

// ---------- 状态门：保存态 / 同步态的转换（docs/09 R09-SYNC-1…5；还债 #4b）----------
// 转换由真实事件驱动（打字 → 落盘成功 / 失败；配了位置 → 走一轮同步），所以只在这里锁得住。
const saveStateNow = () => page.evaluate(() => ({
  st: document.querySelector('.tb-save')?.getAttribute('data-st') ?? null,
  text: document.querySelector('.tb-save')?.textContent ?? null,
  toast: document.querySelector('.notice')?.textContent ?? null,
}))

// ① 保存态：打字之后**真的落盘了**，顶栏稳定在「已保存 · 刚刚」
// 注意中转态：浏览器通道的写是同步 localStorage（微任务就回），`saving` 与 `saved` 会被 React
// 合并进同一次提交——界面上**看不到**「保存中…」。真机通道写库要过 IPC，那个值才看得见
// （ 实测：rAF 逐帧采样 + 子树 MutationObserver 都只录到 `saved`）。
// 所以这一条锁的是**终态与「内容确实进了存档」**；中转值由 `STATE-SAVE-2` 的失败路径侧证（它先过 saving）。
await seedAiPage()
await page.evaluate(() => {
  window.__saveStates = []
  const read = () => document.querySelector('.tb-save')?.getAttribute('data-st') ?? null
  const record = () => { const st = read(); if (window.__saveStates[window.__saveStates.length - 1] !== st) window.__saveStates.push(st) }
  record()
  const host = document.querySelector('.tb-save')?.parentElement ?? document.body
  new MutationObserver(record).observe(host, { attributes: true, subtree: true, attributeFilter: ['data-st'], childList: true, characterData: true })
  const tick = () => { record(); requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
})
const savedProbeText = '保存态转换检查'
await page.locator('.editor-content .moqi-block').first().click()
await sleep(200)
await page.keyboard.type(savedProbeText)
const savedAfter = await (async () => {
  const until = Date.now() + 8000
  for (;;) {
    const persisted = await page.evaluate((needle) => {
      const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
      return blocks.some((b) => (b.content ?? []).map((f) => f.v ?? '').join('').includes(needle))
    }, savedProbeText)
    const state = await saveStateNow()
    if (persisted) return { ...state, persisted }
    if (Date.now() > until) return { ...state, persisted }
    await sleep(250)
  }
})()
const saveSequence = await page.evaluate(() => window.__saveStates ?? [])
check('STATE-SAVE-1 保存态：打字之后内容真的进了存档，正常态不显示保存文案（此前无网）',
  savedAfter.persisted === true && savedAfter.st === null && savedAfter.text === null,
  { saveSequence, savedAfter })

// ② 保存中 → 保存失败：落盘抛错时必须显性提示（否则界面一直说「已保存」，而内容只在内存里）
await page.addInitScript(() => {
  // 开关由本轮用例控制；只让 `:blocks` 这一个键写失败，其余（种子、元数据）照常。
  const original = Storage.prototype.setItem
  Storage.prototype.setItem = function (key, value) {
    if (window.__moqiFailBlockSave === true && String(key).includes(':blocks')) throw new Error('磁盘满了')
    return original.call(this, key, value)
  }
})
await seedAiPage()
await page.evaluate(() => { window.__moqiFailBlockSave = true })
await page.locator('.editor-content .moqi-block').first().click()
await sleep(200)
await page.keyboard.type('保存失败检查')
const saveErrorState = await (async () => {
  const until = Date.now() + 9000
  for (;;) {
    const state = await saveStateNow()
    if (state.st === 'error' && (state.toast ?? '').includes('保存失败')) return state
    if (Date.now() > until) return state
    await sleep(250)
  }
})()
await page.evaluate(() => { window.__moqiFailBlockSave = false })
check('STATE-SAVE-2 保存失败：顶栏转「保存失败」并弹一条显性 toast（不许界面继续显示已保存）（此前无网）',
  saveErrorState.st === 'error' && (saveErrorState.toast ?? '').includes('保存失败：磁盘满了'),
  { saveErrorState })

// ③ 同步态：未配置 → 配好位置走一轮 → 已同步（`R09-SYNC-5` / `R09-SYNC-2`）
// 读的是**侧栏那条同步行**（`09-桌面端UI规范` §5：同步是应用级管道状态，主面就是侧栏底部），
// 设置页与它复用同一份文案（`syncPresentation`）。同步位置跟着库走（`:sync` 键），
// 前面的同步用例会把它配好——所以这里先清掉，才看得到「未配置」那一态。
await seedAiPage()
await page.evaluate(() => { localStorage.removeItem('moqi-project-b:sync') })
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
const syncUnconfigured = await page.evaluate(() => document.querySelector('.sb-sync .stxt')?.textContent ?? null)
await page.locator('.sb-foot button', { hasText: '设置' }).click()
await sleep(700)
await page.evaluate(() => { [...document.querySelectorAll('.set-nav button')].find((b) => (b.textContent ?? '').includes('同步'))?.click() })
await sleep(400)
await page.locator('#set-sync-dir').fill('C:/moqi-accept-sync')
const syncAfterRound = await (async () => {
  const until = Date.now() + 9000
  for (;;) {
    const text = await page.evaluate(() => document.querySelector('[data-sync-status]')?.getAttribute('data-sync-status') ?? null)
    if ((text ?? '').includes('已同步')) return text
    if (Date.now() > until) return text
    await sleep(250)
  }
})()
// 设置是居中模态（R09-SET-16）：遮罩挡住侧栏（这是对的）——用 Esc 关弹窗回编辑器，视图本来没离开过。
await page.keyboard.press('Escape')
await sleep(500)
check('STATE-SYNC-1 同步态：未配置时侧栏不显示；设置页走一轮后显示「已同步」（此前无网）',
  syncUnconfigured === null && (syncAfterRound ?? '').includes('已同步'),
  { syncUnconfigured, syncAfterRound })

// ---------- V2c：索引状态可见（docs/09 §6.3 R09-SEARCH-6 / §4.6 R09-SET-13）----------
// 「降级要看得见」：设置里说清用的是什么引擎、索引了多少块、上次整份重建是什么时候、失败几条。
await seedAiPage()
await page.locator('.sb-foot button', { hasText: '设置' }).click()
await sleep(800)
await page.evaluate(() => { [...document.querySelectorAll('.set-nav button')].find((b) => (b.textContent ?? '').includes('搜索'))?.click() })
await sleep(400)
const indexCard = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.set-card')].find((el) => (el.querySelector('h3')?.textContent ?? '').includes('搜索'))
  if (!card) return null
  const rows = [...card.querySelectorAll('.frow')].map((row) => ({
    label: row.querySelector('label')?.textContent ?? '',
    value: (row.querySelector('.note')?.textContent ?? '').replace(/\s+/g, ''),
  }))
  return { hint: (card.querySelector('.hint')?.textContent ?? '').replace(/\s+/g, '').slice(0, 40), rows }
})
// 设置是居中模态（R09-SET-16）：遮罩挡住侧栏（这是对的）——用 Esc 关弹窗回编辑器，视图本来没离开过。
await page.keyboard.press('Escape')
await sleep(500)
check('R09-SEARCH-6 / R09-SET-13 设置里的搜索状态：索引规模 / 上次重建 / 拼音覆盖；浏览器通道如实说「没有索引」，正常态不显示写入失败行（此前无网）',
  indexCard !== null
  && indexCard.rows.some((row) => row.label === '索引规模' && /^\d+块$/.test(row.value))
  && indexCard.rows.some((row) => row.label === '上次重建' && row.value.includes('不适用') && row.value.includes('没有索引'))
  && indexCard.rows.some((row) => row.label === '拼音覆盖' && row.value.includes('没有索引'))
  && !indexCard.rows.some((row) => row.label === '写入失败'),
  { indexCard })

// ---------- V2c：双链建议 · 规则版（docs/09 §6.2 R09-BEDIT-5b；11 SUGGEST-RULE-1 / SUGGEST-ACCEPT-1）----------
// 判据在 domain/suggest.ts（5 条单测）；这里锁**界面路径**：候选菜单底部出「建议」组、
// 每条只带一个理由、接受才写 ref、关掉不产生任何 operation。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position, extra = {}) => ({ entityId: id, blockUid: uid, type: 'text', content: text ? [{ t: 'text', v: text }] : [], parent, children: [], position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now, pinned: false, starred: false, ...extra })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    { ...mk('sg-me', 'sgme0001', '', null, 0, { isObject: true, objectName: '建议测试页', children: ['sg-m1', 'sg-m2'], tags: ['sg-t1'], objectRefs: ['sg-route'] }), content: [] },
    mk('sg-m1', 'sgm10001', '第一段：这里先按 Esc', 'sg-me', 0),
    mk('sg-m2', 'sgm20002', '第二段：这里接受一条建议', 'sg-me', 1),
    { ...mk('sg-back', 'sgback01', '', null, 1, { isObject: true, objectName: '引用过本篇的页面', children: [] }), content: [] },
    { ...mk('sg-back-b1', 'sgbk0001', '见 [[建议测试页]]', 'sg-back', 0, { objectRefs: ['sg-me'] }), content: [{ t: 'text', v: '见 [[建议测试页]]' }] },
    { ...mk('sg-tag', 'sgtag001', '', null, 2, { isObject: true, objectName: '同标签页', children: [], tags: ['sg-t1'] }), content: [] },
    { ...mk('sg-route', 'sgroute1', '', null, 3, { isObject: true, objectName: '产品路线', children: [] }), content: [] },
    { ...mk('sg-same', 'sgsame01', '', null, 4, { isObject: true, objectName: '同源页', children: [], objectRefs: ['sg-route'] }), content: [] },
    { ...mk('sg-dead', 'sgdead01', '', null, 5, { isObject: true, objectName: '回收站里的同标签页', children: [], tags: ['sg-t1'], deleted: true, deletedAt: now }), content: [] },
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [{ id: 'sg-t1', name: '工作', color: null, created: now, modified: now }] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
const suggestRefsOn = () => page.evaluate(() => JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => (b.objectRefs ?? []).includes('sg-back')).map((b) => b.entityId))
const suggestRefsBefore = await suggestRefsOn()
const openSuggestionMenu = async (needle) => {
  const box = await page.evaluate((text) => {
    // 只认**最内层**块：页面容器块的 textContent 含整页文字，先匹配到它就会点错块（实测踩过）
    const el = [...document.querySelectorAll('.editor-content .moqi-block')]
      .filter((b) => b.querySelector(':scope > .moqi-block') === null)
      .find((b) => (b.textContent ?? '').includes(text))
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }
  }, needle)
  await page.mouse.click(box.x, box.y)
  await sleep(300)
  await page.keyboard.press('End')
  await page.keyboard.type('[[产')
  await sleep(700)
}
await openSuggestionMenu('第一段：这里先按 Esc')
const suggestMenu = await page.evaluate(() => {
  const menu = document.querySelector('.slash-menu')
  if (!menu) return null
  return {
    group: menu.querySelector('.slash-menu-group')?.textContent ?? null,
    rows: [...menu.querySelectorAll('.slash-menu-item')].map((el) => ({
      label: el.querySelector('.slash-menu-label')?.textContent ?? '',
      reason: el.querySelector('.slash-menu-hint')?.textContent ?? '',
    })),
  }
})
// ① 关掉（Esc）不产生任何 operation
await page.keyboard.press('Escape')
await sleep(600)
const afterSuggestEsc = { refs: await suggestRefsOn(), menuClosed: await page.evaluate(() => document.querySelector('.slash-menu') === null) }
// ② 接受一条建议：ref 才写进去
await openSuggestionMenu('第二段：这里接受一条建议')
await page.keyboard.press('ArrowDown')
await sleep(200)
const picked = await page.evaluate(() => {
  const el = document.querySelector('.slash-menu-item.is-active')
  return el ? { label: el.querySelector('.slash-menu-label')?.textContent ?? '', reason: el.querySelector('.slash-menu-hint')?.textContent ?? '' } : null
})
await page.keyboard.press('Enter')
await sleep(900)
const accepted = {
  refs: await suggestRefsOn(),
  blocks: await page.evaluate(() => [...document.querySelectorAll('.editor-content .moqi-block')]
    .filter((el) => el.querySelector(':scope > .moqi-block') === null)
    .map((el) => ({ id: el.dataset.entityId, text: (el.textContent ?? '').trim() }))),
  menuClosed: await page.evaluate(() => document.querySelector('.slash-menu') === null),
}
await page.screenshot({ path: join(REPORT_DIR, 'suggest-group.png') })
check('SUGGEST-RULE-1 / SUGGEST-FILTER-1 / SUGGEST-ACCEPT-1 双链建议 · 规则版：[[ 候选底部出「建议」组、每条只带一个理由（反链 / 同标签 / 同源）、自引用与被删目标不出现、Esc 关掉不产生 operation、接受才写 ref（此前无网）',
  suggestMenu !== null && (suggestMenu.group ?? '').includes('建议')
  && suggestMenu.rows[0].label === '产品路线' && suggestMenu.rows[0].reason === '空页面'
  && suggestMenu.rows.some((row) => row.label === '引用过本篇的页面' && row.reason === '已引用本篇')
  && suggestMenu.rows.some((row) => row.label === '同标签页' && row.reason === '同标签')
  && suggestMenu.rows.some((row) => row.label === '同源页' && row.reason === '都引用了《产品路线》')
  && !suggestMenu.rows.some((row) => row.label.includes('回收站')) && !suggestMenu.rows.some((row) => row.label === '建议测试页')
  && suggestRefsBefore.length === 0 && afterSuggestEsc.refs.length === 0 && afterSuggestEsc.menuClosed === true
  && picked !== null && accepted.refs.join(',') === 'sg-m2' && accepted.menuClosed === true
  && (accepted.blocks.find((b) => b.id === 'sg-m2')?.text ?? '').includes(picked.label)
  && (accepted.blocks.find((b) => b.id === 'sg-m1')?.text ?? '').includes('[[产'),
  { suggestMenu, suggestRefsBefore, afterSuggestEsc, picked, accepted })

// ---------- V2c：页面库筛选面板（docs/09 §4.2 R09-FILT-1…9）----------
// 判据在 `ui/libraryFilter.ts`（纯函数 + 单测）；这里锁**界面路径**：条件真的落到卡片上、
// 计数实时、徽章只数条件、三种关闭路径、排序只改顺序。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position, extra = {}) => ({ entityId: id, blockUid: uid, type: 'text', content: text ? [{ t: 'text', v: text }] : [], parent, children: [], position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now, pinned: false, starred: false, ...extra })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    { ...mk('lf1', 'lf100001', '', null, 0, { isObject: true, objectName: '副业探索', children: ['lf1b1'], tags: ['lf-work'], properties: [{ defId: 'lf-status', type: 'select', optionId: 'doing' }] }), content: [] },
    mk('lf1b1', 'lf1b1001', '周末做一个小工具', 'lf1', 0),
    { ...mk('lf2', 'lf200002', '', null, 1, { isObject: true, objectName: '读书笔记', children: [], tags: ['lf-life'], starred: true }), content: [] },
    { ...mk('lf3', 'lf300003', '', null, 2, { isObject: true, objectName: '平台分发', children: [], tags: ['lf-work'] }), content: [] },
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({
    properties: [{ id: 'lf-status', name: '状态', type: 'select', options: [{ id: 'doing', label: '进行中' }, { id: 'done', label: '已完成' }], created: now, modified: now }],
    tags: [{ id: 'lf-work', name: '工作', color: null, created: now, modified: now }, { id: 'lf-life', name: '生活', color: null, created: now, modified: now }],
  }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
const libraryNames = () => page.evaluate(() => [...document.querySelectorAll('.lcard h3')].map((el) => el.textContent))
const filterBefore = await libraryNames()
await page.locator('button[aria-label="筛选"]').first().click()
await sleep(500)
const filterPanel = await page.evaluate(() => {
  const pop = document.querySelector('.pop.fp')
  if (!pop) return null
  return {
    labels: [...pop.querySelectorAll('.fp-label')].map((el) => el.textContent),
    sort: pop.querySelector('.fp-sort')?.textContent ?? '',
    done: pop.querySelector('.fp-done')?.textContent ?? '',
    count: pop.querySelector('.fp-count')?.textContent ?? '',
  }
})
// ① 星标「仅星标」：条件即时生效 + 计数实时
await page.locator('.pop.fp .fp-seg[aria-label="星标"] .fp-chip', { hasText: '仅星标' }).click()
await sleep(400)
const starred = { cards: await libraryNames(), done: await page.locator('.pop.fp .fp-done').textContent(), count: await page.evaluate(() => document.querySelector('.pop.fp .fp-count')?.textContent ?? '') }
// ② 标签「含所选 #工作」：第二个条件叠加（徽章 = 2）
await page.locator('.pop.fp .fp-seg[aria-label="标签模式"] .fp-chip', { hasText: '含所选' }).click()
await sleep(200)
await page.locator('.pop.fp .fp-tag', { hasText: '工作' }).first().click()
await sleep(400)
const tagged = { cards: await libraryNames(), badge: await page.evaluate(() => document.querySelector('button[aria-label="筛选"] .bdg')?.textContent ?? null) }
// ③ 高级筛选：属性「进行中」+ 关键词（走折叠区）
await page.locator('.pop.fp .fp-adv-toggle').click()
await sleep(250)
await page.locator('.pop.fp .fp-seg[aria-label="状态"] .fp-chip', { hasText: '进行中' }).click()
await sleep(250)
await page.locator('.pop.fp [aria-label="筛选关键词"]').fill('小工具')
await page.locator('.pop.fp .fp-kw-add').click()
await sleep(400)
const advanced = { cards: await libraryNames(), badge: await page.evaluate(() => document.querySelector('button[aria-label="筛选"] .bdg')?.textContent ?? null), chips: await page.evaluate(() => [...document.querySelectorAll('.pop.fp .fp-body .fp-chip.is-on')].map((el) => el.textContent)) }
// ④ 排序：**先重置**（把属性与关键词也清掉），再换标题排序——排序只改顺序、不进条件（徽章仍为空）
await page.locator('.pop.fp .fp-reset').click()
await sleep(400)
const afterResetFirst = { cards: await libraryNames(), badge: await page.evaluate(() => document.querySelector('button[aria-label="筛选"] .bdg')?.textContent ?? null) }
await page.locator('.pop.fp .fp-sort').click()
await sleep(250)
await page.locator('.fp-sort-row', { hasText: '标题' }).click()
await sleep(400)
const sorted = { cards: await libraryNames(), label: await page.locator('.pop.fp .fp-sort').textContent(), badge: await page.evaluate(() => document.querySelector('button[aria-label="筛选"] .bdg')?.textContent ?? null) }
// ⑤ 三种关闭路径：完成 / Esc / 点空白
await page.locator('.pop.fp .fp-done').click()
await sleep(400)
const closedByDone = await page.evaluate(() => document.querySelector('.pop.fp') === null)
await page.locator('button[aria-label="筛选"]').first().click()
await sleep(350)
await page.keyboard.press('Escape')
await sleep(350)
const closedByEsc = await page.evaluate(() => document.querySelector('.pop.fp') === null)
await page.locator('button[aria-label="筛选"]').first().click()
await sleep(350)
await page.mouse.click(700, 600)
await sleep(350)
const closedByOutside = await page.evaluate(() => document.querySelector('.pop.fp') === null)
// ⑥ 重置：条件全清（徽章消失、卡片全回来）
await page.locator('button[aria-label="筛选"]').first().click()
await sleep(350)
await page.locator('.pop.fp .fp-reset').click()
await sleep(400)
const afterReset = { cards: await libraryNames(), badge: await page.evaluate(() => document.querySelector('button[aria-label="筛选"] .bdg')?.textContent ?? null) }
await page.keyboard.press('Escape')
await sleep(300)
check('R09-FILT-1…9 页面库筛选面板：条件即时生效 + 计数实时 + 徽章只数条件 + 高级区（属性/关键词）+ 排序只改顺序 + 完成/Esc/点空白三条关闭路径 + 重置清空（此前无网）',
  filterPanel !== null && filterPanel.labels.join(',') === '星标,标签模式,时间类型,时间范围'
  && filterPanel.sort.includes('默认（置顶优先）') && filterBefore.length === 3
  && starred.cards.join(',') === '读书笔记' && starred.done === '完成' && starred.count.includes('命中 1 条')
  && tagged.cards.length === 0 && tagged.badge === '2'
  // 四条条件叠加（仅星标 + 含所选#工作 + 状态=进行中 + 关键词）：一个都不命中——条件之间是「与」
  && advanced.cards.length === 0 && advanced.badge === '4'
  && advanced.chips.some((text) => text.includes('小工具'))
  && afterResetFirst.cards.join(',') === '副业探索,读书笔记,平台分发' && afterResetFirst.badge === null
  && sorted.cards.join(',') === '平台分发,副业探索,读书笔记' && sorted.label.includes('标题：Z → A') && sorted.badge === null
  && closedByDone === true && closedByEsc === true && closedByOutside === true
  && afterReset.cards.length === 3 && afterReset.badge === null,
  { filterPanel, starred, tagged, advanced, afterResetFirst, sorted, closedByDone, closedByEsc, closedByOutside, afterReset })

// ---------- V2c：拼音检索（路线 B；docs/03 §15.2、11 SEARCH-PINYIN-1）----------
// 判据在 tests/logic/pinyin.test.ts（12 个多音字样本）与黄金数据集（P1–P4）；这里锁**界面路径**：
// 在 ⌘K 里打拼音（全拼 + 首字母）能命中中文块，中文原文通路不受影响，不相关的拼音不许命中。
await seedAiPage()
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position, extra = {}) => ({ entityId: id, blockUid: uid, type: 'text', content: text ? [{ t: 'text', v: text }] : [], parent, children: [], position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now, pinned: false, starred: false, ...extra })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    { ...mk('pin-page', 'pinpage1', '', null, 0, { isObject: true, objectName: '银行与保险', children: ['pin-b1'] }), content: [] },
    mk('pin-b1', 'pinb00001', '银行里的钱要算清楚，音乐与快乐不算。', 'pin-page', 0),
  ]))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
await page.keyboard.press('Control+k')
await sleep(450)
const pinyinProbe = async (query) => {
  await page.locator('[aria-label="搜索关键词"]').fill(query)
  await sleep(700)
  return page.evaluate(() => [...document.querySelectorAll('.sr-row')].map((el) => (el.textContent ?? '').replace(/s+/g, '').slice(0, 30)))
}
const pinyinFull = await pinyinProbe('yinhang')     // 全拼（多音字：逐字转换会拼成 yinxing）
const pinyinInitials = await pinyinProbe('yh')      // 首字母
const pinyinChinese = await pinyinProbe('银行')      // 中文原文通路照旧
const pinyinMiss = await pinyinProbe('zhongguo')    // 不相关的拼音不许命中
await page.keyboard.press('Escape')
await sleep(300)
check('SEARCH-PINYIN-1 拼音检索（路线 B）：⌘K 里打全拼 yinhang / 首字母 yh 都能命中「银行」那一块，中文原文照旧，不相关的拼音不命中',
  // 页面名与正文块都含「银行」⇒ 两条命中都对（页面排在块前）
  pinyinFull.length === 2 && pinyinFull.every((row) => row.includes('银行'))
  && pinyinInitials.length === 2 && pinyinInitials.every((row) => row.includes('银行'))
  && pinyinChinese.length === 2 && pinyinChinese.every((row) => row.includes('银行'))
  && pinyinMiss.length === 0,
  { pinyinFull, pinyinInitials, pinyinChinese, pinyinMiss })

// ---------- 0.5 数据安全：设置里的「数据与备份」（docs/03 §15.9、09 R09-SET-14、11 BACKUP-*）----------
// 判据是「敢不敢把东西放进来」：快照要真的能建、能列、能恢复；能力不可用的地方（浏览器通道的文件
// 导出）要**如实禁用并说明原因**，不许装作能用。
//
// **先清掉「今天已有的快照」**：前序用例早就启动过 app ⇒ 当天的快照那时就建好了（存的是那些用例的库），
// 而「每天一份」的规矩意味着我这条再 seed 也不会重建 ⇒ 恢复回来的是别人的库（ 实测：恢复后
// 只剩 1 块、既不是「备份测试页」也不是「第一块」——**测试前提问题，不是功能问题**；真实使用里
// 「今天的第一份快照」本来就该是当天最早的库）。
await page.evaluate(() => {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index)
    if (key?.includes(':snapshot:')) localStorage.removeItem(key)
  }
})
await page.evaluate(() => localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
  { entityId: 'bk-page', blockUid: 'bkpage01', type: 'text', content: [{ t: 'text', v: '备份测试页' }], parent: null, children: ['bk-b1'], position: 0, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: true, objectName: '备份测试页', properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: 1, modified: 1 },
  { entityId: 'bk-b1', blockUid: 'bkb10001', type: 'text', content: [{ t: 'text', v: '第一块' }], parent: 'bk-page', children: [], position: 0, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: 1, modified: 1 },
])))
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(1200)
// **快照之后**再打一行：恢复要把它滚掉、而快照里那两块要留着——这才是「回滚」的判据
const backupEditorBox = await page.evaluate(() => {
  const el = document.querySelector('.editor-content .moqi-block')
  const rect = el.getBoundingClientRect()
  return { x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2) }
})
await page.mouse.click(backupEditorBox.x, backupEditorBox.y)
await sleep(400)
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await sleep(500)
await page.keyboard.insertText('恢复前打的一行')
await sleep(2600)
const typedBeforeRestore = await page.evaluate(() => JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').some((b) => (b.content ?? []).map((f) => f.v).join('').includes('恢复前打的一行')))
await page.locator('.sb-foot button', { hasText: '设置' }).click()
await sleep(900)
await page.evaluate(() => { [...document.querySelectorAll('.set-nav button')].find((b) => (b.textContent ?? '').includes('备份与恢复'))?.click() })
await sleep(400)
const backupCard = () => page.evaluate(() => {
  const card = document.querySelector('.set-pane') // 备份与恢复页（两张卡同页，读整页）
  if (!card) return null
  return {
    // 注记留 200 字而不是 50：整库导出那条有「zip 包 + 恢复说明 + 浏览器通道如实说明」三截，
  // 截短会让下面这行的 includes 变成假红（ 把导出改成 zip 文案时真踩了一次）。
    rows: [...card.querySelectorAll('.frow')].map((row) => ({ label: row.querySelector('label')?.textContent ?? '', note: (row.querySelector('.note')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) })),
    rows$: card.querySelectorAll('.bk-row').length,
    exportDisabled: [...card.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('导出…'))?.disabled ?? null,
    exportNote: (card.querySelector('.frow:last-of-type .note')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
  }
})
const backupBefore = await backupCard()
// 立即快照 → 同一天是 no-op（每天一份），不再弹提示
await page.getByRole('button', { name: '立即快照' }).click()
await sleep(700)
const backupAfter = await backupCard()
const snapshotToast = await page.evaluate(() => document.querySelector('.notice')?.textContent ?? null)
// 恢复是模态确认：点「恢复」只开弹窗，点「恢复并替换」才真的回退
const restoreClicked = await page.evaluate(() => {
  const card = document.querySelector('.set-pane') // 备份与恢复页（两张卡同页，读整页）
  const rows = [...card.querySelectorAll('.bk-row')]
  const daily = rows.find((row) => (row.textContent ?? '').includes('日'))
  const firstClick = [...(daily?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === '恢复')
  firstClick?.click()
  return Boolean(firstClick)
})
// React 重渲染是异步的：同一个 evaluate 里读不到刚点出来的确认弹窗（读码复核过的老坑）
await sleep(400)
const restoreConfirmRows = await page.evaluate(() => [...document.querySelectorAll('.dlg-f button')].filter((b) => (b.textContent ?? '').includes('恢复并替换')).length)
const restoreConfirmed = await page.evaluate(() => {
  const confirm = [...document.querySelectorAll('.dlg-f button')].find((b) => (b.textContent ?? '').includes('恢复并替换'))
  if (!confirm) return false
  confirm.click()
  return true
})
// 恢复会**整页重载**：等它把数据加载回来再读（固定 sleep 会读到「正在启动」的中间态——
// 就因此误判过一次「恢复没生效」；对账脚本按 3.5 s 读同一路径是好的）⇒ 轮询最稳。
const afterRestore = await (async () => {
  const read = () => page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => !b.deleted)
    const text = rows.map((b) => (b.content ?? []).map((f) => f.v).join('')).join('|')
    return { rolledBack: !text.includes('恢复前打的一行'), keptSnapshot: text.includes('第一块'), page: text.includes('备份测试页'), blocks: rows.length }
  }).catch((err) => {
    // 整页重载恰好落在 evaluate 执行中时，执行上下文被销毁并抛
    // 「Execution context was destroyed」——它的含义是「还没准备好」，不是失败：
  // 继续轮询，读到超时仍不对再由断言兜底（ 实测：全绿的一轮偶发崩在这里）。
    if (String(err?.message ?? err).includes('Execution context was destroyed')) return null
    throw err
  })
  const until = Date.now() + 15000
  for (;;) {
    const state = await read()
    if (state && state.rolledBack && state.keptSnapshot && state.page) return state
    if (Date.now() > until) return state ?? { rolledBack: false, keptSnapshot: false, page: false, blocks: -1 }
    await sleep(400)
  }
})()
// 设置是居中模态（R09-SET-16）：遮罩挡住侧栏（这是对的）——用 Esc 关弹窗回编辑器，视图本来没离开过。
await page.keyboard.press('Escape')
await sleep(500)
// 这一条验：卡片的四行 + 启动自动留当天快照（日 / 周两份）+「立即快照」同一天的 no-op 提示：卡片四行 + 启动自动留当天快照（日 / 周两份，内容与库一致，做过诊断）
// + 恢复走两步确认并**真的回滚**（打的那一行消失、快照里的块回来）+ 浏览器通道的导出如实禁用。
// 恢复的端到端数据结果 已对账验证（对账脚本：启动 2 块 → 打一行 3 块 → 恢复后回到 2 块、
// 打的那行消失，restore-backup-now 里留着恢复前的 3 块）。
check('BACKUP-1 数据与备份：启动自动留当天快照（日 + 周）、「立即快照」同一天是 no-op 且不弹提示、恢复走**模态确认**、浏览器通道的导出与「从备份包恢复」如实降级并说明原因（此前无网）',
  backupCard !== null
  && backupBefore !== null && backupBefore.rows.some((row) => row.label === '数据目录' && row.note.includes('浏览器预览不提供'))
  && backupBefore.rows.some((row) => row.label === '快照')
  && backupBefore.rows$ >= 2 && backupAfter.rows$ === backupBefore.rows$
  && snapshotToast === null
  && backupBefore.exportDisabled === true
  && backupBefore.rows.some((row) => row.label === '导出整库' && row.note.includes('浏览器预览不提供文件导出'))
  /* 从备份包恢复（第 13 项尾巴 · 场景 B）：这一行在场且**浏览器如实降级**——
     真机/桌面的解包恢复通路由 Rust 侧用例看住（backup::tests::restore_from_package_roundtrip_and_refusals）。 */
  && backupBefore.rows.some((row) => row.label === '从备份包恢复' && row.note.includes('校验形状') && row.note.includes('浏览器预览不提供'))
  && restoreClicked === true && restoreConfirmRows === 1 && restoreConfirmed === true
  && typedBeforeRestore === true && afterRestore.rolledBack === true && afterRestore.keptSnapshot === true && afterRestore.page === true,
  { backupBefore, backupAfter, snapshotToast, typedBeforeRestore, restoreClicked, restoreConfirmRows, restoreConfirmed, afterRestore })


// ---------- V2c：窄屏档的检索入口（docs/09 §6.3 落地注）----------
// 用户裁决（强调过多次）：**侧栏不再保留「搜索」行**——桌面的侧栏搜索早已被页面库头部的
// 🔍 取代，手机上页面库（列表页）自己也有一颗 🔍、看得见点得着 ⇒ 侧栏那行是重复的。这一条因此
// **反过来**验：窄屏档下侧栏没有搜索入口，手机用的入口就是与桌面同一处（顶栏 / 页面库的 🔍）。
await page.setViewportSize({ width: 360, height: 800 })
await seedAiPage()
const narrowEntry = await page.evaluate(() => {
  const labeled = [...document.querySelectorAll('button')].map((el) => el.getAttribute('aria-label') ?? '')
  const visible = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') ?? '').includes('全局搜索') && el.offsetParent !== null)
  return {
    compact: matchMedia('(max-width: 700px)').matches,
    searchRow: document.querySelectorAll('.sb-search').length,
    librarySearch: labeled.filter((label) => label.includes('全局搜索')).length,
    entry: visible ? (visible.getAttribute('aria-label') ?? '') : null,
  }
})
await page.evaluate(() => {
  const visible = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') ?? '').includes('全局搜索') && el.offsetParent !== null)
  visible?.click()
})
await sleep(800)
const narrowPanel = await page.evaluate(() => ({ open: Boolean(document.querySelector('.dlg[aria-label="全局搜索"]')), focused: document.activeElement?.getAttribute('aria-label') ?? null }))
await page.locator('[aria-label="搜索关键词"]').fill('第二段')
await sleep(900)
const narrowHits = await page.evaluate(() => [...document.querySelectorAll('.sr-row')].map((el) => (el.textContent ?? '').replace(/\s+/g, '').slice(0, 24)))
await page.locator('.sr-row').first().click()
await sleep(800)
const narrowJump = await page.evaluate(() => ({ closed: document.querySelector('.dlg[aria-label="全局搜索"]') === null, flashed: Boolean(document.querySelector('.moqi-block.is-flash')) }))
await page.setViewportSize({ width: 1280, height: 900 })
check('R09-SEARCH-1 窄屏档的检索入口：**侧栏没有搜索入口**（2026-10-08 用户裁决）；手机上用的就是与桌面同一处入口（顶栏 / 页面库的 🔍），点开同一套面板、搜到能跳',
  narrowEntry.compact === true && narrowEntry.searchRow === 0 && narrowEntry.librarySearch >= 1 && (narrowEntry.entry ?? '').includes('全局搜索')
  && narrowPanel.open === true && (narrowPanel.focused ?? '').includes('搜索关键词')
  && narrowHits.length >= 1 && narrowHits[0].includes('第二段文字')
  && narrowJump.closed === true && narrowJump.flashed === true,
  { narrowEntry, narrowPanel, narrowHits, narrowJump })

// ---------- D-017：覆盖层互斥（窄屏下从页面库抽屉问 AI，面板必须真的能用）----------
// 用户 实测的那个场面：页面库抽屉开着 → 它头部的 🔍 → ⌘K → 「就这些问 AI」，
// 面板确实开出来了，但开在遮罩底下（z 40 vs 遮罩 300）——点面板的任何位置命中的都是遮罩
// （效果是「把页面库关了」），于是看起来像「必须先收起页面库，AI 面板才能用」。
// 判据不是「面板开了」，而是**面板顶上的那一点属于面板自己**、并且点得动（点 ✕ 真的关得掉）。
await page.setViewportSize({ width: 1100, height: 760 })
await seedAiPage()
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
const drawerBefore = await page.evaluate(() => ({
  pagecolMounted: Boolean(document.querySelector('.pagecol')),
  isDrawer: Boolean(document.querySelector('.pagecol.is-drawer')),
}))
// 页面库抽屉没开着就先开（窄屏下它是覆盖式抽屉）
if (!drawerBefore.pagecolMounted) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /页面列表/.test(x.getAttribute('aria-label') ?? ''))
    b?.click()
  })
  await sleep(700)
}
const drawerOpen = await page.evaluate(() => ({
  isDrawer: Boolean(document.querySelector('.pagecol.is-drawer')),
  backdrop: Boolean(document.querySelector('.col-backdrop')),
}))
// 从抽屉头部的 🔍 进搜索 → 点「就这些问 AI」
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /全局搜索/.test(x.getAttribute('aria-label') ?? ''))
  b?.click()
})
await sleep(700)
await page.locator('[aria-label="搜索关键词"]').fill('第二段')
await sleep(800)
await page.locator('.sr-ask').click()
await sleep(1200)
const mutexAfterAsk = await page.evaluate(() => {
  const aip = document.querySelector('.side-panel.aip.is-open')
  const r = aip?.getBoundingClientRect()
  const at = r ? document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 30)) : null
  return {
    panelOpen: Boolean(aip),
    panelZ: aip ? getComputedStyle(aip).zIndex : null,
    drawerClosed: !document.querySelector('.col-backdrop') && !document.querySelector('.pagecol.is-drawer'),
    topmostInPanel: Boolean(aip && at && aip.contains(at)),
    topmostClass: (at?.className ?? '').toString().slice(0, 24),
  }
})
// 点面板头部的 ✕：点得动才算真的可用（互斥之前这一下会打在遮罩上）
await page.locator('.aip-head .x').click()
await sleep(600)
const panelCloseable = await page.evaluate(() => Boolean(document.querySelector('.side-panel.aip.is-open')) === false)
await page.setViewportSize({ width: 1280, height: 900 })
check('OVERLAY-MUTEX-1 窄屏下从页面库抽屉问 AI：抽屉与遮罩让位、面板顶上那一点属于面板自己、✕ 点得动（台账 D-017 的场面）',
  drawerOpen.isDrawer === true && drawerOpen.backdrop === true
  && mutexAfterAsk.panelOpen === true && mutexAfterAsk.drawerClosed === true
  && mutexAfterAsk.topmostInPanel === true
  && panelCloseable === true,
  { drawerBefore, drawerOpen, mutexAfterAsk, panelCloseable })

// ---------- V2c：⌘K 全局检索（docs/09 §6.3 R09-SEARCH-1…5、11 SEARCH-GLOBAL-1）----------
// 判据是「用中文搜一个词，3 秒内跳到那一块」——所以这里真的打字、真的点、真的看跳转与闪烁。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position, extra = {}) => ({ entityId: id, blockUid: uid, type: 'text', content: text ? [{ t: 'text', v: text }] : [], parent, children: [], position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now, pinned: false, starred: false, ...extra })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    { ...mk('sk-page', 'skpage01', '', null, 0, { isObject: true, objectName: '读书笔记', children: ['sk-b1', 'sk-b2'] }), content: [] },
    mk('sk-b1', 'skb10001', '墨契是本地优先的双链笔记', 'sk-page', 0, { tags: ['sk-tag'] }),
    mk('sk-b2', 'skb20002', '第二条：双链和反链都要能用', 'sk-page', 1),
    { ...mk('sk-page2', 'skpage02', '', null, 1, { isObject: true, objectName: '副业探索', children: ['sk-b3'] }), content: [] },
    mk('sk-b3', 'skb30003', '周末做一个小工具试试看', 'sk-page2', 0),
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({
    properties: [],
    tags: [{ id: 'sk-tag', name: '工程笔记', color: null, created: now, modified: now }],
  }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)

const searchOpen = () => page.evaluate(() => {
  const dialog = document.querySelector('.dlg[aria-label="全局搜索"]')
  if (!dialog) return null
  return { focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.className ?? '' }
})
await page.keyboard.press('Control+k')
await sleep(500)
const opened = await searchOpen()
// ① 中文子串（四个字、跨词边界）——默认 unicode61 分词器搜不到的那一类（R09-SEARCH-5）
await page.locator('[aria-label="搜索关键词"]').fill('双链笔记')
await sleep(500)
const substringHit = await page.evaluate(() => ({
  groups: [...document.querySelectorAll('.sr-group h4')].map((el) => el.textContent),
  rows: [...document.querySelectorAll('.sr-row')].map((el) => (el.textContent ?? '').replace(/\s+/g, '').slice(0, 30)),
  marks: document.querySelectorAll('.sr-row mark').length,
  kind: document.querySelector('.sr-row .sr-kind')?.textContent ?? null,
}))
// ② 页面名可搜（结果按「页面」分组，text 是名字）
await page.locator('[aria-label="搜索关键词"]').fill('读书')
await sleep(500)
const pageHit = await page.evaluate(() => ({
  groups: [...document.querySelectorAll('.sr-group h4')].map((el) => el.textContent),
  first: (document.querySelector('.sr-row')?.textContent ?? '').replace(/\s+/g, ''),
}))
// ③ 点结果 → 关面板 + 跳到那一块（跨页）+ 闪烁高亮（R09-SEARCH-3）
await page.locator('[aria-label="搜索关键词"]').fill('工具')
await sleep(500)
await page.locator('.sr-row').first().click()
await sleep(700)
const searchJumped = await page.evaluate(() => ({
  closed: document.querySelector('.dlg[aria-label="全局搜索"]') === null,
  page: (document.querySelector('.doc-col .moqi-block[data-block-object="true"]')?.textContent ?? '').trim(),
  flashed: Boolean(document.querySelector('.moqi-block.is-flash')),
}))
check('SEARCH-GLOBAL-1 中文关键词检索（⌘K）：中文子串命中且高亮、页面名可搜、点结果跳页并闪烁定位（R09-SEARCH-1/2/3/5）',
  opened !== null && (opened.focused ?? '').includes('搜索关键词')
  && substringHit.groups.includes('块') && substringHit.rows.length === 1
  && substringHit.rows[0].includes('墨契是本地优先的双链笔记') && substringHit.marks === 1
  && substringHit.kind === '读书笔记'
  && pageHit.groups.includes('页面') && pageHit.first.includes('读书笔记')
  && searchJumped.closed === true && searchJumped.page.startsWith('副业探索') && searchJumped.flashed === true,
  { opened, substringHit, pageHit, searchJumped })

// ④ 再按 ⌘K 收起（R09-SEARCH-4 的切换）+ 标签那条筛选路径（点标签结果是加 chip 而不是跳转）
await page.keyboard.press('Control+k')
await sleep(450)
const toggleOpened = await searchOpen()
await page.keyboard.press('Control+k')
await sleep(450)
const toggleClosed = await searchOpen()
await page.keyboard.press('Control+k')
await sleep(450)
await page.locator('[aria-label="搜索关键词"]').fill('工程')
await sleep(500)
const tagRow = await page.evaluate(() => ({
  groups: [...document.querySelectorAll('.sr-group')].map((el) => (el.querySelector('h4')?.textContent ?? '') + ':' + el.querySelectorAll('.sr-row').length),
  tagText: (document.querySelector('.sr-group .sr-row')?.textContent ?? '').replace(/\s+/g, ''),
}))
await page.locator('.sr-group', { hasText: '标签' }).first().locator('.sr-row').first().click()
await sleep(500)
const chipApplied = await page.evaluate(() => ({
  chips: [...document.querySelectorAll('.sr-chip')].map((el) => (el.textContent ?? '').replace(/\s+/g, '')),
  stillOpen: document.querySelector('.dlg[aria-label="全局搜索"]') !== null,
}))
await page.keyboard.press('Escape')
await sleep(400)
const escClosed = await searchOpen()
check('SEARCH-GLOBAL-1 ⌘K 再按收起、Esc 关闭；命中标签名时出「标签」分组，点它是加筛选 chip 而不是跳转（R09-SEARCH-4）',
  toggleOpened !== null && toggleClosed === null && tagRow.groups.includes('标签:1')
  && tagRow.tagText.includes('工程笔记') && chipApplied.chips.join('').includes('工程笔记') && chipApplied.stillOpen === true
  && escClosed === null,
  { toggleOpened: toggleOpened !== null, toggleClosed: toggleClosed === null, tagRow, chipApplied, escClosed })

// ---------- 圆角体系 v2（ 用户规范；docs/08 §5.2、R09-RADIUS-1）----------
// 用户点名的缺陷：设置页以外的输入框「没有做圆角处理，就纯是一个黑线」——`.inp` 的外观原先只写在
// `.frow .ctl` 下，链接弹窗 / ⌘K / 属性面板 / 页面库筛选都落到浏览器默认外观（radius 0 + 系统 inset 边）。
// 样本取两处**此前必然为默认外观**的位置：外部链接弹窗的输入框、⌘K 的搜索框；
// 再扫一遍当下 DOM——凡 `.inp` 都必须是控件档 8px + 实线令牌描边。
// 另加聚焦态一条（用户第二次点名）：聚焦只能有**一条**指示——描边转主题色、不许再叠全局焦点环。
await reset()
await page.keyboard.press('Control+l')
await sleep(700)
const radiusDialog = await page.evaluate(() => {
  const probe = (el) => { const s = getComputedStyle(el); return { radius: s.borderTopLeftRadius, style: s.borderTopStyle, color: s.borderTopColor } }
  const inputs = [...document.querySelectorAll('.dlg .inp')]
  return { count: inputs.length, samples: inputs.map(probe) }
})
const radiusFocus = await (async () => {
  await page.evaluate(() => document.querySelector('.dlg .inp')?.focus())
  // 描边有 120ms 过渡：等它走完再读，否则量到的是过渡中途的颜色。
  await sleep(300)
  return page.evaluate(() => {
    const inputs = [...document.querySelectorAll('.dlg .inp')]
    const focused = getComputedStyle(inputs[0])
    const others = inputs.slice(1).map((el) => getComputedStyle(el).borderTopColor)
    return { outlineStyle: focused.outlineStyle, outlineWidth: focused.outlineWidth, focusedBorder: focused.borderTopColor, otherBorders: others }
  })
})()
await page.keyboard.press('Escape')
await sleep(400)
await page.keyboard.press('Control+k')
await sleep(600)
const radiusSearch = await page.evaluate(() => {
  const probe = (el) => { const s = getComputedStyle(el); return { radius: s.borderTopLeftRadius, style: s.borderTopStyle } }
  const input = document.querySelector('.sr-input')
  const all = [...document.querySelectorAll('.inp')]
  return { input: input ? probe(input) : null, allCount: all.length, all: all.map((el) => getComputedStyle(el).borderTopLeftRadius) }
})
await page.keyboard.press('Escape')
await sleep(400)
check('RADIUS-1 输入框一律控件档外观（8px 圆角 + 实线令牌描边）＋ 聚焦只有一条指示（描边转主题色、不叠焦点环，两条线套一起是用户点名的问题）——圆角体系 v2',
  radiusDialog.count >= 2 && radiusDialog.samples.every((s) => s.radius === '8px' && s.style === 'solid' && !/118, 118, 118/.test(s.color))
  && radiusFocus.outlineStyle === 'none' && radiusFocus.otherBorders.length > 0
  && radiusFocus.otherBorders.every((color) => color !== radiusFocus.focusedBorder)
  && radiusSearch.input !== null && radiusSearch.input.radius === '8px' && radiusSearch.input.style === 'solid'
  && radiusSearch.allCount > 0 && radiusSearch.all.every((r) => r === '8px'),
  { radiusDialog, radiusFocus, radiusSearch })

// ---------- 正文列上边距（ 用户裁决；`R09-EDIT-4`、台账 `D-022`）----------
// ** 按新形态重定**（`属性区重规划（已归档）` §0-1/§6 连锁②：摘要条不再常驻）：
// **没有属性面 → 40px**（原型口径，正文顶在窗口栏下，没有钉住条要避）；**有属性面 → 16px**
// （D-022 的收窄推导的前提回来了：16px + 容器块外边距 ≈ 27px < 40）。判据两个数字一起看：
// ① 计算上内边距；② 实测量到的空白 < 40px——只断言 ① 会漏掉「块自身外边距被调大」这类回归。
await reset()
const padNoBrief = await page.evaluate(() => {
  const col = document.querySelector('.doc-col')
  return { padTop: col ? getComputedStyle(col).paddingTop : null, brief: Boolean(document.querySelector('.prop-wrap')) }
})
// 经 ⋯「属性」入口加一条属性（**标签直落**，§0-9）→ 属性面出现 → 走 16px 档；
// 顺带断言入口的两件（标签行在面板里 + 「添加属性」弹层同时打开）。
await page.evaluate(() => document.querySelector('.tb-btn[aria-label="更多"]')?.click())
await sleep(450)
await page.evaluate(() => { const el = [...document.querySelectorAll('.pop[role="menu"] button')].find((b) => (b.textContent ?? '').trim().startsWith('属性')); if (el) el.click() })
await sleep(900)
const entryState = await page.evaluate(() => ({
  dlg: Boolean(document.querySelector('[role="dialog"][aria-label="添加属性"]')),
  tagRow: [...document.querySelectorAll('.pe-row')].some((row) => (row.textContent ?? '').includes('标签')),
  defaultAdded: [...document.querySelectorAll('[role="dialog"] .ap-row')].some((row) => (row.textContent ?? '').includes('标签') && (row.textContent ?? '').includes('已添加')),
}))
await page.keyboard.press('Escape')
await sleep(450)
const padCol = await page.evaluate(() => {
  const col = document.querySelector('.doc-col')
  const prop = document.querySelector('.prop-wrap')
  const name = document.querySelector(".editor-content .moqi-block[data-block-object='true']")
  return {
    padTop: col ? getComputedStyle(col).paddingTop : null,
    withClass: col?.classList.contains('is-with-brief') ?? false,
    gap: prop && name ? Math.round(name.getBoundingClientRect().top - prop.getBoundingClientRect().bottom) : null,
  }
})
const padFocus = await (async () => {
  await page.evaluate(() => document.querySelector('.doc-col')?.click())
  await page.keyboard.press('Control+Shift+f')
  await sleep(600)
  const state = await page.evaluate(() => {
    const col = document.querySelector('.doc-col')
    return { focus: document.body.classList.contains('is-focus'), padTop: col ? getComputedStyle(col).paddingTop : null }
  })
  await page.keyboard.press('Escape')
  await sleep(500)
  return state
})()
check('R09-EDIT-4 / PROPS-ENTRY-1 正文列上边距（D-095：常规态统一 16px——标题离顶栏过远的用户修复；专注模式保持 40px 读距）＋ ⋯「属性」入口：标签直落面板、同时开「添加属性」弹层、弹层里同一条标着「已添加」',
  padNoBrief.padTop === '16px' && padNoBrief.brief === false
  && entryState.dlg === true && entryState.tagRow === true && entryState.defaultAdded === true
  && padCol.padTop === '16px' && padCol.withClass && padCol.gap !== null && padCol.gap > 12 && padCol.gap < 40
  && padFocus.focus && padFocus.padTop === '40px',
  { padNoBrief, entryState, padCol, padFocus })

// ---------- 属性行解剖 + 行内 ⋯ + 添加属性轻结构（ 用户裁决，按当日新原型）----------
// 旧形态已废：每行左侧 👁 眼睛开关、常驻「移除」、两段式弹窗（列表态 + 新建态）。
// 新形态：行解剖 = [类型图标][标签窄栏][值区右置]；管理收进行内 ⋯（重命名 / **从本页删除**）；
// 添加属性 = 搜索 →「最近使用」→「全部」（点了即加即关，**已添加只作提示**）→ 底部一行式新建 → ⚙ 角落。
// 起：摘要条不再常驻（§0-1），进面板的路是 **⋯「属性」入口**（标签直落 + 同时开弹层）。
await reset()
await page.evaluate(() => document.querySelector('.tb-btn[aria-label="更多"]')?.click())
await sleep(450)
await page.evaluate(() => { const el = [...document.querySelectorAll('.pop[role="menu"] button')].find((b) => (b.textContent ?? '').trim().startsWith('属性')); if (el) el.click() })
await sleep(900)
const anatomyClosed = await page.evaluate(() => ({
  eyes: document.querySelectorAll('.prop-edit .eye').length,
  addrow: document.querySelector('.prop-edit .pe-addrow')?.textContent?.trim() ?? null,
  addprop: document.querySelectorAll('.prop-edit .pe-addprop').length,
}))
// 弹层已由入口打开（不再点 pe-addrow）；正文/片段两处形态不变。
await sleep(200)
const dialogShell = await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"]')
  if (!dlg) return null
  return {
    search: document.querySelector('[role="dialog"] .ap-search input')?.getAttribute('aria-label') ?? null,
    caps: [...document.querySelectorAll('[role="dialog"] .ap-cap')].map((el) => (el.textContent ?? '').trim()),
    newline: Boolean(document.querySelector('[role="dialog"] .ap-newline input')),
    chip: document.querySelector('[role="dialog"] .ap-newline .tp-chip')?.textContent?.trim() ?? null,
    go: document.querySelector('[role="dialog"] .ap-newline .go')?.textContent?.trim() ?? null,
    goset: document.querySelector('[role="dialog"] .ap-goset')?.textContent?.includes('属性库') ?? false,
    // 旧形态的残件不许在
    oldHeads: document.querySelectorAll('[role="dialog"] .pe-head').length,
  }
})
await page.locator('[role="dialog"] .ap-newline .tp-chip').click()
await sleep(400)
const typeMenu = await page.evaluate(() => {
  const menu = document.querySelector('.pop[role="menu"]')
  if (!menu) return null
  const buttons = [...menu.querySelectorAll('button')]
  return {
    labels: buttons.map((b) => (b.textContent ?? '').trim()),
    icons: buttons.map((b) => b.querySelector('svg') !== null),
  }
})
// 点「单选」（当前项）收起类型浮层——**别按 Escape**：那会连整个弹窗一起关掉。
await page.locator('.pop[role="menu"] button', { hasText: '单选' }).click()
await sleep(300)
await page.locator('[role="dialog"] .ap-newline input').fill('验收属性')
await page.locator('[role="dialog"] .ap-newline .go').click()
await sleep(900)
const created = await page.evaluate(() => {
  const dialogOpen = document.querySelector('[role="dialog"]') !== null
  const row = [...document.querySelectorAll('.prop-edit .pe-row')].find((el) => (el.querySelector('.pe-k')?.textContent ?? '') === '验收属性')
  const more = row?.querySelector('.pe-more')
  return {
    dialogOpen,
    row: Boolean(row),
    glyph: Boolean(row?.querySelector('.pe-type svg')),
    labelWidth: row?.querySelector('.pe-k') ? Math.round(row.querySelector('.pe-k').getBoundingClientRect().width) : null,
    more: Boolean(more),
    moreIcon: Boolean(more?.querySelector('svg')),
    moreText: (more?.textContent ?? '').trim(),
    moreOpacity: more ? getComputedStyle(more).opacity : null,
  }
})
// 悬停行 → ⋯ 浮出 → 菜单两件（重命名 / 从本页删除）
await page.locator('.prop-edit .pe-row', { hasText: '验收属性' }).hover()
await sleep(250)
const hovered = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.prop-edit .pe-row')].find((el) => (el.querySelector('.pe-k')?.textContent ?? '') === '验收属性')
  const more = row?.querySelector('.pe-more')
  return { moreOpacity: more ? getComputedStyle(more).opacity : null }
})
await page.locator('.prop-edit .pe-row', { hasText: '验收属性' }).locator('.pe-more').click()
await sleep(350)
const rowMenu = await page.evaluate(() => {
  const menu = document.querySelector('.pop[role="menu"]')
  return menu ? [...menu.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()) : null
})
// 重命名：⋯ → 重命名 → 行内输入框 → Enter → 行上就是新名字
await page.locator('.pop[role="menu"] button', { hasText: '重命名' }).click()
await sleep(300)
await page.locator('.prop-edit input[aria-label="重命名 验收属性"]').fill('验收属性二')
await page.keyboard.press('Enter')
await sleep(700)
const propertyRowNames = await page.evaluate(() => [...document.querySelectorAll('.prop-edit .pe-row .pe-k')].map((el) => (el.textContent ?? '').trim()))
// 再开一次：新挂的属性进了「最近使用」组（快捷组的数据源 = uiPrefs.recentProperties）
await page.locator('.prop-edit .pe-addrow').click()
await sleep(500)
const dialogAgain = await page.evaluate(() => ({
  caps: [...document.querySelectorAll('[role="dialog"] .ap-cap')].map((el) => (el.textContent ?? '').trim()),
  firstRecent: [...document.querySelectorAll('[role="dialog"] .ap-row')][0] ? ([...document.querySelectorAll('[role="dialog"] .ap-row')][0].textContent ?? '').trim() : null,
}))
// 校验前移（§3.5）：输入一个已存在的名字（上一段刚把这条属性改名为「验收属性二」）→ 就地一句 + 按钮点不动；清掉即恢复
await page.locator('[role="dialog"] .ap-newline input').fill('验收属性二')
await sleep(300)
const dupHint = await page.evaluate(() => ({
  problem: document.querySelector('[role="dialog"] .ap-problem')?.textContent?.trim() ?? null,
  goDisabled: document.querySelector('[role="dialog"] .ap-newline .go')?.disabled ?? null,
}))
await page.locator('[role="dialog"] .ap-newline input').fill('')
await sleep(250)
const dupCleared = await page.evaluate(() => ({ problem: document.querySelector('[role="dialog"] .ap-problem')?.textContent?.trim() ?? null }))
await page.keyboard.press('Escape')
await sleep(300)
check('R09-PROP-5 / R09-PADD-1…3 属性行新形态：解剖 = 类型图标 + 标签窄栏 + 值区（无 👁、无常驻移除）；管理收进行内 ⋯（重命名 / 从本页删除）；添加属性 = 搜索 + 最近使用（零子注） + 全部（点了即加即关）+ 一行式新建（类型菜单带图标；**校验前移**：重名就地一句、按钮点不动）+ ⚙ 角落「属性库」',
  anatomyClosed.eyes === 0 && anatomyClosed.addrow === '添加属性' && anatomyClosed.addprop === 0
  && dialogShell !== null && dialogShell.search === '搜索属性'
  && dialogShell.caps.join('/').includes('全部属性') && dialogShell.newline && dialogShell.chip === '单选'
  && dialogShell.go === '建并添加' && dialogShell.goset && dialogShell.oldHeads === 0
  && typeMenu !== null && typeMenu.labels.join('/') === '单选/文本/数字/日期/勾选'
  && typeMenu.icons.length === 5 && typeMenu.icons.every(Boolean)
  && created.dialogOpen === false && created.row && created.glyph && created.labelWidth === 96 && created.more
  && created.moreIcon === true && created.moreText === ''
  && hovered.moreOpacity === '1'
  && rowMenu !== null && rowMenu.length === 2 && rowMenu[0] === '重命名' && rowMenu[1] === '从本页删除'
  && propertyRowNames.includes('验收属性二')
  && dialogAgain.caps.includes('最近使用') && dialogAgain.caps[0] === '最近使用' && (dialogAgain.firstRecent ?? '').includes('验收属性二')
  && dupHint.problem === '已有同名属性' && dupHint.goDisabled === true && dupCleared.problem === null,
  { anatomyClosed, dialogShell, typeMenu, created, hovered, rowMenu, propertyRowNames, dialogAgain, dupHint, dupCleared })

// ---------- 「从本页删除」＝本页不显示、值保留（`属性区重规划（已归档）` §0-10， 裁决）----------
// 承接上一段的现场（「验收属性二」在、面板展开、弹层已关）：删 → 行消失 + 值还在 → 加回来即恢复。
const keepBefore = await page.evaluate(() => {
  const b = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
  const page = b.find((x) => x.isObject && !x.deleted)
  const def = (JSON.parse(localStorage.getItem('moqi-project-b:metadata') ?? '{}').properties ?? []).find((d) => d.name === '验收属性二')
  return { defId: def?.id ?? null, props: (page?.properties ?? []).map((v) => v.defId) }
})
await page.locator('.prop-edit .pe-row', { hasText: '验收属性二' }).locator('.pe-more').click()
await sleep(400)
await page.evaluate(() => { const el = [...document.querySelectorAll('.pop[role="menu"] button')].find((b) => (b.textContent ?? '').trim().startsWith('从本页删除')); if (el) el.click() })
await sleep(800)
const keepAfter = await page.evaluate(() => {
  const page = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').find((x) => x.isObject && !x.deleted)
  return {
    rowGone: ![...document.querySelectorAll('.prop-edit .pe-row')].some((r) => (r.textContent ?? '').includes('验收属性二')),
    hidden: page?.propertyHidden ?? [],
    props: (page?.properties ?? []).map((v) => v.defId),
  }
})
await page.locator('.prop-edit .pe-addrow').click()
await sleep(600)
await page.evaluate(() => { const el = [...document.querySelectorAll('[role="dialog"] .ap-row')].find((b) => (b.textContent ?? '').includes('验收属性二')); if (el) el.click() })
await sleep(800)
const keepBack = await page.evaluate(() => {
  const page = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').find((x) => x.isObject && !x.deleted)
  return {
    row: [...document.querySelectorAll('.prop-edit .pe-row')].some((r) => (r.textContent ?? '').includes('验收属性二')),
    hidden: page?.propertyHidden ?? [],
    props: (page?.properties ?? []).map((v) => v.defId),
  }
})
check('PROPS-KEEP-1 「从本页删除」＝本页不再显示、**值保留**（§0-10）：删后行消失且 defId 进 propertyHidden、值仍在 properties；从「添加属性」再加回来 → 行回来、出 propertyHidden、值不用重填',
  keepBefore.defId !== null && keepAfter.rowGone === true
  && keepAfter.hidden.includes(keepBefore.defId) && keepAfter.props.includes(keepBefore.defId)
  && keepBack.row === true && !keepBack.hidden.includes(keepBefore.defId) && keepBack.props.includes(keepBefore.defId),
  { keepBefore, keepAfter, keepBack })

// ---------- 标签取用选择器（`属性区重规划（已归档）` §5-12， 已裁）----------
// 场景承接：面板展开、标签行在（⋯「属性」入口直落）。入口 = 「＋ 添加标签」胶囊（旧输入框不在）；
// 点开 = 搜索 / 创建 + 全量 + 「用在 N 页」；输入即建 → 本页上标签；再点同一条 = 去掉（切换）、多选不关窗。
const tagPill = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.prop-edit .pe-row')].find((el) => (el.querySelector('.pe-k')?.textContent ?? '') === '标签')
  return {
    pill: row?.querySelector('.pe-tagadd')?.textContent?.trim() ?? null,
    legacyInput: row ? row.querySelectorAll('.pe-input').length : null,
  }
})
await page.locator('.prop-edit .pe-tagadd').click()
await sleep(400)
const pickerOpen = await page.evaluate(() => {
  const pop = document.querySelector('.pop[role="menu"]')
  return { open: pop !== null, search: pop?.querySelector('input[aria-label="搜索标签"]') !== null }
})
await page.locator('.pop[role="menu"] input[aria-label="搜索标签"]').fill('验收标签')
await sleep(300)
await page.locator('.pop[role="menu"] button', { hasText: '创建「验收标签」' }).click()
await sleep(700)
const pickerAfterCreate = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.prop-edit .pe-row')].find((el) => (el.querySelector('.pe-k')?.textContent ?? '') === '标签')
  const pop = document.querySelector('.pop[role="menu"]')
  return {
    chip: row?.querySelector('.pe-tag')?.textContent?.trim() ?? null,
    popStillOpen: pop !== null,
    usage: pop ? [...pop.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()) : null,
  }
})
await page.locator('.pop[role="menu"] button', { hasText: '验收标签' }).first().click()
await sleep(600)
const pickerToggleOff = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.prop-edit .pe-row')].find((el) => (el.querySelector('.pe-k')?.textContent ?? '') === '标签')
  return { chips: row ? row.querySelectorAll('.pe-tag').length : null, popOpen: document.querySelector('.pop[role="menu"]') !== null }
})
await page.locator('.pop[role="menu"] button', { hasText: '验收标签' }).first().click()
await sleep(600)
const pickerToggleOn = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.prop-edit .pe-row')].find((el) => (el.querySelector('.pe-k')?.textContent ?? '') === '标签')
  return { chips: row ? row.querySelectorAll('.pe-tag').length : null }
})
await page.keyboard.press('Escape')
await sleep(300)
const pickerClosed = await page.evaluate(() => ({ popOpen: document.querySelector('.pop[role="menu"]') !== null }))
check('PROPS-TAGPICK-1 标签取用选择器（§5-12）：入口是「＋ 添加标签」胶囊（旧输入框不在）；点开＝搜索 + 创建 + 全量列表（各自「用在 N 页」）；输入即建 → 本页上标签；再点同一条＝去掉（切换）且**多选不关窗**',
  tagPill.pill === '＋ 添加标签' && tagPill.legacyInput === 0
  && pickerOpen.open && pickerOpen.search
  && (pickerAfterCreate.chip ?? '').includes('验收标签') && pickerAfterCreate.popStillOpen
  && (pickerAfterCreate.usage ?? []).some((text) => text.startsWith('验收标签') && text.includes('用在 1 页'))
  && pickerToggleOff.chips === 0 && pickerToggleOff.popOpen
  && pickerToggleOn.chips === 1 && pickerClosed.popOpen === false,
  { tagPill, pickerOpen, pickerAfterCreate, pickerToggleOff, pickerToggleOn, pickerClosed })

// ---------- 属性行几何补层（`R04-ACCEPT-7` · `09` `R09-PROP-5` 的两条几何主张）----------
// ① 标签窄栏 96px 起步、**长名换行不截断**；② 值区左缘**统一基准线**（标签多长都不推它）。
// 上面的 R09-PROP-5 只量了单行标签的 labelWidth===96——这两条几何是像素之外最会破的层（真机就栽过一次）。
await reset()
const PROP_LONG_NAME = '这是一个非常非常长的属性名称用来验证换行不截断与值区基准线'
await page.evaluate((longName) => {
  const now = Date.now()
  const mk = (id, uid, type, text, parent, position, children = []) => ({ entityId: id, blockUid: uid, type, content: text ? [{ t: 'text', v: text }] : [], parent, children, position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now })
  const pg = { ...mk('pw-page', 'pwpage001', 'text', '属性行几何检查', null, 0, []), isObject: true, objectName: '属性行几何检查', properties: [{ defId: 'pd-short', type: 'text', value: '进行中' }, { defId: 'pd-long', type: 'text', value: '长名值' }] }
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([pg]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [{ id: 'pd-short', name: '状态', type: 'text' }, { id: 'pd-long', name: longName, type: 'text' }], tags: [] }))
}, PROP_LONG_NAME)
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(600)
await page.evaluate(() => document.querySelector('.tb-btn[aria-label="更多"]')?.click())
await sleep(450)
await page.evaluate(() => { const el = [...document.querySelectorAll('.pop[role="menu"] button')].find((b) => (b.textContent ?? '').trim().startsWith('属性')); if (el) el.click() })
await sleep(900)
const propWrap = await page.evaluate((longName) => {
  const rows = [...document.querySelectorAll('.prop-edit .pe-row')]
  const pick = (name) => rows.find((row) => (row.querySelector('.pe-k')?.textContent ?? '').trim() === name)
  const short = pick('状态'); const long = pick(longName)
  const k = (row) => row?.querySelector('.pe-k')
  const opts = (row) => row?.querySelector('.pe-opts')
  return {
    present: Boolean(short && long),
    shortW: k(short) ? Math.round(k(short).getBoundingClientRect().width) : null,
    longW: k(long) ? Math.round(k(long).getBoundingClientRect().width) : null,
    shortH: k(short) ? Math.round(k(short).getBoundingClientRect().height) : null,
    longH: k(long) ? Math.round(k(long).getBoundingClientRect().height) : null,
    longClip: k(long) ? k(long).scrollWidth - k(long).clientWidth : null,
    leftShort: opts(short) ? Math.round(opts(short).getBoundingClientRect().left) : null,
    leftLong: opts(long) ? Math.round(opts(long).getBoundingClientRect().left) : null,
  }
}, PROP_LONG_NAME)
check('R09-PROP-5 几何补层（`R04-ACCEPT-7`）：长名**换行不截断**（栏宽仍 96、横向无裁切、高 ≥ 两行）＋ 值区左缘**统一基准线**（两种名字长度下 per-opts 左缘逐像素相等）',
  propWrap.present === true
  && propWrap.shortW === 96 && propWrap.longW === 96
  && propWrap.longH > propWrap.shortH && propWrap.longClip <= 1
  && propWrap.leftShort !== null && propWrap.leftShort === propWrap.leftLong,
  propWrap)

// ---------- 属性定义查重（：名字是标签、键必须唯一——导出 front-matter 用它当键）----------
await reset()
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('设置'))?.click() })
await sleep(900)
await page.evaluate(() => { [...document.querySelectorAll('.set-nav button')].find((b) => (b.textContent ?? '').trim() === '属性')?.click() })
await sleep(400)
// ---------- 属性库 · θ4 重设计（`R09-SET-5b`）：行式 ＋ 就地展开 ＋ 选项维护 ＋ 拖拽排序 ----------
/** 行式读数：⠿ / 类型字形 / 名称 / 类型 / 🗑 该有的都在。 */
const pmrRows = () => page.evaluate(() => [...document.querySelectorAll('.pmr')].map((row) => ({
  name: (row.querySelector('.k')?.textContent ?? '').trim(),
  type: (row.querySelector('.tp')?.textContent ?? '').trim(),
  grip: Boolean(row.querySelector('.pmr-grip svg')),
  glyph: Boolean(row.querySelector('.pmr-main .pe-type')),
  del: Boolean(row.querySelector('.pmr-del')),
  edit: Boolean(row.querySelector('.pmr-icon')),
})))
const openAdd = async () => { await page.locator('.pmr-foot button', { hasText: '添加属性' }).click(); await sleep(300) }
/** 展开某一行 = 点行尾 `✏`（**行体不可点**——一个动作一个位置，`R04-TOOL-1`）。 */
const openRow = async (name) => {
  await page.locator(`[aria-label="编辑属性 ${name}"]`).click()
  await sleep(300)
}
/** 收面板 · Esc 路：**焦点要在面板里**（改名失败那种「带草稿收场」就走它）。 */
const closePanel = async () => { await page.keyboard.press('Escape'); await sleep(250) }
/** 收面板 · `✓ 完成` 路（提交改名并收起；确认框刚关掉、焦点在 body 上时走它）。 */
const finishEdit = async () => {
  await page.locator('.pmr.is-open .pmr-done').click()
  await sleep(250)
}

// ① 添加（就地展开 · 维护者点名形态）：空名点不动 → 填名 → 五型 chips → 完成
await openAdd()
const addShape = await page.evaluate(() => ({
  chips: [...document.querySelectorAll('.pmr-chip')].map((b) => (b.textContent ?? '').trim()),
  emptyDisabled: [...document.querySelectorAll('.pmr-foot button')].find((b) => (b.textContent ?? '').includes('完成'))?.disabled ?? null,
  input: Boolean(document.querySelector('input[aria-label="属性名"]')),
}))
await page.locator('input[aria-label="属性名"]').fill('测试属性')
await page.locator('.pmr-chip', { hasText: '单选' }).click()
await sleep(200)
const namedEnabled = await page.locator('.pmr-foot button', { hasText: '完成' }).isEnabled()
await page.locator('.pmr-foot button', { hasText: '完成' }).click()
await sleep(600)
const propFirst = await page.evaluate(() => ({ count: document.querySelectorAll('.pmr').length, toast: document.querySelector('.notice')?.textContent ?? null }))
const rowsFirst = await pmrRows()
check('R09-SET-5b 属性库（θ4）：行式（⠿ / 类型字形 / 名称 / 类型 / 🗑）＋ 就地展开的添加（**空名点不动** · 五型 chips 按线框序 文本/数字/单选/日期/勾选 · 完成后收起）；成功不弹通知',
  addShape.input && addShape.emptyDisabled === true && namedEnabled === true
  && JSON.stringify(addShape.chips) === JSON.stringify(['文本', '数字', '单选', '日期', '勾选'])
  && rowsFirst.length === 1 && rowsFirst[0].name === '测试属性' && rowsFirst[0].type === '单选'
  && rowsFirst[0].grip && rowsFirst[0].glyph && rowsFirst[0].del && rowsFirst[0].edit
  && propFirst.count === 1 && propFirst.toast === null,
  { addShape, namedEnabled, rowsFirst, propFirst })

// ② 查重（含首尾空白）：就地一句 + 不创建 + 不弹通知
await openAdd()
await page.locator('input[aria-label="属性名"]').fill(' 测试属性 ')
await sleep(300)
const dupeCreate = await page.evaluate(() => ({
  problem: document.querySelector('.pmr-panel.is-add .pe-problem')?.textContent ?? null,
  doneDisabled: [...document.querySelectorAll('.pmr-foot button')].find((b) => (b.textContent ?? '').includes('完成'))?.disabled ?? null,
  rows: document.querySelectorAll('.pmr').length,
  toast: document.querySelector('.notice')?.textContent ?? null,
}))
check('R09-SET-5 属性定义查重：同名（含首尾空白）再建 → 就地一句「已有同名属性」且不创建——属性名是标签、键必须唯一',
  (dupeCreate.problem ?? '').includes('已有同名属性「测试属性」') && dupeCreate.doneDisabled === true
  && dupeCreate.rows === 1 && dupeCreate.toast === null,
  { dupeCreate })
// Esc 只收面板：设置弹窗必须还开着（`R09-KEY-13` 一层一个返回）——**先按下去**再看读数。
await page.keyboard.press('Escape')
await sleep(300)
const escScope = await page.evaluate(() => ({ dialog: Boolean(document.querySelector('.set-dlg')), panel: Boolean(document.querySelector('.pmr-panel')) }))
check('R09-SET-5b 属性库（θ4）：Esc 先收**就地面板**、不关设置弹窗（`R09-KEY-13` 一层一个返回；对话框让位靠面板的 `data-esc-claim`）',
  escScope.dialog === true && escScope.panel === false, { escScope })

// ①b 行尾交互（用户 修正）：收起态 = `✏` 在 `🗑` 前（行体不可点）；编辑态 = 行尾只剩 `✓`、
//     面板里**没有**删除按钮（删除只有行尾一处——同一种事不做两种样式）。
const rowOpsClosed = await page.evaluate(() => {
  const row = document.querySelector('.pmr')
  return {
    ops: [...(row?.querySelectorAll('.pmr-row-ops button') ?? [])].map((b) => b.getAttribute('aria-label')),
    done: Boolean(row?.querySelector('.pmr-done')),
    mainIsButton: row?.querySelector('button.pmr-main') !== null,
  }
})
await openRow('测试属性')
const rowOpsOpen = await page.evaluate(() => {
  const row = document.querySelector('.pmr.is-open')
  return {
    done: row?.querySelector('.pmr-done')?.getAttribute('aria-label') ?? null,
    ops: row?.querySelectorAll('.pmr-row-ops button').length ?? -1,
    panelDelete: Boolean(document.querySelector('.pmr-panel .btn-danger')),
    panelTitle: document.querySelector('.pmr-panel input[aria-label^="属性名"]')?.getAttribute('value') ?? null,
  }
})
await closePanel()
const rowOpsAfter = await page.evaluate(() => Boolean(document.querySelector('.pmr.is-open')))
check('R09-SET-5b 属性库（θ4）：行尾 = `✏`（在 `🗑` 之前）＋ `🗑`——**行体不可点**，编辑只走 `✏`、删除只走 `🗑`；**编辑态行尾只剩 `✓ 完成`**（✏/🗑 隐去），面板里没有删除按钮（一种删除只做一处）',
  JSON.stringify(rowOpsClosed.ops) === JSON.stringify(['编辑属性 测试属性', '删除属性 测试属性'])
  && rowOpsClosed.done === false && rowOpsClosed.mainIsButton === false
  && rowOpsOpen.done === '完成编辑 测试属性' && rowOpsOpen.ops === 0 && rowOpsOpen.panelDelete === false
  && rowOpsAfter === false
  && (propFirst.toast === null),
  { rowOpsClosed, rowOpsOpen, rowOpsAfter })

// ③ 建第二个 + 改名（与建属性共用同一套判据）：重名拒 / 保留键拒 / 正常改名后行上就是新名字
await openAdd()
await page.locator('input[aria-label="属性名"]').fill('另一个')
await page.locator('.pmr-chip', { hasText: '文本' }).click()
await page.locator('.pmr-foot button', { hasText: '完成' }).click()
await sleep(600)
const rowNames = () => page.evaluate(() => [...document.querySelectorAll('.pmr .k')].map((el) => (el.textContent ?? '').trim()))
const renameProblem = () => page.evaluate(() => (document.querySelector('.pmr-panel .pe-problem')?.textContent ?? '').trim())
/** 走一轮改名：展开行 → 填名 → Enter（失败就地一句、名字不动，由调用方按 Esc 收场）。 */
const renameTry = async (to) => {
  await openRow('另一个')
  await page.locator('.pmr-panel input[aria-label^="属性名"]').fill(to)
  await page.keyboard.press('Enter')
  await sleep(500)
  return {
    problem: await renameProblem(),
    names: await rowNames(),
    toast: await page.evaluate(() => document.querySelector('.notice')?.textContent ?? null),
  }
}
const renameDupe = await renameTry('测试属性')
await closePanel()
const renameReserved = await renameTry('aliases')
await closePanel()
const renameOk = await renameTry('阶段')
await finishEdit()   // 成功后走「✓ 完成」这条路（提交并收起）
const namesAfterOk = await rowNames()
check('R09-SET-5 改属性名：与建属性共用判据——重名与保留键都拒（**就地一句**、名字不动），正常改名后字典行上是新名字',
  renameDupe.problem.includes('已有同名属性') && renameDupe.names.includes('另一个') && renameDupe.toast === null
  && renameReserved.problem.includes('保留键') && renameReserved.toast === null
  && renameOk.problem === '' && namesAfterOk.includes('另一个') === false && namesAfterOk.includes('阶段'),
  { renameDupe, renameReserved, renameOk, namesAfterOk })

// ④ θ4 ③/④：页头计数 · 搜索行 · ⠿ 拖拽（落数据）· 选项维护（加 / 点名字改名 / 删两步）
const headMeta = await page.evaluate(() => document.querySelector('.set-ph-meta')?.textContent ?? null)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.pmr')]
  const dt = new DataTransfer()
  const from = rows[1].querySelector('.pmr-grip')
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
  rows[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  rows[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
})
await sleep(600)
const afterDrag = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('.pmr .k')].map((el) => (el.textContent ?? '').trim()),
  stored: (JSON.parse(localStorage.getItem('moqi-project-b:metadata') ?? '{}').properties ?? []).map((d) => d.name),
}))
await openRow('测试属性')
await page.locator('.pmr-optadd input').fill('进行中')
await page.keyboard.press('Enter')
await sleep(400)
await page.locator('.pmr-optadd input').fill('已完成')
await page.keyboard.press('Enter')
await sleep(400)
await page.locator('.pmr-optname', { hasText: '进行中' }).click()
await sleep(200)
await page.locator('.pmr-opt input[aria-label^="选项名"]').fill('进行中（改）')
await page.keyboard.press('Enter')
await sleep(400)
await page.locator('.pmr-opt', { hasText: '已完成' }).locator('.pmr-del').click()
await sleep(400)
const optDlg = await page.evaluate(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').replace(/\s+/g, ' '))
await page.locator('[role="dialog"] button', { hasText: '删除选项' }).click()
await sleep(600)
const optsNow = await page.evaluate(() => [...document.querySelectorAll('.pmr-opt .pmr-optname')].map((el) => (el.textContent ?? '').trim()))
await finishEdit()   // 确认框刚关掉 ⇒ 焦点在 body，Esc 会落到设置弹窗上（已知边角），走 ✓
await page.locator('.pmr-search input').fill('阶段')
await sleep(300)
const searchHits = await page.evaluate(() => [...document.querySelectorAll('.pmr .k')].map((el) => (el.textContent ?? '').trim()))
await page.locator('.pmr-search input').fill('不存在的名字')
await sleep(300)
const searchEmptyState = await page.evaluate(() => document.querySelector('.pmr-list .note')?.textContent ?? null)
await page.locator('.pmr-search input').fill('')
await sleep(300)
check('R09-SET-5b 属性库（θ4 续）：页头「共 N 条」· 搜索行筛行（无命中给一句陈述）· ⠿ 拖拽改**定义顺序**（数组序 = 数据）· 选项维护（加 / 点名字改名 / 删：两步 ＋ 影响清单）',
  headMeta === '共 2 条'
  && JSON.stringify(afterDrag.rows) === JSON.stringify(['阶段', '测试属性'])
  && JSON.stringify(afterDrag.stored) === JSON.stringify(['阶段', '测试属性'])
  && (optDlg ?? '').includes('删除选项') && (optDlg ?? '').includes('用在')
  && JSON.stringify(optsNow) === JSON.stringify(['进行中（改）'])
  && JSON.stringify(searchHits) === JSON.stringify(['阶段'])
  && (searchEmptyState ?? '').includes('没有匹配'),
  { headMeta, afterDrag, optDlg, optsNow, searchHits, searchEmptyState })

// ---------- 属性库：用量读数 + 删除两步（`属性区重规划（已归档）` §3.6 / §3.2；θ4 后读数搬进展开态）----------
// 仍在「属性」页（上一段停在这里，行 = 阶段 / 测试属性）。
const usageCells = []
for (const name of await rowNames()) {
  await openRow(name)
  usageCells.push(await page.evaluate(() => [...document.querySelectorAll('.pmr-panel .note')].map((el) => (el.textContent ?? '').trim()).find((text) => text.startsWith('用在')) ?? null))
  await closePanel()
}
check('PROPS-USED-1 属性库每行「用在 N 页」读数（§3.6）：展开态恒有读数行（用在 N 页 · 共 M 个值），数的是未删除页',
  usageCells.length >= 2 && usageCells.every((text) => /^用在 \d+ 页 · 共 \d+ 个值$/.test(text ?? '')),
  { usageCells })
// 删除：两步——点「删除」先把影响清单摆出来（可取消），确认才真删
await page.locator('.pmr', { hasText: '测试属性' }).first().locator('.pmr-del').click()
await sleep(400)
const delDialog = await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"]')
  return dlg ? (dlg.textContent ?? '').replace(/\s+/g, ' ') : null
})
await page.locator('[role="dialog"] button', { hasText: '取消' }).click()
await sleep(300)
const delAfterCancel = await rowNames()
await page.locator('.pmr', { hasText: '测试属性' }).first().locator('.pmr-del').click()
await sleep(400)
await page.locator('[role="dialog"] button', { hasText: '删除属性' }).click()
await sleep(700)
const delAfterConfirm = await page.evaluate(() => {
  const names = [...document.querySelectorAll('.pm-row .k')].map((el) => (el.textContent ?? '').trim())
  const defs = (JSON.parse(localStorage.getItem('moqi-project-b:metadata') ?? '{}').properties ?? []).map((d) => d.name)
  // 设置弹窗本来就开着：确认框关掉后应只剩它一个 [role="dialog"]（数数，不判"全关"）。
  return { names, defs, dialogs: document.querySelectorAll('[role="dialog"]').length }
})
check('PROPS-DEL-1 属性库删除（§3.2 两步）：确认框先给影响清单（用在 N 页 / 共 M 个值 ＋ 提示先导出备份）；取消不动、确认后定义从注册表消失',
  (delDialog ?? '').includes('用在 0 页') && (delDialog ?? '').includes('共 0 个值')
  && (delDialog ?? '').includes('建议先到「数据与备份」导出整库')
  && delAfterCancel.includes('测试属性')
  && !delAfterConfirm.names.includes('测试属性') && !delAfterConfirm.defs.includes('测试属性')
  && delAfterConfirm.dialogs === 1,
  { usageCells, delDialog, delAfterCancel, delAfterConfirm })

// 上一段停在「属性」页：本段要看「备份与恢复」页，先切过去。
await page.evaluate(() => { [...document.querySelectorAll('.set-nav button')].find((b) => (b.textContent ?? '').includes('备份与恢复'))?.click() })
await sleep(400)
// ---------- 设置页：导出落点常显（ 用户走查 #1，T6）----------
// `R09-SET-14`：导出完只弹一次 toast，路径「记都记不住」——落点目录改成常显 + 可复制。
// 浏览器通道拿不到数据目录：如实降级（文案点明 + 复制按钮禁用，同 `canExport` 的口径）。
const exportsRow = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.set-card .frow')].find((el) => (el.querySelector('label')?.textContent ?? '').trim() === '导出落点')
  if (!row) return null
  const note = row.querySelector('.note')
  const button = row.querySelector('button')
  return {
    text: (note?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    title: note?.getAttribute('title') ?? '',
    button: (button?.textContent ?? '').trim(),
    disabled: button ? button.disabled : null,
  }
})
// ---------- T-18：导入页两个活入口（`R09-SET-20` 能力如实——浏览器通道没有系统选择器）----------
await page.evaluate(() => { [...document.querySelectorAll('.set-nav button')].find((b) => (b.textContent ?? '').includes('导入'))?.click() })
await sleep(500)
const importOps = await page.evaluate(() => {
  const rowOf = (label) => [...document.querySelectorAll('.set-pane .frow')].find((el) => (el.querySelector('label')?.textContent ?? '').trim() === label)
  const read = (label) => {
    const row = rowOf(label)
    if (!row) return null
    const button = row.querySelector('button')
    return { text: (button?.textContent ?? '').trim(), disabled: button?.disabled ?? null, title: button?.getAttribute('title') ?? '' }
  }
  return { file: read('选择文件'), folder: read('选择文件夹') }
})
check('T-18 导入页两个活入口（`R09-SET-20` 能力如实）：浏览器通道没有系统选择器 ⇒ 「选择文件…」「选择文件夹…」都**禁用并把原因写在 title 里**（不做假按钮）；桌面 / 移动端由 `FileChannelPort.capabilities` 各自放行（移动端 pickFolder 恒 false）',
  importOps.file?.text.includes('选择文件') === true && importOps.file.disabled === true && importOps.file.title.length > 0
  && importOps.folder?.text.includes('选择文件夹') === true && importOps.folder.disabled === true && importOps.folder.title.length > 0,
  { importOps })
// 回「备份与恢复」页，供下面的 θ5 条目用
await page.evaluate(() => { [...document.querySelectorAll('.set-nav button')].find((b) => (b.textContent ?? '').includes('备份与恢复'))?.click() })
await sleep(400)

// ---------- θ5（T-09）：说明按需展开——`?` 注释（正文只留最短一句；桌面锚定气泡 / 窄档底部 Sheet）----------
const hintShape = await page.evaluate(() => ({
  questionMarks: document.querySelectorAll('.hint-q').length,
  longInline: [...document.querySelectorAll('.set-card .hint')].filter((el) => (el.textContent ?? '').length > 60).map((el) => (el.textContent ?? '').trim().slice(0, 30)),
  conclusion: (document.querySelector('.set-card .hint')?.textContent ?? '').replace(/\s+/g, ''),
}))
await page.locator('.set-card h3 .hint-q').first().click()
await sleep(400)
const hintPop = await page.evaluate(() => ({
  open: Boolean(document.querySelector('.pop.hint-pop')),
  text: (document.querySelector('.pop.hint-pop')?.textContent ?? '').replace(/\s+/g, ''),
  expanded: document.querySelector('.set-card h3 .hint-q')?.getAttribute('aria-expanded'),
}))
await page.keyboard.press('Escape')
await sleep(300)
const hintAfterEsc = await page.evaluate(() => ({
  pop: Boolean(document.querySelector('.pop.hint-pop')),
  dialog: Boolean(document.querySelector('.set-dlg')),
}))
check('R09-SET-21 `?` 注释（θ5 · T-09）：长说明收进 `?`（卡片直排里只留最短一句——本页 ≤ 60 字）· 点 `?` = 桌面锚定气泡（`aria-expanded` 同步）· Esc 只收气泡、不关设置弹窗（`data-esc-claim`，`R09-KEY-13` 一层一个返回）',
  hintShape.questionMarks >= 1 && hintShape.longInline.length === 0
  && hintPop.open === true && hintPop.expanded === 'true' && hintPop.text.includes('后悔药')
  && hintAfterEsc.pop === false && hintAfterEsc.dialog === true,
  { hintShape, hintPop, hintAfterEsc })

check('R09-SET-14 设置页「数据与备份」常显导出落点目录、可复制（2026-10-08 用户走查 #1）；浏览器通道如实降级：没有数据目录 ⇒ 复制按钮禁用并在文案里说明',
  exportsRow !== null && exportsRow.button.includes('复制') && exportsRow.disabled === true
  && exportsRow.text.includes('浏览器预览不提供'),
  { exportsRow })

// ---------- 设置页：栏头固定 + 能开页面库（ 用户走查 #4，T7 / T7b）----------
// `R09-SET-1`：栏头（← + 标题）在滚动口里 sticky——**滚动之后标题与返回仍可见、且不被标题栏盖住**
// （量的是标题/返回的矩形，不是 CSS 声明本身）。「返回页面库」与侧栏「页面库」两条路都真能开。
const setHeadState = async (wrapSel, headSel) => page.evaluate(async ([wSel, hSel]) => {
  const wrap = document.querySelector(wSel)
  const head = document.querySelector(hSel)
  const wbar = document.querySelector('.wbar')
  if (!wrap || !head) return null
  wrap.scrollTop = 900
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const titleRect = (head.querySelector('.set-h1') ?? head.querySelector('h2'))?.getBoundingClientRect() ?? null
  const backRect = head.querySelector('button[aria-label="返回页面库"]')?.getBoundingClientRect() ?? null
  const wbarRect = wbar?.getBoundingClientRect() ?? { bottom: 0 }
  return {
    scrolled: wrap.scrollTop > 0,
    titleTop: titleRect ? Math.round(titleRect.top) : null,
    backTop: backRect ? Math.round(backRect.top) : null,
    wbarBottom: Math.round(wbarRect.bottom),
  }
}, [wrapSel, headSel])
/** 判据：滚动后标题与返回还在视口里，且都落在标题栏下缘之下（没被盖住）。 */
// 设置 = 居中模态（`R09-SET-16`）：⌘, 开合（`SET-OPEN-1`）；滚动只发生在右栏 `.set-pane` 里，
// **先 Esc 归一**：上一段（属性查重）打开过设置弹窗，留着的话下面第一下 ⌘, 会把它关掉。
await page.keyboard.press('Escape')
await sleep(400)
// 面板头部（`.dlg-h`）不随它走——滚到底时标题与关闭按钮仍在原处、不被标题栏盖住。
await page.keyboard.press('Control+,')
await sleep(800)
// 先切到「关于」页：更新日志列表够长，右栏才有可滚量（AI 页比面板还矮，滚不动）。
await page.evaluate(() => { [...document.querySelectorAll('.set-nav button')].find((b) => (b.textContent ?? '').includes('关于'))?.click() })
await sleep(500)
const setModal = await page.evaluate(async () => {
  const pane = document.querySelector('.set-pane')
  const head = document.querySelector('.set-dlg .dlg-h')
  const wbar = document.querySelector('.wbar')
  if (!pane || !head) return null
  pane.scrollTop = 900
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const titleRect = head.querySelector('h3')?.getBoundingClientRect() ?? null
  const closeRect = head.querySelector('button[aria-label="关闭"]')?.getBoundingClientRect() ?? null
  const wbarRect = wbar?.getBoundingClientRect() ?? { bottom: 0 }
  return {
    panel: true,
    titleTop: titleRect ? Math.round(titleRect.top) : null,
    closeTop: closeRect ? Math.round(closeRect.top) : null,
    wbarBottom: Math.round(wbarRect.bottom),
  }
})
const setHeadOk = setModal !== null && setModal.panel === true
  && setModal.titleTop !== null && setModal.titleTop >= setModal.wbarBottom - 1
  && setModal.closeTop !== null && setModal.closeTop >= setModal.wbarBottom - 1
// 关闭三路径之一：✕（另两条 Esc / 点遮罩由弹窗族提供，模态化时手工验过）。
await page.evaluate(() => { document.querySelector('.set-dlg .dlg-h button[aria-label="关闭"]')?.click() })
await sleep(600)
const setClosed = await page.evaluate(() => ({
  closed: !document.querySelector('.set-dlg'),
  view: document.querySelector('.view.is-on')?.getAttribute('aria-label') ?? null,
}))
// ⌘, 再按一次 = 关闭（`SET-OPEN-1`：已开着再按 = 关闭）
await page.keyboard.press('Control+,')
await sleep(600)
const commaOpened = await page.evaluate(() => Boolean(document.querySelector('.set-dlg')))
await page.keyboard.press('Control+,')
await sleep(600)
const commaClosed = await page.evaluate(() => Boolean(document.querySelector('.set-dlg')))
check('R09-SET-16/18 / SET-OPEN-1：设置 = 居中模态（⌘, 开合；✕ / Esc / 点遮罩三路径关闭）——面板头部不随右栏滚动而去、不被标题栏盖住；模态不改视图（正文仍在后面看得见）',
  setHeadOk && setClosed.closed && setClosed.view === '编辑器' && commaOpened && !commaClosed,
  { setModal, setClosed, commaOpened, commaClosed })
// 回收站同一族（同一套 CSS）：标题同样不许被标题栏盖住（内容短、可能没有可滚量，所以不强制 scrolled）。
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('回收站'))?.click() })
await sleep(900)
const trashHead = await setHeadState('.tr-wrap', '.tr-head')
check('回收站视图：栏头也不被标题栏盖住（与设置同族：头部固定、内容自己滚）',
  trashHead !== null && trashHead.titleTop !== null && trashHead.titleTop >= trashHead.wbarBottom - 1,
  { trashHead })

// 走查 #4 的「小窗口下更明显」：窄档（≤700）整块退化为**全屏页**（`R09-SET-16`）——面板铺满视口、✕ 仍能关。
// 同样先 Esc 归一（上面那条以弹窗开着收尾）。
await page.keyboard.press('Escape')
await sleep(400)
const viewBeforeNarrow = await page.evaluate(() => document.querySelector('.view.is-on')?.getAttribute('aria-label') ?? null)
await page.setViewportSize({ width: 360, height: 800 })
await sleep(600)
await page.keyboard.press('Control+,')
await sleep(800)
const narrowModal = await page.evaluate(() => {
  const dlg = document.querySelector('.set-dlg')
  const r = dlg?.getBoundingClientRect()
  return {
    panel: Boolean(dlg),
    w: r ? Math.round(r.width) : null,
    h: r ? Math.round(r.height) : null,
    closeVisible: Boolean(dlg?.querySelector('.dlg-h button[aria-label="关闭"]')),
  }
})
await page.evaluate(() => { document.querySelector('.set-dlg .dlg-h button[aria-label="关闭"]')?.click() })
await sleep(600)
const narrowAfter = await page.evaluate(() => ({
  closed: !document.querySelector('.set-dlg'),
  view: document.querySelector('.view.is-on')?.getAttribute('aria-label') ?? null,
}))
await page.setViewportSize({ width: 1280, height: 900 })
await sleep(400)
check('R09-SET-16 窄档（360）：设置整块退化为全屏页（面板 = 视口）、✕ 仍能关；模态不改视图（开前 = 开后）',
  narrowModal.panel && narrowModal.w === 360 && narrowModal.h === 800 && narrowModal.closeVisible
  && narrowAfter.closed && narrowAfter.view === viewBeforeNarrow,
  { narrowModal, narrowAfter })

// ---------- 导出（R09-EXPORT-7 入口三层；R09-EXPORT-2…6 的保真口径在单测里）----------
// 0.6 第 13 行起：**入口 = 设置 → 数据 → 导出页**——上下文快捷（卡片 ⋯ / 编辑器 …的「导出」）打开
// **导出页并预选「当前页面」**（不再各弹一套对话框）；**侧栏不做导出**。浏览器通道写不了文件：
// 整块如实禁用并写明原因（与整库备份同一条规矩）。
await page.evaluate(() => localStorage.clear())
await reload()
await page.waitForSelector('.lcard, .scard', { timeout: NAV_READY_MS })
await sleep(700)
const readExportPage = () => page.evaluate(() => {
  const seg = [...document.querySelectorAll('.seg[aria-label="导出范围"] button')].map((b) => ({ label: (b.textContent ?? '').trim(), on: b.classList.contains('is-on'), disabled: b.disabled }))
  const start = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('开始导出'))
  return {
    crumb: document.querySelector('.set-ph .set-crumb')?.textContent ?? null,
    seg,
    start: start ? { text: (start.textContent ?? '').trim(), disabled: start.disabled } : null,
    note: [...document.querySelectorAll('.set-pane .note')].map((el) => el.textContent ?? '').join(' '),
  }
})
const sidebarHasExport = await page.evaluate(() => [...document.querySelectorAll('.sb-foot button')].some((b) => (b.textContent ?? '').includes('导出 Markdown')))
// ① 正常进设置（非页面上下文）：**不预选「当前页面」**——范围回到默认「全部页面」
await page.evaluate(() => { [...document.querySelectorAll('.sb-foot button')].find((b) => (b.textContent ?? '').includes('设置'))?.click() })
await sleep(700)
await page.evaluate(() => { [...document.querySelectorAll('.set-nav button')].find((b) => (b.textContent ?? '').includes('导出'))?.click() })
await sleep(500)
const exportFromSettings = await readExportPage()
// ② 上下文快捷（卡片 ⋯「导出」）：**先 Esc 关掉 ① 段留着的设置弹窗**（模态的遮罩会挡住 Playwright 的
//    没开就先开——与 D-017 段同一条口径），然后点卡片 ⋯ → 导出 Markdown。
await page.keyboard.press('Escape')
await sleep(500)
await page.evaluate(() => { [...document.querySelectorAll('.sidebar button')].find((b) => (b.textContent ?? '').includes('页面库'))?.click() })
await sleep(600)
if (!(await page.evaluate(() => Boolean(document.querySelector('.lcard, .scard'))))) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /页面列表/.test(x.getAttribute('aria-label') ?? ''))
    b?.click()
  })
  await sleep(700)
}
await page.locator('.lcard, .scard').first().locator('button.pmore').click()
await sleep(500)
await page.locator('.pop button', { hasText: '导出 Markdown' }).first().click()
await sleep(700)
const exportFromCard = await readExportPage()
check('R09-EXPORT-7 入口三层：卡片 ⋯「导出」→ 打开**导出页**并预选「当前页面」（不再弹对话框）；侧栏不做导出；**设置页里没有「当前页面」**（θ15：设置页范围 = 全部页面 / 按标签…两选——用户 2026-10-13「设置页面哪来的当前页面」）；浏览器通道如实禁用并写明原因',
  sidebarHasExport === false
  && exportFromSettings.crumb === null /* 设置页不再用面包屑重复页名 */
  && exportFromSettings.seg.length === 2 && exportFromSettings.seg[0].label === '按标签…' && exportFromSettings.seg[1].on === true /* θ15：设置页两选、默认「全部页面」 */
  && (exportFromSettings.start?.text ?? '').includes('开始导出（') && exportFromSettings.start?.disabled === true
  && exportFromCard.seg.length === 3 && exportFromCard.seg[0].on === true && exportFromCard.seg[2].on === false /* 上下文快捷：当前页面在位且选中 */
  && (exportFromCard.start?.text ?? '').includes('开始导出（1）')
  && (exportFromCard.note ?? '').includes('浏览器预览不提供文件导出'),
  { sidebarHasExport, exportFromSettings, exportFromCard })

// ---------- MD 输入层 · 粘贴侧（R09-MD-3；打字侧还没做）----------
await reset()
await clickBlock('第一段')
await page.evaluate(async () => {
  const mdClip = ['# 粘来的标题', '- 条目一', '  - 子条目', '[x] 已完成', String.fromCharCode(92) + '- 字面减号'].join(String.fromCharCode(10))
  await navigator.clipboard.writeText(mdClip)
})
await page.keyboard.press('Control+v')
await sleep(1800)
const mdPasted = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('.editor-content .moqi-block')]
  return {
    total: blocks.length,
    heading: blocks.some((el) => el.matches('.moqi-block-heading1') && (el.textContent ?? '').includes('粘来的标题')),
    bullet: blocks.some((el) => el.matches('.moqi-block-bullet') && (el.textContent ?? '').includes('条目一')),
    nested: Boolean(document.querySelector('.editor-content .moqi-block-bullet .moqi-block-bullet')),
    todo: blocks.some((el) => el.matches('.moqi-block-todo') && (el.textContent ?? '').includes('已完成')),
    literal: blocks.some((el) => (el.textContent ?? '').trim() === '- 字面减号'),
  }
})
await page.keyboard.press('Control+z')
await sleep(1800)
const mdUndone = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('.editor-content .moqi-block')]
  return { total: blocks.length, gone: !blocks.some((el) => (el.textContent ?? '').includes('粘来的标题')) }
})
check('R09-MD-3 粘贴即转换（编辑器）：Markdown 大纲粘进来 → 标题 / 列表 / 嵌套 / 待办各就各位、反斜杠转义读回字面；⌘Z 一次整批退回',
  mdPasted.heading && mdPasted.bullet && mdPasted.nested && mdPasted.todo && mdPasted.literal
  && mdUndone.gone && mdUndone.total < mdPasted.total,
  { mdPasted, mdUndone })

// ---------- 粘贴认行内引用语法（`[[页名]]` / `((块名))`；T1 / `R09-MD-7` 的引用半边）----------
// 用户 报的 #6：块菜单「复制为块引用」写出的就是这两样语法（`refToken`），粘回来要认。
// 三条判据：认得出的变行内引用（片段 + 引用点两头上账）· 认不出的保持字面（不凭空造页）· ⌘Z 一次整批退。
// 两条语法各走一条解析支：无记号纯文字（「文档」解析）与带 `- ` 记号同一行（「大纲」解析）。
await reset()
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position, extra = {}) => ({ entityId: id, blockUid: uid, type: 'text', content: text ? [{ t: 'text', v: text }] : [], parent, children: [], position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now, ...extra })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    { ...mk('rp-src', 'rpsrc001', '收件页', null, 0, { isObject: true, objectName: '收件页', children: ['rp-b1'] }) },
    mk('rp-b1', 'rpb10001', '第一段', 'rp-src', 0),
    { ...mk('rp-tgt', 'rptgt001', '素材页', null, 1, { isObject: true, objectName: '素材页', children: ['rp-t1'] }) },
    mk('rp-t1', 'rpt10001', '要引用的块', 'rp-tgt', 0),
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(1200)
await clickBlock('第一段')
await page.keyboard.press('End')
await page.evaluate(async () => { await navigator.clipboard.writeText('看这条 [[素材页]] 和 ((要引用的块)) 与 [[查无此页]] 哦') })
await page.keyboard.press('Control+v')
const refPaste = await poll(() => page.evaluate(() => {
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => !b.deleted)
  const row = blocks.find((b) => (b.content ?? []).some((f) => f.t === 'inline-ref'))
  const tgtPage = blocks.find((b) => b.entityId === 'rp-tgt')
  const tgtBlock = blocks.find((b) => b.entityId === 'rp-t1')
  return {
    refs: (row?.content ?? []).filter((f) => f.t === 'inline-ref').map((f) => `${f.ref.kind}:${f.ref.targetId}`),
    text: (row?.content ?? []).map((f) => f.v).join(''),
    pageBack: tgtPage?.objectBackRefs ?? [],
    blockBack: (tgtBlock?.blockBackRefs ?? []).map((r) => r.fromBlockId),
    pages: blocks.filter((b) => b.isObject).map((b) => b.objectName),
    domRefs: [...document.querySelectorAll('.editor-content .moqi-inline-ref')].map((el) => (el.textContent ?? '').trim()),
  }
}), (value) => value.refs.length === 2, { label: '两条行内引用落库' })
check('R09-MD-7 粘贴认行内引用（无记号纯文字）：`[[页名]]` / `((块名))` 认得出 → 行内引用（片段 + 引用点两头上账、DOM 里两条）；认不出（`[[查无此页]]`）→ 保持字面、不凭空造页',
  refPaste.refs.includes('object:rp-tgt') && refPaste.refs.includes('block:rp-t1')
  && refPaste.text === '看这条 素材页 和 要引用的块 与 [[查无此页]] 哦'
  && refPaste.pageBack.length === 1 && refPaste.blockBack.length === 1
  && refPaste.pages.length === 2 && !refPaste.pages.includes('查无此页')
  && refPaste.domRefs.length === 2 && !refPaste.domRefs.some((text) => text.includes('查无此页')),
  refPaste)

// 带 `- ` 记号同一行：记号照常转块、引用照常认（两条解析支都要覆盖）
await clickBlock('第一段')
await page.keyboard.press('End')
await page.evaluate(async () => { await navigator.clipboard.writeText('- 也见 [[素材页]] 哦') })
await page.keyboard.press('Control+v')
const refPasteMarked = await poll(() => page.evaluate(() => {
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => !b.deleted)
  const bullet = blocks.find((b) => b.type === 'bullet' && (b.content ?? []).some((f) => f.t === 'inline-ref'))
  return {
    type: bullet?.type ?? null,
    refs: (bullet?.content ?? []).filter((f) => f.t === 'inline-ref').map((f) => `${f.ref.kind}:${f.ref.targetId}`),
    pageBack: (blocks.find((b) => b.entityId === 'rp-tgt')?.objectBackRefs ?? []).length,
  }
}), (value) => value.refs.length === 1, { label: '带记号行的引用落库' })
check('R09-MD-7 粘贴认行内引用（与 `- ` 记号同一行）：记号照常转项目符号、`[[素材页]]` 照常认成行内引用（两条解析支同源）',
  refPasteMarked.type === 'bullet' && refPasteMarked.refs.includes('object:rp-tgt') && refPasteMarked.pageBack === 2,
  refPasteMarked)

// ⌘Z 一次整批退：先退带记号那条（反链 2 → 1），再退第一条（引用点与反链全清）
await page.keyboard.press('Control+z')
const refUndoneOne = await poll(() => page.evaluate(() => {
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => !b.deleted)
  return {
    bulletRefs: blocks.filter((b) => b.type === 'bullet' && (b.content ?? []).some((f) => f.t === 'inline-ref')).length,
    pageBack: (blocks.find((b) => b.entityId === 'rp-tgt')?.objectBackRefs ?? []).length,
  }
}), (value) => value.bulletRefs === 0, { label: '第一次 ⌘Z 后退掉带记号那条' })
await page.keyboard.press('Control+z')
const refUndoneAll = await poll(() => page.evaluate(() => {
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => !b.deleted)
  return {
    anyRef: blocks.some((b) => (b.content ?? []).some((f) => f.t === 'inline-ref')),
    pageBack: (blocks.find((b) => b.entityId === 'rp-tgt')?.objectBackRefs ?? []).length,
    blockBack: (blocks.find((b) => b.entityId === 'rp-t1')?.blockBackRefs ?? []).length,
    domRefs: document.querySelectorAll('.editor-content .moqi-inline-ref').length,
  }
}), (value) => !value.anyRef, { label: '第二次 ⌘Z 后引用全清' })
check('R09-MD-7 粘贴认行内引用：⌘Z 一次整批退回（引用点与反链一起退，不留悬空）',
  refUndoneOne.pageBack === 1 && refUndoneAll.pageBack === 0 && refUndoneAll.blockBack === 0 && refUndoneAll.domRefs === 0,
  { refUndoneOne, refUndoneAll })

// ---------- MD 输入层 · 打字侧（R09-MD-2/4；粘贴侧见上一条）----------
await reset()
await clickBlock('第一段')
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await sleep(900)
await page.keyboard.type('- ')
await sleep(800)
const markered = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('.editor-content .moqi-block')]
  return { emptyBullet: blocks.some((el) => el.matches('.moqi-block-bullet') && (el.textContent ?? '').trim() === '') }
})
await page.keyboard.type('条目一')
await sleep(900)
const typedBullet = await page.evaluate(() => [...document.querySelectorAll('.editor-content .moqi-block')].some((el) => el.matches('.moqi-block-bullet') && (el.textContent ?? '').includes('条目一')))
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await sleep(900)
await page.keyboard.type('**粗**')
await sleep(1300)
const inlineTyped = await page.evaluate(() => {
  const block = [...document.querySelectorAll('.editor-content .moqi-block')].pop()
  return { cls: block?.className ?? '', text: (block?.textContent ?? '').trim(), bold: (block?.querySelector('.tx-b')?.textContent ?? '').trim() }
})
await page.keyboard.press('Control+z')
await sleep(1300)
const inlineUndone = await page.evaluate(() => ([...document.querySelectorAll('.editor-content .moqi-block')].pop()?.textContent ?? '').trim())
check('R09-MD-3 打字触发（编辑器）：打 `- ` 当场变项目符号（触发词被吞掉）、接着打的字进那一块；`**粗**` 成对闭合当场变粗体、⌘Z 一次撤掉这次转换（记号回到正文里可继续编辑）',
  markered.emptyBullet && typedBullet
  && inlineTyped.text === '粗' && inlineTyped.bold === '粗'
  && !inlineUndone.includes('粗*粗') && inlineUndone.includes('*') && inlineUndone.includes('粗'),
  { markered, typedBullet, inlineTyped, inlineUndone })
// ---------- 媒体块（13-媒体设计（已归档） §4 三管道；R09-BLOCK-19/20）----------
// 桌面拖入给路径（Tauri 事件）在浏览器里跑不到，这里验两条能在浏览器端到端跑通的：粘贴截图、菜单选文件。
await reset()
await clickBlock('第一段')
await page.evaluate(async () => {
  // 现画一张真 PNG（240×120）：1×1 透明或手搓 base64 会让「看不到图」与「图没加载」混淆——
  // 验收的第一版就吃过这个亏（图片环节全过、肉眼一片空）。
  const canvas = document.createElement('canvas')
  canvas.width = 240
  canvas.height = 120
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#5E6AD2'
  ctx.fillRect(0, 0, 240, 120)
  const blob = await new Promise((resolve) => canvas.toBlob((value) => resolve(value), 'image/png'))
  const data = new DataTransfer()
  data.items.add(new File([blob], 'clip.png', { type: 'image/png' }))
  const target = document.querySelector('.editor-content [contenteditable="true"], .editor-content .moqi-block')
  target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
})
// （）固定 1600ms 的等待窗在机器忙时不够——两遍假红（148/149），而独立探针复刻同一动作
// 0.8s 内图片块就带着完整资产落库（App 无回归）⇒ 改轮询：最多 ~6s、每 400ms 读一次，命中即停。
const readPasted = () => page.evaluate(() => {
  const el = document.querySelector('.editor-content .moqi-block-image')
  const stored = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => b.type === 'image')
  return {
    name: el?.dataset.assetName ?? null,
    hasUrl: (el?.style.getPropertyValue('--asset-url') ?? '').length > 0,
    missing: el?.classList.contains('is-asset-missing') ?? true,
    payload: stored.map((b) => ({ original: b.asset?.originalName, file: b.asset?.fileName ?? null, size: b.asset?.size ?? null })),
  }
})
let mediaPasted = await readPasted()
for (let i = 0; i < 14 && (mediaPasted.payload?.length ?? 0) === 0; i += 1) {
  await sleep(400)
  mediaPasted = await readPasted()
}
// 菜单选文件 → 附件块（headless 里用 filechooser 接住）
const mediaChooser = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null)
await page.evaluate(() => { const b = document.querySelector('button[aria-label="插入新块"]') ?? [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').includes('插入')); b?.click() })
await sleep(600)
const insertMenuLabels = await page.evaluate(() => [...document.querySelectorAll('.pop button')].map((b) => (b.textContent ?? '').replace(/[▸▾]/g, '').trim()))
check('R09-FMT-5 / R09-AIB-8 插入菜单（＋插入 ▾，与斜杠菜单同源）：八项齐全（含今天 / 现在）、**没有「AI 块」**（2026-10-08 用户裁决：插一个空 AI 块没有用）',
  ['待办', '引用', '代码', '嵌入块', '图片块', '附件块'].every((label) => insertMenuLabels.includes(label))
  && insertMenuLabels.every((label) => !label.includes('AI')),
  { insertMenuLabels })
await page.evaluate(() => { const b = [...document.querySelectorAll('.pop button')].find((x) => (x.textContent ?? '').includes('附件块')); b?.click() })
const mediaPicked = await mediaChooser
if (mediaPicked) await mediaPicked.setFiles({ name: '周报 数据.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2') })
await sleep(1600)
const mediaAttached = await page.evaluate(() => {
  const el = document.querySelector('.editor-content .moqi-block-file')
  const stored = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => b.type === 'file')
  return { name: el?.dataset.assetName ?? null, payload: stored.map((b) => ({ original: b.asset?.originalName, size: b.asset?.size ?? null })) }
})
check('R09-BLOCK-19/20 媒体三管道（浏览器验两条）：粘贴截图 → 图片块（显示地址挂上、payload 落库）；菜单「附件块」→ 选文件 → 附件卡（原名 + 大小）',
  (mediaPasted.name ?? '').includes('clip') && mediaPasted.hasUrl && mediaPasted.missing === false
  && mediaPasted.payload.length === 1 && (mediaPasted.payload[0].file ?? '').length > 12 && mediaPasted.payload[0].size > 0
  && mediaAttached.name === '周报 数据.csv' && mediaAttached.payload.length === 1 && mediaAttached.payload[0].size === 7,
  { mediaPasted, mediaAttached })

// 灯箱（`R09-BLOCK-19`「点击预览大图」）：点图片区域开、缩放可用、Esc 收起；点图注不算（那是编辑）。
const lbSpot = await page.evaluate(() => {
  const el = document.querySelector('.editor-content .moqi-block-image')
  if (!el) return null
  const rect = el.getBoundingClientRect()
  return { image: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 16) }, caption: { x: Math.round(rect.left + 30), y: Math.round(rect.bottom - 12) } }
})
if (lbSpot) await page.mouse.click(lbSpot.image.x, lbSpot.image.y)
await sleep(700)
const lightbox = await page.evaluate(() => {
  const mask = document.querySelector('.lb-mask')
 // θ17（ 用户裁定）：工具条**图标化**（中文名进 aria-label）、文件名 / 大小不上条——判据读 aria。
  return mask ? { buttons: [...mask.querySelectorAll('.lb-bar button')].map((b) => b.getAttribute('aria-label') ?? (b.textContent ?? '').trim()) } : null
})
const lightboxZoom = await (async () => {
  await page.evaluate(() => { document.querySelector(".lb-bar button[aria-label='放大']")?.click() })
  await sleep(400)
  return page.evaluate(() => {
    const img = document.querySelector('.lb-stage img')
    return { transform: img?.style.transform ?? 'fit', loaded: (img?.naturalWidth ?? 0) > 0, width: img?.naturalWidth ?? 0 }
  })
})()
await page.keyboard.press('Escape')
await sleep(500)
const lightboxClosed = await page.evaluate(() => document.querySelector('.lb-mask') === null)
check('R09-BLOCK-19 图片预览（θ17 两态：桌面 / 编辑态 = 工具条）：点图片区域开、**工具条图标化**（缩小 / 放大 / 保存副本 / 关闭 —— 中文名在 `aria-label`，**文件名与大小不上条**；**「适应」键已按用户 2026-10-14 裁决去掉**，点图本身 = 回适应）、**图片真的加载出尺寸**、放大真的改倍率（`scale(1)`）、Esc 收起——点图注仍是编辑不进灯箱',
  lightbox !== null && lightbox.buttons.join('/') === '缩小/放大/保存副本/关闭' && !lightbox.buttons.includes('适应')
  && lightboxZoom.transform === 'scale(1)' && lightboxZoom.loaded && lightboxZoom.width > 0 && lightboxClosed,
  { lbSpot, lightbox, lightboxZoom, lightboxClosed })

// D-071（ · 图片块真比例）：块内 `::before` 高 ≈ 内容宽 ÷ `--asset-ratio`。
// 关键态 = `data-own-line='missing'`（图片块带子块、无图注）——修前该态被「补行规则」整条劫持：
// `::before` 被换成 1lh 空行（真机读数 21.67px，竖屏图压成一根细条）。
// 两半：① 直置 missing 回到 D-071 现场；② 自然路径——图片块下一个兄弟 Tab 缩进成它的子块
// （图片是末块时走不到，跳过自然半边，由 ① 兜底）。
// 负例（本项的鉴别力）：把补行规则的 `:not(.moqi-block-image)` 抹掉 ⇒ `missing` 高塌成 1lh ⇒ 必红。
const inBlock = await page.evaluate(() => {
  const el = document.querySelector('.editor-content .moqi-block-image')
  if (!el) return null
  const read = () => { const s = getComputedStyle(el, '::before'); return { h: parseFloat(s.height), w: parseFloat(s.width) } }
  const ratio = parseFloat(el.style.getPropertyValue('--asset-ratio')) || 16 / 9
  const prev = el.dataset.ownLine
  el.dataset.ownLine = 'present'
  const present = read()
  el.dataset.ownLine = 'missing'
  const missing = read()
  el.dataset.ownLine = prev
  return { ratio, present, missing }
})
const childSpot = await page.evaluate(() => {
  const img = document.querySelector('.editor-content .moqi-block-image')
  let el = img?.nextElementSibling
  while (el && !(el.classList?.contains('moqi-block'))) el = el.nextElementSibling
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }
})
let naturalChild = null
if (childSpot) {
  await page.mouse.click(childSpot.x, childSpot.y)
  await sleep(280)
  await page.keyboard.press('Tab')
  await sleep(500)
  naturalChild = await page.evaluate(() => {
    const el = document.querySelector('.editor-content .moqi-block-image')
    const s = getComputedStyle(el, '::before')
    return { ownLine: el.dataset.ownLine ?? null, h: parseFloat(s.height), w: parseFloat(s.width), kids: el.querySelectorAll(':scope > .moqi-block').length }
  })
}
const ratioNear = (m, ratio) => Boolean(m) && m.h > 40 && Math.abs(m.h - m.w / ratio) <= 2
check('R09-BLOCK-19 块内真比例（D-071）：图片块 `::before` 高 ≈ 内容宽 ÷ `--asset-ratio`——`present` 与**带子块无图注的 `missing` 态**（含自然路径：兄弟块 Tab 缩进进图片）都按真比例（负例：补行规则不加图片排除 ⇒ `missing` 态高塌成 1lh、本项必红）',
  ratioNear(inBlock?.present, inBlock?.ratio ?? 2) && ratioNear(inBlock?.missing, inBlock?.ratio ?? 2)
  && (naturalChild === null || (naturalChild.ownLine === 'missing' && naturalChild.kids >= 1 && ratioNear({ h: naturalChild.h, w: naturalChild.w }, inBlock?.ratio ?? 2))),
  { inBlock, naturalChild })

// ---------- 嵌入块第二步（`R09-BLOCK-24`）：选源 / 只读快照 / 一步撤销 / 来源跳转 / 悬空降级 ----------
// 与 `tests/domain.test.ts` 的 R09-BLOCK-24 四条分工：那边验**规则**（一步撤销、拒祖先、正文上限、导出快照），
// 这边验**界面真的按数据长出来**：空态卡 → 选来源 → 只读正文 + 胶囊 → 一次撤销 → 跳来源 → 源被删降级。
// 造数据用 localStorage 直写（与 LIB-MENU 那条同一手法），省掉一串打字步骤。
await page.evaluate(() => {
  const now = Date.now()
  const block = (input) => {
    const base = {
      type: 'text', content: [], parent: null, children: [], position: 0, collapsed: false, checked: false,
      deleted: false, deletedAt: null, prevParent: null, prevIndex: null, blockRefs: [], blockBackRefs: [],
      objectRefs: [], objectBackRefs: [], isObject: false, objectName: null, properties: [], tags: [],
      asset: null, aiMeta: null, created: now, modified: now,
    }
    return { ...base, ...input }
  }
  const text = (value) => [{ t: 'text', v: value }]
  const srcPage = block({ entityId: 'src-page', blockUid: 'srcpage01', isObject: true, objectName: '素材页', content: text('素材页'), children: ['src-1', 'src-2'] })
  const src1 = block({ entityId: 'src-1', blockUid: 'src100001', parent: 'src-page', position: 0, content: text('小节'), children: ['src-1a'] })
  const src1a = block({ entityId: 'src-1a', blockUid: 'src1a0001', parent: 'src-1', position: 0, content: text('小节里的细节') })
  const src2 = block({ entityId: 'src-2', blockUid: 'src200001', parent: 'src-page', position: 1, content: text('另一段') })
  const hostPage = block({ entityId: 'host-page', blockUid: 'hostpage1', isObject: true, objectName: '收件页', content: text('收件页'), children: ['host-1', 'host-embed'] })
  const host1 = block({ entityId: 'host-1', blockUid: 'host10001', parent: 'host-page', position: 0, content: text('正文一段') })
  const hostEmbed = block({ entityId: 'host-embed', blockUid: 'hostembed', type: 'embed', parent: 'host-page', position: 1 })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([hostPage, host1, hostEmbed, srcPage, src1, src1a, src2]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(1400)

// 卡头占位必须是**真的**：`content:none` 的伪元素根本不生成，`minHeight` 照样读出 34px
// （ 实测：占位是死的，正文分隔线切进副行）——所以用「藏掉 ::before 前后的卡高差」当证据。
const headReserve = (page) => page.evaluate(() => {
  const card = document.querySelector('.moqi-block-embed')
  if (!card) return null
  const style = document.createElement('style')
  document.head.appendChild(style)
  const height = () => card.getBoundingClientRect().height
  const withReserve = height()
  style.textContent = '.moqi-block-embed::before{display:none !important}'
  const without = height()
  style.remove()
  return Math.round(withReserve - without)
})

const embedEmpty = await page.evaluate(() => {
  const card = document.querySelector('.moqi-block-embed')
  if (!card) return null
  const style = getComputedStyle(card)
  const head = getComputedStyle(card, '::before')
  const title = document.querySelector('.eb-t')
  const pill = document.querySelector('.eb-pill')
  // 解析 `--accent-soft` 的 rgb，用来断言胶囊底色用的是它（原型 `.eb-go` 的实底，不是描边白底）。
  const probe = document.createElement('span')
  probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--accent-soft').trim()
  document.body.appendChild(probe)
  const softRgb = getComputedStyle(probe).color
  probe.remove()
  return {
    state: card.dataset.embedState,
    pill: pill?.textContent ?? null,
    icon: document.querySelector('.eb-icon') !== null,
    padding: `${style.paddingTop} ${style.paddingRight}`,
    // 卡头高度与 `EMBED_CARD_GEOMETRY.head` 是同一组数字（CSS 与规则不许漂移）。
    headHeight: head.minHeight,
  // 卡头保真（，按原型 `.eb-t` / `.eb-s` / `.eb-go`）：标题 13/600、副行常量、胶囊实底无边框。
    title: title?.textContent ?? null,
    titleFont: title ? `${getComputedStyle(title).fontSize}/${getComputedStyle(title).fontWeight}` : null,
    sub: document.querySelector('.eb-s')?.textContent ?? null,
    pillStyle: pill ? `${getComputedStyle(pill).fontSize}/${getComputedStyle(pill).borderTopWidth}/${getComputedStyle(pill).backgroundColor === softRgb ? 'soft' : 'other'}` : null,
  }
})

// 空态：预留 = 34（`[data-embed-body='']::before` 把下距归零）。
const reserveEmpty = await headReserve(page)

// 点空态卡 → 「选择来源页面 / 块」对话框：页面在前、块在后，两档都在。
await page.click('.moqi-block-embed')
await sleep(900)
const embedPicker = await page.evaluate(() => ({
  open: document.querySelector('.dlg') !== null,
  rows: [...document.querySelectorAll('.dlg .fd-item')].map((row) => row.textContent ?? ''),
}))
// 选「小节」这一块（不是整页：正文要能看出子块缩进）
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.dlg .fd-item')].find((item) => (item.textContent ?? '').includes('小节里的细节') === false && (item.textContent ?? '').startsWith('块小节'))
  row?.click()
})
await sleep(1600)
const embedFilled = await page.evaluate(() => {
  const card = document.querySelector('.moqi-block-embed')
  return {
    state: card?.dataset.embedState ?? null,
    title: card?.dataset.embedTitle ?? null,
    body: card?.dataset.embedBody ?? null,
    pill: document.querySelector('.eb-pill')?.textContent ?? null,
    toast: document.querySelector('.notice')?.textContent ?? null,
  }
})
// 有正文：预留 = 34 + 9（卡头 + 原型 `.eb-head` 的 margin-bottom）。
const reserveFilled = await headReserve(page)

// 一次 ⌘Z 回到空态、⇧⌘Z 回到有来源（换源只占一个撤销步是领域规则，这里验界面跟着走）。
await page.keyboard.press('Control+z')
await sleep(1000)
const embedUndo = await page.evaluate(() => document.querySelector('.moqi-block-embed')?.dataset.embedState ?? null)
await page.keyboard.press('Control+Shift+z')
await sleep(1000)
const embedRedo = await page.evaluate(() => document.querySelector('.moqi-block-embed')?.dataset.embedState ?? null)

check('R09-BLOCK-24 嵌入卡（空态 → 选来源 → 只读快照）：卡片几何按规则表（12/14、卡头 34 **且占位是真盒子**：空态藏掉它矮 34、有正文矮 43）、卡头保真（标题 13/600、副行、胶囊实底无边框）、空态是「选择来源 ↗」、对话框两档候选齐、选完出「页 › 块」标题与源子树正文（子块缩进）、一次 ⌘Z 回到空态',
  embedEmpty !== null && embedEmpty.state === 'empty' && embedEmpty.pill === '选择来源 ↗' && embedEmpty.icon
  && embedEmpty.padding === '12px 14px' && embedEmpty.headHeight === '34px'
  && reserveEmpty === 34 && reserveFilled === 43
  && embedEmpty.title === '选择来源页面 / 块' && embedEmpty.titleFont === '13px/600'
  && embedEmpty.sub === '嵌入块 · 引用自其他页面' && embedEmpty.pillStyle === '11px/0px/soft'
  && embedPicker.open && embedPicker.rows.some((row) => row.startsWith('页')) && embedPicker.rows.some((row) => row.startsWith('块'))
  && embedFilled.state === 'ok' && embedFilled.title === '素材页 › 小节' && (embedFilled.body ?? '').includes('小节里的细节')
  && embedFilled.pill === '来源 ↗' && embedUndo === 'empty' && embedRedo === 'ok',
  { embedEmpty, reserveEmpty, reserveFilled, embedPicker: embedPicker.rows.slice(0, 6), embedFilled, embedUndo, embedRedo })

// 「来源 ↗」跳到源——跨页时先切页（胶囊点了要落到素材页，且目标块闪烁）。
await page.click('.eb-pill')
// 读点加固（，第六刀那轮红过一次）：闪烁实测只持续 ~1.6s，**固定 sleep(1500) 正好卡在它结束附近**
// ——改成轮询到「已切页 + 目标块在闪」为止（有界 4s），把这条竞态读出来。
const embedJump = await poll(
  () => page.evaluate(() => ({
    page: document.querySelector('.editor-content .moqi-block[data-block-object="true"]')?.textContent?.slice(0, 6) ?? null,
    flash: document.querySelector('.is-flash') !== null,
  })),
  (s) => (s.page ?? '').startsWith('素材页') && s.flash,
  { label: '嵌入来源跳转（切页并闪烁）', timeout: 4000 },
)
check('R09-BLOCK-24 嵌入卡「来源 ↗」：跨页先切页再落到源块并闪烁（跳转与反链/搜索同一条路）',
  (embedJump.page ?? '').startsWith('素材页') && embedJump.flash,
  embedJump)

// 源页移入回收站 → 卡降级成「来源已删除」（数据合法、界面降级；裁决 #6）。
await page.evaluate(() => { const el = [...document.querySelectorAll('button, a')].find((x) => (x.textContent ?? '').trim() === '页面库'); if (el) el.click() })
await sleep(1200)
await page.evaluate(() => {
  const card = [...document.querySelectorAll('.lcard, .scard')].find((item) => (item.textContent ?? '').includes('素材页'))
  card?.querySelector('button.pmore')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  card?.querySelector('button.pmore')?.click()
})
await sleep(700)
await page.locator('.pop button').filter({ hasText: '移至回收站' }).click()
await sleep(500)
await page.getByRole('button', { name: '移入回收站' }).click()
await sleep(900)
await page.evaluate(() => {
  const card = [...document.querySelectorAll('.lcard, .scard')].find((item) => (item.textContent ?? '').includes('收件页'))
  card?.click()
})
await sleep(1500)
const embedDangling = await page.evaluate(() => {
  const card = document.querySelector('.moqi-block-embed')
  return { state: card?.dataset.embedState ?? null, body: card?.dataset.embedBody ?? '', pill: document.querySelector('.eb-pill')?.textContent ?? null }
})
check('R09-BLOCK-24 嵌入悬空：源页进回收站后卡降级为「来源已删除」（正文清空、胶囊回到「选择来源 ↗」），反链计数天然含嵌入',
  embedDangling.state === 'dangling' && embedDangling.body === '' && embedDangling.pill === '选择来源 ↗',
  embedDangling)

// ---------- 导入（13-导出与媒体设计（已归档） §「导入」；规则 `R09-MD-3` 的记号表）----------
// 入口 = **把 `.md` 拖进正文**（与媒体三条录入管道同一条拖放通路）。这里验浏览器通道：
// 字节直接读、读不到旁边的 `assets/` ⇒ 媒体行**降级成文字**并如实提示（桌面通道会把文件落进数据目录，
// 那一条要真窗口，见 `07-V3` 清单 E）。
await reset()
const importMarkdown = [
  '---',
  'tags: [导入测试, 草稿]',
  '状态: 进行中',
  '---',
  '',
  '引言一段。',
  '',
  '# 导入出来的页',
  '',
  '## 小节一',
  '',
  '- 条目一',
  '- [x] 做完的',
  '',
  '> 引用一句',
  '',
  '对齐 [测试笔记](测试笔记.md)，另见 [不存在的页](不存在的页.md)。',
  '![封面](assets/封面.png)',
  '[数据.csv](assets/数据.csv)',
  '',
  '结尾一句。',
].join('\n')
await page.evaluate((text) => {
  const data = new DataTransfer()
  data.items.add(new File([text], '导入样本.md', { type: 'text/markdown' }))
  const target = document.querySelector('.editor-content .moqi-block') ?? document.querySelector('.doc-col')
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
}, importMarkdown)
await sleep(2200)
const imported = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.editor-content .moqi-block')]
  return {
    name: document.querySelector('.doc-col .moqi-block[data-block-object="true"]')?.textContent?.slice(0, 10) ?? null,
    types: rows.map((el) => el.dataset.blockType),
    texts: rows.map((el) => (el.textContent ?? '').trim().slice(0, 44)),
    brief: document.querySelector('.prop-brief')?.textContent?.replace(/\s+/g, ' ').slice(0, 48) ?? null,
    toast: document.querySelector('.notice')?.textContent ?? null,
    // 引用还原：导出把 `[[ ]]` 降级成 `[名](名.md)`，导入要还原成页面引用（`.moqi-inline-ref`）。
    refs: [...document.querySelectorAll('.editor-content .moqi-inline-ref')].map((el) => ({ kind: el.dataset.refKind, text: (el.textContent ?? '').trim() })),
    // 对不上的那条保持文字（不凭空造页）——整页文字拼起来找它。
    blind: rows.map((el) => (el.textContent ?? '').trim()).join(' '),
  }
})
check('R09-MD-3 导入（拖入 .md）：建一页（页名取第一处 `# ` 标题）、块类型照记号表落（含列表里的勾选框）、front-matter 的标签与属性按名落到页头、**读不到的媒体行在正文里降级可见**（不静默丢）',
  // 第 0 项是**页面容器自己**（它也是个 .moqi-block），正文从第 1 项起；页名那行只取前 6 个字比较。
  (imported.name ?? '').startsWith('导入出来的页')
  && imported.types.slice(1, 7).join(',') === 'text,heading2,bullet,todo,quote,text'
  && imported.texts.some((text) => text.startsWith('［图片］封面（未找到 assets/封面.png）'))
  && imported.texts.some((text) => text.startsWith('［附件］数据.csv（未找到 assets/数据.csv）'))
  && imported.texts.some((text) => text.includes('结尾一句。'))
  // 引用还原：`[测试笔记](测试笔记.md)` 认出库里那一页 → 变成页面引用；对不上的那条保持文字。
  // 这一条验**降级不静默**：这份样本里的两个页面链接在种子库里都不存在 ⇒ 保持文字 + 提示报数。
  // 「对得上就还原成页面引用（片段 + 引用点一起写、反链上账）」走 test:R09-EXPORT-2 那两条（能造库、更准）。
  && imported.refs.length === 0
  && imported.blind.includes('[测试笔记](测试笔记.md)') && imported.blind.includes('[不存在的页](不存在的页.md)')
  && imported.toast === null
  && imported.brief.includes('状态: 进行中') && imported.brief.includes('导入测试') && imported.brief.includes('草稿'),
  imported)

// ---------- 导入包（第 13 项「拖入 zip」，）：包是 .zip、备份包嗅探、图从包里落 ----------
// 普通包：2 篇 .md（含包内图片引用）+ 1 张图 + 1 个 html（报数）+ macOS 杂物（静默）→ 建 2 页、图落地。
// 备份包（含 project-b.sqlite3）：**不按页面导入**、如实指路「设置 › 备份与恢复」（数据风险点，场景 G）。
const { zipSync, strToU8 } = await import('fflate')
const zipPng = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0))
const zipPack = zipSync({
  '包内页一.md': strToU8('# 包内页一\n\n引言一段。\n\n![图](assets/图.png)\n'),
  'sub/包内页二.md': strToU8('# 包内页二\n\n第二页正文。\n'),
  'assets/图.png': zipPng,
  'notes.html': strToU8('<p>x</p>'),
  '__MACOSX/._junk': strToU8('junk'),
})
const zipB64 = Buffer.from(zipPack).toString('base64')
const dropZip = async (payload, name) => {
  await page.evaluate(({ payload: data, name: fileName }) => {
    const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], fileName, { type: 'application/zip' }))
    const target = document.querySelector('.editor-content .moqi-block') ?? document.querySelector('.doc-col')
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, { payload, name })
}
await reset()
await dropZip(zipB64, '导入包.zip')
await sleep(2600)
const zipImported = await page.evaluate(() => {
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
  return {
    pages: blocks.filter((b) => b.isObject && !b.deleted).map((b) => b.objectName).filter((name) => name.startsWith('包内页')),
    imageAsset: blocks.find((b) => b.type === 'image')?.asset?.originalName ?? null,
    toast: document.querySelector('.notice')?.textContent ?? null,
    openPage: document.querySelector('.doc-col .moqi-block[data-block-object="true"]')?.textContent?.slice(0, 8) ?? null,
  }
})
const backupPack = zipSync({ 'project-b.sqlite3': strToU8('not a real db') })
await dropZip(Buffer.from(backupPack).toString('base64'), '墨契-备份-2026-10-11.zip')
await sleep(1400)
const zipBackup = await page.evaluate(() => ({
  toast: document.querySelector('.notice')?.textContent ?? null,
  pages: JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => b.isObject && !b.deleted).length,
}))
check('IMPORT-ZIP-1 导入包（第 13 项「拖入 zip」）：拖入 .zip = 一次建 N 个页面（允许同名）· 包内的图按相对引用落地 · **备份包（含数据库）不按页面导入、指路「设置 › 备份与恢复」**',
  [...zipImported.pages].sort().join('/') === '包内页一/包内页二'
  && zipImported.imageAsset === '图.png'
  && zipImported.toast === null
  && zipImported.pages.some((name) => (zipImported.openPage ?? '').startsWith(name)) /* 开的是导入的那几篇之一（第一篇按路径序） */
  && (zipBackup.toast ?? '').includes('整库备份包')
  && (zipBackup.toast ?? '').includes('设置 › 备份与恢复')
  && zipBackup.pages === zipImported.pages.length + 1 /* 基线页 + 新建 1 页 */
  , { zipImported, zipBackup })


// ---------- 侧栏「星标」（`R09-PRIN-1`，活原型 `#navStar`）----------
// 用户 报的功能缺失：星标能力早就有（卡片 ⋯ 与 … 菜单都能星标），但侧栏导航没入口。
// 判据：入口在「页面库」下面、带计数徽章；点它进的是**同一个页面库**、只把 star 档拨到「只看星标」；
// 激活态有背景（与页面库同一条 `is-active` 胶囊）；再点一下取消。
await reset()
const starDefault = await page.evaluate(() => {
  const item = [...document.querySelectorAll('.sidebar .sb-nav')].find((el) => (el.textContent ?? '').includes('页面库'))
  const cnt = item?.querySelector('.cnt')
  return { active: item?.classList.contains('is-active') ?? null, cntColor: cnt ? getComputedStyle(cnt).color : null, bg: item ? getComputedStyle(item).backgroundColor : null }
})
// 星标为 0 时整行隐藏（零计数不占位）。
const starHiddenAtZero = await page.evaluate(() => ![...document.querySelectorAll('.sidebar .sb-nav')].some((el) => (el.textContent ?? '').includes('星标')))
// 先给种子页星标（走卡片 ⋯ 里那条真路）
await page.evaluate(() => {
  const card = document.querySelector('.lcard, .scard')
  card?.querySelector('button.pmore')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  card?.querySelector('button.pmore')?.click()
})
await sleep(700)
await page.locator('.pop button').filter({ hasText: '星标' }).first().click()
await sleep(900)
const afterStar = await page.evaluate(() => {
  const navs = [...document.querySelectorAll('.sidebar .sb-nav')]
  const item = navs.find((el) => (el.textContent ?? '').includes('星标'))
  return {
    labels: navs.map((el) => (el.textContent ?? '').trim().slice(0, 6)),
    title: item?.getAttribute('title') ?? null,
    count: (item?.querySelector('.cnt')?.textContent ?? '').trim(),
    active: item?.classList.contains('is-active') ?? null,
  }
})
// 点它 → 只看星标（同一个页面库）
await page.evaluate(() => { const item = [...document.querySelectorAll('.sidebar .sb-nav')].find((el) => (el.textContent ?? '').includes('星标')); item?.click() })
await sleep(900)
const starredOn = await page.evaluate(() => {
  const item = [...document.querySelectorAll('.sidebar .sb-nav')].find((el) => (el.textContent ?? '').includes('星标'))
  const chips = [...document.querySelectorAll('.lcard, .scard')]
  const style = item ? getComputedStyle(item) : null
  return {
    active: item?.classList.contains('is-active') ?? null,
    background: style?.backgroundColor ?? null,
    cards: chips.length,
    filterOn: document.querySelector('.lib-chips')?.textContent?.includes('星标') ?? null,
    libraryActive: [...document.querySelectorAll('.sidebar .sb-nav')].find((el) => (el.textContent ?? '').includes('页面库'))?.classList.contains('is-active') ?? null,
  }
})
// 再点一下 = 取消（与筛选面板里取消勾选同一件事）
await page.evaluate(() => { const item = [...document.querySelectorAll('.sidebar .sb-nav')].find((el) => (el.textContent ?? '').includes('星标')); item?.click() })
await sleep(800)
const starredOff = await page.evaluate(() => {
  const item = [...document.querySelectorAll('.sidebar .sb-nav')].find((el) => (el.textContent ?? '').includes('星标'))
  return { active: item?.classList.contains('is-active') ?? null, cards: document.querySelectorAll('.lcard, .scard').length }
})
check('R09-PRIN-1 侧栏星标入口：在「页面库」下面、带计数徽章与「只看星标页面」说明；星标一页后徽章 +1；点它进同一个页面库只留星标页、**激活态有背景**；再点一下取消',
  // 标签里带计数徽章（「页面库1」「星标0」）⇒ 用前缀比。
  starHiddenAtZero === true
  && (afterStar.labels[0] ?? '').startsWith('页面库') && (afterStar.labels[1] ?? '').startsWith('星标')
  && afterStar.title === '只看星标页面' && afterStar.count === '1' && afterStar.active === false
  && starredOn.active === true && starredOn.background !== 'rgba(0, 0, 0, 0)' && starredOn.cards <= 1
  && starredOff.active === false
  && starredOn.libraryActive === false,
  // 页面库的激活态与它的徽章：默认态里页面库亮（活原型 navLib 默认 active）。
  { starHiddenAtZero, starDefault, afterStar, starredOn, starredOff },
  { starHiddenAtZero, afterStar, starredOn, starredOff })

// ---------- 手机最小批（A 批）：手机排版档 + 悬浮 FAB（`10` §五 / §2.3 的回填值）----------
// 窄视口（360×800）下的四组数：标准档降一档（--fs-e 15px / --lh-e 1.7；小 / 大 / 特大沿用桌面值 15 / 19 / 21）、
// 列宽轴归一（--colw 100%——移动没有列宽轴）、页面名 1.87×（= 15 × 1.87 = 28.05px，落在 title1 档）、
// 悬浮 FAB（56×56 / 圆角 18 / 右 18 / 底 18 + 安全区；桌面档不渲染）。
// 背景（，回填真机读数时逮到三处「写了但没生效」）：① 两行降档选择器写成 data-fs="standard"
// （实际值是 "normal"）；② --colw 用裸 html 选择器压不过 :root / data-colw 档位规则；③ FAB 只给了落位、
// 没把基础档的 display: none 开回来。这条检查把 A 批的这组数钉住（规格在 `10`，读数在 `07-V3-验收记录`）。
// **种子先在桌面档打完再缩**：2a 起 compact = 触控只读态（`MOBILE-EDIT-1`），窄视口里 `reset()`
// 的打字打不进去（此前"窄着种"，只读之后双跑同点卡死换来这条）。
await page.setViewportSize({ width: 1280, height: 900 })
await reset()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('正文')
await page.setViewportSize({ width: 360, height: 800 })
const mobileTier = await poll(
  () => page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    const nameRow = document.querySelector('.editor-content .moqi-block[data-block-object="true"]')
    const textBlock = document.querySelector('.editor-content .moqi-block:not([data-block-object="true"])')
    return {
      fs: root.getPropertyValue('--fs-e').trim(),
      lh: root.getPropertyValue('--lh-e').trim(),
      colw: root.getPropertyValue('--colw').trim(),
      dataFs: document.documentElement.dataset.fs ?? null,
      nameFont: nameRow ? getComputedStyle(nameRow).fontSize : null,
      textFont: textBlock ? getComputedStyle(textBlock).fontSize : null,
      textLine: textBlock ? getComputedStyle(textBlock).lineHeight : null,
    }
  }),
  (s) => s.textFont !== null && s.nameFont !== null,
  { timeout: 6000, label: '窄屏档排版读数就绪' },
)
// 看 FAB：手机上的「页面库」= 编辑器的页面列（窄屏是抽屉，`10` §4.1 的「首页 FAB」在这里落地）。
// 抽屉开着 FAB 才在（点开一张页/点正文会把抽屉收起 ⇒ FAB 收起，符合「仅首页」口径）；
// 这里先按 ▣ 把页面列表打开（它收起时不点开就看不到——不点开就判红会把「没打开」当成「没有」）。
await page.evaluate(() => {
  if (!document.querySelector('.fab')) {
  // 按**前缀**找：标签里带真键位「⌘⇧\」（ 修 D-037 时补的反斜杠）——整串匹配会随文案微调而脆断。
    [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('页面列表（⌘⇧'))?.click()
  }
})
// 测试基建（，@0 批准）：**先等 `.pagecol`、再等 `.fab`**。FAB 只在 `compact` + 页面列可见时
// 挂载（骨架条件渲染），两者各占一次 React 提交；原先合成一个 4s 轮询，负载下偶发读到 `null`
// （实测 5 路 2 级，独立复现次数 300ms 内就位）。超时相应放宽到 9s。
// **仍能红**：FAB 真的不出现时第二个轮询照样超时 ⇒ 读到 `null` ⇒ 下面的 `fab !== null` 判假。
await poll(
  () => page.evaluate(() => Boolean(document.querySelector('.pagecol'))),
  (value) => value === true,
  { timeout: 9000, label: '页面列（FAB 的宿主）' },
)
const fab = await poll(
  () => page.evaluate(() => {
    const el = document.querySelector('.fab')
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const top = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2))
    return {
      display: style.display,
      w: Math.round(rect.width), h: Math.round(rect.height),
      right: Math.round(window.innerWidth - rect.right), bottom: Math.round(window.innerHeight - rect.bottom),
      radius: style.borderRadius,
      aria: el.getAttribute('aria-label'),
      hittable: Boolean(top?.closest?.('.fab')),
    }
  }),
  (value) => value !== null && value.display !== 'none',
  { timeout: 9000, label: '页面列里的悬浮 FAB' },
)
// 桌面档**没有这个 DOM**（4b-③ 起 FAB 由骨架渲染：`compact` 条件挂载，不再靠媒体块开关 display；
// 桌面端走页面库头部的「＋ 新建页面」）。条件挂载是 React 状态 ⇒ 跨断点后有一帧延迟，用 poll 等它撤场。
await page.setViewportSize({ width: 1280, height: 900 })
const fabOnDesktop = await poll(
  () => page.evaluate(() => {
    const el = document.querySelector('.fab')
    return el ? getComputedStyle(el).display : 'absent'
  }),
  (value) => value === 'absent',
  { timeout: 4000, label: '桌面档 FAB 撤场（骨架条件）' },
)
check('MOBILE-A1 手机最小批（`10` 落地值）：窄屏档标准档降一档（--fs-e 15px / --lh-e 1.7）、列宽归 100%、页面名 1.87×（28.05px，落在 title1 档）、正文 15px；页面列（手机上的「页面库」）悬浮 FAB 56×56 / 圆角 18 / 右 18 / 底 18（+安全区）、真点得到（命中测试）、桌面档不渲染',
  mobileTier.fs === '15px' && mobileTier.lh === '1.7' && mobileTier.colw === '100%' && mobileTier.dataFs === 'normal'
  && mobileTier.nameFont === '28.05px' && mobileTier.textFont === '15px' && mobileTier.textLine === '25.5px'
  && fab !== null && fab.display !== 'none' && fab.aria === '新建页面' && fab.hittable === true
  && fab.w === 56 && fab.h === 56 && fab.right === 18 && fab.bottom === 18 && fab.radius === '18px'
  && fabOnDesktop === 'absent',
  { mobileTier, fab, fabOnDesktop })

// ---------- 键盘避让（`#8` / `10` §6.3 · 批 β 升格为**长期回归门**，@0 641 批准）：`--kb-h` 唯一读数源 ----------
// 口径同 `#8` 真机：`--kb-h` 是运行时变量（不进 `tokens.css`），底部预留 / 下沿锚定面 / 遮罩兜底 / 弹窗高**只由它驱动**。
// 正例 = 注入随动；**负例①换值随动**（kb=140 ⇒ 预留 260，写死 300px 的实现必红）·
// **负例②不注入 ⇒ 读数不随动**（移除 `--kb-h` 后逐项回到基准，与基准恒等）。
const kbProbe = async (px) => {
  await page.evaluate((v) => {
    if (v == null) document.documentElement.style.removeProperty('--kb-h')
    else document.documentElement.style.setProperty('--kb-h', `${v}px`)
  }, px)
  await sleep(120)
  return page.evaluate(() => {
    const padBottom = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).paddingBottom : null }
    const probe = (cls, prop) => {
      const d = document.createElement('div'); d.className = cls; document.body.appendChild(d)
      const v = getComputedStyle(d)[prop]; d.remove(); return v
    }
    return {
      docColPadBottom: padBottom('.doc-col'),
      mbarBottom: probe('mbar', 'bottom'),
      capsuleBottom: probe('capsule', 'bottom'),
      sheetBottom: probe('sheet', 'bottom'),
      dlgMaxHeight: probe('dlg', 'maxHeight'),
      maskPadBottom: probe('mask', 'paddingBottom'),
    }
  })
}
await reset()
await page.setViewportSize({ width: 1440, height: 900 })
await sleep(500)
const kbNone = await kbProbe(null)
const kb300 = await kbProbe(300)
const kb140 = await kbProbe(140)
const kbNone2 = await kbProbe(null) // 负例②：不注入（移除变量）
await page.setViewportSize({ width: 360, height: 780 })
await sleep(600)
const kbNoneC = await kbProbe(null)
const kb300C = await kbProbe(300)
const kbNone2C = await kbProbe(null)
// ①b 真元素几何（`R04-ACCEPT-7` 补层：**不是**现造假 div——上面那些读的是声明值，这条量真键盘栏）：
// 窄档下页面列是**覆盖式抽屉**、会盖住正文：先收「页面列」意图再缩/点（同触控批惯例，收场还原）；
// 然后底栏「✎ 编辑」进触控编辑态（真 `.mbar`），注入 --kb-h=300 ⇒ 键盘栏**真坐在**键盘上沿。
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
await page.locator('.doc-col .moqi-block[data-block-object="true"]').first().dblclick()
await sleep(500)
const kbRealProbe = () => page.evaluate(() => {
  const mbar = document.querySelector('.mbar')
  const doccol = document.querySelector('.doc-col')
  const r = mbar?.getBoundingClientRect()
  return {
    present: Boolean(mbar),
    bottom: r ? Math.round(r.bottom) : null,
    docPadBottom: doccol ? getComputedStyle(doccol).paddingBottom : null,
    inner: window.innerHeight,
  }
})
const kbReal0 = await kbRealProbe()
await page.evaluate(() => document.documentElement.style.setProperty('--kb-h', '300px'))
await sleep(160)
const kbReal300 = await kbRealProbe()
await page.evaluate(() => document.documentElement.style.removeProperty('--kb-h'))
await sleep(160)
await page.locator('.mbar button[aria-label="完成"]').click({ timeout: 5000 }).catch(() => {})
await sleep(400)
// 收场复位：页面列意图还原（别把收起态留给下一条——`MOBILE-DRAWER-1` 同一惯例）。
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
await page.setViewportSize({ width: 1280, height: 900 })
await sleep(300)
const kbDlgBase = Math.min(0.72 * 780, 780 - 96) /* compact `.dlg` = `min(72dvh, 100dvh − 96px − kb)`（96px = compact 预留常量，同源 `.doc-col`）；kb=0 ⇒ 561.6 */
const kbDlgKb = Math.min(0.72 * 780, 780 - 96 - 300) /* kb=300 ⇒ min(561.6, 384) = 384 */
check('MOBILE-KB-1 键盘避让（`#8` / `10` §6.3 · 批 β 升格为长期回归门）：`--kb-h` 为**唯一读数源**——宽档 `.doc-col` 底部预留 120 + kb（120→420）、下沿锚定面（键盘栏 / 胶囊 / Sheet）`bottom = kb`（0→300）、compact `.doc-col` 预留 96 + kb（96→396）、compact `.mask` 兜底 `padding-bottom = kb`（0→300）、compact `.dlg` 高 = `min(72dvh, 100dvh − 96px − kb)`（561.6→384，随 kb 收缩）；**负例①换值随动**（kb = 140 ⇒ 260，排除硬编码 300px）· **负例②不注入 ⇒ 读数不随动**（移除 `--kb-h` 后逐项与基准恒等）',
  kbNone.docColPadBottom === '120px' && kb300.docColPadBottom === '420px'
  && kbNone.mbarBottom === '0px' && kb300.mbarBottom === '300px'
  && kbNone.capsuleBottom === '0px' && kb300.capsuleBottom === '300px'
  && kbNone.sheetBottom === '0px' && kb300.sheetBottom === '300px'
  && kb140.docColPadBottom === '260px' /* 负例①：换值随动（写死 300px 的实现这里必红） */
  && kbNoneC.docColPadBottom === '96px' && kb300C.docColPadBottom === '396px'
  && kbNoneC.maskPadBottom === '0px' && kb300C.maskPadBottom === '300px'
  && Math.abs(parseFloat(kbNoneC.dlgMaxHeight) - kbDlgBase) < 1
  && Math.abs(parseFloat(kb300C.dlgMaxHeight) - kbDlgKb) < 1 && kbDlgKb < kbDlgBase /* 随 kb 收缩 */
  /* 负例②：不注入（移除 `--kb-h`）⇒ 四处底面读数逐项与基准**恒等**（不得随动） */
  && kbNone2.docColPadBottom === kbNone.docColPadBottom && kbNone2.docColPadBottom !== kb300.docColPadBottom
  && kbNone2.mbarBottom === kbNone.mbarBottom && kbNone2.maskPadBottom === kbNone.maskPadBottom
  && kbNone2C.dlgMaxHeight === kbNoneC.dlgMaxHeight && kbNone2C.docColPadBottom === kbNoneC.docColPadBottom
  /* ①b 真元素几何：键盘栏（真 .mbar）贴底 / 真坐在键盘上沿；正文真预留 96 + 300 */
  && kbReal0.present === true && kbReal0.bottom === kbReal0.inner
  && kbReal300.bottom === kbReal300.inner - 300 && kbReal300.docPadBottom === '396px',
  { kbNone, kb300, kb140, kbNone2, kbNoneC, kb300C, kbNone2C, kbDlgBase, kbReal0, kbReal300 })

// ---------- A3 移动档分叉（`08` §3）+ 按压换轨（`10` §七）----------
// 为什么要另开一个上下文：`pointer: coarse` 由**输入设备**决定，accept 的主 `page` 是 fine（桌面），
// 移动档的是否生效在它身上量不到。这里开一个 hasTouch + Android UA 的上下文当「手机」。
const coarseCtx = await browser.newContext({
  viewport: { width: 360, height: 780 },
  userAgent: 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
  hasTouch: true,
  isMobile: true,
})
const coarsePage = await coarseCtx.newPage()
await coarsePage.goto(URL)
await coarsePage.waitForSelector('.lcard, .pagecol, .editor-content', { timeout: 30_000 })
await sleep(700)
const readThemeProbe = (p) => p.evaluate(() => {
  const cs = getComputedStyle(document.documentElement)
  const root = document.documentElement
  const hex = (name) => cs.getPropertyValue(name).trim()
  const lum = (value) => {
    const v = value.replace('#', '')
    const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v
    const ch = (c) => { const x = parseInt(c, 16) / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * ch(full.slice(0, 2)) + 0.7152 * ch(full.slice(2, 4)) + 0.0722 * ch(full.slice(4, 6))
  }
  const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
  const alphas = (text) => (text.match(/rgba?\([^)]*\)/g) ?? []).map((m) => parseFloat(m.split(',').pop().replace(')', '')))
  // coarse 块里的规则原文（按压换轨的判据靠它；`CSSMediaRule` 才拿得动 conditionText）
  const coarseRules = []
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = [...sheet.cssRules] } catch { continue }
    for (const rule of rules) {
      if (rule.constructor.name === 'CSSMediaRule' && (rule.conditionText ?? '').includes('pointer: coarse')) {
        for (const inner of rule.cssRules) coarseRules.push(inner.cssText)
      }
    }
  }
  return {
    coarse: window.matchMedia('(pointer: coarse)').matches,
    theme: root.dataset.theme ?? 'default',
    mode: root.dataset.mode ?? 'light',
    bg: hex('--bg'), sideBg: hex('--side-bg'), panel: hex('--panel'), panel2: hex('--panel-2'),
    accentHover: hex('--accent-hover'), inkT: hex('--ink-t'),
    lumBg: lum(hex('--bg')), lumSide: lum(hex('--side-bg')), lumPanel: lum(hex('--panel')), lumPanel2: lum(hex('--panel-2')),
    shadowAlphas: alphas(cs.getPropertyValue('--shadow')),
    contrastInkOnAccent: contrast(hex('--ink-t'), hex('--accent-hover')),
    coarseRules,
    cardActiveScaled: coarseRules.some((t) => /\.lcard:active[^{]*\{[^}]*scale\(0?\.98\)/.test(t)),
    iconActiveNoDim: coarseRules.some((t) => /\.col-new:active[^{]*\{[^}]*opacity:\s*1/.test(t)),
    cardActiveOutsideCoarse: (() => {
      for (const sheet of document.styleSheets) {
        let rules
        try { rules = [...sheet.cssRules] } catch { continue }
        for (const rule of rules) {
          if (rule.constructor.name !== 'CSSMediaRule' && /\.lcard:active/.test(rule.cssText ?? '')) return true
        }
      }
      return false
    })(),
  }
})
const fineProbe = await readThemeProbe(page)
const coarseProbe = await readThemeProbe(coarsePage)
// ---------- A4 紧凑档命中区 ≥44（`10` §1.2 第 2 条 · `08` §4；`accept:PANEL-HIT-1` 的 compact 扩展）----------
// 与 `PANEL-HIT-1` 同一套量法（逐像素 `elementFromPoint`），只是换到 coarse/compact 上下文；
// 例外：折叠箭头 = 整行高 × 32px 沟槽（`10` §1.2 第 2 条明文）。
const hitBoxOf = (p, selector) => p.evaluate((sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  const cx = Math.round(r.left + r.width / 2)
  const cy = Math.round(r.top + r.height / 2)
  const hits = (x, y) => { const t = document.elementFromPoint(x, y); return Boolean(t && (t === el || el.contains(t) || t.closest?.(sel) === el)) }
  if (!hits(cx, cy)) return { w: 0, h: 0, note: '中心都点不到' }
  let left = cx, right = cx, top = cy, bottom = cy
  while (left > 1 && hits(left - 1, cy)) left -= 1
  while (right < window.innerWidth - 1 && hits(right + 1, cy)) right += 1
  while (top > 1 && hits(cx, top - 1)) top -= 1
  while (bottom < window.innerHeight - 1 && hits(cx, bottom + 1)) bottom += 1
  return { w: right - left + 1, h: bottom - top + 1, vw: Math.round(r.width), vh: Math.round(r.height) }
}, selector)
// 首页：FAB / 卡片 ⋯ / 页面库头按钮
const hitHome = { fab: await hitBoxOf(coarsePage, '.fab'), pmore: await hitBoxOf(coarsePage, '.lcard .pmore'), headBtn: await hitBoxOf(coarsePage, '.pagecol-head .tb-btn'), openRow: await hitBoxOf(coarsePage, '.lcard .bd-open') }
// A1（0.6.1）：编辑页顶栏图标纽——先开一张卡进编辑页再量（::after 外扩计入逐像素扫描）
await coarsePage.evaluate(() => { document.querySelector('.lcard .bd-open')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
await sleep(800)
const hitTop = { more: await hitBoxOf(coarsePage, '.topbar .tb-btn[aria-label="更多"]') }
// evidence 带上 hitTop（量测不可见 = 调不出来）
await coarsePage.evaluate(() => { [...document.querySelectorAll('.topbar .tb-btn')].find((b) => b.getAttribute('aria-label') === '返回页面库')?.click() })
await sleep(600)
// 设置：标题栏返回 / 窄档列表行
await coarsePage.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '') === '菜单')?.click() })
await sleep(600)
await coarsePage.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '设置')?.click() })
await sleep(900)
const hitSettings = { back: await hitBoxOf(coarsePage, '.set-topbar .tb-back') }
// 列表行：先把滚动容器回顶（避免首行被 sticky 标题栏压住而量不全），再取第 2 行
await coarsePage.evaluate(() => { const list = document.querySelector('.set-list'); if (list) list.scrollTop = 0 })
await sleep(300)
const hitRowBox = await hitBoxOf(coarsePage, '.set-list .sl-row:nth-of-type(2)')
hitSettings.row = hitRowBox ?? (await hitBoxOf(coarsePage, '.set-list .sl-row'))
await coarsePage.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '') === '关闭')?.click() })
await sleep(500)
// 卡片 ⋯ Sheet：关闭 ✕ / Sheet 行
await coarsePage.evaluate(() => { [...document.querySelectorAll('.lcard .pmore')][0]?.click() })
await sleep(800)
const hitSheet = { close: await hitBoxOf(coarsePage, '.sheet .sh-x'), row: await hitBoxOf(coarsePage, '.sheet .sg-row') }
await coarsePage.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '') === '关闭')?.click() })
await sleep(400)
const atLeast44 = (box) => Boolean(box && box.w >= 44 && box.h >= 44)
check('MOBILE-HIT-1 紧凑档命中区 ≥44（`10` §1.2 第 2 条 · `08` §4 · A4）：逐像素 `elementFromPoint` 量出真实可点盒——FAB（56）/ 卡片 ⋯（外扩后 ≥44）/ 页面库头按钮 / 卡片标题「打开」行（0.6.1 补齐）/ 编辑页顶栏图标纽（0.6.1 补齐，::after 外扩）/ 设置标题栏返回 / 窄档列表行 / Sheet 关闭 ✕ / Sheet 行 全部 ≥44；**例外：折叠箭头 = 整行高 × 32px 沟槽**（本断言不要求它 ≥44）；外扩一律 `::after`（**视觉不动**——`vw/vh` 与改动前一致）',
  atLeast44(hitHome.fab) && atLeast44(hitHome.pmore) && atLeast44(hitHome.headBtn) && atLeast44(hitHome.openRow) && atLeast44(hitTop.more)
  && atLeast44(hitSettings.back) && atLeast44(hitSettings.row)
  && atLeast44(hitSheet.close) && atLeast44(hitSheet.row)
  && hitHome.pmore.vw === 22 && hitHome.headBtn.vw === 38 /* 视觉盒不动 */,
  { hitHome, hitSettings, hitSheet })

await coarseCtx.close()
const sameTheme = fineProbe.theme === coarseProbe.theme && fineProbe.mode === coarseProbe.mode
check('THEME-MOBILE-1 移动档分叉（`08` §3 · A3）：**真 coarse 上下文**（hasTouch + Android UA）里 `pointer: coarse` 命中，且底族按分叉生效——`--bg`/`--side-bg`/`--panel-2` 均**暗于** fine 档、**`--panel`（卡）两档相同**、`--shadow` alpha 变大、`--ink-t` on 移动档 `--accent-hover` **≥4.5**；**负例：fine 档（桌面）不得拿到任一移动档值**（分叉不得泄漏）',
  sameTheme && coarseProbe.coarse === true && fineProbe.coarse === false
  && coarseProbe.bg !== fineProbe.bg && coarseProbe.sideBg !== fineProbe.sideBg && coarseProbe.panel2 !== fineProbe.panel2
  && coarseProbe.lumBg < fineProbe.lumBg && coarseProbe.lumSide < fineProbe.lumSide && coarseProbe.lumPanel2 < fineProbe.lumPanel2 /* 底族压暗（用亮度比，不靠字符串） */
  && Math.abs(coarseProbe.lumPanel - fineProbe.lumPanel) < 0.0001 /* 卡不压暗 */
  && coarseProbe.accentHover !== fineProbe.accentHover
  && Math.max(...coarseProbe.shadowAlphas) > Math.max(...fineProbe.shadowAlphas) * 1.5 /* alpha ×1.8 */
  && coarseProbe.contrastInkOnAccent >= 4.5 && fineProbe.contrastInkOnAccent >= 4.5
  && fineProbe.bg !== coarseProbe.bg,
  { sameTheme, fineProbe: { ...fineProbe, coarseRules: undefined }, coarseProbe: { ...coarseProbe, coarseRules: undefined } })
check('MOBILE-PRESS-1 按压换轨（`10` §七 · A3）：「变实」不「变暗」——`pointer: coarse` 块里卡片按压 = `scale(.98)`、图标按钮按压 = `opacity: 1`（不再压暗）；**负例：卡片 `:active` 规则不得出现在 coarse 块之外**（桌面保持 hover 语义，不被换轨污染）',
  coarseProbe.cardActiveScaled === true && coarseProbe.iconActiveNoDim === true && coarseProbe.cardActiveOutsideCoarse === false,
  { cardActiveScaled: coarseProbe.cardActiveScaled, iconActiveNoDim: coarseProbe.iconActiveNoDim, cardActiveOutsideCoarse: coarseProbe.cardActiveOutsideCoarse, coarseRuleCount: coarseProbe.coarseRules.length })

// ---------- B 批 · `R09-STATE-5` 文案纪律（成功不弹通知 / 契约必在）----------
// **防绕过设计**（回应 @6 D12 的疑问）：不只数文本，而是**行为级双向断言**——
//   ① 成功类动作「**真做成了**」且 `.toast` **必须为 0**（把成功提示改写成契约口吻也绕不过：
//      成功动作本来就不该弹通知）；成功证据用「复制链接 → 真读回剪贴板内容」。
//   ② 契约类动作（不可逆 / 代价）**必须**弹且带补救入口——「移至回收站」= 最短一句 + 撤销按钮，
//      点撤销后卡片回来（顺手证明补救入口不是摆设）。
await page.setViewportSize({ width: 1280, height: 900 })
await sleep(400)
await page.evaluate(() => { [...document.querySelectorAll('.sb-nav')].find((b) => (b.textContent ?? '').includes('页面库'))?.click() })
await page.waitForSelector('.lcard, .scard', { timeout: NAV_READY_MS })
await sleep(300)
const bgToasts = () => page.evaluate(() => document.querySelectorAll('.notice').length)
// 先等干净（前面的检查可能留下未过期的提示，不能算到本断言头上；提示带寿命 6s ⇒ 等待窗 9s）
await page.waitForSelector('.notice', { state: 'detached', timeout: 9000 }).catch(() => {})
const cardsBefore = await page.locator('.lcard, .scard').count()
// ① 成功类：卡片 ⋯ → 复制链接（成功证据 = 剪贴板真拿到内容；不许弹通知）
await page.locator('.lcard, .scard').first().locator('button.pmore').click()
await sleep(400)
const copyLinkRow = await page.evaluate(() => { const b = [...document.querySelectorAll('.pop button')].find((x) => (x.textContent ?? '').includes('复制链接')); b?.click(); return Boolean(b) })
await sleep(600)
const clipAfterCopy = String(await readClipboard())
const toastsAfterCopy = await bgToasts()
// ② 契约类：移至回收站 —— 动作前有确认弹窗；执行后**静默**；⌘Z 复原
await page.locator('.lcard, .scard').first().locator('button.pmore').click()
await sleep(400)
await page.locator('.pop button').filter({ hasText: '移至回收站' }).click()
await page.getByRole('button', { name: '移入回收站' }).click()
await sleep(600)
const trashToast = (await toast()) ?? ''
const cardsAfterTrash = await page.locator('.lcard, .scard').count()
await page.keyboard.press('Control+z')
await sleep(700)
const cardsAfterUndo = await page.locator('.lcard, .scard').count()
const toastsEnd = await bgToasts()
check('R09-STATE-5 文案纪律：成功动作**不弹通知**（复制链接：剪贴板真拿到内容、`.toast` = 0）· 移至回收站**确认弹窗在前、执行后静默**；⌘Z 复原',
  copyLinkRow === true && clipAfterCopy.length > 0 && !clipAfterCopy.startsWith('READ-FAIL')
  && toastsAfterCopy === 0
  && trashToast === '' && cardsAfterTrash === cardsBefore - 1
  && cardsAfterUndo === cardsBefore && toastsEnd === 0,
  { copyLinkRow, clipSample: clipAfterCopy.slice(0, 60), toastsAfterCopy, trashToast, cardsBefore, cardsAfterTrash, cardsAfterUndo, toastsEnd })

// ---------- 触控编辑态（`10` §6.3，第一件）：compact 档 = 只读 / 编辑两态 ----------
// 口径 = 第 12 项「窗口宽度决定用哪种方式」：360 宽的窗口就是手机版面的验收台。
await reset()
// 种子补一块正文（桌面档打完——只读后窄档打不进字）：容器之外要有个块，才能验「点另一块」（θ6：光标一步到位）。
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('第二块')
// 窄档下页面列按「意图」开成覆盖抽屉（`R09-RESP-15`）会盖住正文：先折叠意图再缩，收场再打开还原
// （宽档的并排布局交给下游的 `WINDOW-FIT-1`，不能留一个折叠着的页面列给它）。
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
await page.setViewportSize({ width: 360, height: 720 })
await sleep(700)
const touchRead = await page.evaluate(() => {
 // γ1 负例：**只读态绝不能被抑制**（用户 裁定「保留只读态原生选词与系统长按菜单」）。
  const block = document.querySelector('.doc-col .moqi-block')
  const style = block ? getComputedStyle(block) : null
  return {
    editable: document.querySelector('.doc-col [contenteditable]')?.getAttribute('contenteditable') ?? null,
    touchEditClass: Boolean(document.querySelector('.doc-col.is-touch-edit')),
    blockUserSelect: style ? style.userSelect : null,
    blockTouchAction: style ? style.touchAction : null,
  }
})
// θ13（ 真机轮）：**compact 档不吃长按 / 右键**——Android 长按会派发 `contextmenu`，
// 旧行为会「选中该块 + 弹桌面块菜单」（连同桌面文本浮条）一起漏进手机。只读态先验一次（合成 contextmenu）。
const touchLongPressRead = await page.evaluate(() => {
  const block = document.querySelector('.doc-col .moqi-block[data-entity-id]:not([data-block-object="true"])')
  block?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  return {
    menu: Boolean(document.querySelector('.pop[role="menu"]')),
    selected: document.querySelectorAll('.moqi-block.is-selected').length,
    txtbar: Boolean(document.querySelector('.txtbar')),
  }
})
// 只读态双击容器块（名字行）→ 进编辑
await page.locator('.doc-col .moqi-block[data-block-object="true"]').first().dblclick()
await sleep(500)
const touchEditing = await page.evaluate(() => {
  const editing = document.querySelector('.doc-col .moqi-block[data-touch-edit="1"]')
  const others = [...document.querySelectorAll('.doc-col .moqi-block')].filter((el) => el !== editing)
  return {
    editable: document.querySelector('.doc-col [contenteditable]')?.getAttribute('contenteditable') ?? null,
    colClass: Boolean(document.querySelector('.doc-col.is-touch-edit')),
    editMark: editing?.dataset.entityId ?? null,
    otherOpacity: others.length > 0 ? getComputedStyle(others[0]).opacity : null,
    editOpacity: editing ? getComputedStyle(editing).opacity : null,
  // 批 δ（）：**无弱化**硬断言——编辑态里不得有任何块被降透明（含嵌套叠乘）
    dimmed: [...document.querySelectorAll('.doc-col .moqi-block')].filter((el) => Number.parseFloat(getComputedStyle(el).opacity) < 1).length,
    // γ1：抑制只限**编辑态正文**（`touch-action: pan-y` / `-webkit-touch-callout: none` 在 app.css）
    editTouchAction: (() => { const el = document.querySelector('.doc-col .editor-content'); return el ? getComputedStyle(el).touchAction : null })(),
  }
})
// θ13：编辑态同样不吃长按 / 右键（负例：把 `if (compact …)` 那道闸删掉 ⇒ 这里 `menu` 必真、`selected` 必变 1）
const touchLongPressEdit = await page.evaluate(() => {
  const block = document.querySelector('.doc-col .moqi-block[data-entity-id]:not([data-block-object="true"])')
  block?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  return {
    menu: Boolean(document.querySelector('.pop[role="menu"]')),
    selected: document.querySelectorAll('.moqi-block.is-selected').length,
    txtbar: Boolean(document.querySelector('.txtbar')),
  }
})
// 编辑态内点另一个块（正文子块）→ **θ6（ 用户走查「点另一块要双击、光标不灵敏」）：光标一步到位**——
// 不入选区（γ1 不动——选中仍只认左滑）、光标落到**点按的那一块**；负例：不得冒出胶囊 / 选择栏 / 模式类。
const targetLeaf = page.locator('.doc-col .moqi-block[data-entity-id]:not([data-block-object="true"])').first()
const targetLeafId = await targetLeaf.getAttribute('data-entity-id')
await targetLeaf.click()
await sleep(350)
const touchSelect = await page.evaluate(() => {
  const anchor = window.getSelection()?.anchorNode ?? null
  // 不引 `HTMLElement`（accept 是无头脚本，eslint 全局表里没有它）——按 `nodeType` 判元素，再鸭子类型取 `closest`。
  const anchorEl = anchor !== null && anchor.nodeType === 1 ? anchor : (anchor?.parentElement ?? null)
  const caretEl = anchorEl !== null && typeof anchorEl.closest === 'function' ? anchorEl.closest('.moqi-block[data-entity-id]') : null
  return {
    selected: document.querySelectorAll('.moqi-block.is-selected').length,
    stillEditing: Boolean(document.querySelector('.doc-col.is-touch-edit')),
    // θ6 双锁②：光标真落在点按的块里（读 DOM 选区，不看内部状态）
    caretId: caretEl ? caretEl.dataset.entityId ?? null : null,
    capsule: Boolean(document.querySelector('.capsule')),
    selectMode: Boolean(document.querySelector('.doc-col.is-select-mode')),
  }
})
// θ13（ 用户走查）：**点空白不退编辑**——一下 / 两下都只回打字态。旧行为是两段阶梯
// （第一下回打字态、第二下退编辑），真机上双击空白就把它误触成「直接回退到只读态」。
// 负例：把 `touchBlankTap` 里那级 `exitTouchEdit()` 加回来 ⇒ `stillEditing` / `editable` 必红。
await page.locator('.doc-col').click({ position: { x: 6, y: 6 } })
await sleep(350)
const touchBack = await page.evaluate(() => ({
  selected: document.querySelectorAll('.moqi-block.is-selected').length,
  stillEditing: Boolean(document.querySelector('.doc-col.is-touch-edit')),
}))
await page.locator('.doc-col').click({ position: { x: 6, y: 6 } })
await sleep(350)
const touchBlankTwice = await page.evaluate(() => ({
  stillEditing: Boolean(document.querySelector('.doc-col.is-touch-edit')),
  editable: document.querySelector('.doc-col [contenteditable]')?.getAttribute('contenteditable') ?? null,
}))
// 退编辑走正门 = 格式栏「完成」（`10` §6.3：完成 / Esc / 返回三出口）
// 注：5s 短超时 + 吞异常——若「点空白」被误退编辑（回归），`.mbar` 不存在，断言照常报 FAIL；
// 不这么做时那一轮会 timeout **中断整条套件**（后面的条目全被吞掉，见 的红证记录）。
await page.locator('.mbar button[aria-label="完成"]').click({ timeout: 5000 }).catch(() => {})
await sleep(400)
const touchExited = await page.evaluate(() => ({
  editable: document.querySelector('.doc-col [contenteditable]')?.getAttribute('contenteditable') ?? null,
  colClass: Boolean(document.querySelector('.doc-col.is-touch-edit')),
}))
await page.setViewportSize({ width: 1280, height: 900 })
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(500)
const touchDesktop = await page.evaluate(() => ({
  editable: document.querySelector('.doc-col [contenteditable]')?.getAttribute('contenteditable') ?? null,
  colClass: Boolean(document.querySelector('.doc-col.is-touch-edit')),
}))
check('MOBILE-EDIT-1 触控编辑态（`10` §6.3 + γ1 + 批 δ + θ6/θ13 2026-10-13）：compact 档默认只读 → 双击块进编辑（可编辑 + **不降透明（全部正常黑）** + 编辑块挂标记）→ **长按 / 右键不上手机**（合成 `contextmenu`：只读态与编辑态都不得弹块菜单 / 桌面文本浮条、不得因此选中块）→ 编辑态内**点其他块 = 光标一步到位**（θ6 双锁：**不入选区** + 光标落在点按的那块；负例：不得出胶囊 / 选择栏 / 模式类）→ **点空白不退编辑**（θ13：一下 / 两下都只回打字态；退编辑只认格式栏「完成」/ Esc / 返回）→ 回桌面档恢复可编辑（Esc 层级见逃逸链单测）',
  touchRead.editable === 'false' && touchRead.touchEditClass === false
  && touchLongPressRead.menu === false && touchLongPressRead.selected === 0 && touchLongPressRead.txtbar === false /* θ13：只读态长按不上手机 */
  && touchEditing.editable === 'true' && touchEditing.colClass === true && touchEditing.editMark !== null
  && touchLongPressEdit.menu === false && touchLongPressEdit.selected === 0 && touchLongPressEdit.txtbar === false /* θ13：编辑态同禁（负例：删掉那道 `compact` 闸 ⇒ 必红） */
  && touchEditing.otherOpacity === '1' && touchEditing.editOpacity === '1' && touchEditing.dimmed === 0 /* 批 δ：无弱化（负例：把 `.45` 加回去 ⇒ 这里必红） */
  && touchEditing.editTouchAction === 'pan-y' /* γ1：抑制在编辑态生效 */
  && touchRead.blockUserSelect !== 'none' && touchRead.blockTouchAction !== 'pan-y' /* γ1 负例：只读态无抑制 */
  /* θ6 双锁（负例：把 `onMouseDown` 的 preventDefault 加回去 ⇒ `caretId` 必红；把点块改回选中 ⇒ `selected` / `capsule` 必红） */
  && touchSelect.selected === 0 && touchSelect.stillEditing === true
  && targetLeafId !== null && touchSelect.caretId === targetLeafId
  && touchSelect.capsule === false && touchSelect.selectMode === false
  && touchBack.selected === 0 && touchBack.stillEditing === true /* θ13：点空白只回打字态 */
  && touchBlankTwice.stillEditing === true && touchBlankTwice.editable === 'true' /* θ13：双击空白也不得退到只读 */
  && touchExited.editable === 'false' && touchExited.colClass === false
  && touchDesktop.editable === 'true' && touchDesktop.colClass === false,
  { touchRead, touchLongPressRead, touchEditing, touchLongPressEdit, targetLeafId, touchSelect, touchBack, touchBlankTwice, touchExited, touchDesktop })

// ---------- 键盘上方格式栏（`10` §6.3 定稿）：主条九键 + 四张就地面板 + 插入面板 ----------
// 场景重建（同 MOBILE-EDIT-1 的口径：桌面档种子 → 折页面列 → 缩 360）。
await reset()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('第二块')
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
await page.setViewportSize({ width: 360, height: 720 })
await sleep(600)
const barBefore = await page.evaluate(() => ({ bar: Boolean(document.querySelector('.mbar')) }))
await page.locator('.doc-col .moqi-block[data-block-object="true"]').first().dblclick()
await sleep(500)
const barTier = await page.evaluate(() => {
  const bar = document.querySelector('.mbar')
  if (!bar) return null
  const rect = bar.getBoundingClientRect()
  return {
    h: Math.round(rect.height),
    bottomGap: Math.round(window.innerHeight - rect.bottom),
    // 九键全图标：标签一律读 aria-label（`MOBILE-ICON-1` 锁形状，这里锁顺序与在场）。
    labels: [...bar.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()),
    icons: bar.querySelectorAll('button svg').length,
    glyphText: [...bar.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).join(''),
    panels: document.querySelectorAll('.mbar-panel').length,
  }
})

// M2 · 四张就地面板：键盘不退（`--kb-h` 注入前后主条 bottom 不变）＋ 七 / 六 / 四 / 三格 ＋ 当前值点亮
await page.evaluate(() => document.documentElement.style.setProperty('--kb-h', '300px'))
await sleep(250)
const panelGeometry = await page.evaluate(() => ({
  bottom: Math.round(window.innerHeight - (document.querySelector('.mbar')?.getBoundingClientRect().bottom ?? 0)),
}))
// 转块类型的目标必须是**叶块**（页面容器不参与转换——域层 `R04-CONV-*` 把关）：先点一片叶子。
await page.locator('.doc-col .moqi-block:not([data-block-object="true"])').first().click()
await sleep(400)
await page.locator('.mbar button[aria-label="文本样式"]').click()
await sleep(300)
const textPanel = await page.evaluate(() => ({
  open: Boolean(document.querySelector('.mbar-panel[aria-label="文本样式"]')),
  labels: [...document.querySelectorAll('.mbar-panel[aria-label="文本样式"] button')].map((b) => (b.textContent ?? '').trim()),
  barBottom: Math.round(window.innerHeight - (document.querySelector('.mbar')?.getBoundingClientRect().bottom ?? 0)),
  panelAboveBar: (() => {
    const panel = document.querySelector('.mbar-panel')
    const bar = document.querySelector('.mbar')
    if (!panel || !bar) return null
    return Math.round(bar.getBoundingClientRect().top - panel.getBoundingClientRect().bottom)
  })(),
}))
// 点 H₂：当前编辑块转标题 2，且面板内 H₂ 点亮（当前值回显）
await page.locator('.mbar-panel[aria-label="文本样式"] button', { hasText: 'H₂' }).click()
await sleep(500)
const afterHeading = await page.evaluate(() => {
  const block = document.querySelector('.doc-col .moqi-block:not([data-block-object="true"])')
  const on = [...document.querySelectorAll('.mbar-panel[aria-label="文本样式"] button')].filter((b) => b.classList.contains('is-on')).map((b) => (b.textContent ?? '').trim())
  return { blockType: (block?.getAttribute('data-block-type') ?? '').trim(), on }
})
await page.locator('.mbar button[aria-label="文本样式"]').click()
await sleep(250)
await page.locator('.mbar button[aria-label="列表与段落"]').click()
await sleep(300)
const listPanel = await page.evaluate(() => [...document.querySelectorAll('.mbar-panel[aria-label="列表与段落"] button')].map((b) => (b.getAttribute('aria-label') ?? '').trim()))
await page.locator('.mbar button[aria-label="列表与段落"]').click()
await sleep(250)
const panelsClosed = await page.evaluate(() => document.querySelectorAll('.mbar-panel').length)
await page.evaluate(() => document.documentElement.style.removeProperty('--kb-h'))
await sleep(200)

// M4 · 主条「撤销 / 重做」：打字后 `↩` 回退、`↪` 回来（与 ⌘Z 同一条路由）
await page.locator('.doc-col .moqi-block[data-block-object="true"]').first().click()
await page.keyboard.press('End')
await page.keyboard.type('撤销测试')
await sleep(600)
const undoBefore = await page.evaluate(() => (document.querySelector('.doc-col .moqi-block[data-block-object="true"]')?.textContent ?? '').trim())
await page.locator('.mbar button[aria-label="撤销"]').click()
await sleep(700)
const undoAfter = await page.evaluate(() => (document.querySelector('.doc-col .moqi-block[data-block-object="true"]')?.textContent ?? '').trim())
await page.locator('.mbar button[aria-label="重做"]').click()
await sleep(700)
const redoAfter = await page.evaluate(() => (document.querySelector('.doc-col .moqi-block[data-block-object="true"]')?.textContent ?? '').trim())

// M3 · 插入面板：十格、占键盘位（锚同主条）、blur（键盘收的机制）→ 选「待办」插一块 → 焦点回正文字根
const beforeInsert = await page.evaluate(() => document.querySelectorAll('.doc-col .moqi-block').length)
await page.locator('.mbar button[aria-label="插入"]').click()
await sleep(500)
const insertSheet = await page.evaluate(() => ({
  sheet: Boolean(document.querySelector('.mbar-sheet')),
  tiles: [...document.querySelectorAll('.mbar-tile')].map((b) => (b.getAttribute('aria-label') ?? '').trim()),
  snap: getComputedStyle(document.documentElement).getPropertyValue('--kb-snap').trim(),
  focusedInEditor: Boolean(document.activeElement && document.activeElement.closest('.editor-content')),
  barStillThere: Boolean(document.querySelector('.mbar')),
}))
// 链接 › 子菜单（就地两行）先验一下：点 🔗 → 两行在场；返回后选「待办」
await page.locator('.mbar-tile[aria-label="链接"]').click()
await sleep(300)
const linkSub = await page.evaluate(() => [...document.querySelectorAll('.mbar-subrow button')].map((b) => (b.textContent ?? '').trim()))
await page.locator('.mbar-tile[aria-label="待办"]').click()
await sleep(700)
const afterInsert = await page.evaluate(() => ({
  blocks: document.querySelectorAll('.doc-col .moqi-block').length,
  sheet: Boolean(document.querySelector('.mbar-sheet')),
  focusedInEditor: Boolean(document.activeElement && document.activeElement.closest('.editor-content')),
}))
// 完成（`✓`）：退编辑态并收栏
await page.locator('.mbar button[aria-label="完成"]').click({ timeout: 5000 }).catch(() => {}) // 短超时防中断（见 MOBILE-EDIT-1 处注）
await sleep(500)
const barExit = await page.evaluate(() => ({
  bar: Boolean(document.querySelector('.mbar')),
  editing: Boolean(document.querySelector('.doc-col.is-touch-edit')),
  editable: document.querySelector('.doc-col [contenteditable]')?.getAttribute('contenteditable') ?? null,
}))
await page.setViewportSize({ width: 1280, height: 900 })
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
check('MOBILE-FMT-1 键盘上方格式栏：编辑态升起主条六键（贴底 · 46px · 无键盘时 bottomGap 0）；键序 = 插入 / 文本样式 / 列表与段落 / 撤销 / 重做 / 完成；行内格式由选中浮条承担；面板默认不展开；`✓ 完成` 退编辑并收栏',
  barBefore.bar === false
  && barTier !== null && barTier.h === 46 && barTier.bottomGap === 0
  && barTier.labels.join('/') === '插入/文本样式/列表与段落/撤销/重做/完成'
  && barTier.icons === 6 && barTier.glyphText === '' /* 六键全部 Lucide 线条图标，不再有字形 */
  && barTier.panels === 0
  && barExit.bar === false && barExit.editing === false && barExit.editable === 'false',
  { barBefore, barTier, barExit })

check('MOBILE-PANEL-1 就地面板：点主条键 → 面板浮在主条正上方（间隙 ≤6px）、**键盘不退**（`--kb-h` 注入 300 前后主条 bottom 都 = 300）；`Tт` 七格（T/H₁–H₆）→ 点 H₂ 当前编辑块转 heading2 且面板内 H₂ 点亮；再点同键收起',
  panelGeometry.bottom === 300
  && textPanel.open === true && textPanel.labels.join('/') === 'T/H₁/H₂/H₃/H₄/H₅/H₆' && textPanel.barBottom === 300
  && textPanel.panelAboveBar !== null && Math.abs(textPanel.panelAboveBar) <= 6
  && afterHeading.blockType === 'heading2' && afterHeading.on.join('/') === 'H₂',
  { panelGeometry, textPanel, afterHeading })

check('MOBILE-PANEL-1b 列表与段落面板（同批）：`☰` 七格（无序 / 有序 / 待办 / 缩进 / 反缩进 / 上移 / 下移）点名正确；点同键收起后面板数归 0',
  listPanel.join('/') === '无序/有序/待办/缩进/反缩进/上移/下移'
  && panelsClosed === 0,
  { listPanel, panelsClosed })

check('MOBILE-PANEL-2 插入面板（`10` §6.3 定稿）：点 ＋ → 面板占键盘位（`.mbar-sheet` 在场、`--kb-snap` 记下打开时的键盘高）、**正文字根失焦**（键盘收的机制）、主条仍在；十格点名 = 图片 / 拍照 / 待办 / 引用 / 代码块 / 分割线 / 链接 / 日期时间 / 附件块 / 嵌入块；`链接` 子菜单就地两行（外部链接 / 页面链接）；点「待办」→ 块数 +1、面板收、**焦点回正文字根**（键盘与焦点回来的机制）',
  insertSheet.sheet === true
  && insertSheet.tiles.join('/') === '图片/拍照/待办/引用/代码块/分割线/链接/日期时间/附件块/嵌入块'
  && insertSheet.focusedInEditor === false && insertSheet.barStillThere === true
  && linkSub.join('/') === '外部链接/页面链接'
  && afterInsert.blocks === beforeInsert + 1 && afterInsert.sheet === false && afterInsert.focusedInEditor === true,
  { beforeInsert, insertSheet, linkSub, afterInsert })

check('MOBILE-UNDO-1 主条撤销 / 重做（`θ11` · `10` §6.3 定稿）：打字后点 `↩` 回退（文本变短）、点 `↪` 回到打字后的文本——与 `⌘Z` / `⇧⌘Z` 共用同一条路由（`ui/undoRouting`）',
  undoBefore !== undoAfter && undoAfter.length < undoBefore.length && redoAfter === undoBefore,
  { undoBefore, undoAfter, redoAfter })

// ---------- 工具栏**可用性**（真触控 · 命中 · 焦点不丢）——用户 报「手机端工具栏没法用、不能操作」----------
// 为什么单列：上面所有面板检查都是 `.click()`（鼠标）且只判「面板开没开 / 条在不在」——真机上点
// `<button>` 会先把焦点从正文根抢走 ⇒ 软键盘收起、视口重排（宿主 adjustResize + IME inset 让 WebView
// 变高），点按落在移位后的位置、选区也可能塌掉；表现就是「点不动、没反应」，而桌面套件全绿（门盲区）。
// 这条用 **touchscreen.tap** 走真触控，把 **activeElement 必须仍在正文根内** 当「键盘不退 / 选区不丢」
// 的机器判据（负例：删掉 `MobileFmtBar` 的 `onMouseDown` 守卫 ⇒ 本项必红——修复前实测 activeElement
// 会变成主条按钮）。
// 另开 hasTouch 上下文的理由同 `coarseCtx`：主 page 是 fine（鼠标），触控派发在它身上走不到。
const usageCtx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
  hasTouch: true,
})
const usagePage = await usageCtx.newPage()
usagePage.setDefaultTimeout(60000)
await usagePage.goto(URL, { waitUntil: 'domcontentloaded' })
await usagePage.evaluate(() => localStorage.clear())
await usagePage.evaluate(() => localStorage.setItem('moqi-project-b:ui-prefs', JSON.stringify({ slashHintSeen: true })))
await usagePage.reload({ waitUntil: 'domcontentloaded' })
await usagePage.waitForSelector('.editor-content .moqi-block', { timeout: 60_000 })
await sleep(500)
const usageSeedBox = await usagePage.evaluate(() => {
  const el = document.querySelector('.editor-content .moqi-block')
  const rect = el.getBoundingClientRect()
  return { x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2) }
})
await usagePage.mouse.click(usageSeedBox.x, usageSeedBox.y)
await sleep(300)
await usagePage.keyboard.press('Control+a')
await usagePage.keyboard.type('工具栏使用')
await usagePage.keyboard.press('End')
await usagePage.keyboard.press('Enter')
await usagePage.keyboard.type('第二块工具栏')
await sleep(900)
// 折页面列 → 缩 360 → 双击**叶块**进编辑（同 MOBILE-FMT-1 的场景重建；叶块才会吃格式命令）
await usagePage.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(300)
await usagePage.setViewportSize({ width: 360, height: 720 })
await sleep(600)
await usagePage.locator('.doc-col .moqi-block:not([data-block-object="true"])').first().dblclick()
await sleep(500)
const usageHit = (selector) => usagePage.evaluate((sel) => [...document.querySelectorAll(sel)].map((b) => {
  const rect = b.getBoundingClientRect()
  const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return { label: (b.getAttribute('aria-label') ?? b.textContent ?? '').trim(), hit: at === b || b.contains(at) }
}), selector)
const usageFocus = () => usagePage.evaluate(() => ({
  inEditor: Boolean(document.activeElement && document.activeElement.closest('.editor-content')),
  panels: [...document.querySelectorAll('.mbar-panel')].map((p) => p.getAttribute('aria-label')),
  sheet: Boolean(document.querySelector('.mbar-sheet')),
  bar: Boolean(document.querySelector('.mbar')),
  editing: Boolean(document.querySelector('.doc-col.is-touch-edit')),
}))
const usageTap = async (label) => {
  const point = await usagePage.evaluate((lbl) => {
    const button = [...document.querySelectorAll('.mbar button, .mbar-panel button, .mbar-sheet button')]
      .find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === lbl)
    if (!button) return null
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }, label)
  if (point) await usagePage.touchscreen.tap(point.x, point.y)
  await sleep(350)
  return Boolean(point)
}
const barHits = await usageHit('.mbar button')
// 插入面板：开 = 设计上 blur（收键盘）；再点 ＋ = 关，焦点回正文根
await usageTap('插入')
const usageSheetOpen = await usageFocus()
await usageTap('插入')
const usageSheetClosed = await usageFocus()
await usageTap('完成')
const usageExit = await usageFocus()
await usageCtx.close()
check('MOBILE-FMT-2 工具栏**使用**检测（真触控 · 命中 · 焦点不丢）：主条六键**逐键命中**（`elementFromPoint` 在按钮或其子元素上——不是被别的层盖住）；插入面板按设计 blur 收键盘、再点 `＋` 焦点回来；`✓ 完成` 收栏退编辑（行内格式由选中浮条承担，另见 MOBILE-BUBBLE-1）',
  barHits.length === 6 && barHits.every((b) => b.hit)
  && usageSheetOpen.sheet === true && usageSheetOpen.inEditor === false
  && usageSheetClosed.sheet === false && usageSheetClosed.inEditor === true
  && usageExit.bar === false && usageExit.editing === false,
  { barHits, usageSheetOpen, usageSheetClosed, usageExit })

// ---------- 选区气泡（`10` §6.3 · 2c）：块内选词后的文本动作条 ----------
// 场景重建（同上口径）；选区用**程序化 Range**（确定性的口径见 MOBILE-EDIT-2 的注释）。
await reset()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('第二块')
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
await page.setViewportSize({ width: 360, height: 720 })
await sleep(600)
await page.locator('.doc-col .moqi-block[data-block-object="true"]').first().dblclick()
await sleep(500)
await page.evaluate(() => {
  const child = document.querySelector('.doc-col .moqi-block:not([data-block-object="true"])')
  if (!child) return
  const range = document.createRange()
  range.selectNodeContents(child)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
})
await sleep(400)
const tboxTier = await page.evaluate(() => {
  const svgCount = document.querySelectorAll('.tbox button svg').length
  const bubble = document.querySelector('.tbox')
  const selection = window.getSelection()
  const rect = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : null
  const box = bubble?.getBoundingClientRect() ?? null
  return {
    bubble: Boolean(bubble),
    width: Math.round(box?.width ?? 0),
    svgCount,
    labels: [...document.querySelectorAll('.tbox button')].map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()),
    above: box && rect ? box.bottom <= rect.top + 8 : null,
    below: box && rect ? box.top >= rect.bottom - 8 : null,
    selected: selection?.toString() ?? '',
  }
})
// 删除：动作执行 → 选中的字从 DOM 消失、气泡收起
await page.locator('.tbox button[aria-label="删除"]').click()
await sleep(600)
const tboxAfterDelete = await page.evaluate(() => ({
  childText: document.querySelector('.doc-col .moqi-block:not([data-block-object="true"])')?.textContent ?? null,
  bubble: Boolean(document.querySelector('.tbox')),
}))
// 再选（这回选整个编辑块）：格式 ▸ → 气泡收、`Aa` 文字格式面板就位（`10` §6.3 定稿）
await page.evaluate(() => {
  const row = document.querySelector('.doc-col .moqi-block[data-block-object="true"]')
  if (!row) return
  const range = document.createRange()
  range.selectNodeContents(row)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
})
await sleep(400)
await page.locator('.tbox button', { hasText: '格式 ▸' }).click()
await sleep(400)
const tboxAfterFormat = await page.evaluate(() => ({
  bubble: Boolean(document.querySelector('.tbox')),
  charPanel: Boolean(document.querySelector('.mbar-panel[aria-label="文字格式"]')),
  charLabels: [...document.querySelectorAll('.mbar-panel[aria-label="文字格式"] button')].map((b) => (b.getAttribute('aria-label') ?? '').trim()),
}))
// 再选：`链接` → 就地两行（外部链接 / 页面链接）→ 点「外部链接」开对话框（选区安全通道）
await page.locator('.doc-col .moqi-block[data-block-object="true"]').first().click()
await sleep(300)
await page.evaluate(() => {
  const row = document.querySelector('.doc-col .moqi-block[data-block-object="true"]')
  if (!row) return
  const range = document.createRange()
  range.selectNodeContents(row)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
})
await sleep(400)
await page.locator('.tbox button[aria-label="链接"]').click()
await sleep(300)
const tboxLinkSub = await page.evaluate(() => ({
  sub: [...document.querySelectorAll('.tbox-sub button')].map((b) => (b.textContent ?? '').trim()),
  bubble: Boolean(document.querySelector('.tbox')),
}))
await page.locator('.tbox-sub button', { hasText: '外部链接' }).click()
await sleep(600)
const tboxAfterLink = await page.evaluate(() => ({
  dialog: Boolean(document.querySelector('.dlg, .sheet, .mask')),
  bubble: Boolean(document.querySelector('.tbox')),
}))
// 收尾：关对话框 → 完成退编辑 → 回桌面档 + 还原页面列
await page.keyboard.press('Escape')
await sleep(400)
await page.locator('.mbar button[aria-label="完成"]').click({ timeout: 5000 }).catch(() => {})
await sleep(500)
const tboxExit = await page.evaluate(() => ({
  bubble: Boolean(document.querySelector('.tbox')),
  bar: Boolean(document.querySelector('.mbar')),
  editing: Boolean(document.querySelector('.doc-col.is-touch-edit')),
}))
await page.setViewportSize({ width: 1280, height: 900 })
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
check('MOBILE-BUBBLE-1 选区气泡（`10` §6.3 定稿 · 七格 · 344）：触控编辑态里块内选词 → 选区上方（顶不够翻下方）浮出**文本动作**条（复制 / 剪切 / 粘贴（按剪贴板可读性显隐）/ 全选 / 删除 ｜ `链接` ｜ `格式 ▸`；**`✦AI` 已撤**——顶栏 ✦ 一步可达）；删除 = 选中字从 DOM 消失且气泡收；`格式 ▸` = 气泡收 + `Aa` 文字格式面板就位；`链接` = 就地两行（外部链接 / 页面链接）→ 点「外部链接」开对话框；完成退编辑后气泡与栏都收',
  tboxTier.bubble === true && tboxTier.selected === '第二块'
  && ['复制', '剪切', '全选', '删除', '链接', '格式 ▸'].every((label) => tboxTier.labels.includes(label))
  && tboxTier.labels.includes('✦AI') === false
  && (tboxTier.above === true || tboxTier.below === true)
  && tboxTier.width === 344
  && tboxTier.svgCount >= 5 /* 图标说话（真机口径 ）：复制/剪切/粘贴/全选/删除…只印单色 Icon，中文名在 aria */
  && tboxAfterDelete.childText === '' && tboxAfterDelete.bubble === false
  && tboxAfterFormat.bubble === false && tboxAfterFormat.charPanel === true && tboxAfterFormat.charLabels.join('/') === '加粗/斜体/删除线/下划线/行内代码/高亮'
  && tboxLinkSub.sub.join('/') === '外部链接/页面链接' && tboxLinkSub.bubble === true
  && tboxAfterLink.dialog === true
  && tboxExit.bubble === false && tboxExit.bar === false && tboxExit.editing === false,
  { tboxTier, tboxAfterDelete, tboxAfterFormat, tboxLinkSub, tboxAfterLink, tboxExit })

// ---------- γ1/形态阶梯（）：**左滑是唯一进入方式**——下面两个测试都用它选块 ----------
// 刺激用**合成 PointerEvent**：无头通道里原生鼠标拖拽到不了编辑器根的监听（ 探针实测；
// 真机触控走原生 pointer 路径，代码里 `pointermove` / `mousemove` / `touchmove` 三条刺激共用同一套判据）。
const swipeSelectOne = () => page.evaluate(() => {
  const el = document.querySelector('.moqi-block:not([data-block-object="true"])') ?? document.querySelector('.moqi-block')
  const rect = el.getBoundingClientRect()
  const x = rect.left + 60
  const y = rect.top + rect.height / 2
  const send = (type, cx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true }))
  send('pointerdown', x)
  send('pointermove', x - 30)
  send('pointermove', x - 80)
  send('pointerup', x - 80)
  // 原生触控滑动收尾会补发一次 click，被「吞一次」吃掉（`touchEditorLayer` 的 swallowed）——
  // 合成序列要把这一步补上，否则那口「吞」会留给后面的第一个真实点击。
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x - 80, clientY: y }))
})
/** 选择栏最窄档「不折行」计数：口径 = `Range.getClientRects` 的**文本真实行数**
 *  （按钮 scrollHeight 会被 `::after` 命中区伪元素撑 2px，区分不了折行）。 */
const wrappedRowCount = () => page.evaluate(() => [...document.querySelectorAll('.cap-select .cap-row button')].filter((b) => {
  let lines = 0
  const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.textContent ?? '').trim()) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    lines += range.getClientRects().length
  }
  return lines > 1
}).length)

// ---------- 块操作栏（`10` §6.2 · 3a）：编辑态选中单块后的两行胶囊 ----------
// 场景重建（同上口径）。
await reset()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('第二块')
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
await page.setViewportSize({ width: 360, height: 720 })
await sleep(600)
await page.locator('.doc-col .moqi-block[data-block-object="true"]').first().dblclick()
await sleep(500)
// γ1/形态阶梯（）：**左滑（唯一入口）滑选恰好 1 块** → 块胶囊（两行制）到场、键盘栏退场。
// （原来是「编辑态内点一块」——单击选中已随 γ1 撤掉。）
await swipeSelectOne()
await sleep(450)
const capTier = await page.evaluate(() => ({
  capsule: Boolean(document.querySelector('.capsule')),
  // 互斥（形态阶梯）：恰好 1 块 ⇒ **不得**出现选择栏
  selbar: Boolean(document.querySelector('.capsule.cap-select')),
  // 圈钮在模式内**常显**（含恰好 1 块）⇒ 该块 `::after` = 实心 ✓
  circle: (() => { const el = document.querySelector('.doc-col .moqi-block.is-selected'); return el ? getComputedStyle(el, '::after').content : null })(),
 // 真机口径（）：工具按钮**不印中文**——可见文本只剩字形 / 图标，aria 里才有中文名。
  inkFree: [...document.querySelectorAll('.capsule .cap-row button')].every((b) => [...b.childNodes].every((n) => n.nodeType !== 3 || (n.textContent ?? '').trim().length <= 2)),
  mbarGone: Boolean(document.querySelector('.mbar')) === false,
  flybar: document.querySelectorAll('.flybar').length,
  rows: [...document.querySelectorAll('.cap-row')].map((row) => [...row.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()).join('/')),
  selected: document.querySelectorAll('.moqi-block.is-selected').length,
  // 两排均分 + 键高 44（`10` §6.2 定稿：≥44×44 达标、不带例外）
  keys: [...document.querySelectorAll('.capsule .cap-row button')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }),
}))
// 插入面板（定稿：**无隐藏层**——`＋` 开同一张面板 ＋ 顶部方向段控）
const capBeforeInsert = await page.evaluate(() => document.querySelectorAll('.doc-col .moqi-block').length)
await page.locator('.capsule button[aria-label="插入"]').click()
await sleep(450)
const capInsert = await page.evaluate(() => ({
  sheet: Boolean(document.querySelector('.mbar-sheet')),
  dir: [...document.querySelectorAll('.mbar-dir .seg button')].map((b) => (b.textContent ?? '').trim()),
  dirOn: [...document.querySelectorAll('.mbar-dir .seg button')].find((b) => b.classList.contains('on'))?.textContent?.trim() ?? '',
  tiles: [...document.querySelectorAll('.mbar-tile')].map((b) => (b.getAttribute('aria-label') ?? '').trim()),
}))
await page.locator('.mbar-tile[aria-label="待办"]').click()
await sleep(700)
const capAfterInsert = await page.evaluate(() => ({
  blocks: document.querySelectorAll('.doc-col .moqi-block').length,
  sheet: Boolean(document.querySelector('.mbar-sheet')),
  capsule: Boolean(document.querySelector('.capsule')),
}))
// 删除：块消失 → 选中清空 → 胶囊收、键盘栏回（仍在编辑态）
await page.locator('.capsule button[aria-label="删除块"]').click()
await sleep(700)
const capDeleted = await page.evaluate(() => ({
  textGone: ![...document.querySelectorAll('.doc-col .moqi-block')].some((b) => (b.textContent ?? '').includes('第二块')),
  blocks: document.querySelectorAll('.doc-col .moqi-block').length,
  capsule: Boolean(document.querySelector('.capsule')),
  mbar: Boolean(document.querySelector('.mbar')),
  editing: Boolean(document.querySelector('.doc-col.is-touch-edit')),
}))
// ✓ 完成：再**左滑滑选一块**（删除后剩的那块）→ 完成 → 回打字态（键盘栏回、胶囊收、仍编辑）
await swipeSelectOne()
await sleep(450)
await page.locator('.capsule button[aria-label="完成"]').click()
await sleep(500)
const capDone = await page.evaluate(() => ({
  capsule: Boolean(document.querySelector('.capsule')),
  mbar: Boolean(document.querySelector('.mbar')),
  editing: Boolean(document.querySelector('.doc-col.is-touch-edit')),
  selected: document.querySelectorAll('.moqi-block.is-selected').length,
}))
await page.setViewportSize({ width: 1280, height: 900 })
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
check('MOBILE-CAPSULE-1 块操作栏（`10` §6.2 定稿）：编辑态里**左滑滑选恰好 1 块**（唯一入口）→ 键盘栏退场、底部**两行胶囊 5 + 5**（上排 = 插入 / 复制 / 剪切 / 复制为块引用 / 删除块；下排 = 缩进 / 反缩进 / 上移 / 下移 / 完成——**只印图标 / 字形，中文名在 aria**）、**无隐藏层**（不再有 `⋯` 与「Aa 格式」「⇤⇥ 整理」）、**恰好 1 块不得出选择栏**、圈钮常显、键高 44（≥44×44 达标）；`＋` 开**同一张插入面板** ＋ 顶部方向段控（默认 ↓ 下方）→ 选「待办」插一块；删除 = 块消失、回打字态；✓ 完成 = 清选中、键盘栏回来；**桌面块浮动工具栏让位**（`.flybar` 计数 0）',
  capTier.capsule === true && capTier.mbarGone === true && capTier.selected === 1 && capTier.flybar === 0 /* 块浮动工具栏 = 桌面形态，compact 让位胶囊（`R09-PAIR-22`） */
  && capTier.selbar === false && capTier.circle !== null && String(capTier.circle).includes('✓') /* 形态阶梯互斥 + 圈钮常显 */
  && capTier.rows[0] === '插入/复制/剪切/复制为块引用/删除块' && capTier.rows[1] === '缩进/反缩进/上移/下移/完成' && capTier.inkFree === true
  && capTier.keys.every(([w, h]) => h === 44 && w >= 44) /* 均分后 ≥44×44（定稿：例外只留主条九键） */
  && capInsert.sheet === true && capInsert.dir.join('/') === '↑ 上方/↓ 下方' && capInsert.dirOn === '↓ 下方'
  && capInsert.tiles.join('/') === '图片/拍照/待办/引用/代码块/分割线/链接/日期时间/附件块/嵌入块'
  && capAfterInsert.blocks === capBeforeInsert + 1 && capAfterInsert.sheet === false && capAfterInsert.capsule === true
  && capDeleted.textGone === true && capDeleted.capsule === false && capDeleted.mbar === true && capDeleted.editing === true
  && capDone.capsule === false && capDone.mbar === true && capDone.editing === true && capDone.selected === 0,
  { capTier, capInsert, capBeforeInsert, capAfterInsert, capDeleted, capDone })

// ---------- 选择模式与选择栏（`10` §6.2 · 3b/3c）----------
await reset()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('第二块')
await sleep(300)
await page.keyboard.press('Enter')
await sleep(200)
await page.keyboard.type('第三块')
await sleep(300)
await page.keyboard.press('Enter')
await sleep(200)
await page.keyboard.type('第四块') // γ2/γ3：滑到 2 块后要留一个**未选中**的落点 ⇒ 夹具共 **3 个正文叶块**
await sleep(300)
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
await page.setViewportSize({ width: 360, height: 720 })
await sleep(600)
await page.locator('.doc-col .moqi-block[data-block-object="true"]').first().dblclick()
await sleep(500)
// 左滑（非边缘起手）→ 进选择模式 + **恰好 1 块**选上（→ 块胶囊；刺激见 `swipeSelectOne` 的说明）。
await swipeSelectOne()
await sleep(500)
const selectEntry = await page.evaluate(() => ({
  mode: Boolean(document.querySelector('.doc-col.is-select-mode')),
  // θ12：进选择模式 = **收键盘**——blur 正文字根，焦点不再是 `.editor-content`（无头通道读焦点当键盘的代理读数）
  focused: Boolean(document.activeElement?.closest?.('.editor-content')),
  // γ1 形态阶梯：左滑满选**恰好 1 块** ⇒ **块胶囊**（两行制），**不得**出现选择栏
  capsule: Boolean(document.querySelector('.capsule')),
  selbar: Boolean(document.querySelector('.capsule.cap-select')),
  capCount: (document.querySelector('.cap-count')?.textContent ?? '').trim() || null,
  // 圈钮在模式内**常显**（含恰好 1 块）⇒ 该块 `::after` = 实心 ✓
  circle: (() => { const el = document.querySelector('.doc-col .moqi-block.is-selected'); return el ? getComputedStyle(el, '::after').content : null })(),
  flybar: document.querySelectorAll('.flybar').length,
  label: (document.querySelector('.cap-count')?.textContent ?? '').trim(),
  selected: document.querySelectorAll('.moqi-block.is-selected').length,
  ids: [...document.querySelectorAll('.doc-col .moqi-block.is-selected')].map((el) => el.dataset.entityId),
  circles: [...document.querySelectorAll('.doc-col .moqi-block[data-entity-id]')].map((el) => getComputedStyle(el, '::after').content),
  /* `R04-ACCEPT-7` 补层（形态阶梯的几何）：底边对齐 + 不做高度动画 + `--dur-mid` 交叉淡入的读数锚点。
     「两栅同位」（`10` 二册 §6.2）在下面 selectTwo 处对照：选择栏那一行应与胶囊动作行逐坐标相等。 */
  geom: (() => {
    const cap = document.querySelector('.capsule')
    if (!cap) return null
    const cs = getComputedStyle(cap)
    const r = cap.getBoundingClientRect()
    const done = [...cap.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').includes('完成'))
    const dr = done?.getBoundingClientRect()
    const rows = [...cap.querySelectorAll('.cap-row')].map((el) => {
      const rr = el.getBoundingClientRect()
      return { l: Math.round(rr.left), r: Math.round(rr.right), t: Math.round(rr.top), b: Math.round(rr.bottom) }
    })
    return {
      bottom: Math.round(r.bottom), rowCount: rows.length, rows,
      doneCy: dr ? Math.round(dr.top + dr.height / 2) : null,
      animDur: cs.animationDuration, animName: cs.animationName, transDur: cs.transitionDuration,
      durMid: getComputedStyle(document.documentElement).getPropertyValue('--dur-mid').trim(),
      inner: window.innerHeight,
    }
  })(),
}))
// 点块增删（`D-058` 修复后新锁）：真点容器块名字行 → 增（与已选子块并存成 2 块）；再点 → 移出（回 1 块）。
// 必须**真点**（原生 mousedown + click）：缺陷正出在 mousedown 阶段——React 合成层把正文根的
// `onMouseDown`（点正文退块选中）照常派发、选区先被清空，click 里的 toggle 便从空集加回（台账 `D-058`）。
const tapHit = await page.evaluate(() => {
  const cont = document.querySelector('.doc-col .moqi-block[data-block-object="true"]')
  const child = cont?.querySelector('.moqi-block[data-entity-id]')
  if (!cont || !child) return null
  const cr = cont.getBoundingClientRect()
  const kr = child.getBoundingClientRect()
  // 扫名字行带（容器顶 → 首个子块顶）：找「elementsFromPoint 最顶恰是容器元素本身」的点（`R04-NAME-12` 的判定口径）。
  for (let y = Math.round(cr.top) + 1; y < Math.min(Math.round(kr.top), Math.round(cr.top) + 120); y += 2) {
    for (const x of [Math.round(cr.left) + 8, Math.round(cr.left) + 24, Math.round(cr.left) + 48]) {
      if (document.elementFromPoint(x, y) === cont) return { x, y, contId: cont.dataset.entityId }
    }
  }
  return null
})
// φ3 负例（）：模式内点**页面容器**（名字行）⇒ **不入选区**（容器是选区的边界）、圈钮也不画它。
let selectTapAdd = null
let selectTapRemove = null
let wrappedAtTwo = null
let selectContainerTap = null
if (tapHit) {
  await page.mouse.click(tapHit.x, tapHit.y)
  await sleep(450)
  selectContainerTap = await page.evaluate(() => {
    const container = document.querySelector('.moqi-block[data-block-object="true"]')
    return {
      selected: document.querySelectorAll('.moqi-block.is-selected').length,
      containerSelected: container ? container.classList.contains('is-selected') : null,
      containerCircle: container ? getComputedStyle(container, '::after').content : null,
    }
  })
  // φ3：加第二块要**点另一个正文叶子块**（容器已不可选）——再点一次 = 移出、第三次 = 加回（→ 2 块 ⇒ 选择栏）
  const secondLeaf = page.locator('.doc-col .moqi-block[data-entity-id]:not([data-block-object="true"])').nth(1)
  await secondLeaf.click()
  await sleep(450)
  selectTapAdd = await page.evaluate(() => ({
    label: (document.querySelector('.cap-count')?.textContent ?? '').trim(),
    ids: [...document.querySelectorAll('.doc-col .moqi-block.is-selected')].map((el) => el.dataset.entityId),
    // 形态阶梯：≥ 2 块 ⇒ 选择栏（`.cap-select`）、不得再出胶囊的其他形态
    selbar: Boolean(document.querySelector('.capsule.cap-select')),
  }))
  wrappedAtTwo = await wrappedRowCount() /* 最窄档选择栏不折行（横向滑动兜底） */
  await secondLeaf.click()
  await sleep(450)
  selectTapRemove = await page.evaluate(() => ({
    label: (document.querySelector('.cap-count')?.textContent ?? '').trim() || null,
    ids: [...document.querySelectorAll('.doc-col .moqi-block.is-selected')].map((el) => el.dataset.entityId),
    // 回 1 块 ⇒ 阶梯回退到胶囊（选择栏不得在场）
    selbar: Boolean(document.querySelector('.capsule.cap-select')),
    capsule: Boolean(document.querySelector('.capsule')),
  }))
  // 再加一块 → 2 块：下一步「全选」只在选择栏在场时可用（形态阶梯）
  await secondLeaf.click()
  await sleep(450)
}
const selectTwo = await page.evaluate(() => ({
  label: (document.querySelector('.cap-count')?.textContent ?? '').trim(),
  selbar: Boolean(document.querySelector('.capsule.cap-select')),
  /* 同 selectEntry.geom 的字段：选择栏（单行）与胶囊动作行逐坐标对照（两栅同位）。 */
  geom: (() => {
    const cap = document.querySelector('.capsule')
    if (!cap) return null
    const cs = getComputedStyle(cap)
    const r = cap.getBoundingClientRect()
    const done = [...cap.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').includes('完成'))
    const dr = done?.getBoundingClientRect()
    const rows = [...cap.querySelectorAll('.cap-row')].map((el) => {
      const rr = el.getBoundingClientRect()
      return { l: Math.round(rr.left), r: Math.round(rr.right), t: Math.round(rr.top), b: Math.round(rr.bottom) }
    })
    return {
      bottom: Math.round(r.bottom), rowCount: rows.length, rows,
      doneCy: dr ? Math.round(dr.top + dr.height / 2) : null,
      animDur: cs.animationDuration, animName: cs.animationName, transDur: cs.transitionDuration,
      durMid: getComputedStyle(document.documentElement).getPropertyValue('--dur-mid').trim(),
      inner: window.innerHeight,
    }
  })(),
}))
// ---------- φ2：选择模式内拖拽（整组一次事务 + 一步撤销 + 三条负例）----------
const orderNow = () => page.evaluate(() => [...document.querySelectorAll('.doc-col .moqi-block[data-entity-id]')].map((el) => el.dataset.entityId))
// φ3 之后容器**不可能**进选区（`selectBlock` 一处守卫）⇒ 不用再先把容器移出去；
// 夹具是**三个**正文叶块：选区 = 前两块（选择栏在场），落点目标 = 第三块（未选中）——正例不成两难。
const orderBeforeDrag = await orderNow()
// 滚动归零：目标块靠上就不会落在底部选择栏下面（`elementFromPoint` 必须命中块本体）
await page.evaluate(() => { const scroller = document.querySelector('.doc-col'); if (scroller) scroller.scrollTop = 0 })
await sleep(150)
/** 按住**已选叶子块**→ 移过 slop → 落到**另一个未选叶子块**的中线（→ `into`）；返回拖拽中读数。 */
const dragMid = await page.evaluate(() => {
  const leaves = [...document.querySelectorAll('.doc-col .moqi-block[data-entity-id]')]
  const isLeaf = (el) => el.querySelector('.moqi-block') === null
  const source = leaves.find((el) => el.classList.contains('is-selected') && isLeaf(el))
  const target = leaves.find((el) => !el.classList.contains('is-selected') && isLeaf(el))
  if (!source || !target) return null
  const sr = source.getBoundingClientRect(); const tr = target.getBoundingClientRect()
  const x0 = sr.left + 60; const y0 = sr.top + sr.height / 2; const y1 = tr.top + tr.height / 2
  const send = (type, x, y) => source.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 2, pointerType: 'touch', isPrimary: true }))
  send('pointerdown', x0, y0); send('pointermove', x0 + 24, y0 + 24); send('pointermove', x0 + 24, y1)
  const line = document.getElementById('moqi-drop-line')
  const marker = line ? (line.classList.contains('is-into') ? 'into' : 'line') : null
  return { dragging: document.querySelectorAll('.moqi-block.is-dragging').length, marker, markers: line ? 1 : 0 }
})
const dragLeftAfterRelease = await page.evaluate(() => {
  const el = document.querySelector('.moqi-block.is-dragging') ?? document.querySelector('.doc-col .moqi-block[data-entity-id]')
  el?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', isPrimary: true }))
  return document.querySelectorAll('.moqi-block.is-dragging').length
})
await sleep(600)
const orderAfterDrag = await orderNow()
await page.keyboard.press('Control+z')
await sleep(600)
const orderAfterUndo = await orderNow()
// 负例①：位移 ＜ slop 不进拖拽
const microDrag = await page.evaluate(() => {
  const source = [...document.querySelectorAll('.doc-col .moqi-block[data-entity-id]')].find((el) => el.classList.contains('is-selected'))
  if (!source) return null
  const r = source.getBoundingClientRect()
  const send = (type, x, y) => source.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 3, pointerType: 'touch', isPrimary: true }))
  send('pointerdown', r.left + 60, r.top + r.height / 2)
  send('pointermove', r.left + 64, r.top + r.height / 2 + 4)
  const dragging = document.querySelectorAll('.moqi-block.is-dragging').length
  send('pointerup', r.left + 64, r.top + r.height / 2 + 4)
  return { dragging }
})
// 负例②：按住**未选块**拖动不接管（让给滚动）、也不出速览
const unselectedDrag = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('.doc-col .moqi-block[data-entity-id]')]
  const source = blocks.find((el) => !el.classList.contains('is-selected') && el.querySelector('.moqi-block') === null)
  if (!source) return null
  const r = source.getBoundingClientRect()
  const send = (type, x, y) => source.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 4, pointerType: 'touch', isPrimary: true }))
  send('pointerdown', r.left + 60, r.top + r.height / 2)
  send('pointermove', r.left + 60, r.top + r.height / 2 + 40)
  const dragging = document.querySelectorAll('.moqi-block.is-dragging').length
  send('pointerup', r.left + 60, r.top + r.height / 2 + 40)
  return { dragging, peek: Boolean(document.querySelector('.peek')) }
})
const dragOrderChanged = orderAfterDrag.join('|') !== orderBeforeDrag.join('|')
const dragUndoRestored = orderAfterUndo.join('|') === orderBeforeDrag.join('|')
// 拖拽**不动选区**（`finishDrag` 只清视觉、不改 `selectMode`）⇒ 仍是 2 块、选择栏在场，
// 下面的「全选」直接可用（不必再点块）。
await page.locator('.capsule button[aria-label="全选"]').click()
await sleep(400)
const selectAllNow = await page.evaluate(() => ({
  label: (document.querySelector('.cap-count')?.textContent ?? '').trim(),
  selected: document.querySelectorAll('.moqi-block.is-selected').length,
 // φ3（）：容器不进选区 ⇒ 期望总数 = **非容器**块数；并直接验容器没被选上
  total: document.querySelectorAll('.doc-col .moqi-block[data-entity-id]:not([data-block-object="true"])').length,
  containerSelected: Boolean(document.querySelector('.moqi-block[data-block-object="true"]')?.classList.contains('is-selected')),
}))
// 选择栏 = **复刻胶囊**（`10` §6.2 定稿）：无隐藏层——两排按钮逐格点名（不再有 `⋯` 菜单）。
const selectRows = await page.evaluate(() => [...document.querySelectorAll('.capsule.cap-select .cap-row')].map((row) => [...row.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()).join('/')))
// ✓ 完成 → 退模式、清选中、键盘栏回、仍编辑
await page.locator('.capsule button[aria-label="完成"]').click()
await sleep(500)
const selectDone = await page.evaluate(() => ({
  mode: Boolean(document.querySelector('.doc-col.is-select-mode')),
  bar: Boolean(document.querySelector('.capsule')),
  mbar: Boolean(document.querySelector('.mbar')),
  editing: Boolean(document.querySelector('.doc-col.is-touch-edit')),
  // θ12：✓完成退出 ⇒ 焦点回正文字根（键盘与格式栏按 `10` 二册 §6.2 回来）
  focused: Boolean(document.activeElement?.closest?.('.editor-content')),
}))
await page.setViewportSize({ width: 1280, height: 900 })
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
check('MOBILE-SELECT-1 选择模式与选择栏（`10` §6.2 定稿）：编辑态内左滑（非边缘）→ 进选择模式 + **恰好 1 块**（→ 块胶囊 + 圈钮实心 ✓、其余空圈；**不得**出选择栏）+ **收键盘**（θ12：焦点离开正文字根）；点块 = 加入 / 移出（真点**非容器**叶块 → 2 块成选择栏、再点回 1 块回胶囊）；**选择模式内拖拽**（已选叶块 → 未选叶块中线）= 整组一次事务（顺序变、只画一处落点线、拖完仍留模式）+ **⇧⌘ 一步撤销**；全选 = 全部可见块（**不含页面容器**）；**选择栏 = 复刻胶囊**（同形两排、`✓ 完成` 同位）：上排 = 全选（虚线选框）/ 待办（方框勾）/ 插入 / 复制 / 剪切 / 复制为块引用，下排 = 缩进 / 反缩进 / 上移 / 下移 / 删除块 / 完成——**无隐藏层**；✓ 完成 = 退模式清选中、键盘栏回来（焦点回正文，θ12）、仍在编辑；**桌面块浮动工具栏让位**（`.flybar` 计数 0）',
  selectEntry.mode === true && selectEntry.capsule === true && selectEntry.selbar === false && selectEntry.capCount === null /* 形态阶梯互斥：1 块 ⇒ 胶囊、无「已选 N 块」 */
  && selectEntry.focused === false /* θ12：进模式收键盘（负例：把 `getRootElement()?.blur()` 删掉 ⇒ 这里必红） */
  && selectEntry.selected === 1 && selectEntry.flybar === 0 /* 同上：选择模式也不叠桌面块浮动工具栏 */
  && selectEntry.circle !== null && String(selectEntry.circle).includes('✓') /* 圈钮在模式内常显（含恰好 1 块） */
  && selectEntry.circles.length >= 2 && selectEntry.circles.some((content) => content.includes('✓')) && selectEntry.circles.some((content) => content === '""')
  /* `R04-ACCEPT-7` 补层（几何）：形态阶梯三条视觉性质（`10` 二册 §6.2）——
     ① 底边对齐：胶囊与选择栏都贴底（bottom = 内高）；② 两栅同位：选择栏那一行 = 胶囊**动作行**逐坐标
     相等（l/r/t/b）、`✓ 完成` 同一水平线（cy 相等）；③ 交叉淡入：`animation: fade var(--dur-mid)`，
     容器 transitionDuration = 0s（不做高度动画）。负例：把 `.cap-row` 换成不用两行制 / 加高度过渡 ⇒ 必红。 */
  && selectEntry.geom !== null && selectTwo.geom !== null
  && selectEntry.geom.rowCount === 2 && selectTwo.geom.rowCount === 2 /* 定稿：两栏**同形两排**（复刻） */
  && selectEntry.geom.bottom === selectEntry.geom.inner && selectTwo.geom.bottom === selectTwo.geom.inner
  && selectEntry.geom.doneCy !== null && selectEntry.geom.doneCy === selectTwo.geom.doneCy /* ✓ 完成恒在同位（右下角） */
  && selectEntry.geom.animDur === selectEntry.geom.durMid && selectEntry.geom.animDur === '0.18s'
  && selectEntry.geom.animName.includes('fade') && selectEntry.geom.transDur === '0s'
  && tapHit !== null
  /* φ3：加第二块是点**另一个正文叶块**（容器不可选）⇒ 选区 = 两个叶块、**不含**容器 */
  && selectTapAdd.label === '已选 2 块' && selectTapAdd.ids.length === 2 && !selectTapAdd.ids.includes(tapHit.contId) && selectEntry.ids.every((id) => selectTapAdd.ids.includes(id))
  && selectTapAdd.selbar === true && wrappedAtTwo === 0 /* 2 块 ⇒ 选择栏；最窄档不折行（横向滑动兜底） */
  && selectTapRemove.label === null && selectTapRemove.ids.length === 1 && selectTapRemove.ids[0] === selectEntry.ids[0] && selectTapRemove.selbar === false && selectTapRemove.capsule === true /* 阶梯回退到胶囊 */
  && selectTwo.label === '已选 2 块' && selectTwo.selbar === true
  /* φ2：选择模式内拖拽——进拖拽态 + **只画一处**落点线 + 松手顺序变更 + **⌘Z 一步回退** */
  && dragMid !== null && dragMid.dragging >= 1 && dragMid.marker === 'into' && dragMid.markers === 1
  && dragLeftAfterRelease === 0 && dragOrderChanged === true && dragUndoRestored === true
  /* φ2 负例：位移 ＜ slop 不进拖拽；按住未选块拖动不接管（也不出速览） */
  && microDrag !== null && microDrag.dragging === 0
  && unselectedDrag !== null && unselectedDrag.dragging === 0 && unselectedDrag.peek === false
  && selectAllNow.label === `已选 ${selectAllNow.total} 块` && selectAllNow.selected === selectAllNow.total && selectAllNow.containerSelected === false /* φ3：「全选」不含页面容器 */
  && selectContainerTap !== null && selectContainerTap.selected === 1 && selectContainerTap.containerSelected === false && selectContainerTap.containerCircle === 'none' /* φ3：模式内点容器不入选区、圈钮也不画它 */
  && selectRows[0] === '全选/待办/插入/复制/剪切/复制为块引用' && selectRows[1] === '缩进/反缩进/上移/下移/删除块/完成'
  && selectDone.mode === false && selectDone.bar === false && selectDone.mbar === true && selectDone.editing === true && selectDone.focused === true /* θ12：✓完成退出 ⇒ 焦点回正文（键盘跟着回来） */,
  { selectEntry, tapHit, selectContainerTap, selectTapAdd, wrappedAtTwo, selectTapRemove, selectTwo, dragMid, dragLeftAfterRelease, orderBeforeDrag, orderAfterDrag, orderAfterUndo, microDrag, unselectedDrag, selectAllNow, selectRows, selectDone })

// ---------- θ9（ 用户走查「多选后取消不掉」）：选区清空 ⇒ 退模式；吞 click 不漏到下一次 ----------
// ① 点掉**最后一块**：旧行为 = 底部回格式栏但 `.is-select-mode` 还挂在 `.doc-col` 上（圈钮照画、
//    点块继续走 toggle 分支）——「谁点都取消不掉」。0 块在形态阶梯里没有形态 ⇒ 退出模式。
// ② 拖拽吞 click 的泄漏：拖拽（浏览器**不补发** click）漏下的 `swallowed` 会把**下一次**真实点击吃掉。
await reset()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('第二块')
await sleep(300)
await page.keyboard.press('Enter')
await sleep(200)
await page.keyboard.type('第三块')
await sleep(300)
await page.keyboard.press('Enter')
await sleep(200)
await page.keyboard.type('第四块')
await sleep(300)
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
await page.setViewportSize({ width: 360, height: 720 })
await sleep(600)
await page.locator('.doc-col .moqi-block[data-block-object="true"]').first().dblclick()
await sleep(500)
// ① 滑选 1 块 → **真点**它 ⇒ 选区清空 = 退模式（模式类收、胶囊收、键盘栏回、仍在编辑）
await swipeSelectOne()
await sleep(500)
const lastTapTarget = await page.evaluate(() => {
  const el = document.querySelector('.doc-col .moqi-block.is-selected')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2), mode: Boolean(document.querySelector('.doc-col.is-select-mode')), focused: Boolean(document.activeElement?.closest?.('.editor-content')) }
})
if (lastTapTarget) await page.mouse.click(lastTapTarget.x, lastTapTarget.y)
await sleep(500)
const lastGone = await page.evaluate(() => ({
  selected: document.querySelectorAll('.moqi-block.is-selected').length,
  mode: Boolean(document.querySelector('.doc-col.is-select-mode')),
  capsule: Boolean(document.querySelector('.capsule')),
  mbar: Boolean(document.querySelector('.mbar')),
  editing: Boolean(document.querySelector('.doc-col.is-touch-edit')),
  // θ12：点掉最后一块 ⇒ 退模式回打字态，焦点回正文字根（键盘跟着回来）
  focused: Boolean(document.activeElement?.closest?.('.editor-content')),
}))
// ② 滑选 1 块 → 加第二块（真点另一个叶块）→ 合成一次拖拽（同 φ2 手法）→ **真点**一个已选块
await swipeSelectOne()
await sleep(450)
await page.locator('.doc-col .moqi-block[data-entity-id]:not([data-block-object="true"])').nth(1).click()
await sleep(450)
const leakBefore = await page.evaluate(() => document.querySelectorAll('.moqi-block.is-selected').length)
const dragLeak = await page.evaluate(() => {
  const leaves = [...document.querySelectorAll('.doc-col .moqi-block[data-entity-id]')]
  const isLeaf = (el) => el.querySelector('.moqi-block') === null
  const source = leaves.find((el) => el.classList.contains('is-selected') && isLeaf(el))
  const target = leaves.find((el) => !el.classList.contains('is-selected') && isLeaf(el))
  if (!source || !target) return null
  const sr = source.getBoundingClientRect(); const tr = target.getBoundingClientRect()
  const send = (type, x, y) => source.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 9, pointerType: 'touch', isPrimary: true }))
  send('pointerdown', sr.left + 60, sr.top + sr.height / 2)
  send('pointermove', sr.left + 84, sr.top + sr.height / 2 + 24)
  send('pointermove', sr.left + 84, tr.top + tr.height / 2)
  const dragging = document.querySelectorAll('.moqi-block.is-dragging').length
  send('pointerup', sr.left + 84, tr.top + tr.height / 2)
  return { dragging, mode: Boolean(document.querySelector('.doc-col.is-select-mode')) }
})
await sleep(500)
const leakModeAfterDrag = await page.evaluate(() => Boolean(document.querySelector('.doc-col.is-select-mode')))
await page.locator('.doc-col .moqi-block.is-selected').first().click()
await sleep(500)
const leakAfter = await page.evaluate(() => document.querySelectorAll('.moqi-block.is-selected').length)
await page.setViewportSize({ width: 1280, height: 900 })
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
check('MOBILE-SELECT-2 选区清空即退模式（θ9 · 2026-10-13）：点掉**最后一块** ⇒ 选区清空 = **退出选择模式**（`.is-select-mode` 收、胶囊收、键盘栏回来——焦点回正文＝键盘回来，θ12、仍在编辑）；**拖拽吞 click 不漏**——合成一次拖拽（浏览器不补发 click）后**真点**一个已选块，仍能把它移出选区（旧缺陷：漏下的 `swallowed` 吃掉下一次真实点击，点谁都取消不掉；负例：把 `startSwipe` 里的 `swallowed = false` 删掉 ⇒ `leakAfter` 必红）',
  lastTapTarget !== null && lastTapTarget.mode === true && lastTapTarget.focused === false /* θ12：左滑进模式时已收键盘 */
  && lastGone.selected === 0 && lastGone.mode === false && lastGone.capsule === false && lastGone.mbar === true && lastGone.editing === true && lastGone.focused === true /* θ12：退模式 ⇒ 焦点回正文 */
  && dragLeak !== null && dragLeak.dragging >= 1 && dragLeak.mode === true && leakModeAfterDrag === true /* 拖完仍留在选择模式 */
  && leakBefore === 2 && leakAfter === 1,
  { lastTapTarget, lastGone, dragLeak, leakModeAfterDrag, leakBefore, leakAfter })

// ---------- 工具栏族正形（字阶与图标批）：记法 = 图标语义 ----------
// ① 主条九键 + `Aa` 面板六项 = Lucide 线条图标（20px / 2px 圆头），不再有 B/I/S/U/ab 字形；
// ② 外链 = svg 图标；③ 动作行 = 图标 + 中文标签，emoji 清零（🗑 → Icon trash，Android 上彩色不同轨）；
// ④ 图标尺寸落 08 §6.6 的移动档 19–22。
await reset()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('第二块')
await sleep(1350)
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('页面列表（⌘⇧'))?.click() })
await sleep(400)
await page.setViewportSize({ width: 360, height: 720 })
await sleep(700)
// 只读态：编辑 / AI 在顶栏（Dock 已退役），两枚 svg、尺寸 19–22
const iconDock = await page.evaluate(() => {
  const svgs = [
    document.querySelector('.topbar button[aria-label="编辑"] svg'),
    document.querySelector('.topbar button[aria-label="AI 助手"] svg'),
  ].filter(Boolean)
  return { count: svgs.length, w: svgs.map((s) => Math.round(s.getBoundingClientRect().width)) }
})
// 进编辑态：主条六键 = Lucide 线条图标
await page.locator('.doc-col .moqi-block[data-block-object="true"]').first().dblclick()
await sleep(500)
const iconSeg2 = await page.evaluate(() => ({
  // 主条六键：**全部** Lucide 线条图标，不再有 `＋ Tт Aa ≡ ☰ ✦` 字形。
  svgCount: document.querySelectorAll('.mbar button svg').length,
  svgW: [...document.querySelectorAll('.mbar svg')].map((s) => Math.round(s.getBoundingClientRect().width)),
  keepText: ['＋', 'Tт', 'Aa', '≡', '☰', '✦'].map((label) => [...document.querySelectorAll('.mbar button')].some((b) => (b.textContent ?? '').trim() === label)),
}))
// γ1：**左滑满选一块** → 胶囊（单击选中已撤）：动作行图标 + emoji 清零
await swipeSelectOne()
await sleep(500)
const iconCapsule = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.capsule .cap-row button')]
  const svgs = [...document.querySelectorAll('.capsule svg')]
  return {
    svgCount: svgs.length,
    svgW: svgs.map((s) => Math.round(s.getBoundingClientRect().width)),
    // 只筛**彩色 emoji**（1F300–1FAFF）；✓/✦/⋯/⇤ 这些单色字形是有意的记法，不算 emoji。
    emoji: btns.some((b) => /[\u{1F300}-\u{1FAFF}]/u.test(b.textContent ?? '')),
    deleteIcon: Boolean(document.querySelector('.capsule button[aria-label="删除块"] svg')),
  }
})
await page.keyboard.press('Escape')
await sleep(300)
await page.setViewportSize({ width: 1280, height: 900 })
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('页面列表（⌘⇧'))?.click() })
await sleep(500)
check('MOBILE-ICON-1 工具栏族正形（字阶与图标批）：主条六键**全部 Lucide 线条图标**（20px / 2px，键内零文字 / 中文名在 aria）；胶囊分类行 / 动作行 = **只印图标**（`inkFree`）、**emoji 清零**（删除 = Icon trash）；顶栏编辑 / AI svg；工具栏族图标尺寸落 19–22',
  iconDock.count === 2 && iconDock.w.every((w) => w >= 19 && w <= 22)
  && iconSeg2.svgCount === 6 && iconSeg2.svgW.every((w) => w >= 19 && w <= 22) && iconSeg2.keepText.every((v) => v === false)
  && iconCapsule.svgCount >= 4 && iconCapsule.svgW.every((w) => w >= 19 && w <= 22) && iconCapsule.emoji === false && iconCapsule.deleteIcon === true,
  { iconDock, iconSeg2, iconCapsule })

// ---------- W4 骑批（）：G-E04「下划线整块」＋ G-E06「今天 / 现在」 ----------
await page.setViewportSize({ width: 1280, height: 900 })
await reset()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('工具补齐')
await sleep(1350)
// ① G-E04：整块格式补第六枚「下划线整块」——点一下回读按下态（blockFormats 读节点真值）
await clickHandle(0)
const flyLabels = await page.evaluate(() => [...document.querySelectorAll('.flybar button[aria-label$="整块"]')].map((b) => b.getAttribute('aria-label')))
await page.locator('.flybar button[aria-label="下划线整块"]').click()
await sleep(400)
const underlineWhole = await page.evaluate(() => ({
  pressed: document.querySelector('.flybar button[aria-label="下划线整块"]')?.getAttribute('aria-pressed'),
  txU: document.querySelectorAll('.editor-content .tx-u').length,
}))
await page.keyboard.press('Escape')
await sleep(300)
// ② G-E06：斜杠「插入」组有「今天」「现在」——插出装着日期 / 日期时间的文本块（本地时区口径）
const pad2 = (n) => String(n).padStart(2, '0')
const nowD = new Date()
const todayStr = `${nowD.getFullYear()}-${pad2(nowD.getMonth() + 1)}-${pad2(nowD.getDate())}`
await clickBlock('工具补齐')
await page.keyboard.press('Home') // 斜杠触发要块首（或空格后）——行尾不算
await page.keyboard.type('/')
await sleep(600)
const slashLabels = await page.evaluate(() => [...document.querySelectorAll('.slash-menu-item .slash-menu-label')].map((el) => (el.textContent ?? '').trim()))
await page.locator('.slash-menu-item', { hasText: '今天' }).click()
const todayBlock = await poll(domTexts, (texts) => texts.includes(todayStr), { timeout: 6000, label: '「今天」插入日期块' })
await page.keyboard.press('Home')
await page.keyboard.type('/')
await sleep(600)
await page.locator('.slash-menu-item', { hasText: '现在' }).click()
const nowBlocks = await poll(domTexts, (texts) => texts.some((t) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t)), { timeout: 6000, label: '「现在」插入日期时间块' })
check('W4-1（`G-E04` / `G-E06`，2026-10-11）：块浮动工具栏整块格式 = **六连**（补「下划线整块」，点一下回读按下态 + 整块出 .tx-u）；斜杠「插入」组有「今天」「现在」——插出 `YYYY-MM-DD` / `YYYY-MM-DD HH:MM` 的普通文本块（不加新块类型）',
  flyLabels.join('/') === '加粗整块/斜体整块/下划线整块/删除线整块/行内代码整块/高亮整块'
  && underlineWhole.pressed === 'true' && underlineWhole.txU >= 1
  && slashLabels.includes('今天') && slashLabels.includes('现在')
  && todayBlock.includes(todayStr) && nowBlocks.some((t) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t) && t.startsWith(todayStr)),
  { flyLabels, underlineWhole, slashLabels, todayStr, todayBlock: todayBlock.slice(0, 6), nowBlocks: nowBlocks.slice(0, 6) })

// ---------- 移动骨架（`10` §三 骨架 / §4.1 首页 / §4.3 编辑器 / §4.5 抽屉，4a）----------
// 判据：① 首屏 = 首页（**进应用**落在页面库卡片列表——桌面档先写「页面列收起」的意图再窄化 + reload，
// 首屏仍必须是首页；窗口开关让位、页面库头 = ☰ + 「页面库」、FAB 真点得到）；② ☰ → 侧栏抽屉
// （fixed、≤300px、遮罩在、首页不消失）→ 点遮罩关；③ 点卡片 → 编辑器（顶栏 ←、常驻格式栏让位、
// 顶栏 ✎编辑 / ✦AI 真点得到）；④ ✎编辑 → 触控编辑态（键盘栏升）；
// ⑤ 退编辑后 ← → 回首页。窗口三键不在骨架里动（窄窗验收台，`WINDOW-FIT-1` 看住）。
await reset()
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await page.keyboard.type('第二块')
await sleep(1350)
// 桌面档折页面列（把「上次停在编辑器」的意图写进偏好）→ 窄化 + reload：首屏必须是首页。
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)
await page.setViewportSize({ width: 360, height: 720 })
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
const shellHome = await page.evaluate(() => {
  const pc = document.querySelector('.pagecol')
  const at = document.elementFromPoint(180, 400)
  const fab = document.querySelector('.fab')
  const fr = fab?.getBoundingClientRect()
  const switchEl = document.querySelector('.pagecol-head .lib-switch')
  const newEl = document.querySelector('.pagecol-head .col-new')
  return {
    pagecolW: pc ? Math.round(pc.getBoundingClientRect().width) : null,
    homeOnTop: Boolean(at?.closest('.pagecol')),
    burger: Boolean(document.querySelector('.pagecol-head [aria-label="打开抽屉"]')),
    title: (document.querySelector('.pagecol-head .pc-title')?.textContent ?? '').trim(),
    switchHidden: switchEl ? getComputedStyle(switchEl).display === 'none' : true,
    newHidden: newEl ? getComputedStyle(newEl).display === 'none' : null,
    wbarTogglesHidden: [...document.querySelectorAll('.wbar .tb-btn')].every((el) => getComputedStyle(el).display === 'none'),
    fabHittable: (() => { if (!fr) return false; const top = document.elementFromPoint(Math.round(fr.left + fr.width / 2), Math.round(fr.top + fr.height / 2)); return Boolean(top?.closest?.('.fab')) })(),
  }
})
// ☰ → 侧栏抽屉（首页之上）；点遮罩关。
await page.locator('.pagecol-head [aria-label="打开抽屉"]').click()
await sleep(600)
const shellDrawer = await page.evaluate(() => {
  const sb = document.querySelector('.sidebar')
  const r = sb?.getBoundingClientRect()
  const at = r ? document.elementFromPoint(Math.round(r.left + 40), Math.round(r.top + 220)) : null
  return {
    fixed: sb ? getComputedStyle(sb).position : null,
    w: r ? Math.round(r.width) : null,
    onTop: Boolean(sb && at && sb.contains(at)),
    backdrop: Boolean(document.querySelector('.side-backdrop')),
    homeKept: Boolean(document.querySelector('.pagecol')),
  }
})
await page.locator('.side-backdrop').click({ position: { x: 340, y: 400 } })
await sleep(500)
const shellDrawerClosed = await page.evaluate(() => ({
  backdrop: Boolean(document.querySelector('.side-backdrop')),
  sidebarGone: !document.elementFromPoint(40, 300)?.closest?.('.sidebar'),
}))
// 点卡片 → 编辑器视图：顶栏 ← / ✎ / ✦、无常驻格式栏。
await page.locator('.pagecol .bd-open').first().click()
await sleep(700)
const shellEditor = await page.evaluate(() => {
  const edit = document.querySelector('.topbar [aria-label="编辑"]')
  const ai = document.querySelector('.topbar [aria-label="AI 助手"]')
  const hit = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)); return Boolean(at && (at === el || el.contains(at))) }
  return {
    pagecolGone: !document.querySelector('.pagecol'),
    back: Boolean(document.querySelector('.topbar [aria-label="返回页面库"]')),
    fmtbarHidden: !document.querySelector('.fmtbar'),
    editPresent: Boolean(edit) && hit(edit),
    aiPresent: Boolean(ai) && hit(ai),
  }
})
// ✎ 编辑（顶栏）→ 触控编辑态；键盘栏升。
await page.locator('.topbar [aria-label="编辑"]').click()
await sleep(800)
const shellEditing = await page.evaluate(() => ({
  touch: Boolean(document.querySelector('.doc-col.is-touch-edit')),
  bodyFlag: document.body.classList.contains('is-touch-editing'),
  mbar: Boolean(document.querySelector('.mbar')),
}))
// θ13：点空白**不退编辑**（两下也不退）⇒ 退编辑走正门「完成」；底栏回；← → 回首页。
await page.locator('.doc-col').click({ position: { x: 6, y: 6 } })
await sleep(400)
await page.locator('.doc-col').click({ position: { x: 6, y: 6 } })
await sleep(400)
const shellBlankKept = await page.evaluate(() => Boolean(document.querySelector('.doc-col.is-touch-edit')))
await page.locator('.mbar button[aria-label="完成"]').click({ timeout: 5000 }).catch(() => {}) // 短超时防中断（见 MOBILE-EDIT-1 处注）
await sleep(500)
const shellExit = await page.evaluate(() => ({
  touch: Boolean(document.querySelector('.doc-col.is-touch-edit')),
  editPresent: Boolean(document.querySelector('.topbar [aria-label="编辑"]')),
}))
await page.locator('.topbar [aria-label="返回页面库"]').click()
await sleep(600)
const shellBack = await page.evaluate(() => {
  const pc = document.querySelector('.pagecol')
  return {
    pagecolW: pc ? Math.round(pc.getBoundingClientRect().width) : null,
    burger: Boolean(document.querySelector('.pagecol-head [aria-label="打开抽屉"]')),
  }
})
await page.setViewportSize({ width: 1280, height: 900 })
await sleep(400)
check('MOBILE-SHELL-1 移动骨架（`10` §三/§4.1/§4.3/§4.5 · 4a）：桌面档先写「页面列收起」意图再窄化 reload——首屏仍是首页（页面库整屏 360、☰ +「页面库」头、形态切换与 ＋新建让位、窗口面板开关让位、FAB 真点得到）；☰ → 侧栏抽屉（fixed / ≤300px / 首页之上 / 遮罩在 / 首页不消失）→ 遮罩点关；点卡片 → 编辑器（页面列退场、顶栏 ← / ✎编辑 / ✦AI 真点得到、无常驻格式栏）；✎编辑 → 触控编辑态（键盘栏升）；点空白**不退编辑**（θ13：两下也不退）→ 键盘栏「完成」退编辑；← → 回首页',
  shellHome.pagecolW === 360 && shellHome.homeOnTop === true && shellHome.burger === true && shellHome.title === '页面库'
  && shellHome.switchHidden === true && shellHome.newHidden === true && shellHome.wbarTogglesHidden === true && shellHome.fabHittable === true
  && shellDrawer.fixed === 'fixed' && shellDrawer.w !== null && shellDrawer.w <= 300 && shellDrawer.onTop === true && shellDrawer.backdrop === true && shellDrawer.homeKept === true
  && shellDrawerClosed.backdrop === false && shellDrawerClosed.sidebarGone === true
  && shellEditor.pagecolGone === true && shellEditor.back === true && shellEditor.fmtbarHidden === true && shellEditor.editPresent === true && shellEditor.aiPresent === true
  && shellEditing.touch === true && shellEditing.bodyFlag === true && shellEditing.mbar === true
  && shellBlankKept === true /* θ13：点空白（两下）仍在编辑态 */
  && shellExit.touch === false && shellExit.editPresent === true
  && shellBack.pagecolW === 360 && shellBack.burger === true,
  { shellHome, shellDrawer, shellDrawerClosed, shellEditor, shellEditing, shellBlankKept, shellExit, shellBack })

// ---------- 系统返回键的应用内阶梯（用户 口径：**浮层 → 上一层；编辑态不接**）----------
// Kotlin 侧（`MainActivity.kt`）把返回键先问 `window.__moqiBack`：true = 应用内消化、false = 交系统退出。
// 这里在浏览器通道直接调同一份钩子，走阶梯四级：首页 false → 抽屉 → 编辑器（回页面库）→ 设置（关）。
await reset()
await page.setViewportSize({ width: 360, height: 720 })
await sleep(600)
const backBridge = await page.evaluate(() => typeof window.__moqiBack)
const backLevels = {}
backLevels.home = await page.evaluate(() => window.__moqiBack?.() ?? null)
await page.locator('.pagecol-head [aria-label="打开抽屉"]').click()
await sleep(500)
backLevels.drawerBefore = await page.evaluate(() => Boolean(document.querySelector('.sidebar:not(.is-collapsed)')))
backLevels.drawerConsumed = await page.evaluate(() => window.__moqiBack?.() ?? null)
await sleep(500)
backLevels.drawerAfter = await page.evaluate(() => Boolean(document.querySelector('.sidebar:not(.is-collapsed)')))
await page.locator('.lcard, .scard').first().click()
await sleep(800)
backLevels.editorConsumed = await page.evaluate(() => window.__moqiBack?.() ?? null)
await sleep(600)
backLevels.editorBackHome = await page.evaluate(() => ({ pagecol: Boolean(document.querySelector('.pagecol-head')), editing: Boolean(document.querySelector('.doc-col.is-touch-edit')) }))
await page.evaluate(() => { [...document.querySelectorAll('.sidebar button')].find((b) => (b.textContent ?? '').includes('设置'))?.click() })
await sleep(700)
backLevels.settingsBefore = await page.evaluate(() => Boolean(document.querySelector('.set-dlg')))
// 批 ζ（）：先进**子页**——系统返回要**先「子页 → 列表」**（一层一个返回），不是直接关设置。
// 若外部状态（`settingsSection`）让设置直接落在子页，先按一次返回回到列表。
await page.evaluate(() => { if (!document.querySelector('.set-list')) document.querySelector('.set-topbar > button')?.click() })
await sleep(500)
await page.locator('.set-list .sl-row', { hasText: '导出' }).click()
await sleep(500)
backLevels.subTitle = await page.evaluate(() => (document.querySelector('.tb-t')?.textContent ?? '').trim())
backLevels.subConsumed = await page.evaluate(() => window.__moqiBack?.() ?? null)
await sleep(500)
backLevels.backToList = await page.evaluate(() => ({
  open: Boolean(document.querySelector('.set-dlg')),
  title: (document.querySelector('.tb-t')?.textContent ?? '').trim(),
}))
backLevels.settingsConsumed = await page.evaluate(() => window.__moqiBack?.() ?? null)
await sleep(500)
backLevels.settingsAfter = await page.evaluate(() => Boolean(document.querySelector('.set-dlg')))
check('MOBILE-BACK-1 系统返回键的应用内阶梯（用户 2026-10-12：浮层 → 上一层；全不接交系统退出）——挂 window.__moqiBack：首页 false（交系统）/ 抽屉开着 = 关抽屉 / 编辑器里 = 回页面库 / **设置：子页 → 列表 → 关设置**（批 ζ：与屏上统一标题栏的返回共走同一条栈）；**编辑态不接**（从编辑态返回 = 直接上一层）',
  backBridge === 'function'
  && backLevels.home === false
  && backLevels.drawerBefore === true && backLevels.drawerConsumed === true && backLevels.drawerAfter === false
  && backLevels.editorConsumed === true && backLevels.editorBackHome.pagecol === true && backLevels.editorBackHome.editing === false
  && backLevels.settingsBefore === true
  && backLevels.subTitle === '导出' && backLevels.subConsumed === true && backLevels.backToList.open === true && backLevels.backToList.title === '设置' /* 批 ζ：子页 → 列表 */
  && backLevels.settingsConsumed === true && backLevels.settingsAfter === false,
  { backBridge, backLevels })
// 收尾复位：回桌面视口 + 页面列收起的意图恢复（与 MOBILE-DRAWER-1 同一惯例——别把 360 与收起态留给下一条）。
await page.setViewportSize({ width: 1280, height: 900 })
await sleep(400)
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /页面列表/.test(b.getAttribute('aria-label') ?? ''))?.click() })
await sleep(400)


// ---------- 设置页移动形态（`10` §4.7，4b 前置）：分区列表 → 子页 ----------
// 用户走查点名（）：「别把所有东西都挤在一页」——此前窄档把左分栏横排成一条
// overflow-x 的胶囊带（360 下截断成「外观与主…」），其余分区难够到。判据：列表行序 / 子页返回 /
// 控件整宽（范围三选不被压成「按标 签…」）/ 桌面左分栏原样。
await reset()
await page.setViewportSize({ width: 360, height: 720 })
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
await page.locator('.pagecol-head [aria-label="打开抽屉"]').click()
await sleep(600)
await page.evaluate(() => { [...document.querySelectorAll('.sidebar button')].find((b) => (b.textContent ?? '').includes('设置'))?.click() })
await sleep(700)
const setList = await page.evaluate(() => {
  const dlg = document.querySelector('.set-dlg')
  const r = dlg?.getBoundingClientRect()
  const nav = document.querySelector('.set-nav')
  return {
    fullW: r ? Math.round(r.width) : null,
    navHidden: nav ? getComputedStyle(nav).display === 'none' : 'absent',
    rows: [...document.querySelectorAll('.set-list .sl-row')].map((b) => (b.textContent ?? '').replace(/\s+/g, '').trim()),
    groups: [...document.querySelectorAll('.set-list .sl-grp')].map((d) => (d.textContent ?? '').trim()),
  }
})
// 批 ζ（）：列表页与子页**共用同一条统一标题栏**（返回 ＋ 标题同栏）——不再有两条 `.set-back`。
const setTopbar = await page.evaluate(() => {
  const bar = document.querySelector('.set-topbar')
  const back = bar?.querySelector('button')
  const barRect = bar?.getBoundingClientRect()
  const br = back?.getBoundingClientRect()
  return {
    bar: Boolean(bar),
    h: barRect ? Math.round(barRect.height) : null,
    title: (bar?.querySelector('.tb-t')?.textContent ?? '').trim(),
    backLabel: back?.getAttribute('aria-label') ?? null,
    backClass: back?.className ?? null,
    backW: br ? Math.round(br.width) : null,
    backH: br ? Math.round(br.height) : null,
    inView: barRect ? (barRect.top >= 0 && barRect.bottom <= window.innerHeight && barRect.right <= window.innerWidth) : null,
    legacyBacks: document.querySelectorAll('.set-back').length // 两条旧返回行已删
  }
})
await page.locator('.set-topbar > button').click()
await sleep(500)
const setExitClosed = await page.evaluate(() => Boolean(document.querySelector('.set-dlg')) === false)
await page.evaluate(() => { [...document.querySelectorAll('.sidebar button')].find((b) => (b.textContent ?? '').includes('设置'))?.click() })
await sleep(700)
await page.locator('.set-list .sl-row', { hasText: '导出' }).click()
await sleep(500)
const setSub = await page.evaluate(() => {
  const bar = document.querySelector('.set-topbar')
  const back = bar?.querySelector('button')
  const seg = document.querySelector('.set-pane .seg')
  const sr = seg?.getBoundingClientRect()
  const pageHead = document.querySelector('.set-pane .set-ph')
  return {
    title: (bar?.querySelector('.tb-t')?.textContent ?? '').trim(),
    backLabel: back?.getAttribute('aria-label') ?? null,
    backClass: back?.className ?? null,
    listGone: !document.querySelector('.set-list'),
    segW: sr ? Math.round(sr.width) : null,
    pageHeadHidden: pageHead ? getComputedStyle(pageHead).display === 'none' : null,
  }
})
await page.locator('.set-topbar > button').click()
await sleep(500)
const setBack = await page.evaluate(() => ({
  list: Boolean(document.querySelector('.set-list')),
  pane: Boolean(document.querySelector('.set-pane')),
  title: (document.querySelector('.tb-t')?.textContent ?? '').trim(),
}))
await page.setViewportSize({ width: 1280, height: 900 })
await sleep(500)
const setDesktop = await page.evaluate(() => {
  const nav = document.querySelector('.set-nav')
  return { nav: nav ? getComputedStyle(nav).display : 'absent', list: Boolean(document.querySelector('.set-list')), pane: Boolean(document.querySelector('.set-pane')) }
})
await page.keyboard.press('Escape')
await sleep(400)
check('MOBILE-SET-1 设置页移动形态（`10` §4.7 + 批 ζ 2026-10-12）：360 下打开设置 = 独立全屏页的**分区列表**（行序 = AI / 外观 / 属性 / 同步 / 备份与恢复 / 导出 / 导入 / 搜索 / 关于；桌面左分栏整条收掉）；**列表页与子页共用同一条统一标题栏**（栏高 48、标题「设置」/「导出」、**同一个返回控件**（`aria-label=返回`、命中区 ≥44）、无重复的旧返回行）；点它从列表退出关得掉；子页 → 回列表；桌面 1280 左分栏原样',
  setList.fullW === 360 && (setList.navHidden === true || setList.navHidden === 'absent' /* 列表页整条不渲染 */)
  && setList.rows.join('/') === 'AI/外观/属性/同步/备份与恢复/导出/导入/搜索/关于'
  && setList.groups.join('/') === '编辑/数据/其他'
  && setTopbar.bar === true && setTopbar.h === 48 && setTopbar.title === '设置' && setTopbar.backLabel === '返回'
  && setTopbar.backW >= 44 && setTopbar.backH >= 44 && setTopbar.inView === true && setTopbar.legacyBacks === 0
  && setExitClosed === true /* 列表页返回 = 关设置 */
  /* 子页：标题「导出」、**同一个返回控件**（同 class）、页头 `.set-ph` 退场、控件整宽 */
  && setSub.title === '导出' && setSub.backLabel === '返回' && setSub.backClass === setTopbar.backClass
  && setSub.listGone === true && setSub.segW !== null && setSub.segW >= 260 /* 实测 276：撑满后三选一行 */ && setSub.pageHeadHidden === true
  && setBack.list === true && setBack.pane === false && setBack.title === '设置' /* 子页返回 = 回列表页（标题回「设置」） */
  && setDesktop.nav === 'block' && setDesktop.list === false && setDesktop.pane === true,
  { setList, setTopbar, setExitClosed, setSub, setBack, setDesktop })

// ---------- θ3（ 用户走查）：设置**关掉再进 = 回列表**——子页不是「记忆层级」 ----------
// 缺陷原样：子页 → 关闭（⌘, / Esc / ✕ 任一路）→ 重开还停在子页（层级是外部状态、关闭不归零）。
// 判据 = 负例两连：重开**不得**出现 `.set-pane`（子页面板）、标题必须是「设置」（不是「导出」）。
await reset()
await page.setViewportSize({ width: 360, height: 720 })
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
const openSettingsViaDrawer = async () => {
  await page.locator('.pagecol-head [aria-label="打开抽屉"]').click()
  await sleep(600)
  await page.evaluate(() => { [...document.querySelectorAll('.sidebar button')].find((b) => (b.textContent ?? '').includes('设置'))?.click() })
  await sleep(700)
}
await openSettingsViaDrawer()
await page.locator('.set-list .sl-row', { hasText: '导出' }).click()
await sleep(500)
const setSubBefore = await page.evaluate(() => (document.querySelector('.tb-t')?.textContent ?? '').trim())
// 从**子页**关闭：⌘,（`SET-OPEN-1` 的开合；Esc / 返回按钮那条阶梯由 `MOBILE-BACK-1` 覆盖）
await page.keyboard.press('Control+,')
await sleep(500)
const setSubClosed = await page.evaluate(() => Boolean(document.querySelector('.set-dlg')) === false)
await openSettingsViaDrawer()
const setReopened = await page.evaluate(() => ({
  list: Boolean(document.querySelector('.set-list')),
  pane: Boolean(document.querySelector('.set-pane')),
  title: (document.querySelector('.tb-t')?.textContent ?? '').trim(),
}))
await page.locator('.set-topbar > button').click()
await sleep(400)
await page.setViewportSize({ width: 1280, height: 900 })
await sleep(400)
check('MOBILE-SET-2 设置层级重置（θ3 · 2026-10-13）：**子页 → 关闭 → 重开 = 列表页**（层级不跨次记忆）；负例：重开不得落在「导出」子页（`.set-list` 必须在、`.set-pane` 必须不在、标题 =「设置」）',
  setSubBefore === '导出' && setSubClosed === true
  && setReopened.list === true && setReopened.pane === false && setReopened.title === '设置',
  { setSubBefore, setSubClosed, setReopened })

// ---------- 卡片 ⋯ Sheet（`10` §4.1.2，4b-①）：移动端底部 Sheet 原语的第一消费者 ----------
await reset()
await page.setViewportSize({ width: 360, height: 720 })
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
await page.locator('.pmore').first().click()
await sleep(600)
const cardSheetNow = await page.evaluate(() => {
  const s = document.querySelector('.sheet')
  const r = s?.getBoundingClientRect()
  return {
    present: Boolean(s),
    title: (document.querySelector('.sheet .sh-title')?.textContent ?? '').trim(),
    rows: [...document.querySelectorAll('.sheet .sg-row')].map((b) => (b.textContent ?? '').replace(/\s+/g, '').trim()),
    note: (document.querySelector('.sheet .sg-note')?.textContent ?? '').includes('30 天'),
    flushBottom: r ? Math.round(window.innerHeight - r.bottom) === 0 : null,
    hPct: r ? Math.round((r.height / window.innerHeight) * 100) : null,
    backdrop: Boolean(document.querySelector('.sh-backdrop')),
    popoverGone: !document.querySelector('.pop'),
  }
})
await page.locator('.sheet .sg-row', { hasText: '星标' }).click()
await sleep(500)
const cardStar = await page.evaluate(() => ({ sheetGone: !document.querySelector('.sheet'), star: Boolean(document.querySelector('.pstar')) }))
await page.locator('.pmore').first().click()
await sleep(500)
await page.locator('.sheet .sg-row', { hasText: '打开页面' }).click()
await sleep(700)
const cardOpen = await page.evaluate(() => ({ sheetGone: !document.querySelector('.sheet'), editor: !document.querySelector('.pagecol'), edit: Boolean(document.querySelector('.topbar [aria-label="编辑"]')) }))
await page.setViewportSize({ width: 1280, height: 900 })
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('页面列表（⌘⇧'))?.click() })
await sleep(500)
await page.locator('.pmore').first().click()
await sleep(400)
const cardDesktop = await page.evaluate(() => ({ pop: Boolean(document.querySelector('.pop')), sheet: Boolean(document.querySelector('.sheet')) }))
await page.keyboard.press('Escape')
await sleep(400)
check('MOBILE-CARD-1 卡片 ⋯ Sheet（`10` §4.1.2 · 4b-①）：360 下点卡片 ⋯ → 底部 Sheet（贴底、≤72% 高、遮罩在；标题「页面操作 · 页面名」；六项 = 打开页面 / 置顶 / 星标 / 复制链接 / 导出 Markdown / 移至回收站〔红〕；底部 30 天说明；桌面 Popover 不在）；星标 = 关 Sheet + 卡片头部 ★ 出现；打开页面 = 关 Sheet 进编辑器；桌面 1280 仍是 Popover（不回归）',
  cardSheetNow.present === true && cardSheetNow.title.startsWith('页面操作 · ') && cardSheetNow.rows.join('/') === '打开页面/置顶/星标/复制链接/导出Markdown/移至回收站'
  && cardSheetNow.note === true && cardSheetNow.flushBottom === true && cardSheetNow.hPct !== null && cardSheetNow.hPct <= 72 && cardSheetNow.backdrop === true && cardSheetNow.popoverGone === true
  && cardStar.sheetGone === true && cardStar.star === true
  && cardOpen.sheetGone === true && cardOpen.editor === true && cardOpen.edit === true
  && cardDesktop.pop === true && cardDesktop.sheet === false,
  { cardSheetNow, cardStar, cardOpen, cardDesktop })

// ---------- 回收站两张 Sheet（`10` §4.6，4b-②）：确认框与浏览是两个独立浮层 ----------
// 手机档弹窗族统一退到「贴底 Sheet 形态」（.mask 下缘对齐 / .dlg 通栏上圆下直）——本检查把它
// 在「移至回收站 / 彻底删除」两条链上钉住；浏览 = 抽屉「回收站」开的独立 Sheet（桌面整屏视图
// 在窄档整块不渲染，DOM 单份）。桌面确认框仍居中（不回归）。
await reset()
await page.setViewportSize({ width: 360, height: 720 })
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
// ⋮「页面统计」也走同一档（弹窗族在手机档统一贴底——页内查找 / 统计都在此列）
await page.locator('.pagecol .bd-open').first().click()
await sleep(700)
await page.locator('.topbar [aria-label="更多"]').click()
await sleep(400)
await page.locator('.pop button', { hasText: '页面统计' }).click()
await sleep(600)
const statSheetNow = await page.evaluate(() => {
  const d = document.querySelector('.mask .dlg')
  const r = d?.getBoundingClientRect()
  return { title: (d?.querySelector('.dlg-h h3')?.textContent ?? '').trim(), flush: r ? Math.round(window.innerHeight - r.bottom) === 0 : null }
})
await page.keyboard.press('Escape')
await sleep(400)
await page.locator('.topbar [aria-label="返回页面库"]').click()
await sleep(600)
await page.locator('.pmore').first().click()
await sleep(500)
await page.locator('.sheet .sg-row', { hasText: '移至回收站' }).click()
await sleep(600)
const trashDel = await page.evaluate(() => {
  const d = document.querySelector('.mask .dlg')
  const r = d?.getBoundingClientRect()
  return {
    title: (d?.querySelector('.dlg-h h3')?.textContent ?? '').trim(),
    flush: r ? Math.round(window.innerHeight - r.bottom) === 0 : null,
    fullW: r ? Math.round(r.width) === window.innerWidth : null,
    topR: d ? getComputedStyle(d).borderTopLeftRadius : null,
    botR: d ? getComputedStyle(d).borderBottomLeftRadius : null,
    buttons: [...document.querySelectorAll('.dlg-f button')].map((b) => (b.textContent ?? '').trim()),
    note: (d?.querySelector('.dlg-note')?.textContent ?? '').includes('30 天'),
  }
})
await page.locator('.dlg-f button', { hasText: '移入回收站' }).click()
await sleep(700)
const trashMoved = await page.evaluate(() => ({
  cards: document.querySelectorAll('.lcard, .scard').length,
  noToast: document.querySelector('.notice') === null,
  dlgGone: !document.querySelector('.dlg'),
}))
await page.locator('.pagecol-head [aria-label="打开抽屉"]').click()
await sleep(600)
await page.evaluate(() => { [...document.querySelectorAll('.sidebar button')].find((b) => (b.textContent ?? '').includes('回收站'))?.click() })
await sleep(700)
const trashSheetNow = await page.evaluate(() => ({
  present: Boolean(document.querySelector('.sheet')),
  title: (document.querySelector('.sheet .sh-title')?.textContent ?? '').trim(),
  cnt: (document.querySelector('.tr-cnt')?.textContent ?? '').trim(),
  rowName: (document.querySelector('.sheet .tr-row h4')?.textContent ?? '').trim(),
  acts: [...document.querySelectorAll('.sheet .tr-row .tr-act button')].map((b) => (b.textContent ?? '').trim()),
  clear: Boolean(document.querySelector('.tr-clear')),
  // 窄档里回收站视图是**空壳标记**（`.view.is-on` 语义如旧、桌面整屏正文不渲染）——行只住在 Sheet 里、DOM 单份。
  markerEmpty: document.querySelector('.view[aria-label="回收站"]') !== null && document.querySelectorAll('.view[aria-label="回收站"] .tr-row').length === 0,
}))
await page.locator('.sheet .tr-row .tr-kill').click()
await sleep(600)
const trashPurge = await page.evaluate(() => ({
  title: (document.querySelector('.mask .dlg .dlg-h h3')?.textContent ?? '').trim(),
  flush: (() => { const r = document.querySelector('.mask .dlg')?.getBoundingClientRect(); return r ? Math.round(window.innerHeight - r.bottom) === 0 : null })(),
  buttons: [...document.querySelectorAll('.dlg-f button')].map((b) => (b.textContent ?? '').trim()),
}))
await page.locator('.dlg-f button', { hasText: '彻底删除' }).click()
await sleep(700)
const trashEmpty = await page.evaluate(() => ({
  empty: (document.querySelector('.sheet .le-t')?.textContent ?? '').trim(),
  rows: document.querySelectorAll('.sheet .tr-row').length,
}))
await page.locator('.sheet .sh-x').click()
await sleep(500)
const trashClosed = await page.evaluate(() => ({ sheetGone: !document.querySelector('.sheet'), home: Boolean(document.querySelector('.pagecol')) }))
await page.setViewportSize({ width: 1280, height: 900 })
await sleep(500)
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('全局搜索'))?.click() })
await sleep(600)
const trashDesktop = await page.evaluate(() => {
  const mask = document.querySelector('.mask')
  const dlg = document.querySelector('.mask .dlg')
  return { align: mask ? getComputedStyle(mask).alignItems : null, dlgTop: dlg ? Math.round(dlg.getBoundingClientRect().top) : null }
})
await page.keyboard.press('Escape')
await sleep(400)
check('MOBILE-TRASH-1 回收站两张 Sheet（`10` §4.6 · 4b-②）：360 下 ⋮「页面统计」走弹窗族同一档（贴底）；卡片 ⋯「移至回收站」→ 确认框**贴底 Sheet 形态**（贴底 / 通栏 / 上圆 18 下直 0 / 取消·移入回收站 / 30 天说明）→ 确认后回首页、不再弹提示；抽屉「回收站」→ **浏览 Sheet**（标题 / N 个页面 / 清空 / 行 + 恢复·彻底删除；桌面整屏视图不渲染）；「彻底删除」→ 独立确认 Sheet → 空态；✕ 关回首页；桌面弹窗仍居中（不回归）',
  statSheetNow.title === '页面统计' && statSheetNow.flush === true
  && trashDel.title === '移至回收站' && trashDel.flush === true && trashDel.fullW === true && trashDel.topR === '18px' && trashDel.botR === '0px'
  && trashDel.buttons.join('/') === '取消/移入回收站' && trashDel.note === true
  && trashMoved.cards === 0 && trashMoved.noToast === true && trashMoved.dlgGone === true
  && trashSheetNow.present === true && trashSheetNow.title === '回收站' && trashSheetNow.cnt === '1 个页面' && trashSheetNow.rowName !== '' && trashSheetNow.acts.join('/') === '恢复/彻底删除' && trashSheetNow.clear === true && trashSheetNow.markerEmpty === true
  && trashPurge.title === '从本机彻底删除' && trashPurge.flush === true && trashPurge.buttons.join('/') === '取消/彻底删除'
  && trashEmpty.empty === '回收站是空的' && trashEmpty.rows === 0
  && trashClosed.sheetGone === true && trashClosed.home === true
  && trashDesktop.align === 'flex-start' && trashDesktop.dlgTop !== null && trashDesktop.dlgTop > 10,
  { statSheetNow, trashDel, trashMoved, trashSheetNow, trashPurge, trashEmpty, trashClosed, trashDesktop })

// ---------- 浮层形态收口（`10` §2.3 / §4.5，4b-③）：抽屉 80%·max300·250ms 滑出 ＋ 面板 72% / 88% ----------
// 交接表两行的兑现读数：① 侧栏抽屉「宽窄两套合一」成滑出形态（原来窄档靠 margin 负值收合）；②
// `.side-panel` 的 74% 桌面原型档归到 Sheet 同一套数——默 72%、**AI 助手（重面板）88%**，都贴底。
await reset()
await page.setViewportSize({ width: 360, height: 720 })
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
const drawerRest2 = await page.evaluate(() => {
  const sb = document.querySelector('.sidebar')
  const r = sb?.getBoundingClientRect()
  return {
    w: r ? Math.round(r.width) : null,
    expectW: Math.round(Math.min(window.innerWidth * 0.8, 300)),
    transform: sb ? getComputedStyle(sb).transform : null,
    transition: sb ? getComputedStyle(sb).transitionDuration : null,
  }
})
await page.locator('.pagecol-head [aria-label="打开抽屉"]').click()
await sleep(600)
const drawerOpen3 = await page.evaluate(() => {
  const sb = document.querySelector('.sidebar')
  const r = sb?.getBoundingClientRect()
  return { w: r ? Math.round(r.width) : null, left: r ? Math.round(r.left) : null, transform: sb ? getComputedStyle(sb).transform : null }
})
await page.locator('.side-backdrop').click({ position: { x: 340, y: 400 } })
await sleep(500)
const drawerClosed3 = await page.evaluate(() => {
  const sb = document.querySelector('.sidebar')
  return { transform: sb ? getComputedStyle(sb).transform : null }
})
// 面板：AI = 重面板 88%、引用预览 = 72%；都贴底（窄档 = 底部 Sheet 同族）
await page.locator('.pagecol .bd-open').first().click()
await sleep(700)
await page.locator('.topbar [aria-label="AI 助手"]').click()
await sleep(600)
const aiPanelGeo = await page.evaluate(() => {
  const el = document.querySelector('.side-panel.aip.is-open')
  const r = el?.getBoundingClientRect()
  return {
    open: Boolean(el),
    maxH: el ? getComputedStyle(el).maxHeight : null,
    h: r ? Math.round(r.height) : null,
    capH: Math.round(window.innerHeight * 0.88),
    bottom: r ? Math.round(window.innerHeight - r.bottom) : null,
    parentH: el?.offsetParent ? Math.round(el.offsetParent.getBoundingClientRect().height) : null,
    natural: el ? Math.round([...el.children].reduce((sum, child) => sum + child.getBoundingClientRect().height, 0)) : null,
  }
})
await page.locator('.aip-head .x').click()
await sleep(500)
// 出链种子（`R04-ACCEPT-7` 补层：渲染高度要有**内容支撑**，不能拿空面板混过）——
// 注入 8 条出链 + 8 个目标页 → 重载 → 回编辑器；下面 refPanelGeo 才能量到「内容高于上限 ⇒ 面板到顶」。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text, parent, position, children = [], objRefs = []) => ({ entityId: id, blockUid: uid, type, content: text ? [{ t: 'text', v: text }] : [], parent, children, position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: objRefs, objectBackRefs: [], aiMeta: null, created: now, modified: now })
  const kids = []
  const all = []
  for (let i = 1; i <= 8; i += 1) {
    const tid = `rp-t${i}`
    kids.push(`rp-b${i}`)
    all.push(mk(`rp-b${i}`, `rpb0000${i}`, 'text', `正文块 ${i}`, 'rp-page', i - 1, [], [tid]))
    all.push({ ...mk(tid, `rpt0000${i}`, 'text', `目标页 ${i}`, null, i, [], []), isObject: true, objectName: `目标页 ${i}` })
  }
  const page1 = { ...mk('rp-page', 'rppage001', 'text', '引用预览高度检查', null, 0, kids), isObject: true, objectName: '引用预览高度检查' }
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([page1, ...all]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS }).catch(() => {})
await sleep(700)
await page.locator('.pagecol .bd-open').first().click().catch(() => {})
await sleep(700)
await page.locator('.topbar [aria-label="更多"]').click()
await sleep(400)
await page.locator('.pop button', { hasText: '引用预览面板' }).click()
await sleep(700)
const refPanelGeo = await page.evaluate(() => {
  const el = document.querySelector('.side-panel.ref-panel.is-open')
  const r = el?.getBoundingClientRect()
  const head = el?.querySelector('.side-panel-head')
  const body = el?.querySelector('.side-panel-body')
  // `R04-ACCEPT-7` 补层：**高度等式**——h = min(max-height%×**包含块**高, 内容自然高)。
  // max-height 的百分比基是包含块（面板是 absolute，基 = offsetParent 高），不是视口——
  // 按 0.72×innerHeight 判会假绿（塌成内容高也过），按包含块才算得出真等式。
  return {
    open: Boolean(el),
    maxH: el ? getComputedStyle(el).maxHeight : null,
    h: r ? Math.round(r.height) : null,
    capH: Math.round(window.innerHeight * 0.72),
    bottom: r ? Math.round(window.innerHeight - r.bottom) : null,
    parentH: el?.offsetParent ? Math.round(el.offsetParent.getBoundingClientRect().height) : null,
    natural: head && body ? Math.round(head.getBoundingClientRect().height + body.scrollHeight) : null,
    secs: el ? [...el.querySelectorAll('.rp-sec')].map((x) => (x.textContent ?? '').trim()) : null,
  }
})
await page.locator('.ref-panel .side-panel-head .x').click()
await sleep(400)
// 桌面档：面板回右栏常驻形态（无 max-height 档）
await page.setViewportSize({ width: 1280, height: 900 })
await sleep(500)
await page.locator('.topbar [aria-label="AI 助手"]').click()
await sleep(600)
const aiPanelDesktop = await page.evaluate(() => {
  const el = document.querySelector('.side-panel.aip.is-open')
  return { maxH: el ? getComputedStyle(el).maxHeight : 'absent', pos: el ? getComputedStyle(el).position : 'absent' }
})
await page.locator('.aip-head .x').click()
await sleep(400)
// 收场：中途开过卡片 ⇒「页面列收起」被置 true，按意图还原（下游 `WINDOW-FIT-1` 量 pagecol 的可见性）。
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('页面列表（⌘⇧'))?.click() })
await sleep(500)
check('MOBILE-DRAWER-1 浮层形态收口（`10` §2.3 / §4.5 · 4b-③）：360 下侧栏抽屉 = 80%（max 300px）宽、250ms 滑出、关着 = 离屏（translateX(-100%)，不再靠 margin 抽走）；AI 助手面板 = 重面板 88%、引用预览 = 72%、都贴底；桌面档面板回右栏常驻（无高度档）',
  drawerRest2.w === drawerRest2.expectW && drawerRest2.transition === '0.25s' && drawerRest2.transform !== 'none' && drawerRest2.transform.includes('-')
  && drawerOpen3.w === drawerRest2.expectW && drawerOpen3.left === 0 && drawerOpen3.transform === 'none'
  && drawerClosed3.transform !== 'none' && drawerClosed3.transform.includes('-')
  && aiPanelGeo.open === true && aiPanelGeo.maxH === '88%' && aiPanelGeo.h !== null && aiPanelGeo.h <= aiPanelGeo.capH + 1 && aiPanelGeo.bottom === 0
  && refPanelGeo.open === true && refPanelGeo.maxH === '72%' && refPanelGeo.h !== null && refPanelGeo.h <= refPanelGeo.capH + 1 && refPanelGeo.bottom === 0
  && aiPanelDesktop.maxH === 'none' && aiPanelDesktop.pos === 'absolute'
  /* `R04-ACCEPT-7` 补层：**渲染高度等式**（上文只在读声明与单边不等式）：h = min(maxH%×包含块高, 内容自然高)。
     负例：面板塌成 50px / 内容被裁 ⇒ 等式与自然高两侧都会红；出链种子保证 ref 面板内容**高于**上限。 */
  && aiPanelGeo.parentH !== null && aiPanelGeo.natural !== null
  && Math.abs(aiPanelGeo.h - Math.min(0.88 * aiPanelGeo.parentH, aiPanelGeo.natural)) <= 6
  && refPanelGeo.parentH !== null && refPanelGeo.natural !== null
  && Math.abs(refPanelGeo.h - Math.min(0.72 * refPanelGeo.parentH, refPanelGeo.natural)) <= 6
  && (refPanelGeo.secs ?? []).some((text) => text === '出链 · 8')
  && refPanelGeo.natural > 0.72 * refPanelGeo.parentH /* 内容真的高于上限（否则这条等式没意义） */
  && aiPanelGeo.natural <= 0.88 * aiPanelGeo.parentH /* AI 面板是内容驱动（未顶到上限） */,
  { drawerRest2, drawerOpen3, drawerClosed3, aiPanelGeo, refPanelGeo, aiPanelDesktop })

// ---------- AI 三入口与 AI 块三态在触屏档（`10` §6.4，第 5 项）----------
// ① 顶栏 ✦ → AI 助手 Sheet（88% 重面板，形态已在 `MOBILE-DRAWER-1` 锁）——宫格 6 项 + 自由提问；
// ② 走完一次「问 → 插入为块 → 流式 → 完成态操作条（采用/重新生成/丢弃/继续追问）→ 采用」全链，
//    窄档插入后 **Sheet 自动关闭**（§6.4「点插入为块 → Sheet 关闭」）；③ 块胶囊 ⋯ →「✦ AI 助手」入口。
await page.setViewportSize({ width: 1280, height: 900 })
aiStub.mode = 'stream'
await seedAiPage(aiStubUrl)
await page.setViewportSize({ width: 360, height: 720 })
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
await page.locator('.pagecol .bd-open').first().click()
await sleep(700)
await page.locator('.topbar [aria-label="AI 助手"]').click()
await sleep(700)
const aiSheetAsk = await page.evaluate(() => ({
  open: Boolean(document.querySelector('.aip.is-open')),
  grid: [...document.querySelectorAll('.aip-grid button')].map((b) => (b.textContent ?? '').replace(/\s+/g, '').trim()),
  inbar: (document.querySelector('.aip-inbar .mode')?.textContent ?? '').includes('自由提问'),
}))
await page.locator('.aip-grid button', { hasText: '总结' }).click()
const answered = await poll(
  () => page.evaluate(() => {
    const b = document.querySelector('.aip .acts button')
    return b ? (b.textContent ?? '').trim() : null
  }),
  (label) => typeof label === 'string' && label.startsWith('插入到'),
  { timeout: 12000, label: 'AI 回答卡出现（插入为块）' },
)
await page.locator('.aip .acts button').first().click()
const aiInserted = await waitForAi((s) => s.domCount >= 1 && (s.domStatus === 'generating' || s.domStatus === 'needs-confirmation'), 10000)
const aiSheetClosed = await page.evaluate(() => !document.querySelector('.aip.is-open'))
const aiDone = await waitForAi((s) => s.domStatus === 'needs-confirmation', 12000)
const aiBars = await page.evaluate(() => {
  const bar = document.querySelector('.ai-block-bar')
  const ops = bar?.querySelectorAll('.ai-ops button') ?? []
  return {
    labels: [...ops].map((b) => (b.textContent ?? '').replace(/\s+/g, '').split('合并为普通块')[0].trim()),
    opH: ops[0] ? Math.round(ops[0].getBoundingClientRect().height) : null,
    stopAbsent: !bar?.querySelector('button.ai-stop'),
  }
})
await page.locator('.ai-block-bar .ai-ops button', { hasText: '采用' }).last().click()
// 网格指令本身会先落一条**流式占位块**（桌面同款设计：端点够不到也看得见），「插入为块」再添一份答案块
// ⇒ 文档里两条 AI 块；对**最后一条**（答案块）点采用——它变普通块（界面无痕），占位块照旧走完自己的生命周期。
const aiAccepted = await poll(
  () => page.evaluate(() => ({
    bars: document.querySelectorAll('.ai-block-bar').length,
    marks: document.querySelectorAll('.moqi-block[data-ai-status]').length,
    saved: JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').some((b) => b.aiMeta?.status === 'accepted'),
  })),
  (s) => s.saved,
  { timeout: 8000, label: 'AI 块采用落档' },
)
// ③ 块胶囊 ⋯ →「✦ AI 助手」（`10` §6.4 的「块操作栏 ✦」入口）
await page.locator('.topbar [aria-label="编辑"]').click()
await sleep(700)
// γ1：单击不再选中 ⇒ **左滑满选一块**（恰好 1 块 → 块胶囊）
await swipeSelectOne()
await sleep(500)
// 定稿（`10` §6.2）：**块选中态不放入口**（AI 的家在打字态主条 `✦`）——胶囊里不得有 AI 键；
// 退出选择态后点主条 `✦` = 一键直开 AI 助手。
const capsuleMore = await page.evaluate(() => [...document.querySelectorAll('.capsule button')].map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()))
await page.locator('.capsule button[aria-label="完成"]').click()
await sleep(600)
await page.locator('.topbar [aria-label="AI 助手"]').click()
await sleep(700)
const capsuleAi = await page.evaluate(() => Boolean(document.querySelector('.aip.is-open')))
await page.locator('.aip-head .x').click()
await sleep(400)
await page.setViewportSize({ width: 1280, height: 900 })
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('页面列表（⌘⇧'))?.click() })
await sleep(500)
check('MOBILE-AI-1 AI 三入口与三态（`10` §6.4 · 第 5 项）：360 下顶栏 ✦ → AI 助手 Sheet（宫格 6 项 + 自由提问）；润色 → 回答卡 →「插入为块」= **Sheet 自动关** + 文档里生成 AI 块（生成中 → 完成态操作条 = ✓采用 / ↻重新生成 / ✕丢弃 / 💬继续追问，■停止 收）；操作条按钮触屏档加高（≥40px）；采用 = 界面无痕（标记全撤）且落档 accepted；块胶囊 ⋯ →「✦ AI 助手」也开到同一 Sheet',
  aiSheetAsk.open === true && aiSheetAsk.grid.join('/') === '润色/总结/扩写/提取行动/反问我/换角度' && aiSheetAsk.inbar === true
  && typeof answered === 'string' && answered.startsWith('插入到')
  && aiInserted.domCount >= 1 && aiSheetClosed === true
  && aiDone.domStatus === 'needs-confirmation'
  && aiBars.labels.join('/') === '✓采用/↻重新生成/✕丢弃/💬继续追问' && aiBars.opH !== null && aiBars.opH >= 40 && aiBars.stopAbsent === true
  && aiAccepted.saved === true && aiAccepted.bars <= 1
  && capsuleMore.includes('AI 助手') === false /* 块选中态不放入口（定稿） */ && capsuleAi === true /* 顶栏 ✦ 一键直开助手 */,
  { aiSheetAsk, answered, aiInserted, aiSheetClosed, aiDone: { status: aiDone.domStatus, text: aiDone.domText.slice(0, 40) }, aiBars, aiAccepted, capsuleMore, capsuleAi })

// ---------- W2 后半：触屏档的折叠箭头（`10` §2.3 / §4.3）----------
// 正文列左侧 **30px 折叠沟槽**（文字起于 34px）：有子块的块被指到（触屏的「hover」= 指到的块）
// 就出折叠箭头——住沟槽里、点按折叠 / 展开；把手与行尾 ＋ 是 hover 桌面件，不上手机（`MOD-MOBILE`）。
// 种子走 localStorage 直写（与 BLOCK-COLLAPSE-1 同款——手打的种子会让测得层读不到标记，探针实测）。
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, text, parent, position, children = []) => ({ entityId: id, blockUid: uid, type: 'text', content: [{ t: 'text', v: text }], parent, children, position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now })
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    { ...mk('w2-page', 'w2page001', '折叠检查', null, 0, ['w2-a', 'w2-b']), isObject: true, objectName: '折叠检查' },
    mk('w2-a', 'w2aaaaaa1', '父块', 'w2-page', 0, ['w2-s']),
    mk('w2-s', 'w2ssssss1', '子块', 'w2-a', 0),
    mk('w2-b', 'w2bbbbbb1', '尾块', 'w2-page', 1),
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(800)
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('页面列表（⌘⇧'))?.click() })
await sleep(400)
await page.setViewportSize({ width: 360, height: 720 })
await sleep(700)
// `D10`（ 裁决）：触屏档**常显**折叠箭头——**未指到**（先读）也应在场；
// 负例：把 `blockMarkers.markersForBlock` 里的 `|| input.compact` 摘掉 ⇒ `noHover.present` 必红。
const w2NoHover = await page.evaluate(() => ({
  present: Boolean(document.querySelector('.block-rail[data-marker-kind="collapse"]')),
  handleGone: !document.querySelector('.block-rail[data-marker-kind="handle"]'),
}))
const w2Parent = await page.evaluate(() => {
  const el = document.querySelector('.editor-content .moqi-block[data-entity-id="w2-a"]')
  const r = el.getBoundingClientRect()
  // 瞄**父块自己那一行**（顶 + 半行高）：块中心会落进它的子块里——点块取最深的块，hover 的就不是父块（探针实证）。
  return { x: Math.round(r.left + 60), y: Math.round(r.top + 14), gutter: getComputedStyle(document.querySelector('.doc-col')).paddingLeft }
})
await page.mouse.move(w2Parent.x - 60, w2Parent.y - 60)
await page.mouse.move(w2Parent.x, w2Parent.y)
await poll(
  () => page.evaluate(() => Boolean(document.querySelector('.block-rail[data-marker-kind="collapse"]'))),
  (v) => v === true,
  { timeout: 3000, label: '触屏档折叠箭头出现' },
)
const w2Arrow = await page.evaluate(() => {
  const rail = document.querySelector('.block-rail[data-marker-kind="collapse"]')
  const btn = rail?.querySelector('button')
  const r = btn?.getBoundingClientRect()
  return {
    present: Boolean(rail),
    box: r ? { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) } : null,
    onTop: (() => { if (!r) return false; const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)); return Boolean(at && (at === btn || btn?.contains(at))) })(),
    handleGone: !document.querySelector('.block-rail[data-marker-kind="handle"]'),
    plusGone: !document.querySelector('.block-rail[data-marker-kind="plus"]'),
    inner: window.innerWidth,
  }
})
await page.locator('.block-rail[data-marker-kind="collapse"] button').click()
const w2Collapsed = await poll(() => page.evaluate(() => ({
  collapsed: Boolean(document.querySelector('.moqi-block[data-collapsed="true"]')),
  // 塌陷 = CSS 隐藏（.is-collapsed > .moqi-block { display:none }），子树**留在 DOM 里**（读存在性会误true）——读显示态。
  childShown: (() => { const c = document.querySelector('.editor-content .moqi-block[data-entity-id="w2-s"]'); return c ? getComputedStyle(c).display !== 'none' : false })(),
  arrowPersists: Boolean(document.querySelector('.block-rail[data-marker-kind="collapse"]')),
})), (s) => s.collapsed, 6000)
await page.locator('.block-rail[data-marker-kind="collapse"] button').click()
const w2Expanded = await poll(() => page.evaluate(() => ({
  collapsed: Boolean(document.querySelector('.moqi-block[data-collapsed="true"]')),
  childShown: (() => { const c = document.querySelector('.editor-content .moqi-block[data-entity-id="w2-s"]'); return c ? getComputedStyle(c).display !== 'none' : false })(),
})), (s) => !s.collapsed && s.childShown, 6000)
await page.setViewportSize({ width: 1280, height: 900 })
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('页面列表（⌘⇧'))?.click() })
await sleep(500)
check('MOBILE-COLLAPSE-1 W2 后半 · 触屏档折叠箭头（`10` §2.3/§4.3 · `D10` 定稿常显）：360 下正文列左 30px 折叠沟槽（文字起于 34px）——**未指到也在场**（触屏档「有子块的块」常显：`hovered` 是鼠标事件、触屏只在 tap 残留里偶现）；指到后箭头住沟槽、命中区真点得到、盒子不出视口；点塌 = 子块隐藏且箭头常显，再点 = 展开；**把手与行尾 ＋ 不上手机**（只折叠箭头 + 待办圈）',
  w2Parent.gutter === '34px'
  && w2NoHover.present === true && w2NoHover.handleGone === true /* D10：常显（未 hover）*/
  && w2Arrow.present === true && w2Arrow.box !== null && w2Arrow.box.l >= 0 && w2Arrow.box.r <= w2Arrow.inner && w2Arrow.onTop === true
  /* `R04-ACCEPT-7` 补层（几何）：箭头**盒子**住在 30px 沟槽里（文字起于 34 ⇒ 右缘 ≤ 34）、
     尺寸到位（视觉 22×32，`blockMarkers.COMPACT_COLLAPSE_GEOMETRY`）；旧断言只看了「不出视口」。 */
  && w2Arrow.box.w >= 20 && w2Arrow.box.h >= 24 && w2Arrow.box.r <= 34
  && w2Arrow.handleGone === true && w2Arrow.plusGone === true
  && w2Collapsed.collapsed === true && w2Collapsed.childShown === false && w2Collapsed.arrowPersists === true
  && w2Expanded.collapsed === false && w2Expanded.childShown === true,
  { w2Parent, w2NoHover, w2Arrow, w2Collapsed, w2Expanded })

// WINDOW-FIT-1（`docs/09` §八 `R09-RESP-19` / `docs/08` 四档表）：**窗口宽度决定版面档**——
// 逐档量「宽度 → 档位特征」，因为桌面端就是靠拖窗口来验移动端版面的（0.6 的验收台）。
// 判据只取**档位特征**（不取坐标——收放动画 / 抽屉滑动会让某一瞬间的 x 值不稳定）：
//   compact ≤700 = 手机排版档（--fs-e 15px）+ FAB 在；tablet 701–899 = 侧栏抽屉 + 桌面排版 + 无 FAB；
//   desktop 900–1279 = 侧栏常驻（static）+ 页面列是抽屉；wide ≥1280 = 页面列并排（inline）。
// 外加一条**最小宽度下的横向溢出**：标题条（窗口三键必须永远可达）与文档都不能越出窗口。
const tierOfWidth = async (width) => {
  await page.setViewportSize({ width, height: 800 })
  await sleep(420)
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    const sidebar = document.querySelector('.sidebar')
    const fab = document.querySelector('.fab')
    const pagecol = document.querySelector('.pagecol')
    const close = document.querySelector('.wbar .wctl.close')
    return {
      fsE: root.getPropertyValue('--fs-e').trim(),
      sidebarPos: sidebar ? getComputedStyle(sidebar).position : null,
      fab: fab ? getComputedStyle(fab).display : null,
      pagecolDrawer: pagecol ? pagecol.classList.contains('is-drawer') : null,
      pagecolW: pagecol ? Math.round(pagecol.getBoundingClientRect().width) : null,
      wbarCloseRight: close ? Math.round(close.getBoundingClientRect().right) : null,
      docScroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }
  })
}
const t360 = await tierOfWidth(360)
const t800 = await tierOfWidth(800)
const t1000 = await tierOfWidth(1000)
const t1280 = await tierOfWidth(1280)
check('WINDOW-FIT-1 断点四档：宽度决定版面（compact 手机排版档 + FAB / tablet 侧栏抽屉 + 桌面排版 / desktop 侧栏常驻 + 页面列抽屉 / wide 页面列并排）；最小宽度 360 下标题条与文档不横向溢出',
  t360.fsE === '15px' && t360.sidebarPos === 'fixed' && t360.fab === 'flex'
  && t360.pagecolW === 360 && t360.wbarCloseRight === t360.inner && t360.docScroll <= t360.inner
  && t800.fsE === '17px' && t800.sidebarPos === 'fixed' && t800.fab === null /* 4b-③ 起骨架渲染：非 compact 无此 DOM */ && t800.pagecolDrawer === true
  && t1000.sidebarPos === 'static' && t1000.pagecolDrawer === true && t1000.pagecolW === 400
  && t1280.pagecolDrawer === false && t1280.pagecolW === 400 && t1280.docScroll <= t1280.inner,
  { t360, t800, t1000, t1280 })
await page.setViewportSize({ width: 1280, height: 900 })

// ---------- #6 弹窗尺寸自适应（`min()` / `clamp()` **无断点**表达；`R09-SET-16`）---------
// 实测校正（）：
//   ・桌面档（≥701）`.dlg` 宽 **恒 560**（mask 内距 20px，最小桌面档还剩 661 余量）⇒「宽随视口收窄」在桌面档**不可观测、也不是风险点**（≤700 由 compact 媒体块接管，宽恒 = 视口宽）；
//   ・真正可红的是**高**（`min(78dvh, 100dvh−56px)`）与**内距**（`clamp`）：已用「写死 `max-height:780px`」实测红（780 高下 h=780 vs 期望 374.4）。
// 判据：桌面档宽 ≈560 且不溢出 ・ 高随窗缩（900→702 / 480→374.4 / 560→436.8）・ 内距随窗缩（clamp 生效）・ compact 宽 = 视口宽且贴底 ・ 全程无横向溢出 ・ 弹窗底 ≤ 视口高。
await page.setViewportSize({ width: 1280, height: 900 })
await page.locator('.editor-content .moqi-block').first().click()
await sleep(300)
await page.keyboard.press('Control+f')
await sleep(520)
const dlgFillerInjected = await page.evaluate(() => {
  const dlg = document.querySelector('.dlg')
  if (!dlg) return false
  const filler = document.createElement('div')
  filler.style.height = '2000px' // 只为把内容撑高、量到高的上界
  dlg.appendChild(filler)
  return true
})
const dlgGeom = async (width, height) => {
  await page.setViewportSize({ width, height })
  await sleep(320)
  return page.evaluate(() => {
    const dlg = document.querySelector('.dlg')
    if (!dlg) return null
    const mask = dlg.closest('.mask')
    const rect = dlg.getBoundingClientRect()
    const head = dlg.querySelector('.dlg-h')
    const foot = dlg.querySelector('.dlg-f')
    return {
      w: +rect.width.toFixed(1),
      h: +rect.height.toFixed(1),
      bottom: +rect.bottom.toFixed(1),
      maskAlign: mask ? getComputedStyle(mask).alignItems : null,
      padTop: head ? getComputedStyle(head).paddingTop : null,
      padLeft: head ? getComputedStyle(head).paddingLeft : null,
      footerBottom: foot ? +foot.getBoundingClientRect().bottom.toFixed(1) : null,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      vw: window.innerWidth,
      vh: window.innerHeight,
    }
  })
}
const dgWide = await dlgGeom(1280, 900)
const dg1100 = await dlgGeom(1100, 900)
const dg701 = await dlgGeom(701, 900)
const dgShort480 = await dlgGeom(900, 480)
const dgShort560 = await dlgGeom(1100, 560)
const dgCompact560 = await dlgGeom(560, 800)
const dgCompact400 = await dlgGeom(400, 800)
await page.keyboard.press('Escape')
await sleep(250)
check('#6 / R09-SET-16 弹窗尺寸自适应（`min()` / `clamp()` **无断点**表达）：桌面档宽 ≈560 且（≤ 视口−40）・ 高随窗缩：（900→702 / 560→436.8 / 480→374.4）・ 内距随窗缩（clamp 生效）・ ≤700 沿用现状（宽 = 视口、贴底）・ 全程无横向溢出 ・ 弹窗底 ≤ 视口高（本对话框无 footer ⇒ 以弹窗底代 footer 底）・ **负例：把 `max-height` 写死（如 780px）⇒ 高判据必红（已实测）**',
  dlgFillerInjected === true && [dgWide, dg1100, dg701, dgShort480, dgShort560, dgCompact560, dgCompact400].every(Boolean)
  && [dgWide, dg1100, dg701].every((g) => Math.abs(g.w - 560) <= 1 && g.w <= g.vw - 40)
  && Math.abs(dgWide.h - 702) <= 2 && Math.abs(dg701.h - 702) <= 2
  && Math.abs(dgShort480.h - 374.4) <= 2 && Math.abs(dgShort560.h - 436.8) <= 2
  && parseFloat(dgShort480.padTop) < parseFloat(dgWide.padTop)
  && parseFloat(dg701.padLeft) < parseFloat(dgWide.padLeft)
  && dgCompact560.w === dgCompact560.vw && dgCompact400.w === dgCompact400.vw && dgCompact560.bottom === dgCompact560.vh
  && dgCompact560.maskAlign === 'flex-end'
  && [dgWide, dg1100, dg701, dgShort480, dgShort560, dgCompact560, dgCompact400].every((g) => g.overflowX <= 0 && g.bottom <= g.vh + 1),
  { dgWide, dg1100, dg701, dgShort480, dgShort560, dgCompact560, dgCompact400 })

// ---------- LOAD-RECOVER-1（`G-34` 最小步）：坏库 → 失败屏 → 两步恢复 → 数据回来（浏览器通道全链演出）----------
// 把「库打不开」的自救链从"人工验过一次"变成每次 accept 都验：先把 blocks 写成坏 JSON（模拟损坏的库），
// 断言**失败屏出现**（fail-closed：不静默清空、不重新播种），再从屏上的快照列表走两步恢复，最后断言
// 数据回来（执行后静默）＋「恢复前」后悔药在位。放在整套的最后：它会整页重载并把库回到当天快照那一刻。
await reload() // 顺带把当天快照补出来（若之前被别的检查清过）——失败屏要有可恢复的份
await page.waitForSelector('.editor-content .moqi-block')
const snapshotBefore = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('moqi-project-b:snapshot:')).length)
await page.evaluate(() => localStorage.setItem('moqi-project-b:blocks', '{oops, this is a corrupted library'))
await reload()
await page.waitForSelector('.load-error', { timeout: 60_000 })
const failure = await page.evaluate(() => ({
  title: document.querySelector('.load-error h1')?.textContent ?? null,
  message: document.querySelector('.le-msg')?.textContent ?? null,
  rows: [...document.querySelectorAll('.le-list li')].map((li) => li.querySelector('.le-name')?.textContent ?? ''),
  retry: [...document.querySelectorAll('.le-actions .btn')].map((b) => b.textContent),
  dir: document.querySelector('.le-dir')?.textContent ?? null,
  editorGone: document.querySelector('.editor-content') === null,
}))
await page.locator('.le-list li').first().locator('button', { hasText: '恢复' }).click()
await sleep(200)
const armed = await page.evaluate(() => document.querySelector('.le-warn') !== null)
await page.locator('.le-list li').first().locator('button', { hasText: '确认恢复' }).click()
await page.waitForSelector('.editor-content .moqi-block', { timeout: 60_000 })
await sleep(1200) // 启动通知是重载后一拍弹的
const recoveryNotice = await toast()
const afterRecover = await page.evaluate(() => ({
  failureGone: document.querySelector('.load-error') === null,
  regret: Object.keys(localStorage).some((k) => k.startsWith('moqi-project-b:snapshot:restore-backup-')),
  blocks: JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').length,
}))
check('LOAD-RECOVER-1 坏库自救全链：blocks 坏了 → 失败屏（fail-closed：不静默清空、不重新播种；浏览器通道如实隐藏「复制路径」）→ 快照两步恢复 → 数据回来 ＋「恢复前」后悔药在位（执行后静默）',
  snapshotBefore >= 1 && failure.title === '无法打开墨契' && (failure.message ?? '').includes('损坏') && failure.rows.length >= 1
  && failure.retry.join('/').includes('重新尝试打开') && failure.dir === null && failure.editorGone === true
  && armed === true && afterRecover.failureGone === true && afterRecover.regret === true && afterRecover.blocks > 0
  && recoveryNotice === null,
  { snapshotBefore, failure, armed, recoveryNotice, afterRecover })

// ---------- T-14 对账批（文末自足场景）：G-2 代码块折行 · G-3 代码块 Tab · H-1 标题尾 Enter · H-4 移动档列表标记 ----------
// 放在脚本末段：本块要换掉整页种子，前段各场景的页面假设不受影响。
// 不走 `reset()`（它还要往第一个块里打字——末段承接恢复场景后的状态，打字可能打不进）：
// 直接覆盖 localStorage 两个键 + reload，够本块四条断言用。开场先把窗口摆回桌面档、收掉可能开着的抽屉。
await page.setViewportSize({ width: 1280, height: 900 })
await page.keyboard.press('Escape')
await sleep(400)
await page.evaluate(() => {
  const now = Date.now()
  const mk = (id, uid, type, text2, parent, position, children = []) => ({ entityId: id, blockUid: uid, type, content: [{ t: 'text', v: text2 }], parent, children, position, collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null, isObject: false, objectName: null, properties: [], tags: [], blockRefs: [], blockBackRefs: [], objectRefs: [], objectBackRefs: [], aiMeta: null, created: now, modified: now })
  const page1 = { ...mk('t14-page', 't14page1', 'text', 'T14 对账', null, 0, ['t14-code', 't14-head', 't14-u1', 't14-n1']), isObject: true, objectName: 'T14 对账' }
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify([
    page1,
    mk('t14-code', 't14code1', 'code', 'a very long code line that would overflow the narrow code block width in a 360 viewport for sure 0123456789'),
    mk('t14-code2', 't14cod22', 'code', '  alpha', 't14-page', 1),
    mk('t14-head', 't14head1', 'heading3', '标题尾', 't14-page', 2),
    mk('t14-u1', 't14u1u1u1', 'bullet', '一级', 't14-page', 3, ['t14-u2']),
    mk('t14-u2', 't14u2u2u2', 'bullet', '二级', 't14-u1', 0),
    mk('t14-n1', 't14n1n1n1', 'numbered', '第一条', 't14-page', 4),
  ]))
  localStorage.setItem('moqi-project-b:metadata', JSON.stringify({ properties: [], tags: [] }))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(900)
// 标记几何（与 `R09-BLOCK-31` 中线检查同一套算法）：伪元素没有 rect，用 computed 拼边框盒。
const t14MarkerRead = () => page.evaluate(() => [...document.querySelectorAll('.editor-content .moqi-block[data-entity-id]')]
  .filter((el) => el.dataset.blockType === 'numbered' || el.dataset.blockType === 'bullet')
  .map((el) => {
    const own = getComputedStyle(el)
    const after = getComputedStyle(el, '::after')
    const border = parseFloat(after.borderTopWidth) || 0
    const contentHeight = parseFloat(after.height) || 0
    const borderBoxHeight = after.boxSizing === 'border-box' ? contentHeight : contentHeight + 2 * border
    const firstLineCenter = (parseFloat(own.paddingTop) || 0) + parseFloat(own.lineHeight) / 2
    const markerCenter = (parseFloat(after.top) || 0) + borderBoxHeight / 2
    return { type: el.dataset.blockType, label: after.content, round: after.borderRadius, w: after.width, hollow: after.backgroundColor === 'rgba(0, 0, 0, 0)', delta: Math.round((markerCenter - firstLineCenter) * 10) / 10 }
  }))
const t14MarkerDesktop = await t14MarkerRead()
// G-2：代码块折行（长行不横滚）
const t14Wrap = await page.evaluate(() => {
  const code = document.querySelector('.editor-content .moqi-block[data-entity-id="t14-code"]')
  if (!code) return null
  const cs = getComputedStyle(code)
  return { whiteSpace: cs.whiteSpace, overflowX: cs.overflowX, scrollWidth: Math.round(code.scrollWidth), clientWidth: Math.round(code.clientWidth) }
})
// G-3：代码块内 Tab = 插两空格（**文本变、块不动**）；⇧Tab = 删行首最多两空格（回到原样）
const blockIndexOf = (id) => page.evaluate((blockId) => [...document.querySelectorAll('.editor-content .moqi-block[data-entity-id]')].findIndex((el) => el.dataset.entityId === blockId), id)
const codeIndexOf = (id) => page.evaluate((blockId) => JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => b.parent === 't14-page').sort((a, b) => a.position - b.position).findIndex((b) => b.entityId === blockId), id)
const t14CodeText = () => page.evaluate(() => document.querySelector('.editor-content .moqi-block[data-entity-id="t14-code2"]')?.textContent ?? '')
const t14IndexBefore = await blockIndexOf('t14-code2')
const t14DomainIndexBefore = await codeIndexOf('t14-code2')
const t14TextBefore = await t14CodeText()
// 单行种子 ⇒「行首」= 文本头，与光标落点无关：Tab 在两格之外再插两格、⇧Tab 把行首那两格删掉。
await page.locator('.editor-content .moqi-block[data-entity-id="t14-code2"]').click()
await sleep(300)
await page.keyboard.press('Tab')
await sleep(600)
const t14TextAfterTab = await t14CodeText()
const t14IndexAfterTab = await blockIndexOf('t14-code2')
await page.keyboard.press('Shift+Tab')
await sleep(600)
const t14TextAfterShiftTab = await t14CodeText()
const t14DomainAfter = await page.evaluate(() => {
  const row = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').find((b) => b.entityId === 't14-code2')
  const sib = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]').filter((b) => b.parent === 't14-page').sort((a, b) => a.position - b.position)
  return { type: row?.type, domainIndex: sib.findIndex((b) => b.entityId === 't14-code2') }
})
// H-1：标题尾 Enter → 新块 = 正文（DOM 直读：新块在当前域事务落库前只存在于编辑器里）
await page.locator('.editor-content .moqi-block[data-entity-id="t14-head"]').click()
await page.keyboard.press('End')
await sleep(250)
await page.keyboard.press('Enter')
await sleep(500)
await page.keyboard.type('正文块')
await sleep(600)
const t14Heading = await page.evaluate(() => {
  const head = document.querySelector('.editor-content .moqi-block[data-entity-id="t14-head"]')
  const next = head?.nextElementSibling ?? null
  return { headType: head?.getAttribute('data-block-type') ?? null, nextType: next?.getAttribute('data-block-type') ?? null, nextText: (next?.textContent ?? '').trim() }
})
// H-4：360 视口下标记形状与桌面逐项相等 + 与首行仍同一条中线（±0.6，与 `R09-BLOCK-31` 同判据）
await page.setViewportSize({ width: 360, height: 720 })
await sleep(800)
const t14MarkerMobile = await t14MarkerRead()
await page.setViewportSize({ width: 1280, height: 900 })
await sleep(300)
check('CODEBLOCK-WRAP-1 代码块折行（`R09-BLOCK-18` 对账 · G-2）：代码块 `white-space = pre-wrap`（长行**折行不横滚**）——`scrollWidth ≤ clientWidth + 1`（负例：改回 `pre` + `overflow-x: auto` ⇒ 必红）',
  t14Wrap !== null && t14Wrap.whiteSpace.startsWith('pre-wrap') && t14Wrap.scrollWidth <= t14Wrap.clientWidth + 1,
  { t14Wrap })

check('CODEBLOCK-TAB-1 代码块内 Tab（`R04-KEYS-1` 对账 · G-3）：代码块里按 Tab = **插入两个空格**（文本加长 2）、⇧Tab 把行首那两格删回去（回到原长）——**块不动、类型不变、次序不变**（写代码要的是文本缩进，不是块缩进）',
  t14TextBefore === '  alpha'
  && t14TextAfterTab.length === t14TextBefore.length + 2 /* Tab：文本加两格 */
  && t14TextAfterShiftTab.startsWith('alpha') && t14TextAfterShiftTab.length === t14TextBefore.length /* ⇧Tab：行首两格删掉（净长回到原值） */
  && t14IndexAfterTab === t14IndexBefore && t14DomainAfter.type === 'code' && t14DomainAfter.domainIndex === t14DomainIndexBefore,
  { t14TextBefore, t14TextAfterTab, t14TextAfterShiftTab, t14IndexBefore, t14IndexAfterTab, t14DomainIndexBefore, t14DomainAfter })

check('HEADING-ENTER-1 标题尾 Enter 的新块类型（H-1 对账）：标题（H1–H6）尾按 Enter → 新块 = **正文**（不延续标题）——列表除外（`R04-ENTER-4` 续同类型）',
  t14Heading.headType === 'heading3' && t14Heading.nextType === 'text' && t14Heading.nextText === '正文块',
  t14Heading)

// θ5（T-09）窄档：`?` = **底部 Sheet**（同一份内容、两个容器；`10` §4.8）
await page.setViewportSize({ width: 420, height: 880 })
await sleep(300)
await page.goto(URL)
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(600)
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '设置')?.click() })
await sleep(800)
await page.getByText('备份与恢复').first().click()
await sleep(600)
const narrowQ = await page.evaluate(() => ({
  q: Boolean(document.querySelector('.hint-q')),
  longInline: [...document.querySelectorAll('.set-card .hint')].filter((el) => (el.textContent ?? '').length > 60).length,
}))
await page.locator('.hint-q').first().click()
await sleep(500)
const narrowSheet = await page.evaluate(() => {
  const el = document.querySelector('.sheet')
  return { open: Boolean(el), title: el?.querySelector('.sh-title')?.textContent ?? null, hasText: (el?.textContent ?? '').includes('后悔药') }
})
check('R09-SET-21 窄档 `?` = 底部 Sheet（θ5）：说明进 `Sheet`（标题 = 主题名、正文 = 全文）、直排里仍只有最短一句',
  narrowQ.q === true && narrowQ.longInline === 0
  && narrowSheet.open === true && narrowSheet.title === '本机快照是什么' && narrowSheet.hasText === true,
  { narrowQ, narrowSheet })
await page.setViewportSize({ width: 1280, height: 900 })
await sleep(300)

check('MOBILE-LIST-1 移动档列表标记与桌面同判据（`10` §五 明文 · H-4 对账）：360 视口下标记**形状逐项与桌面相等**（label / round / w / hollow——编号标记的高度跟行高走、360 档行高换档是明文的，不参与相等）+ **与首行仍同一条中线**（|delta| ≤ 0.6，与 `R09-BLOCK-31` 同一算法与判据）',
  t14MarkerDesktop.length >= 3 && t14MarkerMobile.length === t14MarkerDesktop.length
  && t14MarkerMobile.every((row, i) => ['type', 'label', 'round', 'w', 'hollow'].every((key) => row[key] === t14MarkerDesktop[i][key]))
  && t14MarkerMobile.every((row) => Math.abs(row.delta) <= 0.6),
  { t14MarkerDesktop, t14MarkerMobile })


// ---------- M5 可选能力：关闭 AI / 媒体 / 反链 / 属性时不出现假按钮（编辑器可选能力开关）----------
// 宿主开关：产品全开；验收经 localStorage「moqi:features-off」（逗号清单）关灯后 reload——
// 判据住包（editor/features.ts），入口（顶栏 ✦ / ＋插入 / 斜杠 / 飞条 AI / 搜索问 AI / ⋯ 引用预览 / 属性面 / 引用面板本体）消费同一份。
// properties 关灯要有意义，得先让属性面**在场**：经 ⋯「属性」入口给当前页加标签行（PROPS-ENTRY-1 同一条路）。
await page.setViewportSize({ width: 1280, height: 800 })
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
// 造场不走 ⋯ 菜单（整套跑下来负载重、菜单→落库链路在 5s 内不稳）：直接把 `propertyShown`
// 写进当前页的存档块再 reload——PROPS-ENTRY-1 的「标签直落」等价于 `propertyShown` 多一个
// `sys:tags`，这里是同一条数据的确定性写法。
await page.evaluate(() => {
  const activeId = document.querySelector('.moqi-block[data-block-object="true"]')?.dataset.entityId
  if (!activeId) return
  const blocks = JSON.parse(localStorage.getItem('moqi-project-b:blocks') ?? '[]')
  const page = blocks.find((b) => b.entityId === activeId)
  if (!page) return
  const shown = Array.isArray(page.propertyShown) ? page.propertyShown : []
  if (!shown.includes('sys:tags')) page.propertyShown = [...shown, 'sys:tags']
  localStorage.setItem('moqi-project-b:blocks', JSON.stringify(blocks))
})
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
await poll(() => page.evaluate(() => Boolean(document.querySelector('.prop-wrap'))), (v) => v === true, { timeout: 5000, label: '属性面出现（sys:tags 直写后）' })
const briefBeforeOff = await page.evaluate(() => ({ brief: Boolean(document.querySelector('.prop-wrap')), refPanel: Boolean(document.querySelector('.ref-panel')) }))
await page.evaluate(() => { localStorage.setItem('moqi:features-off', 'ai,media,backlinks,properties') })
await page.setViewportSize({ width: 1280, height: 800 })
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
const featureOff = await page.evaluate(() => ({
  aiTop: Boolean(document.querySelector('.topbar [aria-label="AI 助手"]')),
  refMenu: false, // ⋯ 菜单里的「引用预览面板」项在下面点开后读
  brief: Boolean(document.querySelector('.prop-wrap')),
  refPanel: Boolean(document.querySelector('.ref-panel')),
}))
// ＋插入 ▾：媒体三项不出现
await page.locator('.topbar [aria-label="插入新块"]').click()
await sleep(400)
const insertLabelsOff = await page.evaluate(() => [...document.querySelectorAll('.pop button')].map((b) => (b.textContent ?? '').trim()))
await page.keyboard.press('Escape')
await sleep(250)
// 斜杠菜单：插入组无媒体三项
await page.locator('.editor-content .moqi-block:not([data-block-object="true"])').first().click()
await page.keyboard.press('Home')
await page.keyboard.type('/')
await sleep(600)
const slashLabelsOff = await page.evaluate(() => [...document.querySelectorAll('.slash-menu-item .slash-menu-label')].map((el) => (el.textContent ?? '').trim()))
await page.keyboard.press('Escape')
await sleep(250)
// 飞条：选中一块后无「AI 指令」钮
await clickHandle(0)
await sleep(500)
const flyAiOff = await page.evaluate(() => Boolean(document.querySelector('.flybar [aria-label="AI 指令"]')))
await page.keyboard.press('Escape')
await sleep(250)
// ⌘K 搜索覆盖层：无「就这些问 AI」
await page.keyboard.press('Control+k')
await sleep(500)
const askAiOff = await page.evaluate(() => Boolean(document.querySelector('.sr-ask')))
await page.keyboard.press('Escape')
await sleep(250)
// ⋯ 更多菜单：无「引用预览面板」项
await page.locator('.topbar [aria-label="更多"]').click()
await sleep(400)
const moreLabelsOff = await page.evaluate(() => [...document.querySelectorAll('.pop button')].map((b) => (b.textContent ?? '').trim()))
await page.keyboard.press('Escape')
await sleep(250)
featureOff.refMenu = moreLabelsOff.some((text) => text.includes('引用预览面板'))
check('FEATURE-OFF-1 M5 可选能力：关掉 AI / 媒体 / 反链 / 属性（宿主开关）后无假按钮——顶栏无 ✦、＋插入与斜杠无图片/附件/嵌入、飞条无 AI、搜索无问 AI、⋯ 无引用预览、属性面与引用面板本体不渲染；全程不报错',
  briefBeforeOff.brief && briefBeforeOff.refPanel // 前提：开灯时属性面与引用面板本体确实在场——缺席断言才有意义
  && !featureOff.aiTop && !featureOff.refMenu && !flyAiOff && !askAiOff
  && !featureOff.brief && !featureOff.refPanel
  && !insertLabelsOff.some((text) => text.includes('图片块') || text.includes('附件块') || text.includes('嵌入块'))
  && insertLabelsOff.some((text) => text.includes('待办'))
  && !slashLabelsOff.some((text) => text.includes('图片块') || text.includes('附件块') || text.includes('嵌入块'))
  && slashLabelsOff.some((text) => text.includes('待办')),
  { briefBeforeOff, featureOff, flyAiOff, askAiOff, insertLabelsOff, slashLabelsOff: slashLabelsOff.slice(0, 8), moreLabelsOff: moreLabelsOff.slice(0, 8) })

// 正向对照：清掉开关 reload，能力全部回来（证明上面是真关、不是坏）
await page.evaluate(() => { localStorage.removeItem('moqi:features-off') })
await reload()
await page.waitForSelector('.editor-content .moqi-block', { timeout: NAV_READY_MS })
await sleep(700)
const featureOn = await page.evaluate(() => ({
  aiTop: Boolean(document.querySelector('.topbar [aria-label="AI 助手"]')),
  brief: Boolean(document.querySelector('.prop-wrap')),
  refPanel: Boolean(document.querySelector('.ref-panel')),
}))
await page.locator('.topbar [aria-label="插入新块"]').click()
await sleep(400)
const insertLabelsOn = await page.evaluate(() => [...document.querySelectorAll('.pop button')].map((b) => (b.textContent ?? '').trim()))
await page.keyboard.press('Escape')
check('FEATURE-ON-1 M5 可选能力正向对照：清掉开关后 ✦ / 属性面 / 引用面板本体回到界面、＋插入三项媒体齐全（判据是真开关，不是坏）',
  featureOn.aiTop && featureOn.brief && featureOn.refPanel
  && insertLabelsOn.some((text) => text.includes('图片块')) && insertLabelsOn.some((text) => text.includes('嵌入块')),
  { featureOn, insertLabelsOn: insertLabelsOn.slice(0, 8) })

const { report, reportPath } = writeReport({ finishedAt: new Date().toISOString() })
console.log(`\n合计 ${results.length - failed}/${results.length} 通过 · 用时 ${(report.durationMs / 1000).toFixed(1)}s · 预热 ${warmupMs}ms`)
// 「只看合计不看时间戳，把旧报告读成 149/149」是 的教训——汇总行里直接带上 at。
console.log(`at=${report.at} · 报告：${reportPath}${ONLY ? '（子集跑，不写 history/）' : '（历史留档：同目录 history/）'}`)
if (ONLY) console.log(`⚠ 子集模式（MOQI_ONLY=${ONLY}）：${skippedChecks} 条未跑、不计入合计 —— **不得**当作全量绿`)
if (failed > 0) console.log(`失败项：${results.filter((r) => !r.ok).map((r) => r.name.split(' ')[0]).join(' / ')}`)
// AI stub 的「挂起」连接还开着（hold / silent 两个用例故意不复位）：先强断再关，别让进程挂在上面。
aiServer.closeAllConnections()
aiServer.close()
await browser.close()
process.exit(failed === 0 ? 0 : 1)
