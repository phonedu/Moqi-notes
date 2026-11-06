import { invoke } from '@tauri-apps/api/core'

/**
 * 本地技术日志的 **JS 侧入口**：一行一条，写进应用数据目录下的 `logs/app.log`
 * （Rust 侧负责文件、轮转与 panic 钩子；见 `src/logging.rs`）。
 *
 * 纪律（与 Rust 侧同一条）：**只写 id / 计数 / 耗时 / 错误码，绝不写用户正文**——日志是过程物，
 * 不是数据的第二份副本。窗口外的浏览器预览没有原生日志文件，降级到 `console`（不影响功能）。
 */

type Level = 'ERROR' | 'WARN' | 'INFO'

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 写一行。失败**必须静默**——日志坏了不能反过来影响功能。 */
export function logLine(level: Level, message: string): void {
  const flat = message.replaceAll('\n', ' ')
  if (!isTauri()) {
    // 浏览器预览：落到控制台，形态与文件里一致（级别 + 一行）。
    if (level === 'ERROR') console.error(`[${level}] ${flat}`)
    else if (level === 'WARN') console.warn(`[${level}] ${flat}`)
    else console.info(`[${level}] ${flat}`)
    return
  }
  void invoke('log_append', { level, message: flat }).catch(() => undefined)
}

/** 导出诊断日志：返回写到哪（桌面 = 用户选的文件；移动 = `exports/` 里的文件，随后走 SAF 拷出）。 */
export async function exportDiagnostics(destination?: string | null): Promise<string> {
  return invoke<string>('export_diagnostics', { destination: destination ?? null })
}

/**
 * 全局未捕获错误进日志（崩溃 / 异步漏网的第一现场）。
 * 只装一次：入口调它一次，各组件不要再各自装。
 */
export function installGlobalLogHandlers(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (event) => {
    const where = event.filename ? ` @ ${event.filename}:${event.lineno}:${event.colno}` : ''
    logLine('ERROR', `uncaught: ${event.message}${where}`)
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? `${event.reason.name}: ${event.reason.message}` : String(event.reason)
    logLine('ERROR', `unhandled rejection: ${reason}`)
  })
}
