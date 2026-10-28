/**
 * 文件通道端口（`03` §12.4 · 0.6 交付项表第 11 项）：把「选文件 / 选目录 / 另存为」三条系统能力
 * 收成一个端口——桌面走原生对话框，**Android 走 SAF**（同一个 `dialog` 插件在两端各自落到系统能力上）。
 *
 * 三条纪律（§12.4 原文）：
 * ① **能力如实上报**（`capabilities`）：界面按它禁用按钮并把原因写在界面上（`R09-SET-20` 不做假按钮）；
 * ② **移动端 folder picker 官方不支持** ⇒ `pickFolder` 在 Android 如实为 false，不许装作能用；
 * ③ **SAF 内容 URI（`content://…`）不能直接读** ⇒ 实现负责「复制到应用缓存目录再走既有通路」，
 *    校验（扩展名 / 8 MB）与解析**留在原处**，不给第二个入口（`P-*` 的负例自测看这条）。
 */
/** 选中的文件：`ref` 桌面 = 绝对路径 / Android = SAF 内容 URI；`name` 取不到时给默认名（上游拿不到文件名的已知限制）。 */
export type PickedFile = { ref: string; name: string; ext: string }

export type FileChannelCapabilities = {
  pickFile: boolean
  /** **仅桌面**（移动端官方不支持 folder picker）——Android 上如实为 false。 */
  pickFolder: boolean
  saveAs: boolean
}

export interface FileChannelPort {
  capabilities: FileChannelCapabilities
  /** 选一个文件（`extensions` 不含点，如 `['md','txt','zip']`）。取消 = `null`。 */
  pickFile(extensions: string[]): Promise<PickedFile | null>
  /** 选一个目录（仅桌面）。取消 = `null`。 */
  pickFolder(): Promise<string | null>
  /** 「另存为」：给默认文件名，返回用户选的落点（桌面路径 / Android 内容 URI）。取消 = `null`。 */
  saveAs(defaultName: string): Promise<string | null>
  /**
   * 把**已经写好的文件**送到 SAF 落点（Android 专用；`03` §12.4 同一坑的写方向）：
   * `content://` 写不了 ⇒「先照常写进 `exports/`，再拷到用户选的位置」。桌面落点是普通路径，
   * 由 `write(plan, targetPath)` 直接写，**不走这里**（没有第二个入口）。
   */
  copyOut(fromPath: string, toRef: string): Promise<void>
}

/** 扩展名归一（小写、不含点）——取名字失败时用它兜底，别在别处再写一遍。 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLocaleLowerCase()
}

/** 目录型落点的判据（桌面路径用；SAF 的 URI 不走它）——导出的「导出到文件夹」要用。 */
export function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}
