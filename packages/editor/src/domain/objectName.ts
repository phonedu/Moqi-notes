import type { BlockMap } from './block'

/**
 * 页面名的唯一化工具（docs/04 §3、docs/09 §4.3）。
 *
 * 注意：**页面名允许重复**（链接靠 targetId 指向，不靠名字）。这里保留的唯一化只用于
 * 「程序生成的名字」——复制页面时的「（副本）」后缀，避免复制出一串完全同名的页。
 * 用户敲进正文的名字一律原样保留，绝不静默改写。
 *
 * 为什么必须唯一：`[[页面链接]]` 与反链都按**名字**定位目标，重名会让链接指向不确定的对象。
 * 存储层为此建了 `UNIQUE INDEX idx_blocks_object_name ... WHERE is_object = 1 AND deleted = 0`，
 * 但那是最后一道闸：绕过去的结果不是「名字重复」而是一条用户看不懂的
 * 「保存失败：UNIQUE constraint failed: blocks.object_name」。
 *
 * 所以命名规则落在领域里，复制页这类程序生成的名字统一走 `availableCopyName`：
 * 新建页面、重命名、复制页面。用户看到的是自动加序号，而不是保存失败。
 */
const FALLBACK_BASE = '未命名页面'
const MAX_SUFFIX = 9999

/** 该名字在活动对象里是否已被占用（`excludeId` 用于重命名时排除自己）。 */
export function objectNameTaken(blocks: BlockMap, name: string, excludeId?: string): boolean {
  for (const block of blocks.values()) {
    if (!block.isObject || block.deleted) continue
    if (block.entityId === excludeId) continue
    if (block.objectName === name) return true
  }
  return false
}

/**
 * 给**程序生成**的名字找一个不撞车的（复制页面时的「（副本）」后缀用）。
 * 用户敲进正文的页面名一律原样保留——页面名允许重复，见 docs/04 §3。
 */
export function availableCopyName(blocks: BlockMap, desired: string, excludeId?: string): string {
  const base = desired.trim() || FALLBACK_BASE
  if (!objectNameTaken(blocks, base, excludeId)) return base
  for (let n = 2; n <= MAX_SUFFIX; n += 1) {
    const candidate = `${base} ${n}`
    if (!objectNameTaken(blocks, candidate, excludeId)) return candidate
  }
  // 9999 个同名前缀在单机笔记里不可能出现；这里宁可报错也不要静默产生重名。
  throw new Error(`无法为「${base}」找到唯一名称`)
}
