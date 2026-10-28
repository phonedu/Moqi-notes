/**
 * 剪贴板端口（`04` `R04-CLIP-1`；台账 `D-090`）。
 *
 * 为什么要有它：Android WebView 把 `navigator.clipboard` 的读写**整体拒掉**
 *（`NotAllowedError: Write permission denied`，真机 2026-10-24 实测）——复制 / 剪切在手机上
 * 只剩一条「看起来点了、其实没写进去」的失败路径。系统剪贴板因此收成一个端口：
 *
 * - **Tauri 通道**：走 `tauri-plugin-clipboard-manager`（桌面 / Android 都是原生
 *   `ClipboardManager`），读写都可用；
 * - **浏览器通道**：`navigator.clipboard`，写失败时降级到 `execCommand('copy')`
 *   （WebView 里实测仍可用，桌面开发模式 / accept 也不需要新依赖）。
 *
 * 纪律与 `R04-CLIP-1` 同款：**文本仍由域层纯函数出**（`selectionAsText`），端口只负责
 * 「把它送进系统剪贴板」；调用方只决定失败时说什么，不自己碰平台 API。
 */
export interface ClipboardPort {
  /** 写入纯文本。写不进去时抛错（界面据此提示；剪切仍按原口径继续删除）。 */
  writeText(text: string): Promise<void>
  /** 读纯文本。读不到（空 / 无权限 / 不是文本）时抛错——界面据此决定是否摆「粘贴」。 */
  readText(): Promise<string>
}
