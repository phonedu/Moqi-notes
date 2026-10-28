import { pinyin } from 'pinyin-pro'
import { textContent, type Block } from '@moqi/editor'

/**
 * 拼音检索（`docs/03` §15.2 的**路线 B**，用户 2026-10-04 裁决交付）。
 *
 * 做法：**TS 侧算、随保存写进索引**——理由在 spike 里量过（`03` §15.2 的结论表）：
 * Rust 的 `pinyin` crate 只有逐字转换（12 个样本 6 个多音字全错：银行→yinxing、音乐→yinle），
 * 而 `pinyin-pro` 有词库、同一组全对。所以拼音只在一处算（这里），两端语义天然一致：
 * - 桌面 / Android：算好的两串（全拼 + 首字母）随保存交给存储层，写进 `blocks_fts` 的两个派生列；
 * - 浏览器通道：用**同一个函数**做内存匹配（`substringHits` 的拼音分支）。
 *
 * 三条口径（写下来免得两边各猜）：
 * ① **只索引「汉字 + 拉丁」**：标点、空白不进拼音串（否则 `yinhang，` 这种断词会搜不到）；
 * ② **全拼不带声调、不加分隔**：这样用户打 `yinhang` / `shuanglian` 能直接「子串命中」——
 *    代价是「西安」与「先」在拼音层不可区分（`xian`），这是全拼方案的固有取舍，可接受
 *    （中文原文检索仍然精确；拼音只是**多一条**通路，不替代它）；
 * ③ **首字母单独一串**：`yh` 命中「银行」。**至少两位**才用首字母（一位字母太吵，`s` 会命中半本书）。
 */
export type PinyinIndex = { full: string; initials: string }

/**
 * 把一个块的可索引文本转成两串拼音。
 *
 * `pinyin-pro` 的 `type: 'array'` 返回「逐字（或逐段非汉字）的拼音」：汉字给音节（多音字靠它的词库定音），
 * 非汉字原样给回。所以全拼 = 各段拼起来（再去掉标点空白），首字母 = 每段第一个字母。
 */
export function pinyinIndexText(text: string): PinyinIndex {
  const source = text.trim()
  if (source.length === 0) return { full: '', initials: '' }
  const parts = pinyin(source, { toneType: 'none', type: 'array', nonZh: 'consecutive' })
  let full = ''
  let initials = ''
  for (const part of parts) {
    const clean = String(part).toLowerCase().replace(/[^a-z0-9]/g, '')
    if (clean.length === 0) continue
    full += clean
    initials += clean[0]
  }
  return { full, initials }
}

/**
 * 一个块要索引的拼音源文本：**页面名（或正文）+ 正文**。
 *
 * 两端都用这一条（外壳把它算好交给存储层、浏览器通道拿它做内存匹配）——拼音索引的内容范围
 * 因此只有一处定义。**标签名不在这里**：块上只有标签 id，名字在注册表里，而拼音的主场景是
 * 「想不起字怎么写、按读音找页面与正文」；标签仍可按中文命中（标签分组那条路）。
 */
export function pinyinSourceText(block: Block): string {
  const name = block.objectName ?? ''
  const body = textContent(block)
  return name === body ? name : `${name} ${body}`.trim()
}

/** 这串查询是不是「拼音式」的：纯 ASCII 字母，且长度 ≥ 2（一位字母交给原文匹配就够了）。 */
export function isPinyinQuery(query: string): boolean {
  const text = query.trim()
  return text.length >= 2 && /^[a-z]+$/i.test(text)
}

/**
 * 拼音命中判定：全拼子串命中，或（≥2 位时）首字母子串命中。
 * 只在 `isPinyinQuery` 为真时调用——中文查询不走这条路。
 */
export function pinyinMatches(index: PinyinIndex, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return false
  if (index.full.includes(needle)) return true
  return needle.length >= 2 && index.initials.includes(needle)
}

/** 供内存通路用的带缓存的索引（浏览器通道与单测）：按「块 id + 修改时间」缓存，文本一变就重算。 */
const cache = new Map<string, PinyinIndex>()

export function cachedPinyinIndex(entityId: string, modified: number, text: string): PinyinIndex {
  const key = `${entityId}:${modified}`
  const hit = cache.get(key)
  if (hit) return hit
  const index = pinyinIndexText(text)
  // 简单起见只留最近 4000 条（够一屏检索 + 常见页面规模；超了自然按最近使用淘汰）。
  if (cache.size > 4000) cache.clear()
  cache.set(key, index)
  return index
}
