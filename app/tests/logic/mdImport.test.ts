import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdownDocument, parseMarkdownOutline, type OutlineDraft } from '@moqi/editor'
import { splitFrontMatter } from '@moqi/editor'
import {
  applyImportedAssets, collectInlineTags, collectMediaRefs, resolveExternalLinks, resolveInlineRefs, resolvePageRefs, splitInlineRefs, splitPageRefs,
} from '@moqi/editor'
import { refToken } from '@moqi/editor'
import { planMarkdownExport } from '@moqi/editor'
import { createTextBlock, type Block, type MetadataRegistry } from '@moqi/editor'
import { DomainStore } from '../../src/application/store'
import { emptyRegistry, inferPropertyType } from '@moqi/editor'

// ---------------------------------------------------------------------------
// 导入（迁移）的前置：**通用 Markdown 导入测试**（13-导出与媒体设计（已归档） §「导入」，用户裁决 2026-10-06）。
// 验收两条：① 往返——自家导出物导回来，页名 / 层级 / 块类型 / 行内格式 / 标签与属性还原；
// ② 通用文档——任意 CommonMark 文档读成块树、**不丢字**。
// 命名用规则 ID（`R09-EXPORT-*` / `R09-MD-*` 前缀），理由同别处：`MEDIA-*` 那种形状要进 `11`。
// ---------------------------------------------------------------------------

const mkChild = (id: string, text: string, parent: string, extra: Partial<Block> = {}): Block => ({
  ...createTextBlock({ entityId: id, blockUid: `${id}-uid`, text, parent }),
  ...extra,
})

/** 草稿树打平成「类型:文字」的路径表——断言往返时看它，比逐字段比对更能说清「哪一层变了」。 */
function flatten(drafts: OutlineDraft[]): string[] {
  const out: string[] = []
  const walk = (list: OutlineDraft[], depth: number) => {
    for (const draft of list) {
      // 有行内片段就用片段拼文字（`text` 是「没有记号时」的纯文本兜底，导出物里那一行还带着记号）
      const marks = (draft.content ?? []).filter((fragment) => fragment.marks?.length).map((fragment) => `${fragment.marks?.[0]?.type}${fragment.v}`)
      const body = draft.content && draft.content.length > 0 ? draft.content.map((fragment) => fragment.v).join('') : draft.text
      out.push(`${'  '.repeat(depth)}${draft.type}:${body}${marks.length > 0 ? `[${marks.join('|')}]` : ''}`)
      walk(draft.children, depth + 1)
    }
  }
  walk(drafts, 0)
  return out
}

test('R09-MD-3 通用文档：CommonMark 子集读成块树（标题 / 列表 / 嵌套 / 引用 / 围栏 / front-matter / 媒体行），一个字的正文都不丢', () => {
  const doc = [
    '---',
    'tags: [产品, 草稿]',
    '状态: "进行中"',
    'title: 一份外来的文档',
    '---',
    '',
    '开头就是一段普通文字。',
    '',
    '# 第一章',
    '',
    '- 第一条',
    '- 第二条',
    '  - 缩进一条',
    '',
    '1. 编号一',
    '2. 编号二',
    '',
    '- [x] 已经做完的',
    '- [ ] 还没做的',
    '',
    '> 引用一句',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '---',
    '',
    '![图注](assets/封面.png)',
    '[第41周数据.csv](assets/第41周数据.csv)',
    '',
    '结尾。',
  ].join('\n')
  const parsed = parseMarkdownDocument(doc)
  assert.deepEqual(parsed.frontMatter.tags, ['产品', '草稿'])
  // `quoted: true` = 值在文件里是引号化的（导出侧对 `text` 一律引号化 ⇒ 导入的类型推断读这一位）
  assert.deepEqual(parsed.frontMatter.properties, [{ key: '状态', raw: '进行中', quoted: true }])
  assert.equal(parsed.frontMatter.title, '一份外来的文档')
  // 第一个 `# ` 标题作页名（front-matter 的 title 只是兜底）
  assert.equal(parsed.name, '第一章')

  const tree = flatten(parsed.roots)
  assert.deepEqual(tree, [
    'text:开头就是一段普通文字。',
    'bullet:第一条',
    'bullet:第二条',
    '  bullet:缩进一条',
    'numbered:编号一',
    'numbered:编号二',
    'todo:已经做完的',
    'todo:还没做的',
    'quote:引用一句',
    'code:const a = 1',
    'divider:',
    'image:图注',
    'file:第41周数据.csv',
    'text:结尾。',
  ])

  // 媒体行带引用（解析层只说「像图 / 像附件 + 指向哪」，文件由导入流程去找）
  const media = parsed.roots.filter((draft) => draft.mediaRef !== undefined).map((draft) => draft.mediaRef)
  assert.deepEqual(media, [
    { kind: 'image', href: 'assets/封面.png', label: '图注' },
    { kind: 'file', href: 'assets/第41周数据.csv', label: '第41周数据.csv' },
  ])

  // 不丢字：正文里每一段非空文字都能在草稿树里找到（含代码块里的行）
  for (const line of ['开头就是一段普通文字。', '缩进一条', '引用一句', 'const a = 1', '结尾。']) {
    assert.ok(JSON.stringify(parsed.roots).includes(line), `丢了这一行：${line}`)
  }
})

