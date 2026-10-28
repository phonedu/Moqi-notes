/**
 * 关键选择器「在场计数」自检（团队硬规第二条，2026-10-12 立）。
 *
 * 为什么有它：改 `app.css` / `tokens.css` / `themes.css`（以及 **Android 壳 `MainActivity.kt`**）时，最容易出的错不是语法错，
 * 而是**整块规则/代码被顶掉、误删**——门禁（css-order / theme）看不出来（少几条仍然"绿"），
 * 而事故就是这样发生的：2026-10-12 一次 `edit` 锚点选错，把批 α 的三条规则整块替换掉了；
 * **同日第二起**：批 β 改 `MainActivity.kt` 加 IME insets 时把 `D-069` 的背键覆写**整段误删**，
 * 而 `accept:MOBILE-BACK-1` 只看 JS 侧 `window.__moqiBack` ⇒ **门照绿（门盲区）**、真机上返回键直接退出。
 * ⇒ 规矩：**改完 CSS 或 Android 壳先跑本脚本**，计数符合预期再跑门禁。
 *
 * 用法：`node scripts/css-presence.mjs`（读数型：expect 不符才红）
 * 维护：新增「必须恰 N 处」的关键规则时，往 `MUST` 表加一行（把原因写在 `why` 里）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd() // app/
const files = {
  'app.css': 'src/ui/app.css',
  'settings.css': 'src/ui/settings.css',
  'tokens.css': 'src/ui/tokens.css',
  'themes.css': 'src/ui/themes.css',
  // Android 壳（生成的工程，但**我们改过且必须常在**：背键覆写 + IME insets）
  'MainActivity.kt': 'src-tauri/gen/android/app/src/main/java/com/moqi/projectb/MainActivity.kt',
}
const text = {}
for (const [name, rel] of Object.entries(files)) text[name] = readFileSync(join(root, rel), 'utf8')

/** 在哪些文件里数。 */
const count = (pattern, where) => {
  const re = new RegExp(pattern, 'g')
  let n = 0
  for (const name of where) n += (text[name].match(re) ?? []).length
  return n
}

/**
 * 硬要求：`expect` = 必须恰好的处数。不符 ⇒ 退出码 1。
 * 一条规则一行的理由写在 `why`，方便下一轮判断"这条还要不要"。
 */
