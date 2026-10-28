/**
 * 编辑器插件宿主（ 收口，外壳拆分第二刀；来源：`06` §6「外壳新代码免入」）。
 *
 * **职责**：Lexical 的四个交互插件（斜杠菜单 / 引用候选 / 悬停速览 / 文本选中工具栏）＋ 输入与结构键的
 * 编排（Enter / Tab / Backspace / 名字行锚点）＋ `useStableCallback`（插件 effect 的唯一形态）。
 * **只接 props 与回调**，不持业务状态——外壳负责给。
 *
 * 落点依据：`06` §6 落点四问第 ④ 条（画与接线 → 表面组件）。
 */
import type { LexicalEditor, TextFormatType } from '@moqi/editor'
import type { AiAction, RefKind } from '@moqi/editor'
import type { Suggestion } from '@moqi/editor'
import type { BlockMarker, OutlineDraft } from '@moqi/editor'
import type { RefTrigger } from '@moqi/editor'
import { PeekContent, PeekPlugin } from './Peek'
import { TextToolbarPlugin } from './TextToolbar'
import type { BlockCapsuleOps } from '@moqi/editor'
import { useTouchEditorLayer } from '@moqi/editor'
import { SlashItem, SlashMenuPlugin } from './SlashMenu'
import { ReferenceMenuPlugin } from './ReferenceMenu'
import { useEditorPluginsCore } from '@moqi/editor'
import { ALL_FEATURES_ON, type ResolvedFeatures } from '@moqi/editor'


