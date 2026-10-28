import { useEffect, useState, type MouseEvent } from 'react'
import { Icon } from '@moqi/editor'
import { formatRelative } from './format'
import {
  COLUMN_WIDTH_STEPS, FONT_SIZE_STEPS, LINE_HEIGHT_STEPS, THEMES, loadSeenVersion, saveSeenVersion,
  type ColumnWidthStep, type FontSizeStep, type LineHeightStep, type ThemeMode, type UiPrefs,
} from './uiPrefs'
import type { SearchIndexStatus } from '../application/search'
import type { PropertyDef } from './types'
import { splitChangelogBold, type ChangelogRelease } from '../changelog'
import { DataBackupPage, DataExportPage, DataImportPage, PageHead, type BackupSummary, type ExportPageProps } from './SettingsData'
import { SettingsProperties } from './SettingsProperties'

// 搬了家的两件（`SettingsData.tsx`）：为既有引用（`ui/useDataActions.ts` 与 `tests/ui/shell.test.tsx`）留转出口。
export { exportsDirectoryOf } from './SettingsData'
export type { BackupSummary } from './SettingsData'

export type AiSettingsValue = { baseUrl: string; apiKey: string; model: string }

/** 左分栏的分区 id（`09-桌面端UI规范（视图与组件）` §4.6 `R09-SET-17`：只有「数据」是可展开的组）。 */
export type SettingsSection = 'ai' | 'sync' | 'index' | 'appearance' | 'properties' | 'backup' | 'export' | 'import' | 'about'

export type SettingsLevel = 'list' | 'page'

/** 统一标题栏的页名（批 ζ · `10` §4.7）：数据组三页带「数据 · 」分组前缀（`R09-SET-19`）。 */
const SECTION_TITLES: Record<SettingsSection, string> = {
  ai: 'AI', sync: '同步', index: '搜索', appearance: '外观', properties: '属性',
  backup: '备份与恢复', export: '导出', import: '导入', about: '关于',
}

type SettingsViewProps = {
  aiConfig: AiSettingsValue
  aiReady: boolean
  onSaveAi: (value: AiSettingsValue) => void
  properties: PropertyDef[]
  onCreateProperty: (name: string, type: PropertyDef['type']) => void
  /** 改名：**返回失败原因**（`null` = 成功）——属性库内就地显示（`§0-6`）。 */
  onRenameProperty: (defId: string, name: string) => string | null
  /** θ4：属性库的选项维护与排序（一个对象传，免得逐个铺 prop）。 */
  propertyOps: {
    onAddOption: (defId: string, label: string) => void
    onRenameOption: (defId: string, optionId: string, label: string) => boolean
    onRemoveOption: (defId: string, optionId: string) => void
    onMoveOption: (defId: string, optionId: string, toIndex: number) => void
    onMoveProperty: (defId: string, toIndex: number) => void
  }
  /** θ4：名称判据的人话（「完成」可点性 ＋ 就地一句）——判据只有一份（`propertyNameProblem`）。 */
  onNameProblem: (name: string, excludeId?: string) => string | null
  /** 文件通道的两个活入口（`T-18`：选文件 / 选文件夹）——能力面由端口上报，这里只透传。 */
  fileOps: { canPickFile: boolean; canPickFolder: boolean; canSaveAs: boolean; onPickFiles: () => void; onPickFolder: () => void }
  /** 属性库用量读数（§3.6）与删除（§3.2）；`options` = 每个选项的用量（θ4 删选项用）。 */
  usage: Record<string, { pages: number; values: number; options: Record<string, number> }>
  onDeleteProperty: (defId: string) => void
  themeId: string
  mode: ThemeMode
  fontSize: FontSizeStep
  lineHeight: LineHeightStep
  columnWidth: ColumnWidthStep
  /** 只传改动的那几项（主题 id / 浅深 / 三个排版档）。 */
  onSetAppearance: (patch: Partial<Pick<UiPrefs, 'themeId' | 'mode' | 'fontSize' | 'lineHeight' | 'columnWidth'>>) => void
 /** 导入页的行内标签开关（用户 裁决；本机偏好，默认开）。 */
  importInlineTags: boolean
  onToggleImportInlineTags: () => void
  /** 当前分区（**受控**：外壳持有——「打开导出页并预选」与模态化都要从外面切页，`EXPORT-MENU-1`）。 */
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  /** 导出页的口（范围 / 标签 / 计数 / 开始导出）——外壳持有，页面只画。 */
  exportPage: ExportPageProps
  onNotify: (message: string) => void
  /** 当前版本号与阶段号：构建期注入，见 src/version.ts。 */
  version: string
  stage: string
  /** 构建时刻，已格式化；未注入时为空串。 */
  build: string
  /** 更新日志，来自仓库的 CHANGELOG.md。 */
  changelog: ChangelogRelease[]
  /** V2b：同步位置（共享目录路径）与它的状态文案。空串 = 不同步。 */
  syncDirectory: string
  onSyncDirectoryChange: (directory: string) => void
  syncStatusText: string
  onSyncNow: () => void
  /** 本机设备标识（截断显示）——同步的游标与冲突定序按它走，排查时用得上。 */
  deviceIdPreview: string
  /** V2c：检索索引状态（R09-SEARCH-6 / R09-SET-13）；null = 还在读。 */
  indexStatus: SearchIndexStatus | null
  /** 0.5 数据安全（`03` §15.9）：备份状态与动作——外壳负责数据，这一块只负责画与点。 */
  backup: BackupSummary
  /** 移动形态（`10` §4.7，4b）：窄档 = 独立全屏页「分区列表 → 子页」——桌面左分栏整条收掉。 */
  compact?: boolean
  /** 窄档列表页的出口（`D-068` 真机：弹窗头 ✕ 与子页返回叠成两个控件、✕ 也不符合移动直觉）——
      列表页自己带一条 sticky「← 返回」；桌面与子页不受影响。 */
  onClose?: () => void
 /** 批 ζ（）：移动端**层级单源**（提到外壳）——列表页 / 子页；屏上返回与系统返回共用它。 */
  level: SettingsLevel
  onLevelChange: (level: SettingsLevel) => void
}

