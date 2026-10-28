import assert from 'node:assert/strict'
import test from 'node:test'
import { decideBlockMarkerTrigger, decideCodeEnter, decideEmptyEnter, decideInlinePairTrigger, decideLeaveListOnBackspace, decideListEnter, decideTab } from '@moqi/editor'
// 名字行那两个判据（`decideNameRowCross` / `decideNameRowEdge`）2026-10-05 随名字行收口（T5）
// 迁去 `nameLine.test.ts`——判据一字未改，只是跟着模块换了家。
//
// 本文件测的是**输入规则层**（T8）：Enter / Tab / Backspace 的判据（IME 组合态让路是通则）。

test('BLOCK-TAB-8 光标在块里：Tab / ⇧Tab 一律由编辑器消费（含 no-op 情形）', () => {
  // 消费 = 调用方 preventDefault 后走缩进 / 反缩进；no-op 由领域层判，但按键必须先被吃掉。
  assert.deepEqual(decideTab({ blockId: 'b1', shiftKey: false, composing: false }), { kind: 'indent', blockId: 'b1' })
  assert.deepEqual(decideTab({ blockId: 'b1', shiftKey: true, composing: false }), { kind: 'outdent', blockId: 'b1' })
})

test('光标不在块里 / 输入法组合态：让给浏览器移动焦点', () => {
  assert.deepEqual(decideTab({ blockId: null, shiftKey: false, composing: false }), { kind: 'browser' })
  assert.deepEqual(decideTab({ blockId: null, shiftKey: true, composing: false }), { kind: 'browser' })
  // 代码块内：Tab / ⇧Tab 走**文本级**缩进（插两空格 / 删行首两格）——块不动（G-3 对账裁）。
  assert.deepEqual(decideTab({ blockId: 'b1', shiftKey: false, composing: false, inCode: true }), { kind: 'code-text', shiftKey: false, blockId: 'b1' })
  assert.deepEqual(decideTab({ blockId: 'b1', shiftKey: true, composing: false, inCode: true }), { kind: 'code-text', shiftKey: true, blockId: 'b1' })
  // 中文输入法组合态里 Tab 可能用于选候选，不能抢。
  assert.deepEqual(decideTab({ blockId: 'b1', shiftKey: false, composing: true }), { kind: 'browser' })
  assert.deepEqual(decideTab({ blockId: 'b1', shiftKey: true, composing: true }), { kind: 'browser' })
})

test('R04-ENTER-4 列表里的回车：继续 / 逐级外移 / 退出列表是一条链', () => {
  assert.equal(decideListEnter({ isList: true, hasText: true, indented: false }), 'continue', '项内有字：接着建同类型的列表项')
  assert.equal(decideListEnter({ isList: true, hasText: true, indented: true }), 'continue', '缩进的项也一样：先续项')
  assert.equal(decideListEnter({ isList: true, hasText: false, indented: true }), 'outdent', '空项 + 有缩进：沿用 R04-ENTER-3，先上移一级')
  assert.equal(decideListEnter({ isList: true, hasText: false, indented: false }), 'exit', '空项 + 已在最外层：退出列表（变普通文本块）')
  assert.equal(decideListEnter({ isList: false, hasText: false, indented: false }), 'plain', '不是列表：不动既有行为')
})

test('R04-ENTER-3 空块按 Enter 退出缩进：只在缩进块上，且块里没字', () => {
  assert.equal(decideEmptyEnter({ indented: true, hasText: false }), 'outdent', '缩进的空块：升一级')
  assert.equal(decideEmptyEnter({ indented: false, hasText: false }), 'plain', '一级空块：只换行（不产生新块也外移不了）')
  assert.equal(decideEmptyEnter({ indented: true, hasText: true }), 'plain', '块里有字：换行，别外移')
})

