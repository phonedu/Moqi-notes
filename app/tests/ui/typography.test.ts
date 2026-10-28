import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

/**
 * 块的排版契约（docs/09 §四「块解剖」+ 13-视觉批设计（已归档） §3）：**每个块自己声明呈现属性**，
 * 不靠从父块继承；字号走**排版轴**（`--fs-e`），间距走 **em**。
 *
 * 缩进后的块是父块的 DOM 子块，父块类型设置的可继承属性会顺着 DOM 漏给子块：标题下的正文
 * 继承 700 字重、标题下的项目/编号列表还继承 24px 字号、代码块下的块继承等宽与 pre-wrap、
 * 引用块与已勾选待办下的块继承弱化色。原型里缩进只是同级块改 padding-left、没有真实嵌套。
 *
 * 基线写在 `.moqi-block`，类型覆盖写在它后面——两者都是单类选择器（权重相同），靠**源顺序**
 * 决定胜负，所以这份测试同时看护「声明存在」与「类型规则必须排在基线之后」。
 *
 * 2026-10-06 视觉批改契约：字号由**倍率**（`calc(var(--fs-e) × N)`）出，**不用 em**——
 * 块 DOM 是真嵌套，字号写 em 会顺着父块漏下去（容器标题 1.88em ⇒ 下面全部放大 1.88 倍）；
 * 间距仍是 em（CSS 语义：margin / padding 的 em 相对块自身字号，随块字号等比）。
 */
const css = readFileSync(new URL('../../src/ui/app.css', import.meta.url), 'utf8')

/** 定位一条规则的声明体（选择器后到第一个 `}`），返回它在文件里的位置与内容。 */
function rule(selector: string): { at: number; body: string } {
  const at = css.indexOf(`${selector} {`)
  assert.notEqual(at, -1, `app.css 里找不到规则 ${selector}`)
  const end = css.indexOf('}', at)
  return { at, body: css.slice(at, end) }
}

const baseline = rule('.moqi-block')

test('基线：块自己声明字族 / 字号 / 字重 / 行高 / 空白处理 / 颜色', () => {
  for (const declaration of ['font-family: var(--sans)', 'font-size: var(--fs-e)', 'font-weight: 400', 'line-height: var(--lh-e)', 'white-space: normal', 'color: var(--text)']) {
    assert.ok(baseline.body.includes(declaration), `基线缺少 ${declaration}——父块类型的可继承属性会漏给子块`)
  }
})

test('类型覆盖必须排在基线之后：同权重类选择器靠源顺序生效', () => {
  const overrides: Array<[string, string]> = [
    ['.moqi-block-heading1', 'font-weight: 700'],
    ['.moqi-block-heading2', 'font-weight: 700'],
    ['.moqi-block-heading3', 'font-weight: 600'],
    ['.moqi-block-heading4', 'font-size: var(--fs-e)'],
    ['.moqi-block-heading5', 'font-weight: 600'],
    ['.moqi-block-heading6', 'color: var(--text-2)'],
    ['.moqi-block-text', 'font-size: var(--fs-e)'],
    ['.moqi-block-todo', 'font-size: calc(var(--fs-e) * .97)'],
    ['.moqi-block-quote', 'color: var(--text-2)'],
    ['.moqi-block-code', 'font-family: var(--mono)'],
    ['.moqi-block-code', 'white-space: pre-wrap'],
  ]
  for (const [selector, declaration] of overrides) {
    const target = rule(selector)
    assert.ok(target.body.includes(declaration), `${selector} 缺少 ${declaration}`)
    assert.ok(target.at > baseline.at, `${selector} 必须写在 ${baseline.at} 之前的规则之后（否则基线会盖掉它）`)
  }
})

test('缩进后的子块不会再继承父块类型的字号：项目 / 编号列表自己声明字号', () => {
  // 这两类没有字号声明时，会从父块继承（标题下就是标题的字号）。字号走轴变量，不写 px。
  assert.ok(rule('.moqi-block-bullet').body.includes('font-size: calc(var(--fs-e) * .97)'), '项目列表要自己声明字号')
  assert.ok(rule('.moqi-block-numbered').body.includes('font-size: calc(var(--fs-e) * .97)'), '编号列表要自己声明字号')
})

/**
 * em 域机械审计（13-视觉批设计（已归档） §3 的护栏第一条 + §4.7 的单位契约）：
 * **块排版的那一组规则**里，font-size / margin / padding / line-height 一律不许出现 px 字面量；
 * 唯一允许的 px 是「为固定控件让位的结构留白」与「旧引擎的结构退回值」，且必须带注释豁免。
 */