const MUST = [
  // 批 α：Android 撤标题栏后的三处偏移成对归零（各恰 1 处，多一处/少一处都要看）
  { name: '批 α · .ed-col 顶部归零', pattern: String.raw`body\.is-android \.ed-col \{ padding-top: 0`, where: ['app.css'], expect: 1, why: '`#1`：`--wbar-h` 40px 死带' },
  { name: '批 α · .pagecol.is-drawer 上缘归零', pattern: String.raw`body\.is-android \.pagecol\.is-drawer \{ top: 0`, where: ['app.css'], expect: 1, why: '`#1`：页面库头/抽屉上缘' },
  { name: '批 α · .col-backdrop 上缘归零', pattern: String.raw`body\.is-android \.col-backdrop \{ top: 0`, where: ['app.css'], expect: 1, why: '`#1`：抽屉遮罩不漏 40px' },
  // 移动档分叉块：tokens.css / themes.css 各恰一个生成块
  { name: '移动档分叉 · tokens.css 生成块', pattern: String.raw`BEGIN mobile-fork`, where: ['tokens.css'], expect: 1, why: '`08` §3：默认套分叉块由生成器产出' },
  { name: '移动档分叉 · themes.css 生成块', pattern: String.raw`BEGIN mobile-fork`, where: ['themes.css'], expect: 1, why: '`08` §3：其余 19 套分叉块由生成器产出' },
  // 触屏档单一块（app.css）：按压换轨 + 桌面悬停等价都收在这一块
  { name: '触屏档 · app.css 单一块', pattern: String.raw`@media \(pointer: coarse\) \{`, where: ['app.css'], expect: 1, why: '`10` §七 + `08` §3：触屏通则可一处（分批时勿新增第二块）' },
  // 批 η ①：窄档筛选 chip 的**形状**必须回归控件族（回归 `--r-pill` 就是用户报的「椭圆形」）
  { name: '批 η ① · 筛选 chip 形状 = 控件族', pattern: String.raw`\.pop\.fp \.fp-chip \{ padding: 3px 9px; border-radius: var\(--r-ctrl\); \}`, where: ['app.css'], expect: 1, why: '批 η ①：48 高 × `--r-pill` 99px = 药丸球观感（用户反馈）；回归 ⇒ 该行报 0、门红' },
  // θ13（2026-10-13 真机轮）：θ7 的「容器级子块左内距归零」必须**排除标记族**——它们的左内距是给 `•`/序号/复选框让位的。
  // 回归（`:not()` 被抹掉）⇒ 真机上「光标跑到列表原点前面、一打字列表没了」「待办文字压住复选框」（同源 · `011be20` 的回归）。
  { name: 'θ13 · θ7 归零规则排除标记族', pattern: String.raw`data-block-object="true"\] > \.moqi-block:not\(\.moqi-block-bullet\):not\(\.moqi-block-numbered\):not\(\.moqi-block-todo\) \{ padding-left: 0; \}`, where: ['app.css'], expect: 1, why: 'θ13：标记族除外（回归 ⇒ 该行报 0、门红）' },
  { name: 'θ13 · ai-block 内距规则同样排除标记族', pattern: String.raw`\.moqi-block\.ai-block \.moqi-block:not\(\.moqi-block-bullet\):not\(\.moqi-block-numbered\):not\(\.moqi-block-todo\) \{ padding-left: 10px; \}`, where: ['app.css'], expect: 1, why: 'θ13：同上（AI 块里的列表 / 待办照旧吃让位内距）' },
  // D-071（2026-10-13 · 图片块真比例）：补行规则必须**排除重占用 ::before 的三类**（图片本体 / 附件图标 /
  // 嵌入卡头）——它们命中这条会被整条换成 1lh 空行（真机：竖屏图被压成一根细条 21.67px）。
  // 回归（任一 `:not()` 被抹）⇒ 该行报 0、门红；accept 的「R09-BLOCK-19 块内真比例」同步转红。
  { name: 'D-071 · 补行规则排除 ::before 重占用三类', pattern: String.raw`data-own-line='missing'\]:not\(\[data-block-object='true'\]\):not\(\.moqi-block-image\):not\(\.moqi-block-file\):not\(\.moqi-block-embed\)::before`, where: ['app.css'], expect: 1, why: '`D-071`：三类块的 ::before 是块内容（图片本体 / 📎 / 卡头），被补行规则命中 ⇒ 内容换空行' },
  { name: 'D-071 · 图片本体 ::before 规则在场', pattern: String.raw`\.moqi-block-image::before \{`, where: ['app.css'], expect: 1, why: '`R09-BLOCK-19`：图片本体（`aspect-ratio: var(--asset-ratio)` 画在它上）' },
  // 安全区（`10` 主册 §二「安全区与栏高的合成」）：**body 是流内唯一 owner**（四个方向的 padding 一条写全），
  // 浮层（底栏 / 胶囊 / FAB / 面板 / 弹窗）各自让位——浮层用点总数冻结：新增 / 丢失都要显式改数
  // （`D-069` 的教训：整块规则被顶掉时门禁全绿）。
  { name: '安全区 · body 单一 owner 在场', pattern: String.raw`body \{ padding: env\(safe-area-inset-top\)`, where: ['app.css'], expect: 1, why: '`10` §二：流内唯一 owner；被顶掉 ⇒ 真机状态栏/手势条压内容' },
  { name: '安全区 · env() 用点总数（浮层各自让位）', pattern: String.raw`env\(safe-area-inset`, where: ['app.css', 'settings.css'], expect: 14, why: '2026-10-13 实测冻结 13（1 条 body owner 含 4 个方向 + 浮层 8 处）；θ8 工具栏批 +1 ⇒ 14：胶囊与插入面板各自让出手势条（`.capsule` / `.mbar-grid` 的 padding）；增删都要显式改数（防整块误删）' },
  // Android 壳：`D-069` 系统返回键的两根支柱（批 β 曾整段误删 ⇒ 这两行是解药）
  { name: 'Android 壳 · 原生背键覆写在场', pattern: String.raw`onBackPressedDispatcher\.addCallback`, where: ['MainActivity.kt'], expect: 1, why: '`D-069`：系统返回键先问 `window.__moqiBack`，不接才退出；批 β 误删 ⇒ 真机返回直接退出' },
  { name: 'Android 壳 · WebView 引用钩子在位', pattern: String.raw`override fun onWebViewCreate`, where: ['MainActivity.kt'], expect: 1, why: '`D-069`：没有 `webViewRef` 就无法 `evaluateJavascript` 问 JS 阶梯（与上一行成对）' },
]

/** 读数型：只打印（阈值随批变化，不设红）。 */
const READ = [
  { name: 'γ1 · 编辑态正文抑制', pattern: String.raw`is-touch-edit \.editor-content`, where: ['app.css'] },
  { name: 'δ · 编辑块颜色硬口径', pattern: String.raw`\[data-touch-edit="1"\]`, where: ['app.css'] },
  { name: 'β/#8 · 键盘高度读数', pattern: String.raw`var\(--kb-h`, where: ['app.css', 'settings.css'] },
  { name: 'γ2/γ3 · 选择模式', pattern: String.raw`is-select-mode`, where: ['app.css'] },
  { name: 'ε · 无断点表达式', pattern: String.raw`clamp\(`, where: ['app.css', 'settings.css'] },
  { name: 'ζ · 统一标题栏', pattern: String.raw`\.set-topbar`, where: ['app.css', 'settings.css'] },
]

const failures = []
console.log('关键选择器在场计数（团队硬规第二条）：')
for (const rule of MUST) {
  const n = count(rule.pattern, rule.where)
  const ok = n === rule.expect
  console.log(`  ${ok ? '✓' : '✗'} ${rule.name}：${n}（应 ${rule.expect}）· ${rule.why}`)
  if (!ok) failures.push(`${rule.name}：${n} 处，应为 ${rule.expect}（${rule.why}）`)
}
console.log('读数（不设红，供对照）：')
for (const rule of READ) console.log(`  · ${rule.name}：${count(rule.pattern, rule.where)} 处（${rule.where.join(' / ')}）`)

if (failures.length > 0) {
  console.error('\n关键选择器自检不过（改 CSS 时可能整块被顶掉/误删）：')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('\n关键选择器自检：全过。')
