import type { ComponentProps, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react'
import { EditorBody, type EditorBodyProps } from '@moqi/editor'
import type { ResolvedFeatures } from '@moqi/editor'
import { BacklinkSection } from './Backlinks'
import { AiBlockBars, BlockDecorations } from './BlockTools'
import { EditorTopbar } from './EditorTopbar'
import { Icon } from '@moqi/editor'
import { AiPanel, RefPanel } from './Panels'
import { PropertyBrief } from './Property'

type TopbarProps = ComponentProps<typeof EditorTopbar>
type BriefProps = ComponentProps<typeof PropertyBrief>
type RefPanelProps = ComponentProps<typeof RefPanel>
type AiPanelProps = ComponentProps<typeof AiPanel>
type BacklinkProps = ComponentProps<typeof BacklinkSection>
type DecorationProps = ComponentProps<typeof BlockDecorations>
type AiBarsProps = ComponentProps<typeof AiBlockBars>

/**
 * 编辑列需要外壳提供的东西（模块化 M1.5b）。
 *
 * 这一层只拥有**编辑列的 DOM 与布局**：顶栏、属性摘要、正文、块装饰层、AI 行、
 * 引用/AI 面板、专注条与空态。菜单状态、持久化、领域命令仍由外壳持有；需要进
 * 编辑列的入口全部通过这个显式模型传进来，避免再从外壳直接拼编辑列 JSX。
 */
export interface EditorSurfaceModel {
  editorActive: boolean
  /** M5 可选能力：属性面 / 反链 / AI 与引用面板按开关出现。 */
  features: ResolvedFeatures
  compact: boolean
  touchEditId: string | null
  focusMode: boolean
  activePage: { objectName: string | null } | null
  hasProperties: boolean
  noticeSlot: ReactNode
  topbar: TopbarProps
  propertyBrief: BriefProps | null
  contentElement: HTMLDivElement | null
  setContentElement: (element: HTMLDivElement | null) => void
  onChange: EditorBodyProps['onChange']
  docColRef: RefObject<HTMLDivElement | null>
  backlinks: Pick<BacklinkProps, 'targetName' | 'entries' | 'onJump'>
  decoration: Omit<DecorationProps, 'scopeRef' | 'contentRef' | 'enabled' | 'compact'>
  aiBars: Omit<AiBarsProps, 'scopeRef' | 'contentRef' | 'enabled'>
  refPanel: RefPanelProps
  aiPanel: AiPanelProps
  panelBackdrop: boolean
  onClosePanels: () => void
  pageStats: { words: number }
  recentPages: { id: string; name: string; label: string }[]
  onOpenPage: (pageId: string) => void
  onCreatePage: () => void
  onShowPageList: () => void
  onExitFocus: () => void
  onExitSelection: () => void
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void
}

/**
 * 编辑列（模块化 M1.5b）：把正文、装饰层、AI 行和编辑态浮层收进一个组件。
 *
 * 编辑器的 LexicalComposer 仍在外壳；这里只渲染 Lexical 的正文插件和宿主 DOM，
 * 因此换成别的内核时这一层的替换点也是明确的。
 */
export function EditorSurface({ model }: { model: EditorSurfaceModel }) {
  return (
    <div className="ed-col">
      <EditorTopbar {...model.topbar} />

      {/* 提示带（θ10 · `R09-STATE-1b`）：在流里不盖正文。 */}
      {model.noticeSlot}

      {/* 属性面**随「页面有属性」出现**（§0-1/§0-11；「筛这一列」判据在 `libraryFilter.ts`）。 */}
      {model.features.properties && model.propertyBrief ? <PropertyBrief {...model.propertyBrief} /> : null}

      <div className="editor-body">
        <div
          className={`doc-col${model.hasProperties ? ' is-with-brief' : ''}${model.compact && model.touchEditId !== null ? ' is-touch-edit' : ''}`}
          ref={model.docColRef}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !(model.compact && model.touchEditId !== null)) model.onExitSelection()
          }}
          onContextMenu={model.onContextMenu}
        >
          <div className="doc-inner">
            <EditorBody
              onChange={model.onChange}
              setContentElement={model.setContentElement}
              onExitSelection={model.onExitSelection}
            >
              {model.features.backlinks ? <BacklinkSection {...model.backlinks} /> : null}
            </EditorBody>
          </div>
          {/* 块装饰层挂在正文滚动容器内：否则鼠标移到标记上会触发容器的 mouseleave，标记会先消失。 */}
          <BlockDecorations
            scopeRef={model.docColRef}
            contentRef={{ current: model.contentElement }}
            enabled={model.editorActive && !model.focusMode}
            compact={model.compact}
            {...model.decoration}
          />
          {/* AI 块的标签行与操作行常驻在块自己的内边距里（docs/09 §6.11、原型 .ai-block），
              与装饰层一样挂在正文滚动容器内，鼠标移到行上不会触发容器的 mouseleave。
              「继续追问」的上下文按 docs/09 §4.8 是「基于本篇」——askAi 读的是整页子树，
              因此提示语不能写成「已把该 AI 块作为上下文」：那是条文禁止的假契约（见 `docs/09-桌面端UI规范.md` 前言与 `07-规则索引与规则理由.md` 的 `R09-DIFF-1`）。 */}
          <AiBlockBars
            scopeRef={model.docColRef}
            contentRef={{ current: model.contentElement }}
            enabled={model.editorActive && !model.focusMode}
            {...model.aiBars}
          />
        </div>

        {model.panelBackdrop ? (
          <div
            className="ref-backdrop"
            role="presentation"
            onMouseDown={model.onClosePanels}
          />
        ) : null}
        {model.features.backlinks ? <RefPanel {...model.refPanel} /> : null}
        {model.features.ai ? <AiPanel {...model.aiPanel} /> : null}
      </div>

      {model.focusMode ? (
        <div className="focus-bar" role="status">
          <span>专注模式 · 已隐藏侧栏与工具栏</span>
          <b>{model.pageStats.words} 字</b>
          <button type="button" className="btn" onClick={model.onExitFocus}>退出专注 Esc</button>
        </div>
      ) : null}

      {!model.activePage && !model.focusMode ? (
        <div className="ed-empty" role="status">
          <div className="ee-ic"><Icon name="file" size={26} decorative /></div>
          <h2>从一个页面开始</h2>
          <p>左边点一个页面就在这儿打开；也可以新建一篇。</p>
          {model.recentPages.length > 0 ? (
            <div className="ee-recent">
              <div className="ee-h">最近编辑</div>
              {model.recentPages.map((page) => (
                <button key={page.id} type="button" className="ee-it" onClick={() => model.onOpenPage(page.id)}>
                  <span className="ee-t">{page.name}</span>
                  <span className="ee-tm">{page.label}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="ee-acts">
            <button type="button" className="btn pri" onClick={model.onCreatePage}>＋ 新建页面</button>
            <button type="button" className="btn" onClick={model.onShowPageList}>显示页面列表</button>
            {/* B 批：`ee-hint`（快捷键说明）已删——空态不解释用法；速查表在「快捷键」弹窗里 */}
          </div>
        </div>
      ) : null}
    </div>
  )
}