test('R09-MD-3 通用文档：勾选态 / 围栏内不解析记号 / `\\-` 读回字面 / 纯段落文档也给树（不返回 null）', () => {
  const checks = parseMarkdownDocument('- [x] 勾上的\n- [ ] 未勾的')
  // 未勾的待办不带 checked 字段（记号表只在 `[x]` 那条给 true）——草稿层就是「有就 true、没有就空」。
  assert.deepEqual(checks.roots.map((draft) => [draft.type, draft.checked, draft.text]), [
    ['todo', true, '勾上的'],
    ['todo', undefined, '未勾的'],
  ])

  const fenced = parseMarkdownDocument('```\n- 这行在围栏里，不是列表\n```')
  assert.deepEqual(fenced.roots.map((draft) => draft.type), ['code'])
  assert.equal(fenced.roots[0].text, '- 这行在围栏里，不是列表')

  const literal = parseMarkdownDocument('\\- 这行看起来像列表，其实是正文')
  assert.deepEqual(literal.roots.map((draft) => [draft.type, draft.text]), [['text', '- 这行看起来像列表，其实是正文']])

  // 整篇没有一处记号：导入照样给一棵树（粘贴那条路会返回 null 放行走默认粘贴）
  const plain = parseMarkdownDocument('就是一段话。\n\n又一段。')
  assert.deepEqual(plain.roots.map((draft) => draft.type), ['text', 'text'])
  assert.equal(parseMarkdownOutline('就是一段话。'), null)
})

test('R09-EXPORT-2 往返：自家导出物导回来——页名 / 层级 / 块类型 / 行内格式 / 标签与属性还原', () => {
  const page = {
    ...createTextBlock({ entityId: 'pg', blockUid: 'pg-uid', text: '周报', isObject: true, objectName: '周报' }),
    tags: ['tag-产品'],
  }
  page.children = ['h2', 'body', 'bullet', 'todo', 'quote', 'code', 'divider', 'nested']
  const h2 = mkChild('h2', '这周做了什么', 'pg', { type: 'heading2' })
  const body = mkChild('body', '先写下结论。', 'pg')
  body.content = [{ t: 'text', v: '先写下' }, { t: 'text', v: '结论', marks: [{ type: 'bold' }] }, { t: 'text', v: '。' }]
  const bullet = mkChild('bullet', '第一条', 'pg', { type: 'bullet', children: ['bullet-kid'] })
  const bulletKid = mkChild('bullet-kid', '子条目', 'bullet', { type: 'bullet' })
  const todo = mkChild('todo', '发出去', 'pg', { type: 'todo', checked: true })
  const quote = mkChild('quote', '一句引用', 'pg', { type: 'quote' })
  const code = mkChild('code', 'const a = 1', 'pg', { type: 'code' })
  const divider = mkChild('divider', '', 'pg', { type: 'divider' })
  const nested = mkChild('nested', '上一层', 'pg', { type: 'bullet', children: [] })
  nested.children = []
  const page2 = { ...createTextBlock({ entityId: 'pg2', blockUid: 'pg2-uid', text: '随手记', isObject: true, objectName: '随手记' }), parent: null }
  const note = mkChild('note', '只带一句话', 'pg2')
  page2.children = ['note']
  page2.parent = null

  const registry: MetadataRegistry = {
    ...emptyRegistry(),
    tags: [{ id: 'tag-产品', name: '产品', created: 1, modified: 1 }],
  }
  const store = new DomainStore([page, h2, body, bullet, bulletKid, todo, quote, code, divider, nested, page2, note])
  const plan = planMarkdownExport(store.snapshot(), registry, { kind: 'page', pageId: 'pg' }, { today: '2026-10-07' })!
  const markdown = plan.files[0].content

  const parsed = parseMarkdownDocument(markdown)
  assert.equal(parsed.name, '周报', '页名从 `# 周报` 读回来')
  assert.deepEqual(parsed.frontMatter.tags, ['产品'], '标签还原')
  assert.deepEqual(flatten(parsed.roots), [
    'heading2:这周做了什么',
    'text:先写下结论。[bold结论]',
    'bullet:第一条',
    '  bullet:子条目',
    'todo:发出去',
    'quote:一句引用',
    'code:const a = 1',
    'divider:',
    'bullet:上一层',
  ])
})

test('R09-EXPORT-2 往返：正文里的行首记号与行内记号读回来是原文（导出转义、导入读回字面）', () => {
  const page = { ...createTextBlock({ entityId: 'pg', blockUid: 'pg-uid', text: '杂记', isObject: true, objectName: '杂记' }), children: ['lit', 'star'] }
  const literal = mkChild('lit', '- 这行是正文里的破折号，不是列表', 'pg')
  const star = mkChild('star', '这不是斜体，就是两个星号', 'pg')
  star.content = [{ t: 'text', v: '这不是*斜体*，就是两个星号' }]
  const store = new DomainStore([page, literal, star])
  const markdown = planMarkdownExport(store.snapshot(), emptyRegistry(), { kind: 'page', pageId: 'pg' }, { today: '2026-10-07' })!.files[0].content
  const parsed = parseMarkdownDocument(markdown)
  assert.deepEqual(flatten(parsed.roots).map((line) => line.replace(/^  +/, '')), [
    'text:- 这行是正文里的破折号，不是列表',
    'text:这不是*斜体*，就是两个星号',
  ])
})

test('R09-EXPORT-2 往返：行内引用（导出写 `[名](<名.md>)`）读回来还原成引用——不是退化成字面文本（台账 D-045）', () => {
  const page = { ...createTextBlock({ entityId: 'pg', blockUid: 'pg-uid', text: '周报', isObject: true, objectName: '周报' }), children: ['body'] }
  const body = mkChild('body', '见 目标页', 'pg')
  body.content = [
    { t: 'text', v: '见 ' },
    { t: 'inline-ref', v: '目标页', ref: { kind: 'object', targetId: 'target' } },
  ]
  const target = { ...createTextBlock({ entityId: 'target', blockUid: 'target-uid', text: '目标页', isObject: true, objectName: '目标页' }) }
  const store = new DomainStore([page, body, target])
  const markdown = planMarkdownExport(store.snapshot(), emptyRegistry(), { kind: 'page', pageId: 'pg' }, { today: '2026-10-07' })!.files[0].content
  assert.ok(markdown.includes('[目标页](<目标页.md>)'), `导出侧写的是带尖括号的形态：${markdown}`)

  const parsed = parseMarkdownDocument(markdown)
  const resolved = resolvePageRefs(parsed.roots, (name) => (name === '目标页' ? 'target' : null))
  assert.deepEqual(resolved.unresolved, [], '两种写法都要认，不该有「未对上」的链接')
  assert.ok(JSON.stringify(resolved.drafts).includes('"targetId":"target"'), `引用要还原到目标 id：${JSON.stringify(resolved.drafts)}`)
})

