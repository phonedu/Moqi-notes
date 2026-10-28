/**
 * **front-matter 的唯一所有者**（YAML 子集的读半边；导出侧写在 `exportMd.ts` 的 `frontMatterLines`）。
 *
 * 为什么单独一件（2026-10-10，随「Obsidian 互通」批拆册）：`mdSyntax.ts` 里同时住着行引擎、
 * 文档解析与 front-matter，三者各自是独立的知识；拆开两边都短、也各自能单测。
 *
 * 读法（只认导出侧写得出的那几种形态 + 手写文档的常见变体，不做通用 YAML）：
 * - `tags: [a, b]` / `tags:` + `- a` 两种写法都认；
 * - 一般键的**列表值**（`key: [a, b]` / `key:` + `- a`）识别成 `list`，`raw` 保留原文
 *   ——我们的数据模型没有多值属性（多值目前只有标签），调用方按文本导入并**报数**；
 * - `title` 作页名兜底；`created` / `modified` 单独摘出来（导出写的系统字段，导入要**读回**）；
 * - 其余 `key: 值` 一律进 `properties`（保留键的过滤在调用方，域层的保留键清单是唯一所有者）。
 */

export type FrontMatterProperty = {
  key: string
  /** 去引号后的值原文（列表值也保留原文写法，供文本兜底与报数）。 */
  raw: string
  /** 值是 YAML 序列时有值（`[a, b]` 或块列表）；我们的属性模型没有多值，调用方按文本导入。 */
  list?: string[]
  /**
   * 值在文件里是**引号化**的（`"5"` / `"true"`）：导出侧对 `text` 类型一律引号化，
   * 也就是说「有引号 = 文本」——导入侧的类型推断要读这一位，否则 `"5"` 会被猜成数字（类型漂移）。
   */
  quoted: boolean
}

export type FrontMatter = {
  tags: string[]
  properties: FrontMatterProperty[]
  title: string | null
  /** 导出写的 ISO 本地时区时间戳；导入据此还原页面的 `created` / `modified`（没有则 null）。 */
  created: string | null
  modified: string | null
}

export function emptyFrontMatter(): FrontMatter {
  return { tags: [], properties: [], title: null, created: null, modified: null }
}

export function isFrontMatterDelimiter(line: string | undefined): boolean {
  return line !== undefined && line.trim() === '---'
}

/** 去掉 YAML 里的包裹引号（`"a,b"` / `'a'` / 裸词）。 */
export function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/** 去引号 + **记下有没有引号**（`"5"` 是文本、`5` 是数字——导入侧的类型推断读这一位）。 */
function parseScalar(value: string): { raw: string; quoted: boolean } {
  const quoted = value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  return { raw: unquote(value), quoted }
}

/** flow 序列 `[a, b]` → 逐项去引号；不是 flow 序列返回 null。 */
function flowSequence(raw: string): string[] | null {
  if (!raw.startsWith('[') || !raw.endsWith(']')) return null
  return raw.slice(1, -1).split(',').map((item) => unquote(item.trim())).filter((item) => item.length > 0)
}

/**
 * front-matter 切分：第一行不是 `---` 就原样返回（`body` 是全部行）。
 * 缩进（tab / 4 空格）对 front-matter 无意义——只按行读。
 */
export function splitFrontMatter(text: string): { frontMatter: FrontMatter; body: string[] } {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (!isFrontMatterDelimiter(lines[0])) return { frontMatter: emptyFrontMatter(), body: lines }
  const end = lines.findIndex((line, index) => index > 0 && isFrontMatterDelimiter(line))
  if (end < 0) return { frontMatter: emptyFrontMatter(), body: lines }

  const frontMatter = emptyFrontMatter()
  /** 正在收块列表的键（`key:` 之后的 `- item` 行归它）；null = 当前没有。 */
  let listKey: string | null = null
  let listProperty: FrontMatterProperty | null = null

  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('- ') || trimmed === '-') {
      const item = unquote(trimmed.replace(/^-\s*/, ''))
      if (item.length === 0) continue
      if (listKey === 'tags') { if (!frontMatter.tags.includes(item)) frontMatter.tags.push(item) }
      else if (listProperty) { (listProperty.list ??= []).push(item) }
      continue
    }
    const at = trimmed.indexOf(':')
    if (at <= 0) continue
    const key = unquote(trimmed.slice(0, at).trim())
    const raw = trimmed.slice(at + 1).trim()
    listKey = raw.length === 0 ? key : null
    listProperty = null

    if (key === 'created' || key === 'modified') {
      const value = unquote(raw)
      if (key === 'created') frontMatter.created = value || null
      else frontMatter.modified = value || null
      listKey = null
      continue
    }
    if (key === 'title') { frontMatter.title = unquote(raw); listKey = null; continue }

    const items = raw.length > 0 ? flowSequence(raw) : null
    if (key === 'tags') {
      // `tags: [a, b]` 与 `tags:` + 列表两种写法都认（导出写第一种，手写文档常见第二种）。
      for (const item of items ?? []) if (!frontMatter.tags.includes(item)) frontMatter.tags.push(item)
      continue
    }
    const property: FrontMatterProperty = items
      ? { key, raw: unquote(raw), list: items, quoted: false }
      : { key, ...parseScalar(raw) }
    // 空值的键（`key:`）先落下，后面可能跟块列表；`raw` 为空且最终没有列表项时它仍是「有键无值」。
    frontMatter.properties.push(property)
    if (raw.length === 0) listProperty = property
  }
  return {
    frontMatter: {
      ...frontMatter,
      // 「有键无值、也没等到列表项」的条目按空值丢弃（与旧口径一致：空值不进属性）；
      // 只有块列表、没有 flow 写法的（`key:` + `- a`）用顿号顿开补一个文本，值不丢。
      properties: frontMatter.properties
        .filter((property) => property.raw.length > 0 || (property.list?.length ?? 0) > 0)
        .map((property) => (property.raw.length === 0 && property.list ? { ...property, raw: property.list.join('、') } : property)),
    },
    body: lines.slice(end + 1),
  }
}
