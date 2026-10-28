/**
 * 媒体资产端口（13-媒体设计（已归档） §3 / §4）。
 *
 * **边界**：命名与内容都在界面侧决定（磁盘名 = 不透明随机名、字节 = 三管道拿到的），
 * 端口只做哑事——写进 `<数据目录>/assets/`、列出来（判「文件缺失」）、按名删、把磁盘名换算成
 * 能喂 `<img>` 的显示地址。
 *
 * 两条通路如实上报能力：
 * - 桌面 / Android：走 Rust 命令（落盘 + `convertFileSrc` 的 asset 协议）；
 * - 浏览器预览：**不落盘**（`persistAssets: false`）——字节留在内存里、用 object URL 显示，
 *   够跑通界面流程与 accept（与 `BrowserBackupPort` 同一条定位：语义对齐、能力如实上报）。
 */
export type AssetImportResult = { diskName: string; originalName: string; sizeBytes: number }

export interface AssetPort {
  /** `persistAssets` = 字节真的落盘（浏览器预览为 false：只活在这次会话里）。 */
  capabilities: { persistAssets: boolean }
  /** 开局准备（桌面：问一次 assets 目录，显示地址要用它）。界面 await 它之后再画图。 */
  prepare(): Promise<void>
  /**
   * 订阅「OS 文件拖进来」（桌面：Tauri 的拖放事件，事件里是**路径**）。
   * 浏览器预览没有这条：HTML5 drop 由界面自己接（拿到的就是字节）。返回退订函数。
   */
  watchDrops(handler: (paths: string[]) => void): Promise<() => void>
  /** 写一份资产（先写文件、后写事务）。返回落盘字节数。 */
  write(diskName: string, bytes: Uint8Array): Promise<number>
  /**
   * 从**本机路径**导入（OS 文件拖入那条管道：桌面拿到的是路径、不是字节）。
   * 浏览器预览没有这条（HTML5 drop 给的是字节，走 `write`）。
   */
  importFromPath(sourcePath: string, diskName: string): Promise<AssetImportResult>
  /** `assets/` 下已有的磁盘名（判「文件缺失」用）。 */
  listNames(): Promise<string[]>
  /** 按磁盘名删（只给彻底删除那条路用；幂等）。 */
  remove(diskName: string): Promise<boolean>
  /**
   * 「另存为副本」（`R09-BLOCK-19/20`）：把资产复制到认得的目录并把**路径**给界面（桌面），
   * 或触发浏览器下载（浏览器通道，返回 null）。与整库导出同一条诚实做法；「系统另存为」留插件轮。
   */
  saveCopy(diskName: string, displayName: string): Promise<string | null>
  /** 磁盘名 → 能喂 `<img>` / `background-image` 的显示地址；拿不到返回 null（界面降级成占位卡）。 */
  displayUrl(diskName: string): string | null
}