test('R09-EXPORT-2 往返：代码块正文里含 ``` 时（导出写 4 个反引号）读回来还是同一个代码块（台账 D-046）', () => {
  const page = { ...createTextBlock({ entityId: 'pg', blockUid: 'pg-uid', text: '片段', isObject: true, objectName: '片段' }), children: ['code'] }
  const code = mkChild('code', '```\n内部围栏\n```', 'pg', { type: 'code' })
  const store = new DomainStore([page, code])
  const markdown = planMarkdownExport(store.snapshot(), emptyRegistry(), { kind: 'page', pageId: 'pg' }, { today: '2026-10-07' })!.files[0].content
  assert.ok(markdown.includes('````'), `围栏要加宽到 4 个反引号：${markdown}`)

  const parsed = parseMarkdownDocument(markdown)
  assert.equal(parsed.roots.length, 1, '还是一个代码块（不是「围栏行 + 普通行」）')
  assert.equal(parsed.roots[0].type, 'code')
  assert.equal(parsed.roots[0].text, '```\n内部围栏\n```', '代码正文逐字还原（含内部的三反引号）')
})

test('R09-EXPORT-2 往返：引用块里的子项读回来还是子项（旧实现整行 trim 成 quote 的文字，台账 D-047）', () => {
  const page = { ...createTextBlock({ entityId: 'pg', blockUid: 'pg-uid', text: '摘录', isObject: true, objectName: '摘录' }), children: ['quote'] }
  const quote = mkChild('quote', '一句引用', 'pg', { type: 'quote', children: ['kid'] })
  const kid = mkChild('kid', '子条目', 'quote', { type: 'bullet' })
  const store = new DomainStore([page, quote, kid])
  const markdown = planMarkdownExport(store.snapshot(), emptyRegistry(), { kind: 'page', pageId: 'pg' }, { today: '2026-10-07' })!.files[0].content
  assert.ok(markdown.includes('>   - 子条目'), `子块每一行都带引用前缀：${markdown}`)

  const parsed = parseMarkdownDocument(markdown)
  assert.deepEqual(flatten(parsed.roots), ['quote:一句引用', '  bullet:子条目'], '引用与它的子项各归各位')
})

test('R09-EXPORT-2 往返：下划线（Markdown 没语法，导出写 `<u>…</u>`）读回来是下划线；字面 `<u>` 文本不被吃成格式', () => {
  const page = { ...createTextBlock({ entityId: 'pg', blockUid: 'pg-uid', text: '排版', isObject: true, objectName: '排版' }), children: ['body', 'lit'] }
  const body = mkChild('body', '这段带下划线', 'pg')
  body.content = [{ t: 'text', v: '这段' }, { t: 'text', v: '带下划线', marks: [{ type: 'underline' }] }]
  const literal = mkChild('lit', '<u>这不是标签</u>', 'pg')
  literal.content = [{ t: 'text', v: '<u>这不是标签</u>' }]
  const store = new DomainStore([page, body, literal])
  const markdown = planMarkdownExport(store.snapshot(), emptyRegistry(), { kind: 'page', pageId: 'pg' }, { today: '2026-10-07' })!.files[0].content
  assert.ok(markdown.includes('<u>带下划线</u>'), `下划线写成 <u>：${markdown}`)
  assert.ok(markdown.includes('\\<u>这不是标签\\</u>'), `字面的 <u> 要转义（往返无歧义）：${markdown}`)

  const parsed = parseMarkdownDocument(markdown)
  assert.deepEqual(flatten(parsed.roots), [
    'text:这段带下划线[underline带下划线]',
    'text:<u>这不是标签</u>',
  ])
})


test('R09-MD-3 导入：媒体引用的落地——命中的贴成媒体草稿（图注进 content）、缺文件的降级成文字（一字不丢）', () => {
  const doc = parseMarkdownDocument('![封面](assets/封面.png)\n[数据.csv](assets/数据.csv)\n![没有的图](assets/丢了.png)')
  assert.deepEqual(collectMediaRefs(doc.roots), [
    { href: 'assets/封面.png', kind: 'image', label: '封面' },
    { href: 'assets/数据.csv', kind: 'file', label: '数据.csv' },
    { href: 'assets/丢了.png', kind: 'image', label: '没有的图' },
  ], '清单去重、按出现顺序')

  const assets = new Map([
    ['assets/封面.png', { fileName: 'disk-1.png', originalName: '封面.png', mime: 'image/png', size: 123, width: 480, height: 270 }],
    ['assets/数据.csv', { fileName: 'disk-2.csv', originalName: '数据.csv', mime: 'text/csv', size: 45 }],
  ])
  const { drafts, missing } = applyImportedAssets(doc.roots, assets)
  assert.deepEqual(missing, ['assets/丢了.png'], '缺哪条报哪条')
  assert.deepEqual(drafts.map((draft) => [draft.type, draft.text, draft.asset?.fileName ?? null]), [
    ['image', '封面', 'disk-1.png'],
    ['file', '', 'disk-2.csv'],
    ['text', '［图片］没有的图（未找到 assets/丢了.png）', null],
  ])
  assert.deepEqual(drafts[0].content, [{ t: 'text', v: '封面' }], '图片块的 content 就是图注')
  assert.equal(drafts[1].content, undefined, '附件块的 content 恒空')
  assert.equal(drafts[0].mediaRef, undefined, '落地过的草稿不再带引用')
})

