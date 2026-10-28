import assert from 'node:assert/strict'
import test from 'node:test'
import { entryBaseName, isBackupMarkerName, planPackage, resolvePackageImage } from '@moqi/editor'

// ---------------------------------------------------------------------------
// 导入包条目分拣（第 13 项「拖入 zip」）：判据只此一份——浏览器（fflate）与桌面（Rust 解包）两条路共用。
// 三条硬口径：备份包嗅探（数据风险点，场景 G）· 支持类型白名单 · macOS 杂物静默。
// ---------------------------------------------------------------------------

test('planPackage：文档 / 图片 / 备份包 / 杂物的分拣与排序', () => {
  const plan = planPackage([
    '包内页二.md',
    'assets/图.png',
    'sub/包内页一.markdown',
    'notes.html',
    '备/深层/project-b.sqlite3',
    '__MACOSX/._junk',
    '._hidden.md',
    'dir/',
    'photo.JPG',
    'readme.txt',
  ])
  assert.equal(plan.isBackup, true)
  assert.deepEqual(plan.documents, ['readme.txt', 'sub/包内页一.markdown', '包内页二.md'])
  assert.deepEqual(plan.images, ['assets/图.png', 'photo.JPG'])
  assert.equal(plan.skipped, 1) // notes.html；macOS 杂物与目录项都不计入
})

test('planPackage：普通 Markdown 包（无库文件）不算备份包', () => {
  const plan = planPackage(['a.md', 'assets/x.png'])
  assert.equal(plan.isBackup, false)
  assert.deepEqual(plan.documents, ['a.md'])
})

test('isBackupMarkerName：只看基名（任意层出现都算）', () => {
  assert.equal(isBackupMarkerName('project-b.sqlite3'), true)
  assert.equal(isBackupMarkerName('backup/deep/project-b.sqlite3'), true)
  assert.equal(isBackupMarkerName('project-b.sqlite3-wal'), false)
  assert.equal(entryBaseName('a/b/c.md'), 'c.md')
})

test('resolvePackageImage：原样 → 后缀 → 基名兜底；越界路径拒绝', () => {
  const images = ['assets/图 一.png', 'sub/img/图二.png', 'photo.jpg']
  assert.equal(resolvePackageImage('assets/图 一.png', images), 'assets/图 一.png')
  assert.equal(resolvePackageImage('图二.png', images), 'sub/img/图二.png')
  assert.equal(resolvePackageImage('./photo.jpg', images), 'photo.jpg')
  assert.equal(resolvePackageImage('../secret.png', images), null)
  assert.equal(resolvePackageImage('/abs.png', images), null)
  assert.equal(resolvePackageImage('缺图.png', images), null)
})