test('R04-ENTER-6 代码块里的回车：Enter = 换行；空块 / 尾空行上再按 = 退出代码块', () => {
  assert.equal(decideCodeEnter({ isEmptyBlock: false, atEmptyLine: false }), 'newline', '正文里：插换行（LineBreakNode ⇄ 领域 \n）')
  assert.equal(decideCodeEnter({ isEmptyBlock: true, atEmptyLine: false }), 'exit', '空代码块：直接转 text 块，不留空代码块')
  assert.equal(decideCodeEnter({ isEmptyBlock: false, atEmptyLine: true }), 'exit', '光标在行尾空行上：收掉尾随换行、其后新建 text 块')
})

test('R04-ENTER-4 列表项行首 Backspace：本项退出列表（空项与块中不让路）', () => {
  assert.equal(decideLeaveListOnBackspace({ isList: true, hasText: true, atStart: true }), true)
  assert.equal(decideLeaveListOnBackspace({ isList: true, hasText: false, atStart: true }), false, '空项：让给「空块合并」通路')
  assert.equal(decideLeaveListOnBackspace({ isList: true, hasText: true, atStart: false }), false, '块中间：那是行内删除')
  assert.equal(decideLeaveListOnBackspace({ isList: false, hasText: true, atStart: true }), false, '不是列表：不动既有行为')
})

// MD 输入层 · 打字触发（`09-桌面端交互规范` §6.12 `R09-MD-2`/`R09-MD-4`，2026-10-06）
test('R09-MD-3 打字触发判据：整行就是记号才转（记号自带尾随空格，别 trim 掉）；句中与表外不动', () => {
  // 正例：整行就是触发词（含那个空格）
  assert.equal(decideBlockMarkerTrigger('- ')?.type, 'bullet')
  assert.equal(decideBlockMarkerTrigger('* ')?.type, 'bullet')
  assert.equal(decideBlockMarkerTrigger('# ')?.type, 'heading1')
  assert.equal(decideBlockMarkerTrigger('### ')?.type, 'heading3')
  assert.equal(decideBlockMarkerTrigger('#### ')?.type, 'heading4')
  assert.equal(decideBlockMarkerTrigger('##### ')?.type, 'heading5')
  assert.equal(decideBlockMarkerTrigger('###### ')?.type, 'heading6')
  assert.equal(decideBlockMarkerTrigger('> ')?.type, 'quote')
  assert.equal(decideBlockMarkerTrigger('1. ')?.type, 'numbered')
  assert.equal(decideBlockMarkerTrigger('[ ] ')?.type, 'todo')
  assert.deepEqual(decideBlockMarkerTrigger('[x] '), { type: 'todo', checked: true, length: 4, handled: undefined })
  assert.equal(decideBlockMarkerTrigger('---')?.type, 'divider')
  assert.equal(decideBlockMarkerTrigger('```')?.handled, 'fence')
  // 反例：记号后面还有字 / 句中 / 表外
  assert.equal(decideBlockMarkerTrigger('- 记着买牛奶'), null, '整行是「记号 + 正文」不触发（那是粘贴的路）')
  assert.equal(decideBlockMarkerTrigger('算一下 5 - 3'), null)
  assert.equal(decideBlockMarkerTrigger('2026-10-04'), null)
  assert.equal(decideBlockMarkerTrigger('#标签'), null)
  assert.equal(decideBlockMarkerTrigger('-'), null, '光一个减号不是记号')
  assert.equal(decideBlockMarkerTrigger(''), null)
})

