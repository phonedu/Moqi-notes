import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseChangelog, splitChangelogBold, toPlainChangelogText } from '../../src/changelog'

// A 类：更新日志解析是纯函数，先锁格式契约；文件位置和版本一致性由 pnpm verify-version 把关。

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '../..')

test('解析真实 CHANGELOG.md：每个版本都有发布日和分类条目', () => {
  const releases = parseChangelog(readFileSync(resolve(APP_ROOT, 'CHANGELOG.md'), 'utf8'))
  assert.ok(releases.length >= 2, '至少要有 0.1.0 和当前版本两个段落')
  for (const release of releases) {
    assert.match(release.version, /^\d+\.\d+\.\d+/)
    assert.equal(release.unreleased, false)
    assert.match(release.date ?? '', /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(release.sections.length > 0, `${release.version} 没有任何分类条目`)
  }
})

test('当前版本在 CHANGELOG 里有对应段落', () => {
  const pkg = JSON.parse(readFileSync(resolve(APP_ROOT, 'package.json'), 'utf8')) as { version: string }
  const releases = parseChangelog(readFileSync(resolve(APP_ROOT, 'CHANGELOG.md'), 'utf8'))
  assert.ok(
    releases.some((release) => release.version === pkg.version),
    `CHANGELOG.md 缺少 ${pkg.version} 段落`,
  )
})

test('版本段落支持方括号、无方括号和未发布三种写法', () => {
  const releases = parseChangelog([
    '# 更新日志',
    '',
    '## [未发布]',
    '',
    '### 新增',
    '',
    '- 正在做的功能',
    '',
    '## [0.3.0] - 2026-10-01',
    '',
    '### 修复',
    '',
    '- 修了一处',
    '',
    '## 0.2.0 - 2026-09-27',
    '',
    '### 新增',
    '',
    '- 一条功能',
  ].join('\n'))

  assert.deepEqual(releases, [
    { version: '未发布', date: null, unreleased: true, sections: [{ title: '新增', items: ['正在做的功能'] }] },
    { version: '0.3.0', date: '2026-10-01', unreleased: false, sections: [{ title: '修复', items: ['修了一处'] }] },
    { version: '0.2.0', date: '2026-09-27', unreleased: false, sections: [{ title: '新增', items: ['一条功能'] }] },
  ])
})

test('空分类被丢弃，没有分类标题的条目单独成组', () => {
  const releases = parseChangelog([
    '## [0.2.0] - 2026-09-27',
    '',
    '- 先出现但还没分类的条目',
    '',
    '### 修复',
    '',
    '### 新增',
    '',
    '* 星号也是合法条目',
  ].join('\n'))

  assert.deepEqual(releases, [
    {
      version: '0.2.0',
      date: '2026-09-27',
      unreleased: false,
      sections: [
        { title: '', items: ['先出现但还没分类的条目'] },
        { title: '新增', items: ['星号也是合法条目'] },
      ],
    },
  ])
})

test('无法识别的一级标题及其内容被忽略，不并入上一个版本', () => {
  const releases = parseChangelog([
    '## [0.2.0] - 2026-09-27',
    '',
    '### 新增',
    '',
    '- 属于 0.2.0 的条目',
    '',
    '## 写作说明',
    '',
    '- 这条不该出现在任何版本里',
  ].join('\n'))

  assert.deepEqual(releases, [
    { version: '0.2.0', date: '2026-09-27', unreleased: false, sections: [{ title: '新增', items: ['属于 0.2.0 的条目'] }] },
  ])
})

test('日期格式不合法时记为未标注日期，版本仍然保留', () => {
  const releases = parseChangelog(['## [0.2.0] - 2026/09/27', '', '### 新增', '', '- 一条'].join('\n'))
  assert.equal(releases.length, 1)
  assert.equal(releases[0].version, '0.2.0')
  assert.equal(releases[0].date, null)
})

test('界面按纯文本显示条目：去掉 Markdown 行内代码标记', () => {
  assert.equal(toPlainChangelogText('正文里手写的 `#标签` 只做筛选'), '正文里手写的 #标签 只做筛选')
  assert.equal(toPlainChangelogText('没有标记的条目'), '没有标记的条目')
})

test('条目里的 `**粗体**` 切成片段由界面渲染成真粗体（不再把星号显示给用户）', () => {
  assert.deepEqual(splitChangelogBold('**图片与附件**：菜单 / 粘贴截图'), [
    { text: '图片与附件', bold: true },
    { text: '：菜单 / 粘贴截图', bold: false },
  ])
  assert.deepEqual(splitChangelogBold('没有粗体的条目'), [{ text: '没有粗体的条目', bold: false }])
  assert.deepEqual(splitChangelogBold('含 `#标签` 与 **粗体** 的条目'), [
    { text: '含 #标签 与 ', bold: false },
    { text: '粗体', bold: true },
    { text: ' 的条目', bold: false },
  ])
})
