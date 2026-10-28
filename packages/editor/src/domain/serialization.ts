import type { AiMeta, AiStatus, Block, BlockMap, PropertyValue } from './block'
import { isStructuralCode, validateBlockShape, validateBlockGraph } from './validation'

/** Fills defaults for fields added after a Block was first persisted. */
export function normalizeBlock(block: Block): Block {
  if (typeof block.checked !== 'boolean') block.checked = false
  if (typeof block.position !== 'number' || !Number.isFinite(block.position)) block.position = 0
  if (typeof block.pinned !== 'boolean') block.pinned = false
  if (typeof block.starred !== 'boolean') block.starred = false
  if (!Array.isArray(block.tags)) block.tags = []
  // 属性面板的本页两档（`13-属性区重规划` §0-1/§0-3/§0-10，2026-10-10）：旧库缺字段 = 空 = 现有行为。
  if (!Array.isArray(block.propertyShown)) block.propertyShown = []
  if (!Array.isArray(block.propertyHidden)) block.propertyHidden = []
  if (!Array.isArray(block.properties)) block.properties = []
  else block.properties = block.properties.map(normalizePropertyValue).filter((value): value is PropertyValue => value !== null)
  if (block.aiMeta === undefined) block.aiMeta = null
  else if (block.aiMeta !== null) block.aiMeta = normalizeAiMeta(block.aiMeta)
  return block
}

/**
 * 载入时修补 aiMeta 的**必填字段**，其余字段原样保留。
 *
 * 这里过去是「白名单重建」：按固定字段重新拼一个对象 ⇒ **新加的字段（后来是 `sourceScope`）
 * 在载入时被静默丢掉**（用户实测 2026-09-29：AI 块的来源文案回到旧口径「来源 N 块」；
 * 顺带发现 `ask` 动作与 `generating` 状态的整条记录也会被判非法、直接丢成 null）。
 * 规则改成：**先展开原对象、再修必填字段**——白名单只用来**判非法**（返回 null），
 * 不再用来决定「保留什么」。加字段时不必回来改这里（`docs/06` §4.2 对照表）。
 */
function normalizeAiMeta(raw: unknown): AiMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const meta = raw as Record<string, unknown>
  // 与 `validation.ts` 的合法动作集合、`AI_ACTION_LABEL` 的键**三处同步**（V2c 起是 7 项）。
  // 漏掉一处的症状不是报错，而是整条 aiMeta 被判非法、静默丢成 null（`R09-AIB-11` 的教训）。
  const actions: AiMeta['action'][] = ['summary', 'actions', 'ask', 'polish', 'expand', 'askback', 'reframe']
  if (typeof meta.action !== 'string' || !actions.includes(meta.action as AiMeta['action'])) return null
  const statuses: AiStatus[] = ['generating', 'complete', 'needs-confirmation', 'cancelled', 'error', 'accepted']
  if (typeof meta.status !== 'string' || !statuses.includes(meta.status as AiStatus)) return null
  return {
    ...(meta as unknown as AiMeta),
    action: meta.action as AiMeta['action'],
    status: meta.status as AiStatus,
    sourceBlockIds: Array.isArray(meta.sourceBlockIds) ? meta.sourceBlockIds.filter((id): id is string => typeof id === 'string') : [],
    ...(typeof meta.confidence === 'number' ? { confidence: meta.confidence } : {}),
    ...(meta.request && typeof meta.request === 'object' ? { request: meta.request as AiMeta['request'] } : {}),
    ...(typeof meta.error === 'string' ? { error: meta.error } : {}),
  }
}

function normalizePropertyValue(raw: unknown): PropertyValue | null {
  if (!raw || typeof raw !== 'object') return null
  const property = raw as Record<string, unknown>
  const defId = typeof property.defId === 'string' ? property.defId : null
  if (!defId) return null
  switch (property.type) {
    case 'text': return typeof property.value === 'string' ? { defId, type: 'text', value: property.value } : null
    case 'number': return typeof property.value === 'number' && Number.isFinite(property.value) ? { defId, type: 'number', value: property.value } : null
    case 'date': return typeof property.value === 'string' ? { defId, type: 'date', value: property.value } : null
    case 'checkbox': return typeof property.value === 'boolean' ? { defId, type: 'checkbox', value: property.value } : null
    case 'select': return typeof property.optionId === 'string' ? { defId, type: 'select', optionId: property.optionId } : null
    // Legacy v0.1 shape `{ defId, value: string }`; treat as text until a def overrides it.
    default: return typeof property.value === 'string' ? { defId, type: 'text', value: property.value } : null
  }
}

export function serializeBlock(block: Block): string {
  const issues = validateBlockShape(block)
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join('; '))
  return JSON.stringify(block)
}

export function parseBlock(json: string): Block {
  const value: unknown = JSON.parse(json)
  if (!value || typeof value !== 'object') throw new Error('Block JSON 必须是对象')
  const block = normalizeBlock(value as Block)
  const issues = validateBlockShape(block)
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join('; '))
  return structuredClone(block)
}

/**
 * 载入面的解析（`docs/03-技术说明（数据与存储）` §5）：**只有结构性形状码才抛**，报告级的码
 * （媒体四条 / `pinned`、`starred` 两条 / `link-url-invalid` 之外的报告级……见 `STRUCTURAL_CODES`）
 * 随块放行——载入出来用户才能删掉那块来修（写入路径由 `assertValidBlockGraph` 过滤，不会因为
 * 一行报告级数据变成只读）。与写入面同一个判据 `isStructuralCode`，两个口径不许各写一份。
 */
export function parseBlockForLoad(json: string): Block {
  const value: unknown = JSON.parse(json)
  if (!value || typeof value !== 'object') throw new Error('Block JSON 必须是对象')
  const block = normalizeBlock(value as Block)
  const blocking = validateBlockShape(block).filter((issue) => isStructuralCode(issue.code))
  if (blocking.length > 0) throw new Error(blocking.map((issue) => issue.message).join('; '))
  return structuredClone(block)
}

export function serializeBlockGraph(blocks: BlockMap): string {
  const issues = validateBlockGraph(blocks)
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join('; '))
  return JSON.stringify([...blocks.values()])
}

export function parseBlockGraph(json: string): BlockMap {
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value)) throw new Error('Block graph JSON 必须是数组')
  const blocks = new Map<string, Block>()
  for (const item of value) {
    const block = parseBlock(JSON.stringify(item))
    blocks.set(block.entityId, block)
  }
  const issues = validateBlockGraph(blocks)
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join('; '))
  return blocks
}
