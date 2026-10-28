import assert from 'node:assert/strict'
import test from 'node:test'
import { readImeInset } from '@moqi/editor'

/**
 * 键盘高度读数的**输入侧**（`readImeInset`，`#8` / `10` 二册 §6.3）。
 *
 * 为什么有它：`accept:MOBILE-KB-1` 覆盖的是**消费侧**（注入 `--kb-h` 之后各锚定面怎么动）；
 * 「`visualViewport` → 键盘高」这条输入链此前没有单测（`R04-ACCEPT-7` 的补层——断言要贴到
 * 主张最会破的那一层：换算式被改错时，消费侧照样全绿）。
 */
test('readImeInset 纯读数：内高 − 视口高 − 顶部偏移（负值取 0、四舍五入）', () => {
  assert.equal(readImeInset({ height: 800, offsetTop: 0 }, 1200), 400, '常规：键盘占 400')
  assert.equal(readImeInset({ height: 700, offsetTop: 100 }, 1200), 400, '顶部偏移要进算式')
  assert.equal(readImeInset({ height: 1200, offsetTop: 0 }, 1200), 0, '视口不比内高矮（桌面档）⇒ 0')
  assert.equal(readImeInset(null, 1200), 0, '没有 visualViewport（桌面 / SSR / 测试环境）⇒ 0')
  assert.equal(readImeInset({ height: 800, offsetTop: 0 }, 0), 0, '没有内高 ⇒ 0')
  assert.equal(readImeInset({ height: 799.4, offsetTop: 0 }, 1200), 401, '四舍五入（进位）')
  assert.equal(readImeInset({ height: 799.6, offsetTop: 0 }, 1200), 400, '四舍五入（舍去）')
})