test('R09-MD-3 导入：文档整篇落成一个新页面——页面与正文同一事务（一次撤销退回整篇）', () => {
  const doc = parseMarkdownDocument('# 周报\n\n正文一段\n- 条目')
  const store = new DomainStore([])
  const created = store.insertDocumentAsPage(doc.roots, '周报', { tags: ['tag-产品'] })!
  assert.ok(created.pageId && created.blockIds.length === 2)
  const page = store.get(created.pageId)!
  assert.equal(page.isObject, true)
  assert.equal(page.objectName, '周报')
  assert.deepEqual(page.tags, ['tag-产品'])
  assert.deepEqual(page.children, created.blockIds, '正文是页面的子块')
  assert.deepEqual(store.get(created.blockIds[0])!.content, [{ t: 'text', v: '正文一段' }])
  assert.equal(store.get(created.blockIds[1])!.type, 'bullet')

  // 撤销走的是**领域那套删除语义**（软删，块还在图里但 deleted = true），不是从 map 里抹掉。
  store.undo()
  assert.equal(store.get(created.pageId)!.deleted, true, '一次撤销把整篇（含页面）退掉')
  assert.ok(created.blockIds.every((id) => store.get(id)!.deleted), '正文一起退')
  store.redo()
  assert.equal(store.get(created.pageId)!.deleted, false, '重做也整篇回来')
  assert.equal(store.get(created.pageId)!.children.length, 2)
})

test('R09-EXPORT-2 导入：引用还原——`[名](名.md)` 认出页名就还原成页面引用（片段 + 引用点一起写），认不出就保持文字', () => {
  // ① 纯函数：切跨度
  assert.deepEqual(splitPageRefs('见 [产品路线](产品路线.md) 与 [外面](https://example.com)'), [
    { text: '见 ' },
    { label: '产品路线', file: '产品路线.md' },
    { text: ' 与 [外面](https://example.com)' },
  ], '只认 .md 链接，外部链接原样留在文字里')

  // ② 库里对得上 → 还原成引用；对不上 → 保持文字并报出来
  const doc = parseMarkdownDocument('这一页对齐 [产品路线](产品路线.md)，另见 [不存在的页](不存在的页.md)。')
  const { drafts, unresolved } = resolvePageRefs(doc.roots, (name) => (name === '产品路线' ? 'page-1' : null))
  assert.deepEqual(unresolved, ['不存在的页.md'])
  assert.deepEqual(drafts[0].content, [
    { t: 'text', v: '这一页对齐 ' },
    { t: 'inline-ref', v: '产品路线', ref: { kind: 'object', targetId: 'page-1' } },
    { t: 'text', v: '，另见 [不存在的页](不存在的页.md)。' },
  ])
  assert.deepEqual(drafts[0].refs, [{ kind: 'object', targetId: 'page-1' }], '引用点单列——插入时要一起写')
})

test('R09-EXPORT-2 导入：还原出来的引用**真的落进图里**（片段落进块、引用点在两头上账、反链看得见、撤销一起退）', () => {
  const target = { ...createTextBlock({ entityId: 'target-page', blockUid: 'target01', text: '产品路线', isObject: true, objectName: '产品路线' }) }
  const store = new DomainStore([target])
  const doc = parseMarkdownDocument('# 收件页\n\n这一页对齐 [产品路线](产品路线.md)。')
  const { drafts } = resolvePageRefs(doc.roots, (name) => (name === '产品路线' ? 'target-page' : null))
  const created = store.insertDocumentAsPage(drafts, '收件页')!

  const body = store.get(created.blockIds[0])!
  assert.deepEqual(body.content, [
    { t: 'text', v: '这一页对齐 ' },
    { t: 'inline-ref', v: '产品路线', ref: { kind: 'object', targetId: 'target-page' } },
    { t: 'text', v: '。' },
  ])
  assert.deepEqual(body.objectRefs, ['target-page'], '引用点写上了（反链面板读它）')
  assert.deepEqual(store.get('target-page')!.objectBackRefs, [created.blockIds[0]], '反向引用也上账')

  store.undo()
  assert.equal(store.get(created.blockIds[0])!.deleted, true, '一次撤销整篇退掉')
  assert.deepEqual(store.get('target-page')!.objectBackRefs, [], '反链一起退干净，不留悬空引用')
})

test('R09-MD-7 粘贴：`[[页名]]` / `((块名))` 是**可读取的引用语法**——切跨度 + 按名还原（片段与引用点一起写、认不出保持字面）', () => {
  // ① 纯函数：切跨度（`[[` 归页面、`((` 归块；其余原样留在文字里；`target` 解析用 / `display` 显示用）
  assert.deepEqual(splitInlineRefs('见 [[产品路线]] 与 ((方案要点)) 两处'), [
    { text: '见 ' },
    { kind: 'object', target: '产品路线', display: '产品路线', raw: '[[产品路线]]' },
    { text: ' 与 ' },
    { kind: 'block', target: '方案要点', display: '方案要点', raw: '((方案要点))' },
    { text: ' 两处' },
  ])

  // ①b 与「复制为块引用」是**同一张语法表**（`selectionText.refToken` 写、`mdRefs.splitInlineRefs` 读）——
  // 用户 2026-10-08 报的缺口正是这条往返：菜单写出去的语法自己粘回来不认。这条断言把它钉死。
  const pageBlock = createTextBlock({ entityId: 'rt-page', blockUid: 'rtpg0001', text: '产品路线', isObject: true, objectName: '产品路线' })
  const plainBlock = createTextBlock({ entityId: 'rt-blk', blockUid: 'rtblk001', text: '方案要点' })
  assert.deepEqual(splitInlineRefs(refToken(pageBlock)), [{ kind: 'object', target: '产品路线', display: '产品路线', raw: '[[产品路线]]' }], '页面：refToken 写出 `[[…]]`、splitInlineRefs 必须认回来')
  assert.deepEqual(splitInlineRefs(refToken(plainBlock)), [{ kind: 'block', target: '方案要点', display: '方案要点', raw: '((方案要点))' }], '块：refToken 写出 `((…))`、splitInlineRefs 必须认回来')

  // ② 库里有 → 还原；没有 → 保持字面并报出来（不凭空造页，与导入同口径）
  const drafts = parseMarkdownDocument('看这条 [[产品路线]] 和 ((方案要点)) 与 [[不存在的页]]。').roots
  const { drafts: resolved, unresolved } = resolveInlineRefs(drafts, (kind, label) => {
    if (kind === 'object' && label === '产品路线') return 'page-1'
    if (kind === 'block' && label === '方案要点') return 'blk-1'
    return null
  })
  assert.deepEqual(unresolved, ['[[不存在的页]]'])
  assert.deepEqual(resolved[0].content, [
    { t: 'text', v: '看这条 ' },
    { t: 'inline-ref', v: '产品路线', ref: { kind: 'object', targetId: 'page-1' } },
    { t: 'text', v: ' 和 ' },
    { t: 'inline-ref', v: '方案要点', ref: { kind: 'block', targetId: 'blk-1' } },
    { t: 'text', v: ' 与 [[不存在的页]]。' },
  ])
  assert.deepEqual(resolved[0].refs, [
    { kind: 'object', targetId: 'page-1' },
    { kind: 'block', targetId: 'blk-1' },
  ], '引用点单列——插入时要一起写')
})