/**
 * 设置（docs/09 §4.6）：**左分栏 ＋ 右栏表单**——AI 能力 / 同步 / 检索索引 / 外观与主题 /
 * 全局属性管理 / **数据（组：备份与恢复 · 导出 · 导入）** / 关于（`R09-SET-17` 的分区表；只有「数据」
 * 是可展开的组）。数据组三页与页头住在 `SettingsData.tsx`、属性字典住在 `SettingsProperties.tsx`——
 * 拆开是为了体量门（`check:size` 600 行）与「每个页面认自己的输入」。
 *
 * **本组件仍是「视图」形态**：`R09-SET-16` 的居中模态化（⌘, 打开、`view` 只剩编辑器与回收站）随
 * 数据区下一刀、与外壳一起改。同步从 V2b 起是真实能力（共享目录「同步位置」＋ 状态 ＋ 本机标识）；
 * 原型里的 S3 / 局域网 / 设备列表未实现、未排期，不在这里占位。关于卡片显示真实版本号与更新日志
 * （构建期注入，见 src/version.ts）。
 */
export function SettingsView({
  aiConfig, aiReady, onSaveAi, properties, usage, onCreateProperty, onRenameProperty, onDeleteProperty, onNameProblem, propertyOps, fileOps,
  themeId, mode, fontSize, lineHeight, columnWidth, onSetAppearance, onNotify,
  version, stage, build, changelog, importInlineTags, onToggleImportInlineTags,
  syncDirectory, onSyncDirectoryChange, syncStatusText, onSyncNow, indexStatus, backup, section, onSectionChange, exportPage, compact, onClose, level, onLevelChange,
}: SettingsViewProps) {
  /** 左分栏选中项与「数据」组的展开态（`R09-SET-17`）：默认进「AI 能力」（分区表的第一条）。 */
  const [dataOpen, setDataOpen] = useState(true)
  /** 统一标题栏的返回（批 ζ）：**一层一个返回**——子页→列表页，列表页→关设置；与系统返回键共走同一条栈。 */
  const backFromSettings = () => { if (level === 'page') onLevelChange('list'); else onClose?.() }
  const [draft, setDraft] = useState<AiSettingsValue>(aiConfig)
  // 本次会话开始时记下的版本号：与当前版本不同就说明刚更新过（首次运行没有基准，不提示）。
  const [seenVersion] = useState(() => loadSeenVersion())
  const [openVersions, setOpenVersions] = useState<Record<string, boolean>>({})
  const hasUnseenUpdate = version !== '' && seenVersion !== null && seenVersion !== version

  useEffect(() => {
    if (version) saveSeenVersion(version)
  }, [version])

  const pickTheme = (mode: ThemeMode) => (event: MouseEvent<HTMLButtonElement>) => {
    void event
    onSetAppearance({ mode })
  }

  const navEntry = (id: SettingsSection, label: string, icon: Parameters<typeof Icon>[0]['name']) => (
    <button key={id} type="button" className={section === id ? 'is-active' : ''} onClick={() => onSectionChange(id)}>
      <Icon name={icon} size={16} decorative />{label}
    </button>
  )

  /** 移动列表的一行（`10` §4.7）：点进子页；「数据」三页各是独立子页（组标注 + 三行）。 */
  const mobileEntry = (id: SettingsSection, label: string, icon: Parameters<typeof Icon>[0]['name']) => (
    <button key={id} type="button" className="sl-row" onClick={() => { onSectionChange(id); onLevelChange('page') }}>
      <span className="ic"><Icon name={icon} size={20} decorative /></span>{label}
      <span className="ch"><Icon name="chevron-right" size={20} decorative /></span>
    </button>
  )

  return (
    <div className="set-body">
      {/* 批 ζ（）：**统一标题栏**（返回 ＋ 标题同栏，`10` §4.7）——列表页与子页**同一个控件**，
          只有标题与 `onBack` 不同（原来两条 `.set-back` 一「返回」一「设置」、几何也两套）。 */}
      {/* 类名按批 ζ 契约（`@0` 614）：`.set-topbar` / `.tb-back` / `.tb-ic` / `.tb-t`——样式在 `settings.css`。
          阴影 = **常驻极淡 `--shadow`**（分隔靠它；无底线）——620 已撤回「仅滚动时浮起」，**不需要滚动挂钩**。 */}
      {compact ? (
        <div className="set-topbar">
          <button type="button" className="tb-back" aria-label="返回" title="返回" onClick={backFromSettings}>
            <span className="tb-ic"><Icon name="arrow-left" size={20} decorative /></span>
          </button>
          <span className="tb-t">{level === 'page' ? SECTION_TITLES[section] : '设置'}</span>
        </div>
      ) : null}
      {compact && level === 'list' ? (
        <nav className="set-list" aria-label="设置分区">
          {mobileEntry('ai', 'AI', 'sparkles')}
          <div className="sl-grp">编辑</div>
          {mobileEntry('appearance', '外观', 'sun')}
          {mobileEntry('properties', '属性', 'properties')}
          <div className="sl-grp">数据</div>
          {mobileEntry('sync', '同步', 'refresh')}
          {mobileEntry('backup', '备份与恢复', 'archive')}
          {mobileEntry('export', '导出', 'file-copy')}
          {mobileEntry('import', '导入', 'copy')}
          {mobileEntry('index', '搜索', 'search')}
          <div className="sl-grp">其他</div>
          {mobileEntry('about', '关于', 'help')}
        </nav>
      ) : (
      <div className="set-split">
          {compact ? null : (
            <nav className="set-nav" aria-label="设置分区">
              {navEntry('ai', 'AI', 'sparkles')}
              <div className="set-grp">编辑</div>
              <div className="set-sub">
                {navEntry('appearance', '外观', 'sun')}
                {navEntry('properties', '属性', 'properties')}
              </div>
              {/* 「数据」是唯一可展开的组（`R09-SET-17`）：同步 / 备份 / 导出 / 导入 / 搜索。 */}
              <button type="button" className="set-grp" aria-expanded={dataOpen} onClick={() => setDataOpen((open) => !open)}>
                <Icon name="archive" size={16} decorative />数据
                <span className="chev"><Icon name={dataOpen ? 'chevron-up' : 'chevron-down'} size={14} decorative /></span>
              </button>
              {dataOpen ? (
                <div className="set-sub">
                  {navEntry('sync', '同步', 'refresh')}
                  {navEntry('backup', '备份与恢复', 'archive')}
                  {navEntry('export', '导出', 'file-copy')}
                  {navEntry('import', '导入', 'copy')}
                  {navEntry('index', '搜索', 'search')}
                </div>
              ) : null}
              <div className="set-grp">其他</div>
              {navEntry('about', '关于', 'help')}
            </nav>
          )}
            <div className="set-pane">
              {/* 子页不再自带返回行：返回在**统一标题栏**里（批 ζ）——避免「两个返回」两套几何。 */}
              {section === 'ai' ? (
                <>
                  <PageHead title="模型服务" />
          <div className="set-card">
            <div className="frow">
              <label htmlFor="set-ai-base">服务地址</label>
              <div className="ctl">
                <input
                  id="set-ai-base"
                  className="inp"
                  value={draft.baseUrl}
                  placeholder="服务方提供的接口地址（如 https://api.deepseek.com/v1）"
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                />
              </div>
            </div>
            <div className="frow">
              <label htmlFor="set-ai-model">模型</label>
              <div className="ctl">
                <input
                  id="set-ai-model"
                  className="inp"
                  value={draft.model}
                  placeholder="服务方提供的模型名（以服务方文档为准；写错会报模型不存在）"
                  onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                />
              </div>
            </div>
            <div className="frow">
              <label htmlFor="set-ai-key">密钥</label>
              <div className="ctl">
                <input
                  id="set-ai-key"
                  className="inp"
                  type="password"
                  value={draft.apiKey}
                  placeholder="sk-…"
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                />
              </div>
            </div>
            <div className="frow">
              <label />
              <div className="ctl"><span className="note">密钥仅存本机</span></div>
            </div>
            <div className="frow">
              <label />
              <div className="ctl">
                {aiReady ? null : <span className="note">填写三项后可用</span>}
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn btn-brand"
                  onClick={() => onSaveAi({ ...draft })}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
                </>
              ) : null}

              {section === 'sync' ? (
                <>
                  <PageHead title="同步" />
          <div className="set-card">
            <h3><Icon name="refresh" size={16} decorative />同步</h3>
            <div className="frow">
              <label htmlFor="set-sync-dir">同步位置</label>
              <div className="ctl">
                <input
                  id="set-sync-dir"
                  className="inp"
                  type="text"
                  value={syncDirectory}
                  placeholder="例如 /Users/你/OneDrive/moqi-sync（留空 = 不同步）"
                  onChange={(event) => onSyncDirectoryChange(event.target.value)}
                />
              </div>
            </div>
            <div className="frow">
              <label>状态</label>
              <div className="ctl">
                <span className="note" data-sync-status={syncStatusText}>{syncStatusText}</span>
                <span style={{ flex: 1 }} />
                <button type="button" className="btn" onClick={onSyncNow} disabled={!syncDirectory}>立即同步</button>
              </div>
            </div>
          </div>
                </>
              ) : null}

              {section === 'index' ? (
                <>
                  <PageHead title="搜索" />
          {/* V2c：检索索引状态（`09-桌面端交互规范` §6.3 `R09-SEARCH-6` / `R09-SET-13`）。
              **降级要看得见**：用哪条通路、索引了多少块、上次整份重建是什么时候——不静默少一块能力。 */}
          <div className="set-card">
            <h3><Icon name="search" size={16} decorative />搜索</h3>
            <div className="frow">
              <label>索引规模</label>
              <div className="ctl"><span className="note">{indexStatus ? `${indexStatus.indexed} 块` : '读取中…'}</span></div>
            </div>
            <div className="frow">
              <label>上次重建</label>
              <div className="ctl">
                <span className="note">
                  {indexStatus === null ? '读取中…'
                    : indexStatus.engine === 'memory-scan' ? '不适用（没有索引）'
                      : indexStatus.rebuiltAt === null ? '未知'
                        : formatRelative(indexStatus.rebuiltAt)}
                </span>
              </div>
            </div>
            <div className="frow">
              <label>拼音覆盖</label>
              <div className="ctl">
                <span className="note">
                  {indexStatus === null ? '读取中…'
                    : indexStatus.engine === 'memory-scan' ? '按需计算（没有索引）'
                      : `${indexStatus.pinyinIndexed} / ${indexStatus.indexed} 块`}
                  <span className="sub-hint">（输拼音找中文：yinhang → 银行；老库在启动时自动回填）</span>
                </span>
              </div>
            </div>
            {indexStatus && indexStatus.failures > 0 ? (
              <div className="frow">
                <label>写入失败</label>
                <div className="ctl"><span className="note">{indexStatus.failures} 条</span></div>
              </div>
            ) : null}
          </div>

                </>
              ) : null}

              {section === 'backup' ? <DataBackupPage backup={backup} onNotify={onNotify} compact={compact} /> : null}
              {section === 'export' ? <DataExportPage {...exportPage} compact={compact} fileOps={fileOps} /> : null}
              {section === 'import' ? <DataImportPage inlineTags={importInlineTags} onToggleInlineTags={onToggleImportInlineTags}
                compact={compact} fileOps={fileOps} /> : null}

              {section === 'appearance' ? (
                <>
                  <PageHead title="外观" />
          <div className="set-card">
            <h3><Icon name="sun" size={16} decorative />外观与主题<span className="sub">20 套主题 · 浅深 · 排版三轴</span></h3>
            <div className="frow">
              <label>主题</label>
              <div className="ctl">
                <select className="inp set-select" value={themeId} aria-label="主题" onChange={(event) => onSetAppearance({ themeId: event.target.value })}>
                  {THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
                </select>
              </div>
            </div>
            <div className="frow">
              <label>浅深</label>
              <div className="ctl">
                <div className="seg" role="group" aria-label="浅深">
                  <button type="button" className={mode === 'light' ? 'is-on' : ''} onClick={pickTheme('light')}>浅色</button>
                  <button type="button" className={mode === 'dark' ? 'is-on' : ''} onClick={pickTheme('dark')}>深色</button>
                  <button type="button" className={mode === 'system' ? 'is-on' : ''} onClick={pickTheme('system')}>跟随系统</button>
                </div>
              </div>
            </div>
            <div className="frow">
              <label>正文字号</label>
              <div className="ctl">
                <div className="seg" role="group" aria-label="正文字号">
                  {FONT_SIZE_STEPS.map((step) => (
                    <button key={step.value} type="button" className={fontSize === step.value ? 'is-on' : ''} onClick={() => onSetAppearance({ fontSize: step.value })}>{step.label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="frow">
              <label>行高</label>
              <div className="ctl">
                <div className="seg" role="group" aria-label="行高">
                  {LINE_HEIGHT_STEPS.map((step) => (
                    <button key={step.value} type="button" className={lineHeight === step.value ? 'is-on' : ''} onClick={() => onSetAppearance({ lineHeight: step.value })}>{step.label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="frow">
              <label>正文列宽</label>
              <div className="ctl">
                <div className="seg" role="group" aria-label="正文列宽">
                  {COLUMN_WIDTH_STEPS.map((step) => (
                    <button key={step.value} type="button" className={columnWidth === step.value ? 'is-on' : ''} onClick={() => onSetAppearance({ columnWidth: step.value })}>{step.label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="hint">字号 / 行高 / 列宽只作用于编辑区（档位即钳制，不提供自由输入）。</div>
          </div>

                </>
              ) : null}

              {section === 'properties' ? (
                <SettingsProperties
                  properties={properties}
                  usage={usage}
                  onCreateProperty={onCreateProperty}
                  onRenameProperty={onRenameProperty}
                  onDeleteProperty={onDeleteProperty}
                  onNameProblem={onNameProblem}
                  ops={propertyOps}
                />
              ) : null}

              {section === 'about' ? (
                <>
                  <PageHead title="关于" />
          <div className="set-card">
            <h3><Icon name="help" size={16} decorative />关于<span className="sub">版本与更新日志</span></h3>
            {/* B 批（`R09-STATE-5`）：关于页的「版本号来自 package.json…」实现说明已删（界面自证；实现细节不属 UI） */}
            <div className="frow">
              <label>当前版本</label>
              <div className="ctl">
                <span className="ver">{version || '未注入'}</span>
                {stage ? <span className="attr">阶段 {stage}</span> : null}
                {hasUnseenUpdate ? <span className="attr kv">本次更新</span> : null}
                <span style={{ flex: 1 }} />
                {build ? <span className="note">构建于 {build}</span> : null}
              </div>
            </div>
            <div className="rel">
              <div className="rel-h"><Icon name="history" size={16} decorative />更新日志<span className="sub">来自 CHANGELOG.md</span></div>
              {changelog.length === 0 ? (
                <div className="rel-empty">没有可显示的更新记录。</div>
              ) : changelog.map((release) => {
                const isOpen = openVersions[release.version] ?? release.version === version
                return (
                  <div className="rel-item" key={release.version}>
                    <button
                      type="button"
                      className="rel-head"
                      aria-expanded={isOpen}
                      onClick={() => setOpenVersions({ ...openVersions, [release.version]: !isOpen })}
                    >
                      <span className="v">{release.version}</span>
                      <span className="d">{release.unreleased ? '未发布' : release.date ?? '未标注日期'}</span>
                      {release.version === version ? <span className="attr kv">当前</span> : null}
                      <span className="chev"><Icon name={isOpen ? 'chevron-up' : 'chevron-down'} size={14} decorative /></span>
                    </button>
                    {isOpen ? (
                      <div className="rel-body">
                        {release.sections.map((section, index) => (
                          <div className="rel-sec" key={`${release.version}-${index}`}>
                            {section.title ? <div className="t">{section.title}</div> : null}
                            <ul>
                              {section.items.map((item) => (
                  <li key={item}>
                    {/* 条目里的 `**粗体**` 渲染成真粗体（`splitChangelogBold`）：CHANGELOG 是 Markdown，
                        直接显示星号在界面上就是「没渲染」的样子。 */}
                    {splitChangelogBold(item).map((part, index) => (part.bold ? <strong key={index}>{part.text}</strong> : part.text))}
                  </li>
                ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
                </>
              ) : null}
            </div>
          </div>
      )}
    </div>
  )
}
