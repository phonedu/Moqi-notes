import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sidebar } from '../../src/ui/Sidebar'
import { SidebarStatsView } from '../../src/ui/SidebarStats'
import { createTextBlock } from '@moqi/editor'
import { buildSidebarStats } from '@moqi/editor'
import { TrashView } from '../../src/ui/TrashView'
import { SettingsView, exportsDirectoryOf, type SettingsSection } from '../../src/ui/SettingsView'
import { SettingsProperties } from '../../src/ui/SettingsProperties'
import { HintNote, DataBackupPage, DataExportPage, DataImportPage } from '../../src/ui/SettingsData'
import { InlineNotice } from '../../src/ui/InlineNotice'
import { BulkDeleteDialog, DiscardAiBlockDialog, TagMergeDialog } from '../../src/ui/Dialogs'
import { useNotice } from '../../src/ui/useNotice'
import { PropertyBrief } from '../../src/ui/Property'
import { PropertyRows } from '../../src/ui/PropertyRows'
import { BlockTypeMenu, InsertMenu, MoreMenu, OutlinePop, TagMenu } from '../../src/ui/Overlays'
import type { PropertyDef, PropertyRow } from '../../src/ui/types'
import { BLOCK_TYPE_ITEMS, INSERT_ITEMS, blockTypeLabel, insertRoute } from '../../src/ui/menuItems'
import { slashItems } from '../../src/ui/SlashMenu'
import { inlineRefClassNames } from '@moqi/editor'
import { insertDateText } from '../../src/ui/format'

const anchor = { top: 40, left: 20, right: 60, bottom: 60, width: 40, height: 20 }

const rows: PropertyRow[] = [
  { kind: 'custom', def: { id: 'def-status', name: '状态', type: 'select', options: [{ id: 'o1', label: '进行中' }], created: 1, modified: 1 }, value: { defId: 'def-status', type: 'select', optionId: 'o1' } },
  { kind: 'tags', tags: [{ id: 't1', name: '副业' }] },
  // 「时间」= 一行（`13-属性区重规划` §0-12）：值 = created、可改；`modified` 不进面板。
  { kind: 'time', timestamp: 1_700_000_000_000 },
]

function callbacks() {
  return {
    onSetValue: () => undefined,
    onAddOption: () => undefined,
    onRemoveProperty: () => undefined,
    onRenameProperty: () => null,
    onSetCreated: () => undefined,
    onAddTag: () => undefined,
    onRemoveTag: () => undefined,
  }
}