test('R09-MD-7 粘贴：按名解析单一所有者（`store.resolveInlineRef`）——页名找同名页、块名找标签相同的块（同页优先、自己除外），认不出返回 null', () => {
  const page = { ...createTextBlock({ entityId: 'own-page', blockUid: 'ownpg001', text: '收件页', isObject: true, objectName: '收件页' }), children: ['own-b1', 'own-b2'] }
  const anchor = { ...createTextBlock({ entityId: 'own-b1', blockUid: 'ownb1001', text: '第一段', parent: 'own-page' }) }
  const ownBlock = { ...createTextBlock({ entityId: 'own-b2', blockUid: 'ownb2001', text: '方案要点', parent: 'own-page' }) }
  const target = { ...createTextBlock({ entityId: 'target-page', blockUid: 'tgtpg001', text: '产品路线', isObject: true, objectName: '产品路线' }), children: ['tgt-b1'] }
  const targetBlock = { ...createTextBlock({ entityId: 'tgt-b1', blockUid: 'tgtb1001', text: '方案要点', parent: 'target-page' }) }
  const store = new DomainStore([page, anchor, ownBlock, target, targetBlock])

  assert.equal(store.resolveInlineRef('object', '产品路线', 'own-b1'), 'target-page', '页名 → 同名页')
  assert.equal(store.resolveInlineRef('object', '收件页', 'own-b1'), 'own-page', '页级自引用不拒（行内 `[[` 的规矩，见 D-014 条）')
  assert.equal(store.resolveInlineRef('block', '方案要点', 'own-b1'), 'own-b2', '块名 → 标签相同的块，**同页优先**')
  assert.equal(store.resolveInlineRef('block', '方案要点', 'tgt-b1'), 'own-b2', '同页没有（自己被排除）→ 兜底取全库第一个候选')
  assert.equal(store.resolveInlineRef('object', '不存在的页', 'own-b1'), null, '认不出 → null（调用方保持字面）')
  assert.equal(store.resolveInlineRef('block', '不存在的块', 'own-b1'), null)
})

test('R09-MD-7 粘贴：行内记号与代码不被引用还原吃掉——`**粗** [[页名]]` 的粗体保住、转义读回字面、代码里的跨度不还原', () => {
  const resolve = (_kind: 'object' | 'block', label: string) => (label === '产品路线' ? 'p1' : null)

  // ① 记号行里「粗体 + 引用」同行：marks 保住（2026-10-08 修——此前从原始文字重建会把 `**` 漏进正文）
  const marked = parseMarkdownOutline('- **粗** [[产品路线]] 哦')!
  assert.deepEqual(resolveInlineRefs(marked, resolve).drafts[0].content, [
    { t: 'text', v: '粗', marks: [{ type: 'bold' }] },
    { t: 'text', v: ' ' },
    { t: 'inline-ref', v: '产品路线', ref: { kind: 'object', targetId: 'p1' } },
    { t: 'text', v: ' 哦' },
  ])

  // ② 粗体**跨**引用（`**见 [[页名]] 哦**`）：两侧的 marks 都留住
  const across = parseMarkdownDocument('**见 [[产品路线]] 哦**')
  assert.deepEqual(resolveInlineRefs(across.roots, resolve).drafts[0].content, [
    { t: 'text', v: '见 ', marks: [{ type: 'bold' }] },
    { t: 'inline-ref', v: '产品路线', ref: { kind: 'object', targetId: 'p1' } },
    { t: 'text', v: ' 哦', marks: [{ type: 'bold' }] },
  ])

  // ③ 导入路（页面链接）同一口径：粗体 + `[名](名.md)` 同行
  const imported = parseMarkdownDocument('- **粗** [产品路线](产品路线.md)')
  assert.deepEqual(resolvePageRefs(imported.roots, (name) => (name === '产品路线' ? 'p1' : null)).drafts[0].content, [
    { t: 'text', v: '粗', marks: [{ type: 'bold' }] },
    { t: 'text', v: ' ' },
    { t: 'inline-ref', v: '产品路线', ref: { kind: 'object', targetId: 'p1' } },
  ])

  // ④ 转义的行内记号读回字面（记号行与纯文字行同口径）：`\*字面\*` 不是斜体、不漏反斜杠
  const escaped = parseMarkdownOutline('- \\*字面\\* 和 [[产品路线]]')!
  assert.equal(escaped[0].text, '*字面* 和 [[产品路线]]')
  assert.deepEqual(resolveInlineRefs(escaped, resolve).drafts[0].content, [
    { t: 'text', v: '*字面* 和 ' },
    { t: 'inline-ref', v: '产品路线', ref: { kind: 'object', targetId: 'p1' } },
  ])

  // ⑤ 代码是字面：围栏块与行内代码里的跨度都不还原（与导出侧 isCode 原样同一条纪律）
  const fenced = parseMarkdownDocument('```\n看 [[产品路线]] 哦\n```')
  assert.equal(resolveInlineRefs(fenced.roots, resolve).drafts[0].content, undefined, '围栏块整个不扫')
  const inlineCode = parseMarkdownDocument('看 `[[产品路线]]` 但 [[产品路线]] 要认')
  assert.deepEqual(resolveInlineRefs(inlineCode.roots, resolve).drafts[0].content, [
    { t: 'text', v: '看 ' },
    { t: 'text', v: '[[产品路线]]', marks: [{ type: 'code' }] },
    { t: 'text', v: ' 但 ' },
    { t: 'inline-ref', v: '产品路线', ref: { kind: 'object', targetId: 'p1' } },
    { t: 'text', v: ' 要认' },
  ], '行内代码里的不认、旁边的照认')
})

