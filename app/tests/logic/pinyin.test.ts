import assert from 'node:assert/strict'
import test from 'node:test'
import { cachedPinyinIndex, isPinyinQuery, pinyinIndexText, pinyinMatches } from '../../src/application/pinyinSearch'

/**
 * 拼音检索的规则（`docs/03` §15.2 路线 B；行为 `SEARCH-PINYIN-1`）。
 *
 * 这张表就是 spike 里用来对比两个库的那 12 个样本——**多音字是这条能力的命门**：
 * 逐字转换会把「银行」拼成 yinxing，用户打 yinhang 就搜不到，那等于白做。
 * 所以这里逐条锁住「词库定音」的结果；换库或升级版本时，它先红。
 */
const DISAMBIGUATION: [string, string][] = [
  ['重庆', 'chongqing'],
  ['重量', 'zhongliang'],
  ['银行', 'yinhang'],
  ['音乐', 'yinyue'],
  ['快乐', 'kuaile'],
  ['行长', 'hangzhang'],
  ['重读', 'zhongdu'],
  ['双链笔记', 'shuanglianbiji'],
  ['干净的界面', 'ganjingdejiemian'],
  ['长恨歌', 'changhenge'],
  ['长城', 'changcheng'],
  ['这个人很重要', 'zhegerenhenzhongyao'],
]

test('SEARCH-PINYIN-1 多音字逐条锁定（spike 的 12 个样本；这条挂了就说明拼音库换了或退化了）', () => {
  for (const [text, expected] of DISAMBIGUATION) {
    assert.equal(pinyinIndexText(text).full, expected, `${text} 的拼音`)
  }
})

test('SEARCH-PINYIN-1 全拼与首字母两串都要给：标点空白不进串，拉丁与数字原样保留', () => {
  assert.deepEqual(pinyinIndexText('银行'), { full: 'yinhang', initials: 'yh' })
  // 括号（标点）不进串：双链笔记（第一版）→ shuanglianbijidiyiban，首字母是「每段第一个字母」slbjdyb
  assert.deepEqual(pinyinIndexText('双链笔记（第一版）'), { full: 'shuanglianbijidiyiban', initials: 'slbjdyb' })
  assert.equal(pinyinIndexText('   ').full, '')
  // 拉丁与数字原样保留（首字母里 2026 贡献 '2'）
  assert.deepEqual(pinyinIndexText('Hello 世界 2026'), { full: 'helloshijie2026', initials: 'hsj2' })
})

test('SEARCH-PINYIN-1 命中判定：全拼子串命中，首字母要两位以上；中文查询不走这里', () => {
  const bank = pinyinIndexText('银行')
  assert.equal(pinyinMatches(bank, 'yinhang'), true, '全拼')
  assert.equal(pinyinMatches(bank, 'yinhan'), true, '全拼的部分前缀也算子串命中')
  assert.equal(pinyinMatches(bank, 'yh'), true, '首字母')
  // 一位字母若正好是全拼的子串，仍然算命中（这是子串语义）；但**不许**用首字母去匹配一位字母
  assert.equal(pinyinMatches(bank, 'y'), true, 'y 是 yinhang 的子串')
  assert.equal(pinyinMatches({ full: '', initials: 'yh' }, 'y'), false, '一位字母不拿首字母匹配（太吵）')
  assert.equal(pinyinMatches(bank, 'zhongguo'), false, '不相关的不许命中')

  assert.equal(isPinyinQuery('yinhang'), true)
  assert.equal(isPinyinQuery('yh'), true)
  assert.equal(isPinyinQuery('y'), false, '一位字母当普通子串处理')
  assert.equal(isPinyinQuery('银行'), false, '中文不走拼音通路')
  assert.equal(isPinyinQuery('yin hang'), false, '带空格不是纯字母（当普通子串）')
})

test('SEARCH-PINYIN-1 内存通路带缓存：同一个块同一版本算一次，改了就重算', () => {
  const first = cachedPinyinIndex('b1', 100, '银行')
  const again = cachedPinyinIndex('b1', 100, '银行')
  assert.equal(first, again, '同样输入返回同一个对象（缓存命中）')
  const changed = cachedPinyinIndex('b1', 101, '银河')
  assert.equal(changed.full, 'yinhe', '块改过（modified 变）就重算')
  assert.notEqual(changed, first)
})
