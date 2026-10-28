import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { createTextBlock, type Block, type BlockMap } from '../domain/block'
import { blocksFromEditorState, editorNodes, loadBlocksIntoEditor } from './blockLexicalAdapter'
import { EditorBody, type EditorBodyProps } from './EditorBody'
import { EditorComposer } from './EditorComposer'
import { EDITOR_THEME } from './theme'
import { EditorErrorBoundary } from './errorBoundary'
import type { EditorHost } from './host'

/** 恒定引用的空操作（M6 收尾）：内联箭头每渲染一新引用会让 Lexical 的选区恢复竞态——DOM 选区被浏览器挂到元素上、随后被归一化到根开头。 */
const noop = () => undefined

export type MoqiEditorProps = {
  host: EditorHost
  /** 当前文档标识（D-102）：变化 = 换文档 ⇒ 重新 load 并**重挂载**编辑器——Lexical 只在挂载时消费 initialConfig，
   *  不重挂载就会一直显示旧文档。`host` 变化同样触发重载；宿主应保持 host 引用稳定（useMemo）。 */
  documentId?: string
  /** 空库时新建页面用的页名（页面名仍由正文首行派生）。 */
  emptyPageName?: string
  toolbar?: ReactNode
  /** M5 扩展点：宿主自己的 Lexical 插槽（slash 命令、格式快捷键等）——渲染在 Composer 内、正文之后。 */
  plugins?: ReactNode
  onChange?: (blocks: Block[]) => void
  onError?: (error: unknown) => void
  /** 落盘完成后回调（宿主写入计数 / 状态用）。 */
  onSave?: (blocks: Block[]) => void
  contentClassName?: string
  placeholder?: string
}

/**
 * 最小可复用编辑器（M3）：宿主给 `EditorHost`，编辑器只读/写快照。
 *
 * 这是 `@moqi/editor` 公开面的前身：没有界面壳、没有页面库/同步/设置，
 * 也不依赖 `composition` / `adapters` / Tauri。完整工具栏与触控层在 M4/M5 接插槽。
 */
export function MoqiEditor({
  host, documentId, emptyPageName = '未命名页面', toolbar, plugins, onChange, onError, onSave,
  contentClassName, placeholder,
}: MoqiEditorProps) {
  const [initial, setInitial] = useState<BlockMap | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 重载序号（D-102）：每次 load 完成 +1，作为 EditorDocument（连同错误边界）的 key——换文档 / 换 host 必重挂载。 */
  const [reloadSeq, setReloadSeq] = useState(0)

  useEffect(() => {
    let active = true
    void host.storage.load()
      .then((blocks) => {
        if (!active) return
        setInitial(toBlockMap(blocks ?? [], emptyPageName))
        setReloadSeq((n) => n + 1)
      })
      .catch((error: unknown) => {
        if (!active) return
        setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => { active = false }
  }, [host, documentId, emptyPageName])

  if (loadError) return <div className="moqi-editor-error" role="alert">编辑器载入失败：{loadError}</div>
  if (!initial) return <div className="moqi-editor-loading" role="status">正在打开编辑器…</div>
  return (
    <EditorErrorBoundary key={reloadSeq} onError={onError}>
      <EditorDocument
        host={host}
        initial={initial}
        toolbar={toolbar}
        plugins={plugins}
        onChange={onChange}
        onError={onError}
        onSave={onSave}
        contentClassName={contentClassName}
        placeholder={placeholder}
      />
    </EditorErrorBoundary>
  )
}

function EditorDocument({
  host, initial, toolbar, plugins, onChange, onError, onSave, contentClassName, placeholder,
}: {
  host: EditorHost
  initial: BlockMap
  toolbar?: ReactNode
  plugins?: ReactNode
  onChange?: (blocks: Block[]) => void
  onError?: (error: unknown) => void
  /** 落盘完成后回调（宿主写入计数 / 状态用）。 */
  onSave?: (blocks: Block[]) => void
  contentClassName?: string
  placeholder?: string
}) {
  const baseRef = useRef(initial)
  const pendingRef = useRef<Block[] | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 落盘链尾（D-102）：所有 save 串在这条链上——上一次没落完，下一次排它后面（宿主直接写 SQLite 时，
   *  旧快照后到会覆盖新快照）。链上的失败就地交给 onError、不传染后续。 */
  const savingRef = useRef<Promise<unknown>>(Promise.resolve())

  const flush = useCallback(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return
    savingRef.current = savingRef.current
      .then(() => host.storage.save(pending))
      .then(() => { onSave?.(pending) })
      .catch((error: unknown) => { onError?.(error) })
    return savingRef.current
  }, [host, onError, onSave])

  useEffect(() => () => { void flush() }, [flush])

  /* D-102：页面隐藏 / 关闭时尽力冲一遍防抖（pagehide 与 visibilitychange；异步 save 不保证
     落完——这是 best-effort，宿主侧的关键落盘仍应自己把关）。flush 幂等：无 pending 即空操作。 */
  useEffect(() => {
    const onHide = () => { flush() }
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [flush])

  const initialConfig = useMemo<ComponentProps<typeof EditorComposer>['initialConfig']>(() => ({
    namespace: 'moqi-editor',
    nodes: editorNodes,
    theme: EDITOR_THEME,
    onError(error: Error) { onError?.(error) },
    editorState(editor) {
      loadBlocksIntoEditor(editor, initial)
    },
  }), [initial, onError])

  const handleChange = useCallback<EditorBodyProps['onChange']>((editorState, _editor, tags) => {
    if (tags.has('moqi-load')) return
    const next = blocksFromEditorState(editorState, baseRef.current)
    baseRef.current = next
    const blocks = [...next.values()]
    pendingRef.current = blocks
    onChange?.(blocks)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => { flush() }, 200)
  }, [flush, onChange])

  return (
    <EditorComposer initialConfig={initialConfig}>
      {toolbar}
      <EditorBody
        onChange={handleChange}
        setContentElement={noop}
        onExitSelection={noop}
        contentClassName={contentClassName}
        placeholder={placeholder}
      />
      {plugins}
    </EditorComposer>
  )
}

function toBlockMap(blocks: Block[], emptyPageName: string): BlockMap {
  if (blocks.length > 0) return new Map(blocks.map((block) => [block.entityId, block]))
  const page = createTextBlock({
    entityId: crypto.randomUUID(),
    blockUid: `p${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
    isObject: true,
    objectName: emptyPageName,
  })
  return new Map([[page.entityId, page]])
}