// ---------------------------------------------------------------------------
// 2026-10-10「Obsidian 互通」批：通用 MD 的边角 + Obsidian 语法 → 块树（读回侧）
// ---------------------------------------------------------------------------

test('R09-MD-3 通用文档：围栏里的 `# ` 不算页名（页名摘取跳过围栏）——代码块那行一个字不丢', () => {
  const doc = parseMarkdownDocument(['```bash', '# 这是注释，不是页名', 'echo hi', '```', '', '# 真正的页名', '正文'].join('\n'))
  assert.equal(doc.name, '真正的页名', '围栏里的 `# ` 不是页名')
  assert.deepEqual(doc.roots.map((draft) => [draft.type, draft.text]), [
    ['code', '# 这是注释，不是页名\necho hi'],
    ['text', '正文'],
  ], '注释那行留在代码块里（旧实现会把它从代码块里摘掉）；真正的页名行被摘成页名、不再当块')
})

test('R09-MD-3 通用文档：缩进按**列**算——tab 缩进（Obsidian 默认）与 2 / 4 空格三种写法都给同一棵树', () => {
  const expected = ['bullet:一级', '  bullet:二级', '    bullet:三级']
  for (const [name, doc] of [
    ['tab', '- 一级\n\t- 二级\n\t\t- 三级'],
    ['4 空格', '- 一级\n    - 二级\n        - 三级'],
    ['2 空格', '- 一级\n  - 二级\n    - 三级'],
  ] as const) {
    assert.deepEqual(flatten(parseMarkdownDocument(doc).roots), expected, `${name} 缩进`)
  }
})

test('R09-MD-3 通用文档：setext 标题（`===` / `---` 紧邻段落）升成标题；空行隔开的 `---` 仍是分隔线', () => {
  assert.deepEqual(flatten(parseMarkdownDocument('大标题\n===\n\n小标题\n---').roots), ['heading1:大标题', 'heading2:小标题'])
  // 导出侧写分隔线**前面保证空行**（`exportMd`）——自家往返不受 setext 影响
  assert.deepEqual(flatten(parseMarkdownDocument('一段文字\n\n---\n\n又一段').roots), ['text:一段文字', 'divider:', 'text:又一段'])
  // 行尾两空格（CommonMark 的硬换行标记）不进正文
  assert.deepEqual(flatten(parseMarkdownDocument('硬换行  \n下一行').roots), ['text:硬换行', 'text:下一行'])
})

test('R09-MD-3 导入：Obsidian 的媒体嵌入 `![[图.png]]` 认成媒体引用；`![[页面]]` 不是媒体（保持字面）', () => {
  const doc = parseMarkdownDocument([
    '![[封面 图.png]]',
    '![[数据.csv]]',
    '![[另一页]]',
    '![[图.png|300]]',
  ].join('\n'))
  assert.deepEqual(collectMediaRefs(doc.roots), [
    { href: '封面 图.png', kind: 'image', label: '封面 图.png' },
    { href: '数据.csv', kind: 'file', label: '数据.csv' },
    { href: '图.png', kind: 'image', label: '图.png' },
  ], '页面嵌入与宽度后缀（`|300`）都不当媒体')
  assert.equal(flatten(doc.roots)[2], 'text:![[另一页]]', '页面嵌入保持字面（不凭空造引用）')
})

test('R09-MD-7 导入：Obsidian 的 `[[页名|别名]]` 与 `[[目录/页名]]` 还原成引用；带锚点的保持字面并单独报数', () => {
  const drafts = parseMarkdownDocument('见 [[产品路线|路线图]]、[[笔记/产品路线]] 与 [[产品路线#目标]] 三处。').roots
  const { drafts: resolved, unresolved, anchored } = resolveInlineRefs(drafts, (kind, label) =>
    (kind === 'object' && (label === '产品路线' || label === '笔记/产品路线') ? 'page-1' : null))
  assert.deepEqual(unresolved, [], '别名与带路径的写法都该认出来（不带路径的按末段对）')
  assert.deepEqual(anchored, ['[[产品路线#目标]]'], '锚点单独报数——不是「页没找到」')
  assert.deepEqual(resolved[0].content, [
    { t: 'text', v: '见 ' },
    { t: 'inline-ref', v: '路线图', ref: { kind: 'object', targetId: 'page-1' } },
    { t: 'text', v: '、' },
    { t: 'inline-ref', v: '产品路线', ref: { kind: 'object', targetId: 'page-1' } },
    { t: 'text', v: ' 与 [[产品路线#目标]] 三处。' },
  ], '别名进显示文字、路径链接显示末段名')
})

test('R09-MD-7 导入：外部链接还原成 `link` 片段（`[文字](url)` / `<自动链接>` / `![alt](http…)`），本地相对路径不转', () => {
  const drafts = parseMarkdownDocument([
    '看 [文档](https://example.com/a) 与 <https://example.com/b>。',
    '![外链图](https://example.com/c.png)',
    '这是 [本地](assets/x.png) 的说明。',
  ].join('\n')).roots
  const { drafts: linked, links } = resolveExternalLinks(drafts)
  assert.equal(links, 3, '三条外链（两条行内 + 一条图片形态）')
  assert.deepEqual(linked[0].content, [
    { t: 'text', v: '看 ' },
    { t: 'link', v: '文档', url: 'https://example.com/a' },
    { t: 'text', v: ' 与 ' },
    { t: 'link', v: 'https://example.com/b', url: 'https://example.com/b' },
    { t: 'text', v: '。' },
  ])
  assert.deepEqual(linked[1].content, [{ t: 'link', v: '外链图', url: 'https://example.com/c.png' }], '外链图片落成 link（模型里没有「外链图片」块，但 alt 与 URL 都不丢）')
  assert.equal(linked[2].content, undefined, '本地相对路径既不是资产也不是外链——保持字面')
})

