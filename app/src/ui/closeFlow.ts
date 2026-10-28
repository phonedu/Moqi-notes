/**
 * 关闭窗口的流程规则（docs/09 §3.1「关闭」、docs/03 保存契约）。
 *
 * 关闭是**生命周期动作**：先把保存队列落盘，再关；有 AI 块正在生成时先让用户选
 * （继续生成 / 直接关闭）。不做「未保存」确认——全程自动保存，只差队列里最后几拍。
 *
 * 保存期间重复关闭请求仍然拦截；最后调用 destroy()，不会重新触发关闭请求。
 */
export type CloseAction = 'ignore' | 'confirm-generating' | 'flush-then-close'

export function closeAction(input: { closing: boolean; generating: boolean }): CloseAction {
  if (input.closing) return 'ignore'
  return input.generating ? 'confirm-generating' : 'flush-then-close'
}

export async function saveThenClose(save: () => Promise<void>, close: () => Promise<boolean>, timeoutMs = 1500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      save(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('保存超时，请等待保存完成后重试关闭')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  return close()
}
