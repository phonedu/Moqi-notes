/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * 可选能力开关（M5，`13-编辑器模块化` §3/§4）。
 *
 * 口径（§3）：AI 助手、图片/附件/嵌入、反链区、页面属性是**可选能力**——
 * 默认关闭时对应按钮不出现；不许用假按钮或空实现冒充。
 * 行内引用（`[[` / `((`）是核心能力（§3「块引用的行内部分」），**不设开关**。
 */
export type EditorFeature = 'ai' | 'media' | 'backlinks' | 'properties'

/** 宿主给的开关（缺省 = 全关）：只写要开的项。 */
export type EditorFeatures = Partial<Record<EditorFeature, boolean>>

/** 解析后的完整开关（四个键都在）。 */
export type ResolvedFeatures = Record<EditorFeature, boolean>

export const ALL_FEATURES_OFF: ResolvedFeatures = { ai: false, media: false, backlinks: false, properties: false }
export const ALL_FEATURES_ON: ResolvedFeatures = { ai: true, media: true, backlinks: true, properties: true }

/** 合成生效开关：缺省全关，显式给的覆盖之。 */
export function resolveFeatures(input?: EditorFeatures): ResolvedFeatures {
  return { ...ALL_FEATURES_OFF, ...input }
}
