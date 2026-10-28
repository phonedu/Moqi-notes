/**
 * `ClipboardPort` 的两条实现（`04` `R04-CLIP-1`；台账 `D-090`）。
 *
 * - `LayeredClipboardPort`：**原生优先**——Tauri 下先走
 *   `@tauri-apps/plugin-clipboard-manager`（Android = `ClipboardManager.setPrimaryClip`，
 *   桌面 = 系统剪贴板）；插件失败（浏览器通道 / 插件没注册）再走浏览器这一层。
 * - 浏览器这一层：`navigator.clipboard` 可用就用它；被 WebView 拒时降级到
 *  `execCommand('copy')`（真机 实测：async 写被拒、`execCommand` 返回 true）。
 *
 * 为什么不在 UI 里直接调 `navigator.clipboard`：`ui/**` 不许碰平台 API（边界门），
 * 而且「原生优先 + 降级」只能有一份实现——复制 / 剪切 / 复制为块引用 / 粘贴检测
 * 必须走同一条路，否则手机上永远有一半动作是静默失败的。
 */
import type { ClipboardPort } from '../application/clipboard'

/** 适配器内部用的最小后端（原生插件与浏览器各自实现它）。 */
export type ClipboardBackend = {
  writeText(text: string): Promise<void>
  readText(): Promise<string>
}

/**
 * 浏览器通道的写：先试 async API，失败再走临时 `textarea` + `execCommand('copy')`。
 * `execCommand` 需要当前文档里有一个可选的编辑区，所以临时插一个离屏 textarea，
 * 复制完立刻移除——不碰正文、不留 DOM。
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;left:-9999px;top:0;width:10px;height:10px;opacity:0'
  document.body.appendChild(area)
  try {
    area.focus()
    area.select()
    area.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

/** 浏览器通道（开发模式 / accept / 非 Tauri 外壳）。 */
export const browserClipboardBackend: ClipboardBackend = {
  async writeText(text) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // WebView 的 async 写被拒是常态；再给 `execCommand` 一次机会（见文件头注）。
    }
    if (!legacyCopy(text)) throw new Error('剪贴板不可用')
  },
  async readText() {
    return await navigator.clipboard.readText()
  },
}

/** 原生通道：动态载入插件，浏览器构建里不提前拉 Tauri 依赖。 */
async function nativeClipboardBackend(): Promise<ClipboardBackend> {
  const { readText, writeText } = await import('@tauri-apps/plugin-clipboard-manager')
  return { writeText, readText }
}

/**
 * 分层端口：原生失败就退回浏览器层。**读**也一样（Android 插件对空剪贴板 / 非文本会 reject，
 * 退回浏览器层仍读不到时，界面就把「粘贴」藏起来——与既有 `10` §6.3 的口径一致）。
 */
export class LayeredClipboardPort implements ClipboardPort {
  constructor(
    private readonly native: (() => Promise<ClipboardBackend>) | null,
    private readonly browser: ClipboardBackend,
  ) {}

  async writeText(text: string): Promise<void> {
    if (this.native) {
      try {
        const backend = await this.native()
        await backend.writeText(text)
        return
      } catch {
        // 插件不可用（浏览器通道 / 旧包 / 平台不支持）：走浏览器层，绝不静默丢掉这次复制。
      }
    }
    await this.browser.writeText(text)
  }

  async readText(): Promise<string> {
    if (this.native) {
      try {
        const backend = await this.native()
        return await backend.readText()
      } catch {
        // 空剪贴板 / 非文本 / 插件不可用：交给浏览器层再试一次。
      }
    }
    return await this.browser.readText()
  }
}

export function createDefaultClipboardPort(): ClipboardPort {
  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  return new LayeredClipboardPort(tauri ? nativeClipboardBackend : null, browserClipboardBackend)
}
