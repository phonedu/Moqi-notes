/*
 * 更新日志解析（app/CHANGELOG.md，写作规则见 docs/06 §10）。
 * 纯函数、不碰文件系统：构建期由 vite.config.ts 读文件后调用，
 * 门禁脚本 scripts/check-version.ts 复用同一份实现，界面里的更新日志
 * 因此和仓库里的 CHANGELOG.md 永远是同一份数据，不存在二次维护。
 *
 * 识别规则：
 * - `## [版本号] - 日期` 或 `## [未发布]` 开一个版本段落；括号可省略。
 * - 不认识的 `## 标题` 视为普通章节，连带其下内容一起忽略，不并入上一个版本。
 * - `### 分类` 开一个分类；分类下每个 `- 条目` 是一条；空分类不输出。
 * - 条目必须一行一条；分类出现前的条目归入无标题分类。
 */

export type ChangelogSection = {
  /** 分类名（新增 / 改进 / 修复 / 数据与兼容 / 已知限制）；空串表示没有分类标题。 */
  title: string
  items: string[]
}

export type ChangelogRelease = {
  version: string
  /** 发布日 `YYYY-MM-DD`；未发布版本为 null。 */
  date: string | null
  unreleased: boolean
  sections: ChangelogSection[]
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UNRELEASED_TITLES = new Set(['未发布', 'unreleased'])
const RELEASE_RE = /^##\s+(\S.*)$/
const SECTION_RE = /^###\s+(\S.*)$/
const ITEM_RE = /^[-*]\s+(\S.*)$/

function readReleaseHeading(text: string): { version: string; date: string | null; valid: boolean } {
  const body = text.trim()
  const bracketed = /^\[(.+?)\](?:\s*-\s*(.+))?$/.exec(body)
  const parts = bracketed ? [bracketed[1], bracketed[2] ?? ''] : body.split(/\s+-\s+/, 2)
  const version = parts[0].trim()
  const rawDate = (parts[1] ?? '').trim()
  return {
    version,
    date: DATE_RE.test(rawDate) ? rawDate : null,
    valid: VERSION_RE.test(version) || UNRELEASED_TITLES.has(version.toLowerCase()),
  }
}

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let current: ChangelogRelease | null = null
  let section: ChangelogSection | null = null
  let ignoring = false

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    const releaseMatch = RELEASE_RE.exec(line)
    if (releaseMatch) {
      const heading = readReleaseHeading(releaseMatch[1])
      ignoring = !heading.valid
      section = null
      current = heading.valid
        ? { version: heading.version, date: heading.date, unreleased: UNRELEASED_TITLES.has(heading.version.toLowerCase()), sections: [] }
        : null
      if (current) releases.push(current)
      continue
    }
    if (ignoring || !current) continue

    const sectionMatch = SECTION_RE.exec(line)
    if (sectionMatch) {
      section = { title: sectionMatch[1].trim(), items: [] }
      current.sections.push(section)
      continue
    }

    const itemMatch = ITEM_RE.exec(line)
    if (!itemMatch) continue
    if (!section) {
      section = { title: '', items: [] }
      current.sections.push(section)
    }
    section.items.push(itemMatch[1].trim())
  }

  return releases.map((release) => ({
    ...release,
    sections: release.sections.filter((entry) => entry.items.length > 0),
  }))
}

/**
 * 条目在界面按纯文本显示：CHANGELOG 是给人和编辑器读的 Markdown，
 * 行内代码标记（反引号）在应用里没有渲染器，直接去掉比原样显示更清楚。
 */
export function toPlainChangelogText(text: string): string {
  return text.replaceAll('`', '')
}

/**
 * 把一条条目切成「普通 / 粗体」片段：只认 `**粗体**`（CHANGELOG 里唯一的行内强调）。
 * 界面不引 markdown 依赖（`06` §10：CHANGELOG 是给人和编辑器读的），所以这里只做这一种标记，
 * 避免把 `**图片与附件**` 这种没渲染的星号直接显示给用户。
 */
export function splitChangelogBold(text: string): { text: string; bold: boolean }[] {
  return toPlainChangelogText(text)
    .split('**')
    .map((part, index) => ({ text: part, bold: index % 2 === 1 }))
    .filter((part) => part.text !== '')
}
