import type { AiAction } from '@moqi/editor'
import type { AIPort, AiProposal, AiRequest } from '../application/aiPort'

/** 端口的家在 `application/aiPort.ts`（2026-10-09 上提）；这里 re-export，既有 `from '../adapters/ai'` 引用不断。 */
export type { AIPort, AiProposal, AiRequest } from '../application/aiPort'

export type AiConfig = { baseUrl: string; apiKey: string; model: string; provider?: string }

/**
 * T17 D-020: deterministic stand-in used by A/D/L tests. `failWith` and a
 * `delayMs` long enough to abort let tests exercise error and cancel paths
 * without any network access.
 */
export class StubAIPort implements AIPort {
  constructor(private options: { items?: string[]; status?: AiProposal['status']; confidence?: number; delayMs?: number; failWith?: string; chunkSize?: number } = {}) {}

  async generate(request: AiRequest, signal: AbortSignal): Promise<AiProposal> {
    if (this.options.delayMs) await abortableDelay(this.options.delayMs, signal)
    if (signal.aborted) throw new Error('aborted')
    if (this.options.failWith) throw new Error(this.options.failWith)
    return {
      status: this.options.status ?? 'complete',
      items: this.options.items ?? defaultItems(request),
      confidence: this.options.confidence,
      request: { provider: 'stub', model: 'stub', requestedAt: Date.now() },
    }
  }

  /** 按固定片长逐段回调，供流式与「停止后保留已生成部分」的测试使用。 */
  async generateStream(request: AiRequest, signal: AbortSignal, onDelta: (delta: string) => void): Promise<AiProposal> {
    const items = this.options.items ?? defaultItems(request)
    const text = items.join('\n')
    const size = Math.max(1, this.options.chunkSize ?? Math.ceil(text.length / 4))
    for (let at = 0; at < text.length; at += size) {
      if (signal.aborted) throw new Error('aborted')
      if (this.options.delayMs) await abortableDelay(this.options.delayMs, signal)
      if (signal.aborted) throw new Error('aborted')
      onDelta(text.slice(at, at + size))
    }
    if (this.options.failWith) throw new Error(this.options.failWith)
    return {
      status: this.options.status ?? 'complete',
      items,
      confidence: this.options.confidence,
      request: { provider: 'stub', model: 'stub', requestedAt: Date.now() },
    }
  }
}

/** T17 D-020: OpenAI-compatible `chat/completions` adapter (DeepSeek/OpenAI). */
export class OpenAICompatibleAIPort implements AIPort {
  private readonly fetchImpl: typeof fetch

  /**
   * `fetch` 必须绑定到全局对象再保存：作为实例方法调用（`this.fetchImpl(...)`）
   * 会让浏览器把它当成带错误 receiver 的调用并抛出 "Illegal invocation"。
   */
  constructor(private config: AiConfig, fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  async generate(request: AiRequest, signal: AbortSignal): Promise<AiProposal> {
    const response = await this.request(request, signal, false)
    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim().length === 0) throw new Error('AI 响应缺少内容')
    return {
      status: 'complete',
      items: parseItems(request.action, content),
      request: { provider: this.config.provider ?? 'openai', model: this.config.model, requestedAt: Date.now() },
    }
  }

  /** SSE 流式生成：逐块解析 `data:` 行，把增量交给调用方，最后按动作规整为提案。 */
  async generateStream(request: AiRequest, signal: AbortSignal, onDelta: (delta: string) => void): Promise<AiProposal> {
    const response = await this.request(request, signal, true)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('AI 响应不支持流式读取')
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // 最后一行可能被截断，留到下一次读取再解析。
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload.length === 0 || payload === '[DONE]') continue
        try {
          const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> }
          const delta = chunk.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            content += delta
            onDelta(delta)
          }
        } catch {
          // 忽略无法解析的行（注释、keep-alive、非 JSON 心跳）。
        }
      }
    }
    if (content.trim().length === 0) throw new Error('AI 响应缺少内容')
    return {
      status: 'complete',
      items: parseItems(request.action, content),
      request: { provider: this.config.provider ?? 'openai', model: this.config.model, requestedAt: Date.now() },
    }
  }

  private async request(request: AiRequest, signal: AbortSignal, stream: boolean): Promise<Response> {
    const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPTS[request.action] },
          { role: 'user', content: request.text },
        ],
        ...(stream ? { stream: true } : {}),
      }),
      signal,
    })
    if (!response.ok) {
      // 服务端通常带一句 JSON 说明（模型名写错 = "Model Not Exist"、密钥错 = 401…）——
      // **原文透传**比我们猜原因可靠：模型清单随各家服务变，应用侧不维护「哪个模型存在」的知识。
      let detail = ''
      try {
        const body = (await response.json()) as { error?: { message?: unknown }; message?: unknown }
        const text = body?.error?.message ?? body?.message
        if (typeof text === 'string' && text.trim().length > 0) detail = `：${text.trim()}`
      } catch { /* 响应体不是 JSON 就只报状态码 */ }
      const hint = response.status === 404 || response.status === 400
        ? '（请检查设置里的模型名与服务地址是否是该服务当前提供的）'
        : response.status === 401 || response.status === 403
          ? '（请检查设置里的密钥）'
          : ''
      throw new Error(`AI 请求失败：HTTP ${response.status}${detail}${hint}`)
    }
    return response
  }
}

