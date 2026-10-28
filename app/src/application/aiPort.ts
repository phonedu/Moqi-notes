import type { AiAction, AiRequestInfo } from '@moqi/editor'

/**
 * AI 端口的**契约**（`AIPort` + 两个数据形状）——按六边形规矩由**应用层**定义、适配器实现
 * （`06` §4 的分层：`adapters` 实现上层要的口；反向 import 会把方向倒过来）。
 * 从 `adapters/ai.ts` 上提到这里：那是 `application` 侧唯一一处反向引用 adapters 的地方
 * （门 ⑩ 的结构读数点了名），adapters 侧改为 re-export 保持既有引用不断。
 */
export type AiRequest = { action: AiAction; sources: string[]; text: string }
export type AiProposal = {
  status: 'complete' | 'needs-confirmation'
  items: string[]
  confidence?: number
  request: AiRequestInfo
}

export interface AIPort {
  generate(request: AiRequest, signal: AbortSignal): Promise<AiProposal>
  /**
   * 流式生成（docs/09 §6.11）：每收到一段增量就回调一次 onDelta，返回与 `generate` 相同形状的最终提案。
   * 端口可选实现：只实现 `generate` 的端口由上层退化为一元生成。
   */
  generateStream?(request: AiRequest, signal: AbortSignal, onDelta: (delta: string) => void): Promise<AiProposal>
}
