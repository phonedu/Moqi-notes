import type { AiAction } from '@moqi/editor'
import { resolveAiStatus } from '@moqi/editor'
import type { AIPort, AiProposal } from './aiPort'

export type AiRunResult =
  | { ok: true; proposal: AiProposal }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string }

/**
 * T17: thin orchestration over an AIPort. It owns cancel/error semantics so the
 * editor only deals with a discriminated result and never touches the network
 * layer directly.
 */
export class AiService {
  constructor(private port: AIPort) {}

  async run(action: AiAction, sourceIds: string[], text: string, signal: AbortSignal): Promise<AiRunResult> {
    try {
      const proposal = await this.port.generate({ action, sources: sourceIds, text }, signal)
      return { ok: true, proposal: { ...proposal, status: resolveAiStatus(proposal) } }
    } catch (error) {
      if (signal.aborted) return { ok: false, cancelled: true }
      return { ok: false, cancelled: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 流式生成（docs/09 §6.11）：端口未实现流式时退化为一元生成（完成后一次性回调），
   * 因此上层可以始终按流式处理，取消与错误语义与 `run` 完全一致。
   */
  async runStream(action: AiAction, sourceIds: string[], text: string, signal: AbortSignal, onDelta: (delta: string) => void): Promise<AiRunResult> {
    const request = { action, sources: sourceIds, text }
    try {
      const proposal = this.port.generateStream
        ? await this.port.generateStream(request, signal, onDelta)
        : await (async () => {
            const result = await this.port.generate(request, signal)
            onDelta(result.items.join('\n'))
            return result
          })()
      return { ok: true, proposal: { ...proposal, status: resolveAiStatus(proposal) } }
    } catch (error) {
      if (signal.aborted) return { ok: false, cancelled: true }
      return { ok: false, cancelled: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