test('R09-MD-3 行内触发判据：成对闭合且收尾才转；位置与长度给全（触发层据此抹记号）', () => {
  assert.deepEqual(decideInlinePairTrigger('**粗**'), { mark: 'bold', inner: '粗', index: 0, length: 5 })
  assert.deepEqual(decideInlinePairTrigger('前面 *斜*'), { mark: 'italic', inner: '斜', index: 3, length: 3 })
  assert.deepEqual(decideInlinePairTrigger('~~删~~'), { mark: 'strike', inner: '删', index: 0, length: 5 })
  assert.deepEqual(decideInlinePairTrigger('==亮=='), { mark: 'highlight', inner: '亮', index: 0, length: 5 })
  assert.deepEqual(decideInlinePairTrigger('`码`'), { mark: 'code', inner: '码', index: 0, length: 3 })
  // 没闭合 / 不在收尾 / 空内容：不转
  assert.equal(decideInlinePairTrigger('**粗'), null)
  assert.equal(decideInlinePairTrigger('**粗** 后面还有字'), null)
  assert.equal(decideInlinePairTrigger('****'), null)
  assert.equal(decideInlinePairTrigger('普通文本'), null)
})

test('R09-MD-3 连跑校验：`**粗*` 不算闭合（别让第 4 个键被单字符的斜体吃掉）', () => {
  assert.equal(decideInlinePairTrigger('**粗*'), null, '开头是两个 * 的连跑，不是斜体')
  assert.equal(decideInlinePairTrigger('*粗**'), null)
  assert.deepEqual(decideInlinePairTrigger('**粗**'), { mark: 'bold', inner: '粗', index: 0, length: 5 })
  assert.deepEqual(decideInlinePairTrigger('前 *粗*'), { mark: 'italic', inner: '粗', index: 2, length: 3 })
})

test('R09-MD-3 块级判据容忍编辑器侧的零宽锚点（`- \u200b` 也要能触发）', () => {
  assert.equal(decideBlockMarkerTrigger('- \u200b')?.type, 'bullet', '块里常挂零宽锚点，长度比对要先去掉它')
  assert.equal(decideBlockMarkerTrigger('\u200b# ')?.type, 'heading1')
  assert.equal(decideBlockMarkerTrigger('- \u200b记着买牛奶'), null, '去掉零宽后仍是「记号 + 正文」⇒ 不触发')
})

// MD 输入层 · 全角 / 中文标点归一（用户 2026-10-10 裁决：第 22 项只做"归一"这一半；`09` §6.12 `R09-MD-4.3`）
test('FMT-MD-10 打字触发：中文标点 / 全角态的记号字符归一后照样触发（落库仍是半角）', () => {
  // 中文标点态：`>` `1.` `[ ]` 被输入法换成 `》`／`。`／`【】`
  assert.equal(decideBlockMarkerTrigger('》 ')?.type, 'quote')
  assert.equal(decideBlockMarkerTrigger('《 ')?.type, 'quote', '`《` `》` 都映到 `>`——各输入法配对不同')
  assert.equal(decideBlockMarkerTrigger('１. ')?.type, 'numbered')
  assert.equal(decideBlockMarkerTrigger('【 】 ')?.type, 'todo', '待办：`[ ] ` 的全角形态')
  assert.equal(decideBlockMarkerTrigger('【x】 ')?.checked, true, '已勾：`[x] ` 的全角形态')
  assert.equal(decideBlockMarkerTrigger('－【 】 '), null, '两步走：先「－ 」转列表、再「【 】 」转待办，不会一步凑成 ')
  assert.equal(decideBlockMarkerTrigger('－ ')?.type, 'bullet')
  assert.equal(decideBlockMarkerTrigger('＃ ')?.type, 'heading1')
  assert.equal(decideBlockMarkerTrigger('＊ ')?.type, 'bullet')
  assert.equal(decideBlockMarkerTrigger('｀｀｀ ')?.type, 'code')

  // 归一**只在判据里**：正文不受影响（判据要求「整行就是记号」，句子一律不动）
  assert.equal(decideBlockMarkerTrigger('《红楼梦》 '), null)
  assert.equal(decideBlockMarkerTrigger('今天 12。 '), null)
  assert.equal(decideBlockMarkerTrigger('引号里的一句话。 '), null)
  assert.equal(decideBlockMarkerTrigger('＃标签 不是标题 '), null, '带正文的全角记号也不动')
})