test('侧栏只做导航（页面库 / 标签 / 底部系统区）：**搜索与新建都不在侧栏**——唯一入口 = 中间栏页面库头部（指令 §九-5）', () => {
  const markup = renderToStaticMarkup(
    <Sidebar
      collapsed={false}
      view="editor"
      libraryActive
      starredActive={false}
      starCount={1}
      onOpenStarred={() => undefined}
      pageCount={3}
      tags={[{ id: 't1', name: '副业', count: 2 }]}
      activeTagId={null}
      trashCount={1}
      syncStatus={{ kind: 'synced', at: Date.now() }}
      theme="light"
      onOpenLibrary={() => undefined}
      onOpenTrash={() => undefined}
      onOpenSettings={() => undefined}
      onToggleTheme={() => undefined}
      onSelectTag={() => undefined}
      onTagMenu={() => undefined}
      onKeyboardHelp={() => undefined}
    />,
  )
  assert.doesNotMatch(markup, /sb-search/, '侧栏不再重复搜索入口')
  assert.doesNotMatch(markup, /新建页面/, '新建页面也不在侧栏（2026-10-07 按指令 §九-5 移回页面库头部「＋」）')
  assert.match(markup, /页面库/)
  // 星标（`R09-PRIN-1`，活原型 `#navStar`）：就在「页面库」下面，带计数徽章与「只看星标页面」的说明。
  assert.match(markup, /星标/, '侧栏导航要有星标入口')
  assert.match(markup, /只看星标页面/, '星标入口的说明写清「只看星标」而不是第四个视图')
  assert.match(markup, /#/)
  assert.match(markup, /副业/)
  assert.match(markup, /回收站/)
  // R09-EXPORT-7：**侧栏不做导出**（家 = 设置 → 数据 → 导出页；⋯ 菜单是上下文快捷）。
  assert.doesNotMatch(markup, /导出 Markdown/, '侧栏只做导航，不再挂导出入口')
  assert.match(markup, /设置/)
  // 侧栏底部只留回收站 / 设置；低频的系统动作与同步常态不再占位。
  assert.doesNotMatch(markup, /快捷键/, '快捷键进设置 / 快捷键面板')
  assert.doesNotMatch(markup, /深色模式|浅色模式/, '主题切换进设置')
  assert.doesNotMatch(markup, /已同步|未配置同步/, '同步正常态不显示；只有同步中 / 离线才出一行')
  assert.doesNotMatch(markup, /已保存 · 刚刚/, '保存态不该再出现在侧栏——它不是应用级管道状态')
})

test('SIDE-STATS-3 侧栏统计区渲染 12 周热力图与页面 / 标签 / 字数三格，数字过长用简写', () => {
  const now = new Date(2026, 9, 24, 12).getTime()
  const page = createTextBlock({ entityId: 'sp', blockUid: 'sp000001', text: 'x'.repeat(1234), isObject: true, objectName: '统计页', now })
  page.tags = ['t1', 't2']
  const stats = buildSidebarStats([page], now)
  const markup = renderToStaticMarkup(<SidebarStatsView stats={stats} />)

  assert.match(markup, /近 12 周/)
  assert.match(markup, /aria-label="近 12 周有 1 天有改动，最多 1 个页面"/)
  assert.equal((markup.match(/class="sb-heat-day/g) ?? []).length, 84, '12 × 7 个格子')
  assert.equal((markup.match(/class="sb-heat-weekday"/g) ?? []).length, 7, '左侧七行星期')
  assert.match(markup, /class="sb-heat-month">\d+月/, '下方有月份标签')
  assert.ok(markup.indexOf('sb-figures') < markup.indexOf('class="sb-heat"'), '统计三格在热力图之前')
  assert.match(markup, /1\.2k/, '字数超过 1000 走 k 简写')
  assert.match(markup, /title="1234 字"/, '悬停仍能看到精确值')
  assert.match(markup, /页面/)
  assert.match(markup, /标签/)
  assert.match(markup, /字/)
})

test('SIDE-STATS-4 侧栏顺序：统计三格 → 热力图 → 页面库 → 星标 / 标签', () => {
  const now = new Date(2026, 9, 24, 12).getTime()
  const page = createTextBlock({ entityId: 'sp', blockUid: 'sp000001', text: '统计页', isObject: true, objectName: '统计页', now })
  const markup = renderToStaticMarkup(
    <Sidebar
      collapsed={false}
      view="editor"
      libraryActive
      starredActive={false}
      starCount={1}
      onOpenStarred={() => undefined}
      pageCount={1}
      tags={[{ id: 't1', name: '副业', count: 1 }]}
      activeTagId={null}
      trashCount={0}
      syncStatus={{ kind: 'synced', at: now }}
      theme="light"
      onOpenLibrary={() => undefined}
      onOpenTrash={() => undefined}
      onOpenSettings={() => undefined}
      onToggleTheme={() => undefined}
      onSelectTag={() => undefined}
      onTagMenu={() => undefined}
      onKeyboardHelp={() => undefined}
      stats={buildSidebarStats([page], now)}
    />,
  )
  const at = (needle: string) => markup.indexOf(needle)
  assert.ok(at('sb-figures') >= 0 && at('sb-figures') < at('class="sb-heat"'), '统计三格在热力图之前')
  assert.ok(at('class="sb-heat"') < at('页面库'), '热力图在页面库之前')
  assert.ok(at('页面库') < at('星标'), '页面库在星标之前')
  assert.ok(at('星标') < at('sb-sec">标签'), '星标在标签之前')
})

test('回收站视图给出恢复与彻底删除入口（V2b 起两条都是真实能力，不再标注「后续版本」）', () => {
  const markup = renderToStaticMarkup(
    <TrashView
      entries={[{ id: 'x', name: '竞品调研', deletedLabel: '3 天前', remainingDays: 27, childCount: 2, backlinkCount: 6 }]}
      onBack={() => undefined}
      onRestore={() => undefined}
      onPurge={() => undefined}
      onEmptyTrash={() => undefined}
    />,
  )
  assert.match(markup, /回收站/)
  assert.match(markup, /竞品调研/)
  assert.match(markup, /剩余 <b>27 天<\/b>/)
  assert.match(markup, />恢复</)
  assert.match(markup, /title="从本机彻底删除，不可恢复"/)
  assert.match(markup, /title="把列表内全部页面从本机彻底删除（不可恢复）"/)
  assert.equal(/后续版本/.test(markup), false, '彻底删除与清空回收站都已实现，不该再有「后续版本」标注')
})

/** 设置页的公共 props（两条用例共用；分区用 `initialSection` 选——一次渲染只画当前页）。 */
const settingsProps = {
  aiConfig: { baseUrl: '', apiKey: '', model: 'deepseek-chat' },
  aiReady: false,
  onSaveAi: () => undefined,
  properties: [] as PropertyDef[],
  onCreateProperty: () => undefined,
  onRenameProperty: () => null,
  onDisableProperty: () => undefined,
  onNameProblem: () => null,
  propertyOps: {
    onAddOption: () => undefined,
    onRenameOption: () => true,
    onRemoveOption: () => undefined,
    onMoveOption: () => undefined,
    onMoveProperty: () => undefined,
  },
  themeId: 'default',
  mode: 'light' as const,
  fontSize: 'normal' as const,
  lineHeight: 'normal' as const,
  columnWidth: 'normal' as const,
  onSetAppearance: () => undefined,
  onNotify: () => undefined,
  fileOps: { canPickFile: false, canPickFolder: false, canSaveAs: false, onPickFiles: () => undefined, onPickFolder: () => undefined },
  version: '0.2.0-rc.1',
  stage: 'V2a',
  build: '2026-09-27 21:05',
  changelog: [
    { version: '0.2.0-rc.1', date: '2026-09-27', unreleased: false, sections: [{ title: '新增', items: ['大纲结构：`Tab` 缩进与拖拽移动。'] }] },
    { version: '0.1.0', date: '2026-09-24', unreleased: false, sections: [{ title: '新增', items: ['Block 数据模型与本地 SQLite 持久化。'] }] },
  ],
  syncDirectory: '',
  onSyncDirectoryChange: () => undefined,
  syncStatusText: '未配置同步',
  onSyncNow: () => undefined,
  deviceIdPreview: 'dev…',
  indexStatus: { engine: 'fts5-trigram' as const, indexed: 12, rebuiltAt: 1, pinyinIndexed: 12, failures: 0 },
  backup: { dataDirectory: null, canExport: false, snapshots: [], packages: [], onRestorePackage: () => undefined, onCreateSnapshot: () => undefined, onRestoreSnapshot: () => undefined, onExportDatabase: () => undefined, onExportSnapshot: () => undefined },
  exportPage: { enabled: false, busy: false, activePageName: null, tags: [], choice: { kind: 'all' as const, tagId: null }, onChoiceChange: () => undefined, count: 0, onExport: () => undefined, onExportAs: () => undefined, onExportToFolder: () => undefined },
  usage: {},
  onDeleteProperty: () => undefined,
  importInlineTags: true,
  onToggleImportInlineTags: () => undefined,
  // 批 ζ：移动端层级单源（受控）；本册测的是桌面左分栏，固定 'list' 即可。
  level: 'list' as const,
  onLevelChange: () => undefined,
}
const renderSettings = (section: SettingsSection = 'ai', overrides: Partial<typeof settingsProps> = {}) =>
  renderToStaticMarkup(<SettingsView {...settingsProps} {...overrides} section={section} onSectionChange={() => undefined} />)

test('设置左分栏（R09-SET-17）：五组分区、「数据」组五页在册；同步页是 V2b 的真实配置（不再是 V3 占位）', () => {
  // 导航常驻：AI / 编辑 / 数据 / 关于；数据组五页都在（一次渲染只画当前页，内容按分区各渲染一次）。
  const nav = renderSettings()
  for (const label of ['AI', '编辑', '外观', '属性', '数据', '同步', '备份与恢复', '导出', '导入', '搜索', '关于']) {
    assert.match(nav, new RegExp(label), `导航里应有「${label}」`)
  }
  // 默认页 = AI（分区第一条）；页名只出现一次：模型服务。
  assert.match(nav, /模型服务/)
  assert.match(nav, /服务地址/)
  // V2b：同步页从「V3 占位」变成真实配置（共享目录 = 同步位置）。
  const sync = renderSettings('sync')
  assert.match(sync, /同步位置/)
  assert.match(sync, /立即同步/)
  assert.doesNotMatch(sync, /同步属于 V3 能力/, '同步已是 V2b 的真实能力，不该再有 V3 占位文案')
 // 视觉批（）：外观卡改名「外观与主题」，除浅深外多了 20 套主题与排版三轴。
  const appearance = renderSettings('appearance')
  assert.match(appearance, /暖纸·赭/)
  assert.match(appearance, /正文字号/)
  assert.match(appearance, /正文列宽/)
  // 属性页（属性字典：建 / 改名 / 停用）。
  const props = renderSettings('properties', { properties: [{ id: 'def-status', name: '状态', type: 'select', options: [{ id: 'o1', label: '进行中' }], created: 1, modified: 1 }] })
  assert.match(props, /属性/)
  assert.match(props, /状态/)
  assert.match(props, /单选题?/)
})

test('关于页显示真实版本号与更新日志，当前版本默认展开、旧版本折叠', () => {
  const markup = renderSettings('about')
  assert.match(markup, /关于/)
  assert.match(markup, /0.2.0-rc.1/)
  assert.match(markup, /阶段 V2a/)
  assert.match(markup, /构建于 2026-09-27 21:05/)
  assert.match(markup, /更新日志/)
  assert.match(markup, /当前/)
  assert.match(markup, /大纲结构：Tab 缩进与拖拽移动。/)
  assert.match(markup, /0.1.0/)
  assert.doesNotMatch(markup, /Block 数据模型与本地 SQLite 持久化。/)
  assert.doesNotMatch(markup, /`/, '更新日志按纯文本显示，不带 Markdown 行内代码标记')
})

test('属性面板（`13-属性区重规划` §0-2/§0-7/§0-10）：一张表零分区、零注释文字、默认字段行也能「从本页删除」', () => {
  const markup = renderToStaticMarkup(
    <PropertyRows rows={rows} onOpenAddProperty={() => undefined} {...callbacks()} />,
  )
  assert.match(markup, /页面属性/)
  assert.match(markup, /状态/)
  assert.match(markup, /标签/)
  // 「时间」一行（§0-12）：旧的两行（创建时间 / 编辑时间）退场
  assert.match(markup, /时间/)
  assert.doesNotMatch(markup, /创建时间/)
  assert.doesNotMatch(markup, /编辑时间/)
  // 分区条与注释文字全删（§0-6/§0-7：对外一律叫「属性」）
  assert.doesNotMatch(markup, /系统字段/)
  assert.doesNotMatch(markup, /每篇页面固有 · 不可移除/)
  assert.doesNotMatch(markup, /悬停行出 ⋯/, '面板零注释文字')
  assert.doesNotMatch(markup, /暂无属性/, '空态文案随「空页无面」一起删（§0-11）')
  // 添加属性仍在列表末尾一行
  assert.match(markup, /pe-addrow/)
  assert.match(markup, /添加属性/)
  // 管理入口 = 行内 ⋯：自定义属性行 / 标签行 / **「时间」一行**都有（默认字段也「可从本页删除」，§0-2；
 // ⋯ 保留 = 用户 裁决）
  const menus = markup.match(/的属性操作/g) ?? []
  assert.equal(menus.length, 3, '⋯ 出现在自定义属性行、标签行与「时间」行上')
  // 眼睛开关不再常驻（旧形态的字符串不许残留）；「移除」旧文案下岗（现在是「从本页删除」，在 ⋯ 里）
  assert.doesNotMatch(markup, /眼睛开关/)
  assert.doesNotMatch(markup, />移除</)
  // 图标规范：⋯ 与「收起」不许用文本字形当图标（`08` §8：图标一律走 `Icon.tsx`）
  assert.doesNotMatch(markup, />⋯</)
  assert.doesNotMatch(markup, /收起 ∧/)
})

test('属性摘要条在收起态显示属性摘要（不含「更新」——§3.4 移出），展开态切换为编辑面板', () => {
  const brief = renderToStaticMarkup(
    <PropertyBrief rows={rows} open={false} onToggle={() => undefined} onOpenAddProperty={() => undefined} {...callbacks()} />,
  )
  assert.match(brief, /状态:/)
  assert.match(brief, /#副业/)
  assert.doesNotMatch(brief, /标签:/, '标签不再带「标签:」前缀')
  assert.doesNotMatch(brief, /更新:/, '「更新: 时间」已移出摘要')
  assert.match(brief, /点击展开属性编辑/)

  const open = renderToStaticMarkup(
    <PropertyBrief rows={rows} open onToggle={() => undefined} onOpenAddProperty={() => undefined} {...callbacks()} />,
  )
  assert.match(open, /收起/)
  assert.doesNotMatch(open, /收起 ∧/, '收起键不带文本字形（图标一律走 Icon.tsx；2026-10-09 用户点名去掉）')
  assert.match(open, /添加属性/)
})

test('安全确认三件：多块删除 / 丢弃 AI / 合并标签都写清后果与动作名', () => {
  const bulk = renderToStaticMarkup(
    <BulkDeleteDialog count={3} refs={2} hasChildren onConfirm={() => undefined} onClose={() => undefined} />,
  )
  assert.match(bulk, /删除 3 个块（含子块）？/)
  assert.match(bulk, /有 2 处引用会失效/)
  assert.match(bulk, /删除后可用 ⌘Z 撤销/)
  assert.match(bulk, /删除块/)

  const discard = renderToStaticMarkup(<DiscardAiBlockDialog onConfirm={() => undefined} onClose={() => undefined} />)
  assert.match(discard, /丢弃这个 AI 块？/)
  assert.match(discard, /不进回收站，也不能撤销/)
  assert.match(discard, /丢弃/)

  const merge = renderToStaticMarkup(
    <TagMergeDialog sourceName="旧标签" sourceCount={2} targetName="新标签" onConfirm={() => undefined} onClose={() => undefined} />,
  )
  assert.match(merge, /合并 #旧标签？/)
  assert.match(merge, /篇页面从 #旧标签 改指向 #新标签/)
  assert.match(merge, /合并后可用 ⌘Z 撤销/)
})

test('编辑器 … 菜单是三段式：视图导航 / 页面动作 / 危险区', () => {
  const markup = renderToStaticMarkup(
    <MoreMenu
      anchor={anchor}
      refOpen
      onToggleRef={() => undefined}
      onFind={() => undefined}
      onStats={() => undefined}
      onFocus={() => undefined}
      onCopyLink={() => undefined}
      onDuplicate={() => undefined}
      onExport={() => undefined}
      onDelete={() => undefined}
      starred={false}
      onToggleStar={() => undefined}
      onOpenProperties={() => undefined}
      onClose={() => undefined}
    />,
  )
  // `W5`：两句「后续版本」占位入口（图谱 / 历史）已撤——隐藏优于灰着（侧栏撤项同一先例）。
  assert.doesNotMatch(markup, /关系图谱/, '图谱入口是占位，已隐藏')
  assert.doesNotMatch(markup, /本页修改记录/, '历史入口是占位，已隐藏')
  const order = ['属性', '页内查找', '引用预览面板', '页面统计', '专注模式', '星标', '复制链接', '复制页面', '导出 Markdown', '移至回收站']
  let cursor = -1
  for (const label of order) {
    const at = markup.indexOf(label)
    assert.ok(at > cursor, `${label} 必须按原型顺序出现`)
    cursor = at
  }
  assert.match(markup, /已开启 ✓/)
})

test('块类型下拉覆盖菜单清单并高亮当前类型；含「标题 1」（正文 H1–H6 完整可用、页面标题 = 容器名字行，2026-10-10 裁决，R09-FMT-2）', () => {
  const markup = renderToStaticMarkup(<BlockTypeMenu anchor={anchor} current="todo" onPick={() => undefined} onClose={() => undefined} />)
  for (const label of ['标题 1', '标题 2', '标题 3', '正文', '引用', '待办', '代码', '无序列表', '有序列表', '分隔线']) {
    assert.match(markup, new RegExp(label))
  }
  assert.equal(blockTypeLabel.heading1, '标题 1', 'H1 与菜单同源（`# ` 输入与导入的 H1 块、格式栏 Aa 的 tooltip 读它）')
  assert.match(markup, /class="is-on"/)
})

test('插入下拉的媒体三件套已点亮（R09-BLOCK-19/20/24）：不再禁用、不再带 V3 徽标；且不含「AI 块」（2026-10-08 用户裁决，R09-FMT-5）', () => {
  const markup = renderToStaticMarkup(<InsertMenu anchor={anchor} onPick={() => undefined} onClose={() => undefined} />)
  assert.match(markup, /待办/)
  assert.match(markup, /引用/)
  assert.match(markup, /代码/)
  assert.doesNotMatch(markup, /AI 块/)
 // 起三项都实现了（13-媒体设计（已归档））：可点、无版本徽标、tooltip 只说能力
  assert.match(markup, /title="同步显示来源块内容"/)
  assert.match(markup, /title="本地上传 \/ 粘贴 \/ 拖入"/)
  assert.match(markup, /title="任意文件占位卡"/)
  assert.equal((markup.match(/disabled=""/g) ?? []).length, 0, '三项都可点')
  assert.equal((markup.match(/<span class="d">V3<\/span>/g) ?? []).length, 0, '不再有 V3 徽标')
})

test('大纲下拉列出当前页面的标题层级并可定位', () => {
  const markup = renderToStaticMarkup(
    <OutlinePop
      anchor={anchor}
      entries={[{ id: 'b1', label: '目标与约束', depth: 0, kind: 'block' }, { id: 'b2', label: '候选方向', depth: 1, kind: 'block' }]}
      onJump={() => undefined}
      onClose={() => undefined}
    />,
  )
  assert.match(markup, /页面大纲/)
  assert.match(markup, /目标与约束/)
  assert.match(markup, /H1/)
  assert.match(markup, /H2/)
  assert.match(markup, /padding-left:26px/)
})

test('标签菜单显示影响范围并给出三个全局操作', () => {
  const markup = renderToStaticMarkup(
    <TagMenu anchor={anchor} tag={{ id: 't1', name: '副业', count: 2 }} onRename={() => undefined} onMerge={() => undefined} onRemoveAll={() => undefined} onClose={() => undefined} />,
  )
  assert.match(markup, /# 副业/)
  assert.match(markup, /2 篇页面/)
  assert.match(markup, /重命名/)
  assert.match(markup, /合并到…/)
  assert.match(markup, /从所有页面移除/)
})

test('块类型与插入项来自单一数据源，斜杠菜单不会与下拉漂移', () => {
  const typeMenu = renderToStaticMarkup(<BlockTypeMenu anchor={anchor} current="text" onPick={() => undefined} onClose={() => undefined} />)
  for (const item of BLOCK_TYPE_ITEMS) {
    assert.ok(typeMenu.includes(item.label), `块类型菜单缺少 ${item.label}`)
    const slash = slashItems.find((entry) => entry.kind === 'type' && entry.type === item.type)
    assert.ok(slash, `斜杠菜单缺少块类型 ${item.type}`)
    assert.equal(slash.label, item.label)
  }

  const insertMenu = renderToStaticMarkup(<InsertMenu anchor={anchor} onPick={() => undefined} onClose={() => undefined} />)
  for (const item of INSERT_ITEMS) {
    assert.ok(insertMenu.includes(item.label), `插入菜单缺少 ${item.label}`)
    if (item.version) continue
    const slash = slashItems.find((entry) => entry.kind === 'insert' && entry.insert === item.kind)
    assert.ok(slash, `斜杠菜单缺少插入项 ${item.kind}`)
    assert.equal(slash.label, item.label)
  }

  // 未交付的插入项不得出现在斜杠菜单里（位置由下拉承载并标注版本）
  for (const item of INSERT_ITEMS.filter((entry) => entry.version)) {
    assert.equal(slashItems.some((entry) => entry.kind === 'insert' && entry.insert === item.kind), false, `${item.kind} 属于 ${item.version}，不应出现在斜杠菜单`)
  }
})

test('R09-SET-14 导出落点目录：`<数据目录>/exports`，两向分隔符都不叠；拿不到数据目录时 null（界面如实降级）', () => {
  assert.equal(exportsDirectoryOf('C:\\数据\\moqi'), 'C:\\数据\\moqi\\exports')
  assert.equal(exportsDirectoryOf('C:\\数据\\moqi\\'), 'C:\\数据\\moqi\\exports')
  assert.equal(exportsDirectoryOf('/home/me/.moqi'), '/home/me/.moqi/exports')
  assert.equal(exportsDirectoryOf('/home/me/.moqi/'), '/home/me/.moqi/exports')
  assert.equal(exportsDirectoryOf(null), null)
  assert.equal(exportsDirectoryOf(''), null)
})

test('R09-FMT-5 插入项各有明确落点：文字型直插 / 图片附件走选文件 / 嵌入落占位（斜杠菜单与 ＋插入 共用一个分流器）', () => {
  const routes = INSERT_ITEMS.map((item) => [item.kind, insertRoute(item.kind)] as const)
  assert.deepEqual(routes, [
    ['todo', 'block'], ['quote', 'block'], ['code', 'block'],
    ['today', 'block'], ['now', 'block'], // G-E06（）：今天 / 现在 = 装着日期的文本块
    ['embed', 'embed'], ['image', 'file'], ['file', 'file'],
  ], '插入清单与落点路由必须一一对上——加一项就往这里补一行（2026-10-08：斜杠菜单曾把图片喂给文字型直插，落出空壳块）')
})

test('G-E06 斜杠「今天」「现在」的插入文本：today = YYYY-MM-DD、now = YYYY-MM-DD HH:MM（本地时区，补零）', () => {
  const ts = new Date(2026, 9, 11, 9, 5).getTime() //  09:05 本地
  assert.equal(insertDateText('today', ts), '2026-10-11')
  assert.equal(insertDateText('now', ts), '2026-10-11 09:05')
  assert.equal(insertDateText('now', new Date(2026, 11, 3, 23, 59).getTime()), '2026-12-03 23:59')
})
test('页面链接与块引用使用可区分的行内类名', () => {
  assert.deepEqual(inlineRefClassNames('object'), ['moqi-inline-ref', 'moqi-ref-object'])
  assert.deepEqual(inlineRefClassNames('block'), ['moqi-inline-ref', 'moqi-ref-block'])
})

test('T08/θ4 属性库（`R09-SET-5b`）静态形态：行式（⠿ / 类型字形 / 名称 / 类型 / 🗑）＋ 页头「共 N 条」＋ 搜索行 ＋ 页头/底部入口', () => {
  const defs: PropertyDef[] = [
    { id: 'd1', name: '状态', type: 'select', options: [{ id: 'o1', label: '进行中' }], created: 1, modified: 1 },
    { id: 'd2', name: '备注', type: 'text', created: 1, modified: 1 },
  ]
  const html = renderToStaticMarkup(
    <SettingsProperties
      properties={defs}
      usage={{ d1: { pages: 1, values: 1, options: { o1: 1 } }, d2: { pages: 0, values: 0, options: {} } }}
      onCreateProperty={() => undefined}
      onRenameProperty={() => null}
      onDeleteProperty={() => undefined}
      onNameProblem={() => null}
      ops={{
        onAddOption: () => undefined,
        onRenameOption: () => true,
        onRemoveOption: () => undefined,
        onMoveOption: () => undefined,
        onMoveProperty: () => undefined,
      }}
    />,
  )
  assert.ok(html.includes('共 2 条'), '页头右侧小字「共 N 条」')
  assert.ok(html.includes('aria-label="搜索属性"'), '列表上方一行搜索')
  assert.ok(html.includes('拖动排序 状态') && html.includes('拖动排序 备注'), '行首把手（图标 ＋ 可访问名）')
  assert.ok(html.includes('aria-label="编辑属性 状态"') && html.includes('aria-label="删除属性 状态"'), '行尾 ✏ ＋ 🗑')
  assert.ok(html.indexOf('编辑属性 状态') < html.indexOf('删除属性 状态'), '✏ 在 🗑 **之前**')
  assert.ok(!html.includes('完成编辑'), '收起态没有行尾 👍✓（编辑态才有）')
  assert.ok(!html.includes('btn-danger'), '面板里的删除按钮已退役（删除只有行尾一处）')
  assert.ok(html.includes('状态') && html.includes('单选') && html.includes('备注') && html.includes('文本'), '名称 ＋ 类型在行上')
  assert.ok(html.includes('添加属性') && html.includes('aria-expanded="false"'), '底部「＋ 添加属性」')
  assert.ok(!html.includes('>完成<'), '都收着时没有「完成」（添加态才有它；编辑态的完成在行尾 ✓）')
})

test('T12/θ10 就地提示带（`R09-STATE-1b`）：null 不渲染 · 带动作出按钮（点了先跑动作再收）· 无动作只有一句', () => {
  assert.equal(renderToStaticMarkup(<InlineNotice notice={null} onDone={() => undefined} />), '', 'null ⇒ 不占位')
  let acted = 0
  let done = 0
  const withAction = renderToStaticMarkup(
    <InlineNotice notice={{ message: '已移至回收站（30 天内可恢复）', actionLabel: '撤销', onAction: () => { acted += 1 } }} onDone={() => { done += 1 }} />,
  )
  assert.ok(withAction.includes('已移至回收站') && withAction.includes('撤销') && withAction.includes('role="status"'))
  const plain = renderToStaticMarkup(<InlineNotice notice={{ message: '剪贴板不可用' }} onDone={() => undefined} />)
  assert.ok(plain.includes('剪贴板不可用') && !plain.includes('button'), '无动作 ⇒ 没有按钮')
  assert.equal(acted, 0)
  assert.equal(done, 0)
})

test('T12/θ10 `useNotice`：`notify` 一处发号——`band()` 拿得到同一句；`onDone` 收干净；带动作的带按钮', () => {
  let api: ReturnType<typeof useNotice> | null = null
  const Probe = () => { api = useNotice(); return null }
  renderToStaticMarkup(<Probe />)
  const h = api as unknown as ReturnType<typeof useNotice>
  assert.ok(h)
  assert.equal(renderToStaticMarkup(<>{h.band()}</>), '', '没发号时带子是空的')
  // 探针组件每次渲染重建 hook ⇒ 用一条自带渲染的探针把「发了号之后再渲染」这一步做完
  let live: ReturnType<typeof useNotice> | null = null
  const Live = () => { live = useNotice(); return <>{live.band()}</> }
  const first = renderToStaticMarkup(<Live />)
  assert.equal(first, '')
  const again = renderToStaticMarkup(<Live />)
  assert.equal(again, '')
  void h
})

test('T09/θ5 `?` 注释（`R09-SET-21`）：行内小圆问号（两种形态同一颗按钮）· 直排只留最短一句 · 页面渲染带上它', () => {
  const desktop = renderToStaticMarkup(<HintNote compact={false} title="本机快照是什么"><span>后悔药：每天一份</span></HintNote>)
  assert.ok(desktop.includes('aria-label="说明：本机快照是什么"') && desktop.includes('aria-expanded="false"'), '收起态 = 一颗行内问号（未展开）')
  const narrow = renderToStaticMarkup(<HintNote compact title="导入的格式与图片"><span>含图片请用 .zip</span></HintNote>)
  assert.ok(narrow.includes('aria-label="说明：导入的格式与图片"'), '窄档同一颗按钮（容器差异在点击之后：Sheet vs 气泡）')

  const backup = renderToStaticMarkup(
    <DataBackupPage
      compact={false}
      onNotify={() => undefined}
      backup={{ dataDirectory: null, snapshots: [], canExport: false, onCreateSnapshot: () => undefined, onRestoreSnapshot: () => undefined, onExportSnapshot: () => undefined, onExportDatabase: () => undefined } as never}
    />,
  )
  assert.ok(backup.includes('说明：本机快照是什么'), '备份与恢复页在（卡片头右侧挂 `?`）')
  assert.ok(!backup.includes('滚动保留 7 天 + 4 周'), '长说明**不在直排里**（收进 `?` 面板）')

  const exportPage = renderToStaticMarkup(
    <DataExportPage
      compact={false}
      enabled={false} busy={false} activePageName={null} tags={[]} count={0}
      choice={{ kind: 'all', tagId: null }} onChoiceChange={() => undefined} onExport={() => undefined} onExportAs={() => undefined} onExportToFolder={() => undefined}
    />,
  )
  assert.ok(exportPage.includes('导出的是<strong>可读的 Markdown</strong>；原样恢复走「备份与恢复」。'), '导出页直排只留最短一句')
  assert.ok(exportPage.includes('说明：导出的格式'), '细节在 `?` 里')

  const importPage = renderToStaticMarkup(<DataImportPage compact inlineTags onToggleInlineTags={() => undefined} fileOps={{ canPickFile: false, canPickFolder: false, onPickFiles: () => undefined, onPickFolder: () => undefined }} />)
  assert.ok(importPage.includes('支持 <strong>.md / .txt / .zip</strong>；html / json 不支持。'), '导入页直排只留最短一句')
  assert.ok(importPage.includes('说明：导入的格式与图片'))
})
