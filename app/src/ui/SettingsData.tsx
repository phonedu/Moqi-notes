import { useState, type ReactNode } from 'react'
import { Icon } from '@moqi/editor'
import { Popover, anchorOf, type AnchorRect } from './Popover'
import { Sheet } from './Overlays'
import { ConfirmDialog } from './Dialogs'
import { clipboardPort } from '../composition'
import type { BackupPackageInfo, SnapshotInfo } from '../application/backup'

/**
 * 「数据」组三页（`09-桌面端UI规范（视图与组件）` §4.6.1 的 `R09-SET-20 / 21 / 22`）：
 * **备份与恢复 / 导出 / 导入**——设置左分栏里「数据」组下的三个子页；`PageHead` 是同壳各页共用的页头
 * （面包屑 ＋ 页名，`R09-SET-19`）。
 *
 * 为什么单独一份文件：`SettingsView.tsx` 已 568 行、体量门 600（`check:size`），三页塞进去必超；
 * 这三页与其余设置分区也没有耦合（只吃 `BackupSummary` 一个数据结构）。
 *
 * **能力如实**（`R09-SET-20` 的口径：能力不可用就禁用并写明原因，不做假按钮）：今天已经通了的能力
 * （数据目录 / 导出落点 / 快照 / 恢复 / 导出整库）照旧接线；**从备份包恢复**、导出页的形态三选、
 * 导入页的选文件通路还没接（解包通路随数据区下一刀、系统对话框与移动端 SAF 随后接），一律禁用并把原因写在界面上。
 */

/** 数据目录 → **导出落点**（`<数据目录>/exports/`）。纯函数：显示与复制共用一份，也进单测。 */
export function exportsDirectoryOf(dataDirectory: string | null): string | null {
  if (dataDirectory === null || dataDirectory.length === 0) return null
  const separator = dataDirectory.includes('\\') ? '\\' : '/'
  return `${dataDirectory}${dataDirectory.endsWith(separator) ? '' : separator}exports`
}

/** 「备份与恢复」页要的一切；`canExport` 为假时按钮禁用**并说明原因**（能力如实上报）。 */
export type BackupSummary = {
  dataDirectory: string | null
  canExport: boolean
  snapshots: SnapshotInfo[]
  /** \`exports/\` 下的备份包（含根级库的 .zip）——「从备份包恢复」列它用（第 13 项尾巴 · 场景 B）。 */
  packages: BackupPackageInfo[]
  /** 从备份包恢复（确认由卡片两步点击承担；调用方负责重载）。 */
  onRestorePackage: (name: string) => void
  onCreateSnapshot: () => void
  onRestoreSnapshot: (name: string) => void
  onExportDatabase: () => void
  onExportSnapshot: (name: string) => void
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 页头：只留页名（可选分组小字）；同壳的各页不再用面包屑重复页名。 */
export function PageHead({ crumb, title, meta }: { crumb?: string; title: string; meta?: string }) {
  return (
    <div className="set-ph">
      {crumb ? <div className="set-crumb">{crumb}</div> : null}
      {/* `meta` = 页头右侧小字（θ4 ③：属性库的「共 N 条」并进页头、不占行）。 */}
      <h2>{title}{meta ? <span className="set-ph-meta">{meta}</span> : null}</h2>
    </div>
  )
}

/**
 * `?` 注释（θ5 · 用户授权按建议定）：**正文只留最短一句结论，说明按需展开**——
 * 桌面 = 锚定气泡（`Popover`），窄档 = 底部 `Sheet`（同一份内容、两个容器，不新造原语）。
 * 为什么不是常驻小字：说明是「要的时候才读」的东西，常驻会把卡片挤成说明书（用户判词同 `R09-STATE-5` 的精神）。
 */
export function HintNote({ compact, title, children }: { compact?: boolean; title: string; children: ReactNode }) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="hint-q"
        aria-label={`说明：${title}`}
        title={title}
        aria-expanded={anchor !== null || sheetOpen}
        /* 气泡开着时让设置弹窗的 Esc **让位**（`data-esc-claim`：`Dialog` 的 Esc 是 document 捕获阶段接的，
           子层抢不到）——焦点这会儿就在这颗按钮上，命中即放行，由气泡自己收自己。 */
        {...(anchor !== null ? { 'data-esc-claim': '' } : {})}
        onClick={(event) => {
          if (compact) { setSheetOpen(true); return }
          setAnchor(anchor ? null : anchorOf(event.currentTarget))
        }}
      >
        <Icon name="help" size={14} decorative />
      </button>
      {anchor !== null ? (
        <Popover anchor={anchor} width={320} maxHeight={260} onClose={() => setAnchor(null)} className="hint-pop" label={title}>
          <div className="hint-body">{children}</div>
        </Popover>
      ) : null}
      {sheetOpen ? (
        <Sheet title={title} onClose={() => setSheetOpen(false)}>
          <div className="hint-body">{children}</div>
        </Sheet>
      ) : null}
    </>
  )
}