test('R09-MD-7 导入：`***粗斜***` 一次落两个 mark（读回侧，与导出侧的内到外顺序一致）', () => {
  const drafts = parseMarkdownDocument('这段是 ***重点*** 的。').roots
  assert.deepEqual(drafts[0].content, [
    { t: 'text', v: '这段是 ' },
    { t: 'text', v: '重点', marks: [{ type: 'italic' }, { type: 'bold' }] },
    { t: 'text', v: ' 的。' },
  ])
})

test('R09-MD-3 导入：callout 降级成「引用 ＋ 首行原文」（用户裁决 2026-10-10）——连续引用行合成一个块，导出再导入仍是同一个', () => {
  // ① 读回来：`> [!note] 标题` 与它的正文是**同一个引用块**（正文是子块），空行隔开的另起一块
  const doc = parseMarkdownDocument('> [!note] 提示\n> 正文一行\n\n> 另一个引用')
  assert.deepEqual(flatten(doc.roots), [
    'quote:[!note] 提示',
    '  text:正文一行',
    'quote:另一个引用',
  ], 'callout 的首行原文留在引用文字里、正文落成子块；空行隔开的是另一个引用块')

  // ② 写回去：块内空行写成 `>`（不是空行）——Obsidian 读回来仍是一个 callout，不会被拆成两段
  const page = { ...createTextBlock({ entityId: 'pg', blockUid: 'pg-uid', text: '摘录', isObject: true, objectName: '摘录' }), children: ['q'] }
  const quote = mkChild('q', '[!note] 提示', 'pg', { type: 'quote', children: ['body'] })
  const body = mkChild('body', '正文一行', 'q')
  const store = new DomainStore([page, quote, body])
  const markdown = planMarkdownExport(store.snapshot(), emptyRegistry(), { kind: 'page', pageId: 'pg' }, { today: '2026-10-10' })!.files[0].content
  assert.ok(markdown.includes('> [!note] 提示\n>   正文一行'), `正文带引用前缀、整段仍在同一个引用里（不被空行拆开）：${markdown}`)

  const again = parseMarkdownDocument(markdown)
  assert.deepEqual(flatten(again.roots), ['quote:[!note] 提示', '  text:正文一行'], '往返后还是同一个引用块（结构等价）')
})

test('R09-EXPORT-6 front-matter：列表值 / 引号标记 / 系统时间戳都读出来（时间戳不再写而不读）', () => {
  const { frontMatter } = splitFrontMatter([
    '---',
    'tags: [产品, 草稿]',
    'aliases: [别名一, 别名二]',
    '步骤:',
    '  - 第一步',
    '  - 第二步',
    '评分: 5',
    '已完成: true',
    '状态: "进行中"',
    'created: 2026-09-28T21:40:00+08:00',
    'modified: 2026-10-06T09:31:00+08:00',
    '---',
  ].join('\n'))
  assert.deepEqual(frontMatter.tags, ['产品', '草稿'])
  assert.equal(frontMatter.created, '2026-09-28T21:40:00+08:00')
  assert.equal(frontMatter.modified, '2026-10-06T09:31:00+08:00')
  assert.deepEqual(frontMatter.properties.find((item) => item.key === 'aliases'), { key: 'aliases', raw: '[别名一, 别名二]', list: ['别名一', '别名二'], quoted: false })
  assert.deepEqual(frontMatter.properties.find((item) => item.key === '步骤'), { key: '步骤', raw: '第一步、第二步', list: ['第一步', '第二步'], quoted: false }, '块列表也能收，值不丢')
  assert.equal(frontMatter.properties.find((item) => item.key === '状态')?.quoted, true)

  // 类型推断：裸数字 / 裸 true / ISO 日期按写法认；**引号化的值一律文本**（导出侧对 text 就是引号化）
  assert.equal(inferPropertyType('5'), 'number')
  assert.equal(inferPropertyType('true'), 'checkbox')
  assert.equal(inferPropertyType('2026-10-10'), 'date')
  assert.equal(inferPropertyType('5', true), 'text')
  assert.equal(inferPropertyType('进行中'), 'text')
})

test('R09-EXPORT-2 往返：时间戳回读——导出写的 created / modified 落回页面上（排序不因此改动）', () => {
  const store = new DomainStore([])
  const created = store.insertDocumentAsPage(parseMarkdownDocument('# 老笔记\n正文').roots, '老笔记', {
    created: Date.parse('2020-01-02T03:04:05+08:00'),
    modified: Date.parse('2021-02-03T04:05:06+08:00'),
  })!
  const page = store.get(created.pageId)!
  assert.equal(page.created, Date.parse('2020-01-02T03:04:05+08:00'))
  assert.equal(page.modified, Date.parse('2021-02-03T04:05:06+08:00'))
  assert.equal(page.position, 0, '位置仍按追加算（导入旧笔记不会插到页面库中间）')
})

