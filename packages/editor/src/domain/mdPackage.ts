/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * **导入包的条目分拣**（`13-数据区重规划` §2 场景 E / 第 13 项）：拖入 `.zip` 时，
 * 「哪些条目是可读的 Markdown、哪些要如实报数、这个包是不是**备份包**」的判据只此一份——
 * 浏览器通道（`fflate` 解包）与桌面通道（Rust 解包）共用，避免两条路各写一套。
 *
 * 两条硬口径（`13-数据区重规划` §2 场景 G「两种 zip 分不清」是**数据风险点**）：
 * - 包里有 `project-b.sqlite3`（备份包的标志）⇒ **不按页面导入**：这是整库备份，
 *   该走「设置 › 备份与恢复」的恢复，拖进正文导入等于静默把一批页面和备份混为一谈；
 * - 只认 `.md` / `.markdown` / `.txt`（`.txt` 当纯文本走同一解析器）；其余条目**报数不导入**。
 */

export type PackageEntryKind = 'document' | 'image' | 'other'

export type PackagePlan = {
  /** 是不是整库备份包（包根或任意层出现 `project-b.sqlite3`）。 */
  isBackup: boolean
  /** 可导入的文档条目（`.md` / `.markdown` / `.txt`，路径序）。 */
  documents: string[]
  /** 图片条目（`assets/` 里那种）：文档里的相对引用按名从包里取字节。 */
  images: string[]
  /** 其余条目不导入：macOS 元数据（`__MACOSX/`、`.` 开头）静默，别的计入 skipped。 */
  skipped: number
}

/** 路径的最后一段（两种分隔符都认；条目名按 zip 规范用 `/`）。 */
export function entryBaseName(name: string): string {
  return name.split('/').pop() ?? name
}

/** 整库备份包的标志：条目基名 = `project-b.sqlite3`。 */
export function isBackupMarkerName(name: string): boolean {
  return entryBaseName(name) === 'project-b.sqlite3'
}

export function planPackage(entries: string[]): PackagePlan {
  const plan: PackagePlan = { isBackup: false, documents: [], images: [], skipped: 0 }
  for (const raw of entries) {
    const name = raw.replace(/\\/g, '/')
    if (name.endsWith('/') || name.length === 0) continue // 目录项
    if (isBackupMarkerName(name)) { plan.isBackup = true; continue }
    // macOS 打包杂物（`__MACOSX/…` 与 `._x`）静默丢，不计入报数。
    if (name.startsWith('__MACOSX/') || entryBaseName(name).startsWith('._')) continue
    if (/\.(md|markdown|txt)$/i.test(name)) { plan.documents.push(name); continue }
    if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name)) { plan.images.push(name); continue }
    plan.skipped += 1
  }
  plan.documents.sort()
  plan.images.sort()
  return plan
}

/** 文档里的相对引用（`assets/图.png` / `图.png`）在包内找条目：先原样、再按基名对 `assets/`。 */
export function resolvePackageImage(href: string, images: string[]): string | null {
  const wanted = href.replace(/^\.\//, '').replace(/\\/g, '/')
  if (wanted.startsWith('/') || wanted.includes('..')) return null
  const exact = images.find((name) => name === wanted || name.endsWith('/' + wanted))
  if (exact) return exact
  const base = entryBaseName(wanted)
  return images.find((name) => entryBaseName(name) === base) ?? null
}