/** 未接能力的行：禁用的控件 ＋ 写明的原因（`R09-SET-20` 的「禁用并说明原因」，不做假按钮）。 */
function NotYetRow({ label, what, why }: { label: string; what: string; why: string }) {
  return (
    <div className="frow">
      <label>{label}</label>
      <div className="ctl">
        <span className="note">{what}</span>
        <span className="sub-hint">{why}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" disabled>未接入</button>
      </div>
    </div>
  )
}

/** 备份与恢复页（`R09-SET-20`）：原「数据与备份」卡片的内容搬进来 ＋「从备份包恢复」行。 */
export function DataBackupPage({ backup, onNotify, compact }: { backup: BackupSummary; onNotify: (message: string) => void; compact?: boolean }) {
  /** 恢复不可逆（之后的新改动会丢）：统一走模态确认，不在行内做两步点击。 */
  const [restore, setRestore] = useState<{ kind: 'snapshot' | 'package'; name: string } | null>(null)
  const exportsDirectory = exportsDirectoryOf(backup.dataDirectory)
  /** B 批（`R09-STATE-5`）：复制路径成功不弹通知（剪贴板自证）——只有失败才就地提示。 */
  const copy = (path: string | null) => {
    if (path === null) return
    void clipboardPort.writeText(path).catch(() => onNotify('剪贴板不可用'))
  }
  return (
    <>
      <PageHead title="备份与恢复" />
      <div className="set-card">
        <h3>
          <Icon name="archive" size={16} decorative />本机快照<span className="sub">后悔药 · 每天一份</span>
          <HintNote compact={compact} title="本机快照是什么">
            本机<strong>后悔药</strong>：每天一份，滚动保留 7 天 + 4 周；粒度是「天」，不是逐条历史。
            恢复前会先自动留一份「恢复前」的快照，所以恢复本身也可反悔。
          </HintNote>
        </h3>
        <div className="frow">
          <label>数据目录</label>
          <div className="ctl">
            <span className="note bk-path" title={backup.dataDirectory ?? ''}>{backup.dataDirectory ?? '（浏览器预览不提供；桌面版可见）'}</span>
            <button type="button" className="btn" disabled={backup.dataDirectory === null} onClick={() => copy(backup.dataDirectory)}>复制路径</button>
          </div>
        </div>
        <div className="frow">
          <label>导出落点</label>
          <div className="ctl">
            <span className="note bk-path" title={exportsDirectory ?? ''}>{exportsDirectory ?? '（浏览器预览不提供；桌面版可见）'}</span>
            <button type="button" className="btn" disabled={exportsDirectory === null} onClick={() => copy(exportsDirectory)}>复制路径</button>
          </div>
        </div>
        <div className="frow">
          <label>快照</label>
          <div className="ctl">
            <span className="note">
              {backup.snapshots.length === 0
                ? '还没有快照（启动时自动留一份）'
                : `最近 ${backup.snapshots.length} 份 · 占用 ${formatBytes(backup.snapshots.reduce((sum, entry) => sum + entry.sizeBytes, 0))}`}
            </span>
            <button type="button" className="btn" onClick={backup.onCreateSnapshot}>立即快照</button>
          </div>
        </div>
        {/* 快照与整库导出的**范围差别**要说在明处：快照只含库文件（设计如此），要连图片附件一起走就得「导出整库」。 */}
        {backup.snapshots.length > 0 ? (
          <>
            <div className="frow">
              <label />
              <div className="ctl">
                <span className="note">快照只含库文件（不含图片 / 附件）；带资产的副本请用「导出整库」</span>
              </div>
            </div>
            <div className="bk-list" role="list" aria-label="快照列表">
              {backup.snapshots.map((entry) => (
                <div className="bk-row" role="listitem" key={entry.name}>
                  <span className="bk-name">{entry.name.replace('.sqlite3', '')}</span>
                  <span className="bk-kind">{entry.kind === 'weekly' ? '周' : entry.kind === 'restore' ? '恢复前' : '日'}</span>
                  <span className="bk-size">{formatBytes(entry.sizeBytes)}</span>
                  <button type="button" className="btn" onClick={() => setRestore({ kind: 'snapshot', name: entry.name })}>恢复</button>
                  <button type="button" className="btn" disabled={!backup.canExport} onClick={() => backup.onExportSnapshot(entry.name)}>导出这一份</button>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div className="set-card">
        <h3><Icon name="copy" size={16} decorative />带走与恢复<span className="sub">整库包 = 库 + 图片附件</span></h3>
        <div className="frow">
          <label>导出整库</label>
          <div className="ctl">
            <span className="note">
              一个 .zip 包（project-b.sqlite3 + assets/ 图片附件）——留档 / 换机器时带走
              {backup.canExport ? '' : '（浏览器预览不提供文件导出，请用桌面版）'}
            </span>
            <button type="button" className="btn" disabled={!backup.canExport} onClick={backup.onExportDatabase}>导出…</button>
          </div>
        </div>
        {/* 从备份包恢复（第 13 项尾巴 · 场景 B「换机器」闭环）：只列 exports/ 下的**备份包**
            （含根级库的 .zip）——Markdown 包与快照单文件不在此列（两种 zip 在列表这层就分开）。 */}
        <div className="frow">
          <label>从备份包恢复</label>
          <div className="ctl">
            <span className="note">
              一个整库 .zip（包内含 project-b.sqlite3）：校验形状 → 先自动留一份「恢复前」→ 替换库并把 assets/ 落回数据目录 → 重载
              {backup.canExport ? '' : '（浏览器预览不提供，请用桌面版 / 真机）'}
            </span>
          </div>
        </div>
        {backup.canExport ? (
          backup.packages.length === 0 ? (
            <div className="frow">
              <label />
              <div className="ctl"><span className="note">还没有备份包——「导出整库…」产出的 .zip 会列在这里</span></div>
            </div>
          ) : (
            <div className="bk-list" role="list" aria-label="备份包列表">
              {backup.packages.map((entry) => (
                <div className="bk-row" role="listitem" key={entry.name}>
                  <span className="bk-name">{entry.name.replace(/\.zip$/i, '')}</span>
                  <span className="bk-kind">整库包</span>
                  <span className="bk-size">{formatBytes(entry.sizeBytes)}</span>
                  <button type="button" className="btn" onClick={() => setRestore({ kind: 'package', name: entry.name })}>恢复</button>
                </div>
              ))}
            </div>
          )
        ) : null}
        <div className="frow">
          <label>异地副本</label>
          <div className="ctl">
            <span className="note">
              把<b>同步位置</b>指到一个云盘目录（OneDrive / 坚果云 / iCloud 都行）≈ 多一份异地副本
              <span className="sub-hint">（两台设备指同一个目录就能还原）</span>
            </span>
          </div>
        </div>
      </div>
      {restore ? (
        <ConfirmDialog
          title={restore.kind === 'snapshot' ? '恢复这一份快照？' : '从备份包恢复？'}
          confirmLabel="恢复并替换"
          danger
          body={<>
            <p>会用「<b>{restore.name.replace(/\.(sqlite3|zip)$/i, '')}</b>」替换当前全部数据。之后的新改动会丢。</p>
            <p>恢复前会先自动留一份「恢复前」快照。</p>
            <p className="dlg-note">恢复是整库替换，不是合并。</p>
          </>}
          onConfirm={() => {
            const pending = restore
            setRestore(null)
            if (pending.kind === 'snapshot') backup.onRestoreSnapshot(pending.name)
            else backup.onRestorePackage(pending.name)
          }}
          onClose={() => setRestore(null)}
        />
      ) : null}
    </>
  )
}

/**
 * 导出页（`R09-SET-21`：表单顺序钉死 = 范围 → 创建时间 → 格式 → 内容形态 → 附件 → 开始导出（N））。
 * 今天能通的只有「范围」的三种语义（当前页面 / 按标签 / 全部页面）与 ZIP 形态——但**动作接线**要外壳
 * 把 `runMarkdownExport` / 标签表 / 实时页数传进来（随数据区下一刀），所以本刀先把表单摆对、能力写清。
 */
/** 导出页的口（`R09-SET-21`）：范围选择与动作住外壳，页面只画与控制（受控，便于「打开导出页并预选」）。 */
export type ExportPageProps = {
  enabled: boolean
  busy: boolean
  activePageName: string | null
  tags: { id: string; name: string; count: number }[]
  choice: { kind: 'page' | 'tag' | 'all'; tagId: string | null }
  onChoiceChange: (choice: { kind: 'page' | 'tag' | 'all'; tagId: string | null }) => void
  /** 当前选择下的页面数（按钮上的 N；「当前页面」= 1）。 */
  count: number
  onExport: () => void
  /** 「另存为…/ 存到文件夹…」（`T-18`）：同一份 plan，落点 = 系统对话框选的位置。 */
  onExportAs: () => void
  onExportToFolder: () => void
}

export function DataExportPage({ enabled, busy, activePageName, tags, choice, onChoiceChange, count, onExport, onExportAs, onExportToFolder, compact, fileOps = { canSaveAs: false, canPickFolder: false } }: ExportPageProps & { compact?: boolean; fileOps?: { canSaveAs: boolean; canPickFolder: boolean } }) {
  return (
    <>
      <PageHead title="导出" />
      <div className="set-card">
        <div className="hint">
          导出的是<strong>可读的 Markdown</strong>；原样恢复走「备份与恢复」。
          <HintNote compact={compact} title="导出的格式">
            导出的是<strong>可读的 Markdown</strong>（给别人看、给别的笔记软件读）；要能原样恢复回墨契的整库备份，
            走「备份与恢复」的<strong>导出整库</strong>（`.zip` = 库 ＋ 图片附件）。
          </HintNote>
        </div>
        <div className="frow">
          <label>范围</label>
          <div className="ctl">
            <div className="seg" role="group" aria-label="导出范围">
              {/* θ15（2026-10-13 用户裁定）：**设置页没有「当前页面」**——这一项只在**从页面上下文进来**（编辑器 … / 卡片 ⋯
                  预选）时在位；一旦离开它就回不来（「全部 / 按标签」两选才是设置页的常驻范围）。 */}
              {choice.kind === 'page' ? (
                <button type="button" className="is-on" disabled={busy} onClick={() => onChoiceChange({ kind: 'page', tagId: null })}>当前页面</button>
              ) : null}
              <button type="button" className={choice.kind === 'tag' ? 'is-on' : ''} disabled={busy || tags.length === 0} onClick={() => onChoiceChange({ kind: 'tag', tagId: choice.tagId ?? tags[0]?.id ?? null })}>按标签…</button>
              <button type="button" className={choice.kind === 'all' ? 'is-on' : ''} disabled={busy} onClick={() => onChoiceChange({ kind: 'all', tagId: null })}>全部页面</button>
            </div>
            {choice.kind === 'page' ? <span className="sub-hint">（{activePageName ?? '当前没有打开页面'}）</span> : null}
          </div>
        </div>
        {choice.kind === 'tag' ? (
          <div className="frow">
            <label htmlFor="set-export-tag">标签</label>
            <div className="ctl">
              <select id="set-export-tag" className="inp set-select" value={choice.tagId ?? ''} onChange={(event) => onChoiceChange({ kind: 'tag', tagId: event.target.value })}>
                {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}（{tag.count} 页）</option>)}
              </select>
            </div>
          </div>
        ) : null}
        <div className="frow">
          <label>格式</label>
          <div className="ctl"><span className="note">Markdown（目前仅这一种）</span></div>
        </div>
        <NotYetRow label="创建时间" what="不限 ▾ ＋ 起止日期" why="后续规划（与「按标签」并列的第二条筛选轴）" />
        <div className="frow">
          <label>内容形态</label>
          <div className="ctl">
            <span className="note">当前页面 → 单个 .md；按标签 / 全部页面 → 一个 .zip（包内根平铺）</span>
            <span className="sub-hint">（手动三选：合并为单个 .md / 导出到文件夹）</span>
          </div>
        </div>
        <NotYetRow label="附件" what="☑ 含图片、音频等附件（默认全含）" why="做成可勾随内容形态一起（不勾 = 只有文字，包更小）" />
        <div className="frow">
          <label />
          <div className="ctl">
            <span className="note">{enabled ? '' : '浏览器预览不提供文件导出，请用桌面版'}</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn" disabled={busy || !enabled || count === 0 || !fileOps.canSaveAs} title={fileOps.canSaveAs ? '选一个位置保存这一份' : '这个通道没有系统保存对话框'} onClick={onExportAs}>另存为…</button>
            <button type="button" className="btn" disabled={busy || !enabled || count === 0 || !fileOps.canPickFolder} title={fileOps.canPickFolder ? '选一个文件夹存进去（文件名沿用导出名）' : '这个通道不能选文件夹'} onClick={onExportToFolder}>存到文件夹…</button>
            <button type="button" className="btn btn-brand" disabled={busy || !enabled || count === 0} onClick={onExport}>{busy ? '正在导出…' : `开始导出（${count}）`}</button>
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * 导入页（`R09-SET-22`）：支持 `.md` / `.txt` / `.zip`，html / json 不支持并写明；上限行如实写
 * 「单文件 8 MB」；可给这批页面打一个标签；zip = 导入包（一次建 N 个新页面）。
 * **选文件 / 选文件夹**两条通路尚未接（桌面为系统对话框、移动为 SAF），本刀先立页面与口径。
 *
 * **行内标签开关（用户 2026-10-10 裁决，本页第一个真能用的控件）**：导入 Obsidian 的 `.md` 时，
 * 正文里的 `#标签` / `#父/子` 要不要收成页面标签——默认开（对齐 Obsidian 语义"行内标签 ⊂ 这篇
 * 笔记的标签"）；**只登记、正文一字不动**（幂等、往返逐字一致），判据见 `domain/mdRefs.collectInlineTags`。
 * 拖入 `.md` 那条快捷通路读同一份偏好（开关在哪条通路上都生效）。
 */
export function DataImportPage({ inlineTags, onToggleInlineTags, compact, fileOps }: {
  inlineTags: boolean
  onToggleInlineTags: () => void
  compact?: boolean
  /** 文件通道的两个活入口（`T-18`）：能力面由端口上报（浏览器 / 移动端各如实禁用 + 写明原因）。 */
  fileOps: { canPickFile: boolean; canPickFolder: boolean; onPickFiles: () => void; onPickFolder: () => void }
}) {
  return (
    <>
      <PageHead title="导入" />
      <div className="set-card">
        <div className="hint">
          支持 <strong>.md / .txt / .zip</strong>；html / json 不支持。
          <HintNote compact={compact} title="导入的格式与图片">
            支持 <strong>.md / .txt / .zip</strong>；html / json <strong>不支持</strong>。
            含本地图片的 Markdown 请用文件夹或 .zip（单文件读不到旁边的图）。
          </HintNote>
        </div>
        <div className="frow">
          <label htmlFor="import-inline-tags">行内标签</label>
          <div className="ctl">
            <label htmlFor="import-inline-tags" className="note" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                id="import-inline-tags"
                type="checkbox"
                checked={inlineTags}
                onChange={onToggleInlineTags}
              />
              收成页面标签
            </label>
            <span className="note">正文里的 <code>#标签</code> 导入时登记进标签体系（正文不动）</span>
          </div>
        </div>
        <div className="frow">
          <label>上限</label>
          <div className="ctl"><span className="note">单文件 8 MB（桌面路径 / 移动 SAF 都照这一条）</span></div>
        </div>
        <div className="frow">
          <label>选择文件</label>
          <div className="ctl">
            <span className="note">选一个 .md / .txt / .zip（与拖入同一条路）</span>
            <button
              type="button"
              className="btn"
              disabled={!fileOps.canPickFile}
              title={fileOps.canPickFile ? '打开系统文件选择器' : '浏览器预览没有系统文件选择器'}
              onClick={() => void fileOps.onPickFiles()}
            >
              选择文件…
            </button>
          </div>
        </div>
        <div className="frow">
          <label>选择文件夹</label>
          <div className="ctl">
            <span className="note">递归收文件夹里的 .md，连同相对路径的图一起进（上限 500 篇）</span>
            <button
              type="button"
              className="btn"
              disabled={!fileOps.canPickFolder}
              title={fileOps.canPickFolder ? '选一个文件夹导入' : '移动端系统不支持选文件夹（带图导入请用 .zip）'}
              onClick={() => void fileOps.onPickFolder()}
            >
              选择文件夹…
            </button>
          </div>
        </div>
        <NotYetRow label="打标签" what="给这一批新页面统一打一个标签" why="当前版本还没接" />
        <div className="frow">
          <label>现在就能用的入口</label>
          <div className="ctl">
            <span className="note">把 .md 文件拖进窗口即可导入</span>
          </div>
        </div>
      </div>
    </>
  )
}