/**
 * 七条系统提示词（`AiAction` → 文本）。**全文与修订历史另有一份活文档：`docs/12-AI提示词.md`**
 * ——改这里必须同步改那边，两边逐字一致由 `test:PROMPT-DOC-1` 把关（提示词是内容资产，
 * 会按阶段反复修改；用户 2026-10-05 裁决：自己做、住 `docs/12`）。
 *
 * 共同口径：**只输出正文**、不写「以下是…」这类前言、不加标题与说明——
 * 结果会直接落成块，多一句前言就多一段要用户手动删的字。
 *
 * 已知待办（`05` 第十二次登记）：现在的文本是按「一段文本」写的，而面板「基于本篇」喂进去的是
 * 整页多条块——「整篇」档的输出质量偏弱（13-AI评测材料（已归档））；分档组装（把块角色喂给模型、
 * 整篇时要求按块保留结构）尚未排期。
 */
export const SYSTEM_PROMPTS: Record<AiAction, string> = {
  summary: '你是大纲笔记助手。请用中文简洁总结用户提供的内容，只输出总结正文，不要前言。',
  actions: '你是大纲笔记助手。请从用户内容中提取可执行行动项，每行一项，只输出行动项，不要编号或前言。',
  ask: '你是大纲笔记助手。用户会先给出笔记正文，然后提出一个问题。请只依据正文用中文回答，答不出的部分明确说明，不要编造，只输出回答正文。',
  polish: '你是大纲笔记助手。请润色用户提供的内容：保留原意与要点，只调整表达与语序，让它更通顺。只输出润色后的正文，不要解释改动，不要前言。',
  expand: '你是大纲笔记助手。请扩写用户提供的内容：补充必要的细节、例子或理由，让论述更完整，但不要引入原文没有的事实。只输出扩写后的正文，不要前言。',
  askback: '你是大纲笔记助手。请针对用户提供的内容提出 3 个能引导深入思考的问题，每行一个问题。只输出问题本身，不要编号、不要解答、不要前言。',
  reframe: '你是大纲笔记助手。请从另一个视角重写用户提供的内容（例如换立场、换读者、换时间尺度），保留核心事实。只输出重写后的正文，不要说明你换了什么视角，不要前言。',
}

/**
 * 把模型输出规整成块文本行（`summary` / `ask` 不拆行；其余按行拆成条目）。
 *
 * 行首列表符（`- ` / `* ` / `• ` / `1. ` / `1、`）要剥掉——模型常自带编号，落成块文本没有意义。
 * 但**不能把正文吃进去**（台账 D-019，2026-10-05）：原先的 `[-*•]\s*` 允许列表符后跟**零个**空白，
 * 于是行首 `**加粗**` 被吃成一个 `*`（13-AI评测材料（已归档）「换角度」那条格式破损的真因）、
 * `1.5 倍` 被吃成 `5 倍`、`2026.10.05` 被吃成 `10.05`。现在两条口径：
 * - `-` / `*` / `•` 只有**后面跟空白**才算列表符（`-5 度`、`*斜体*`、`**加粗**` 都是正文）；
 * - `数字.` / `数字)` / `数字、` 只有**后面不是数字**才算编号符（`1.5`、`1.1 节`、日期是正文）。
 */
export function parseItems(action: AiAction, content: string): string[] {
  if (action === 'summary' || action === 'ask') return [content.trim()]
  return content
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]\s+|\d+[.)、](?!\d)\s*)/, '').trim())
    .filter((line) => line.length > 0)
}

function defaultItems(request: AiRequest): string[] {
  const firstLine = request.text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  if (request.action === 'summary') return [`（stub 总结）${firstLine}`]
  if (request.action === 'ask') return [`（stub 回答）${firstLine}`]
  return request.text.split('\n').map((line) => line.replace(/^\s*[-*•]\s*/, '').trim()).filter((line) => line.length > 0).map((line) => `（stub 行动项）${line}`)
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
