import assert from 'node:assert/strict'
import test from 'node:test'
import { menuPlacement } from '../../src/ui/blockAnchor'

/**
 * 块锚菜单落位（blockAnchor.ts `menuPlacement`，斜杠 / 双链菜单共用）：此前只有
 * `max-height: 60dvh` 不夹视口，块贴近窗口底时盒子下半截被窗口截掉，盒内滚动够不着尾部
 * （「行内」组看不见，用户实测）。这里钉住三条：默认就地展开且盒高夹进下方空间、
 * 贴底且上方更宽就上翻到块顶上、两侧都没空间时下限兜底（盒内滚动仍到得了尾）。
 */

test('默认就地展开：top = 块下沿落点，盒高夹进视口下方（EDGE = 12）', () => {
  const p = menuPlacement({ top: 200, blockTop: 176 }, 800)
  assert.equal(p.top, 200)
  assert.equal(p.bottom, null)
  assert.equal(p.maxHeight, 800 - 200 - 12)
})

test('块贴底：下方放不下（<220）且上方更宽 → 上翻，bottom 锚在块顶上方 4', () => {
  const p = menuPlacement({ top: 680, blockTop: 676 }, 800)
  assert.equal(p.top, null)
  assert.equal(p.bottom, 800 - 676 + 4)
  assert.equal(p.maxHeight, 676 - 4 - 12)
})

test('上方不比下方宽就不翻：就地夹紧，下限兜底', () => {
  // below = 120-60-12 = 48；above = 56-4-12 = 40 < 48 → 不翻
  const p = menuPlacement({ top: 60, blockTop: 56 }, 120)
  assert.equal(p.top, 60)
  assert.equal(p.bottom, null)
  assert.equal(p.maxHeight, 96)
})

test('两侧都没空间（整屏大块里的 /）：下限兜底，盒内滚动仍够得着尾部', () => {
  // below = 100-90-12 < 0；above = 10-16 < 0 → 不翻
  const p = menuPlacement({ top: 90, blockTop: 10 }, 100)
  assert.equal(p.top, 90)
  assert.equal(p.maxHeight, 96)
})