test('em 域审计：块排版规则的字号 / 间距不含 px（结构留白必须带豁免注释）', () => {
  const emDomainRules = [
    '.moqi-block', '.moqi-block-text', '.moqi-block-heading1', '.moqi-block-heading2', '.moqi-block-heading3',
    '.moqi-block-heading4', '.moqi-block-heading5', '.moqi-block-heading6',
    '.moqi-block-todo', '.moqi-block-quote', '.moqi-block-code', '.moqi-block-bullet', '.moqi-block-numbered',
    '.editor-content', '.doc-inner',
  ]
  const typed = /(font-size|margin|padding|line-height)(-[a-z]+)?\s*:\s*[^;]*[0-9]+px/
  const offenders: string[] = []
  for (const selector of emDomainRules) {
    for (const declaration of rule(selector).body.split(';')) {
      if (!typed.test(declaration)) continue
      // 豁免：**规则体内带「豁免」注释**的结构留白（为固定尺寸的把手 / ＋ / 标记 / 复选框让位）——
      // 契约原话「豁免必须有注释，无注释的 px 一律回改 em」（13-视觉批设计（已归档） §4.7）。
      const exempt = /豁免/.test(rule(selector).body)
      if (!exempt) offenders.push(`${selector} · ${declaration.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `em 域内出现未豁免的 px：\n${offenders.join('\n')}`)
})

test('排版轴：编辑区吃 --fs-e / --lh-e，正文列吃 --colw（切档只改变量）', () => {
  assert.ok(rule('.editor-content').body.includes('font-size: var(--fs-e)'), '编辑区字号要挂在轴变量上')
  assert.ok(rule('.editor-content').body.includes('line-height: var(--lh-e)'), '编辑区行高要挂在轴变量上')
  assert.ok(rule('.doc-inner').body.includes('max-width: var(--colw)'), '正文列宽要挂在轴变量上')
  // 倍率：**页面标题 2**（2026-10-24 字阶批：基准 17px × 2 = 34px，落在 Cupertino large-title 档；
  // 原 2.35 × 16.5 = 38.8px 比该档大一档）/ H1 1.45 / H2 1.21 / H3 1.03 / H5 .97 / H6 .94；H4 = 1×（与正文同号）
  for (const [selector, ratio] of [['.moqi-block[data-block-object=\'true\']', '2'], ['.moqi-block-heading1', '1.45'], ['.moqi-block-heading2', '1.21'], ['.moqi-block-heading3', '1.03'], ['.moqi-block-heading5', '.97'], ['.moqi-block-heading6', '.94']] as Array<[string, string]>) {
    assert.ok(rule(selector).body.includes(`calc(var(--fs-e) * ${ratio})`), `${selector} 的倍率要写成 calc(var(--fs-e) * ${ratio})`)
  }
  assert.ok(rule('.moqi-block-heading4').body.includes('font-size: var(--fs-e)'), 'H4 = 与正文同号（1×）')
})

/**
 * UI 字阶（2026-10-24，Cupertino 11 档）：UI 层只许 `--type-*`，编辑正文仍走 `--fs-e`。
 * 这条测试看两件事：① 11 组令牌齐全且值 = 设计稿；② 组件 CSS 里不再出现裸 `font-size: Npx`。
 * 引用层门禁（任何 CSS / TSX 里新增裸字号）在 `scripts/check-type-scale.mjs`。
 */
test('UI 字阶：Cupertino 11 档令牌齐全，值 = 设计稿', () => {
  const tokens = readFileSync(new URL('../../src/ui/tokens.css', import.meta.url), 'utf8')
  const scale: Array<[string, number, number, number]> = [
    ['large-title', 34, 41, 700],
    ['title1', 28, 34, 700],
    ['title2', 22, 28, 700],
    ['title3', 20, 25, 600],
    ['headline', 17, 22, 600],
    ['body', 17, 22, 400],
    ['callout', 16, 21, 400],
    ['subheadline', 15, 20, 400],
    ['footnote', 13, 18, 400],
    ['caption1', 12, 16, 400],
    ['caption2', 11, 13, 500],
  ]
  for (const [name, size, line, weight] of scale) {
    assert.ok(tokens.includes(`--type-${name}-size: ${size}px`), `--type-${name}-size 应为 ${size}px`)
    assert.ok(tokens.includes(`--type-${name}-line: ${line}px`), `--type-${name}-line 应为 ${line}px`)
    assert.ok(tokens.includes(`--type-${name}-weight: ${weight}`), `--type-${name}-weight 应为 ${weight}`)
  }
})

test('UI 字阶：组件 CSS 不再出现裸 font-size px（正文轴走 --fs-e / --type-*）', () => {
  const offenders: string[] = []
  for (const file of ['app.css', 'settings.css']) {
    const code = readFileSync(new URL(`../../src/ui/${file}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of code.matchAll(/font-size:\s*([^;]+);/g)) {
      if (/[0-9.]+px/.test(match[1])) offenders.push(`${file}: ${match[0].trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `UI 层出现裸 font-size px：\n${offenders.join('\n')}`)
})