test('R09-EXPORT-2 往返：资产链接含空格 / 括号时加尖括号、图注转义 `]`——导出再导入都还在', () => {
  const page = { ...createTextBlock({ entityId: 'pg', blockUid: 'pg-uid', text: '图册', isObject: true, objectName: '图册' }), children: ['img', 'file'] }
  const img = mkChild('img', '封面 图（v2）', 'pg', {
    type: 'image',
    asset: { fileName: 'disk-1.png', originalName: '封面 图.png', mime: 'image/png', size: 1 },
  })
  const file = mkChild('file', '', 'pg', {
    type: 'file',
    asset: { fileName: 'disk-2.pdf', originalName: '报告 [草稿].pdf', mime: 'application/pdf', size: 2 },
  })
  const store = new DomainStore([page, img, file])
  const markdown = planMarkdownExport(store.snapshot(), emptyRegistry(), { kind: 'page', pageId: 'pg' }, {
    today: '2026-10-10',
    existingAssets: ['disk-1.png', 'disk-2.pdf'],
  })!.files[0].content
  assert.ok(markdown.includes('![封面 图（v2）](<assets/封面 图.png>)'), `含空格的资产路径要加尖括号：${markdown}`)
  // 标签里的方括号要转义（`]` 会截断链接文字）；**目标**在 `<>` 里是字面量，不转义（CommonMark 允许）。
  assert.ok(markdown.includes('[报告 \\[草稿\\].pdf](<assets/报告 [草稿].pdf>)'), `文件名里的方括号要转义：${markdown}`)

  const parsed = parseMarkdownDocument(markdown)
  assert.deepEqual(collectMediaRefs(parsed.roots), [
    { href: 'assets/封面 图.png', kind: 'image', label: '封面 图（v2）' },
    { href: 'assets/报告 [草稿].pdf', kind: 'file', label: '报告 [草稿].pdf' },
  ], '两种写法（尖括号 + 转义）都读得回来')
})

test('R09-EXPORT-2 往返：一篇「什么都有」的页面导出再导入——块类型 / 层级 / 行内格式 / 引用 / 资产全还原', () => {
  const page = {
    ...createTextBlock({ entityId: 'pg', blockUid: 'pg-uid', text: '全量页', isObject: true, objectName: '全量页' }),
    children: ['h2', 'body', 'bullet', 'todo', 'quote', 'code', 'divider', 'img'],
  }
  const h2 = mkChild('h2', '小节', 'pg', { type: 'heading2' })
  const body = mkChild('body', '带 **粗** 与 <u>下划线</u> 的一句', 'pg')
  body.content = [
    { t: 'text', v: '带 ' },
    { t: 'text', v: '粗', marks: [{ type: 'bold' }] },
    { t: 'text', v: ' 与 ' },
    { t: 'text', v: '下划线', marks: [{ type: 'underline' }] },
    { t: 'text', v: ' 的一句' },
  ]
  const bullet = mkChild('bullet', '父项', 'pg', { type: 'bullet', children: ['kid'] })
  const kid = mkChild('kid', '子项', 'bullet', { type: 'bullet' })
  const todo = mkChild('todo', '做完的', 'pg', { type: 'todo', checked: true })
  const quote = mkChild('quote', '引用一行', 'pg', { type: 'quote', children: ['qkid'] })
  const qkid = mkChild('qkid', '引用里的子项', 'quote', { type: 'bullet' })
  const code = mkChild('code', '```\n内层围栏\n```', 'pg', { type: 'code' })
  const divider = mkChild('divider', '', 'pg', { type: 'divider' })
  const img = mkChild('img', '图注', 'pg', {
    type: 'image',
    asset: { fileName: 'disk-1.png', originalName: '封面.png', mime: 'image/png', size: 1 },
  })
  const store = new DomainStore([page, h2, body, bullet, kid, todo, quote, qkid, code, divider, img])
  const markdown = planMarkdownExport(store.snapshot(), emptyRegistry(), { kind: 'page', pageId: 'pg' }, {
    today: '2026-10-10',
    existingAssets: ['disk-1.png'],
  })!.files[0].content

  const parsed = parseMarkdownDocument(markdown)
  assert.equal(parsed.name, '全量页')
  assert.deepEqual(flatten(parsed.roots), [
    'heading2:小节',
    'text:带 粗 与 下划线 的一句[bold粗|underline下划线]',
    'bullet:父项',
    '  bullet:子项',
    'todo:做完的',
    'quote:引用一行',
    '  bullet:引用里的子项',
    'code:```\n内层围栏\n```',
    'divider:',
    'image:图注',
  ])
})


// 行内标签采集（用户 2026-10-10 裁决：导入页开关"行内标签 → 页面标签"；判据照 Obsidian）
test('IMPORT-TAG-1 行内标签采集：判据照 Obsidian（行首/空白起、非纯数字、进代码不算、父子标签原样、保序去重）', () => {
  const scan = (text: string) => collectInlineTags(parseMarkdownDocument(text).roots)

  assert.deepEqual(scan('这句有个 #标签 和 #父/子 两处。'), ['标签', '父/子'], '空白后起标签、父子标签原样收')
  assert.deepEqual(scan('#行首标签 开头的行'), ['行首标签'], '行首也是合法前导')
  assert.deepEqual(scan('看 https://x.com/a#anchor 与 #真标签'), ['真标签'], 'URL 里的 `#` 不算（前导不是空白）')
  assert.deepEqual(scan('#123 不是标签， #123a 是'), ['123a'], '纯数字不认（`#123a` 前要有空白——中文标点紧贴的「，#123」在 Obsidian 里同样不认）')
  assert.deepEqual(scan('# 标题 不是标签'), [], '`#` 后有空格 ⇒ 标题记号，不是标签')
  assert.deepEqual(scan('```\n#代码里的标签\n```'), [], '围栏块不扫（代码是字面）')
  assert.deepEqual(scan('行内 `#代码标签` 不算，旁边 #真标签 算'), ['真标签'], '行内代码不扫')
  assert.deepEqual(scan('#重复 再来一次 #重复'), ['重复'], '同名只收一条（保序）')

  // 只读不写：采集不改正文（改了字就不幂等、往返也不再逐字一致）
  const drafts = parseMarkdownDocument('这句有个 #标签 在中间。').roots
  const before = JSON.stringify(drafts)
  collectInlineTags(drafts)
  assert.equal(JSON.stringify(drafts), before, '采集是纯读——草稿树一字不动')
})