/** 编辑器内的 Lexical 插件集合：Enter、缩进、折叠、待办、引用跳转、斜杠菜单、AI 与文本工具栏。 */
export function EditorPlugins({ enabled, onEnter, onLeaveList, onIndent, onOutdent, onToggleCollapse, onMoveStep, onJumpRef, onOpenExternal, onPasteUrl, onPasteOutline, onMarkerTrigger, onPasteMedia, onActiveBlock, onEditor, onSlashCommand, findTargets, suggestFor, onInsertRef, onAi, onOpenAiPanel, onOpenMedia, resolvePeek, resolveRefTitle, onNotify, onAdoptRoot, onNameRowCross, onSelectNameRow, onNameRowEdge, formats, onToggleFormat, isLinkConvert, clearLinkConvert, onConvertLink, touchCompact, touchEditId, clipboard, onTouchActivate, onTouchFollow, onTouchBlank, onTouchExit, onOpenLinkDialog, blockOps, toolbarOps, features }: {
  enabled: boolean
  onEnter: (editor: LexicalEditor) => boolean
  /** 列表降级出口：光标在【有内容的列表项】行首按 Backspace → 退出列表（docs/04 §3 R04-ENTER-4）。 */
  onLeaveList: (editor: LexicalEditor, event: KeyboardEvent) => boolean
  onIndent: (editor: LexicalEditor, blockId: string) => boolean
  onOutdent: (editor: LexicalEditor, blockId: string) => boolean
  onToggleCollapse: (editor: LexicalEditor, blockId: string) => void
  onMoveStep: (direction: -1 | 1) => void
  onJumpRef: (blockId: string) => void
  onOpenExternal: (url: string) => void
  onPasteUrl: (url: string) => void
  onPasteOutline: (anchorId: string, drafts: OutlineDraft[]) => void
  /** 粘贴截图 / 图片文件（剪贴板里就是 File，spike ②）。 */
  onPasteMedia: (file: File) => void
  /** MD 打字触发：整行记号 → 转块（走与工具栏同一个入口）。 */
  onMarkerTrigger: (blockId: string, marker: BlockMarker) => void
  onActiveBlock: (blockId: string | null) => void
  onEditor: (editor: LexicalEditor | null) => void
  onSlashCommand: (editor: LexicalEditor, blockId: string, item: SlashItem, triggerText: string) => void
  findTargets: (kind: RefKind, query: string, fromId: string) => { targetId: string; label: string; hint: string }[]
  /** V2c：双链建议（规则版）——候选菜单底部那一组。 */
  suggestFor: (kind: RefKind, query: string, fromId: string) => Suggestion[]
  onInsertRef: (editor: LexicalEditor, blockId: string, kind: RefKind, trigger: RefTrigger, query: string, targetId: string, displayText: string) => void
  onAi: (action: AiAction) => void
  onOpenAiPanel: () => void
  onOpenMedia: (blockId: string) => void
  resolvePeek: (targetId: string, displayText: string) => PeekContent | null
  resolveRefTitle: (targetId: string, displayText: string) => string | null
  onNotify: (message: string) => void
  onAdoptRoot: (containerBlockId: string, items: { entityId: string; blockUid: string }[]) => void
  /** 名字行与第一个子块那处接缝的光标跨越（`04` §3.1 R04-NAME-12）；返回 true 表示按键已消费。 */
  onNameRowCross: (editor: LexicalEditor, options: { backward: boolean; deletes: boolean }) => boolean
  /** 点击空名字行（占位那一片，target 是容器元素本身）⇒ 光标落到名字行（`04` §3.1 R04-NAME-12）。 */
  onSelectNameRow: (containerId: string | null) => boolean
  /** Home / End 在名字行时落到这一行自己的行首 / 文字末尾（`04` §3.1 R04-NAME-12）。 */
  onNameRowEdge: (editor: LexicalEditor, end: boolean) => boolean
  /** 选区 / 光标处的格式（三层共用快照），透传给文本选中工具栏。 */
  formats: TextFormatType[]
  onToggleFormat: (format: TextFormatType) => void
  /** 「选中文字 → 转链接」的意图（见 linkConvertBlockRef）：候选菜单读它决定筛选与链接文字。 */
  isLinkConvert: (blockId: string) => boolean
  /** 收尾：插入完成或菜单关闭时清掉意图。 */
  clearLinkConvert: () => void
  /** 文本选中工具栏的 `[[` 按钮：插入触发词 + 记下一次性意图。 */
  onConvertLink: () => void
  /** 触控编辑态（`10` §6.3，compact 档）：只读 / 编辑两态与三个出口。 */
  touchCompact: boolean
  /** 剪贴板端口注入（D-104）：透传给触控层 → 选区气泡。 */
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> }
  touchEditId: string | null
  onTouchActivate: (blockId: string) => void
  /** θ6：编辑态点另一块——只跟「编辑块」标记，不抢焦点（`touchEditorLayer` 的口径）。 */
  onTouchFollow: (blockId: string) => void
  /** 编辑态内点空白：有块选中 → 回打字态；没有 → 退编辑（判据在 `useTouchEdit`）。 */
  onTouchBlank: () => void
  onTouchExit: () => void
  /** 键盘上方格式栏（`10` §6.3 · 2b）：`Aa` 开块类型菜单 / `＋ 块` 在编辑块下方插块 / `链接` 开对话框。 */
  onOpenLinkDialog: () => void
  /** 块操作栏（`10` §6.2 · 3a）的动作束：选中集合与批量 / 单块动作都由外壳接线。 */
  blockOps: BlockCapsuleOps
  /** M5 可选能力：AI / 媒体关闭时对应入口不出现（缺省全开）。 */
  features?: ResolvedFeatures
  /** 键盘上方格式栏（`10` §6.3 定稿）九键的回调束：撤销 / 重做走同一路由，插入面板收键盘占位。 */
  toolbarOps: {
    blockKind: string
    onConvertBlock: (kind: string) => void
    onIndent: (direction: 'indent' | 'outdent') => void
    onMoveStep: (direction: -1 | 1) => void
    onHistory: (redo: boolean) => void
    onInsertTile: (tile: string, sub?: 'ext' | 'page' | 'today' | 'now') => void
  }
}) {
  const featureSet = features ?? ALL_FEATURES_ON
  const editor = useEditorPluginsCore({
    enabled, onEnter, onLeaveList, onIndent, onOutdent, onToggleCollapse, onMoveStep, onJumpRef, onOpenExternal,
    onPasteUrl, onPasteOutline, onPasteMedia: featureSet.media ? onPasteMedia : undefined, onMarkerTrigger, onActiveBlock, onEditor, onToggleFormat,
    onAdoptRoot, onNameRowCross, onSelectNameRow, onNameRowEdge, touchCompact, touchEditId,
  })
  const touchLayer = useTouchEditorLayer({
    editor, enabled, touchCompact, touchEditId, clipboard, blockOps, formats, onToggleFormat, onConvertLink, onLinkDialog: onOpenLinkDialog, onOpenAiPanel,
    onOpenMedia, media: featureSet.media,
    onTouchActivate, onTouchFollow, onTouchBlank, onTouchExit,
    blockKind: toolbarOps.blockKind, onConvertBlock: toolbarOps.onConvertBlock,
    onIndent: toolbarOps.onIndent, onMoveStep: toolbarOps.onMoveStep, onHistory: toolbarOps.onHistory, onInsertTile: toolbarOps.onInsertTile,
  })

  return (
    <>
      <SlashMenuPlugin enabled={enabled} media={featureSet.media} onCommand={onSlashCommand} />
      <ReferenceMenuPlugin
        enabled={enabled}
        findTargets={(kind, query, fromId) => findTargets(kind, query, fromId)}
        suggestFor={(kind, query, fromId) => suggestFor(kind, query, fromId)}
        onInsert={onInsertRef}
        convertIntent={isLinkConvert}
        clearConvertIntent={clearLinkConvert}
      />
      <PeekPlugin enabled={enabled} resolve={resolvePeek} onJump={onJumpRef} resolveTitle={resolveRefTitle} />
      {/* 桌面选中工具栏**不上手机**（`10` §6.3）：触控档的文字动作 = 选区气泡 / 格式栏——θ13（ 真机轮）
          把口径从「只在触控编辑态让位」收成**整个 compact 档让位**：只读态保留原生选词（用户同日裁定），
          但原生选词不该顺带把桌面浮条钓出来。 */}
      <TextToolbarPlugin
        enabled={enabled && !touchCompact}
        formats={formats}
        onToggleFormat={onToggleFormat}
        onConvertLink={onConvertLink}
        onLinkDialog={onOpenLinkDialog}
        onAi={featureSet.ai ? onAi : undefined}
        onOpenAiPanel={featureSet.ai ? onOpenAiPanel : undefined}
        onNotify={onNotify}
      />
      {touchLayer}
    </>
  )
}
