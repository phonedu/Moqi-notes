import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createTextNode, FORMAT_TEXT_COMMAND, REDO_COMMAND, UNDO_COMMAND } from 'lexical'
import { createTextBlock, type Block, type BlockMap, type BlockType } from '@moqi/editor'
import { $findBlockNode, $isBlockNode } from '@moqi/editor'
import { createMemoryEditorHost } from '@moqi/editor'
import { MoqiEditor, useSlashMenu } from '@moqi/editor'
import '@moqi/editor/src/editor.css'
import '../../src/ui/tokens.css'
import './demo.css'

function seed(): BlockMap {
  const now = Date.now()
  const page = createTextBlock({
    entityId: 'demo-page',
    blockUid: 'demo-page-0001',
    text: '独立编辑器 Demo',
    isObject: true,
    objectName: '独立编辑器 Demo',
    now,
  })
  const child = (id: string, uid: string, text: string, position: number, type: BlockType = 'text') => {
    const block = createTextBlock({ entityId: id, blockUid: uid, text, parent: page.entityId, now })
    block.position = position
    block.type = type
    return block
  }
  const heading = child('demo-heading', 'demo-heading-001', '当前编辑器内核', 0, 'heading2')
  const body = child('demo-body', 'demo-body-0001', '这个页面由现有的 domain + editor 端口直接挂载：没有墨契壳、没有页面库、没有 Tauri。输入的文字会以一整份 Block[] 交回宿主。', 1)
  const bullet = child('demo-bullet', 'demo-bullet-01', '块模型、事务、选择与撤销仍然来自同一套代码', 2, 'bullet')
  const quote = child('demo-quote', 'demo-quote-001', '这是裸宿主 spike，不是最终 API；M1/M2 之后才会抽成正式包。', 3, 'quote')
  const todo = child('demo-todo', 'demo-todo-0001', '试一下在下面按回车，编辑器会继续走现有输入规则', 4, 'todo')
  todo.checked = true
  page.children = [heading.entityId, body.entityId, bullet.entityId, quote.entityId, todo.entityId]
  return new Map([page, heading, body, bullet, quote, todo].map((block) => [block.entityId, block]))
}

function DemoToolbar() {
  const [editor] = useLexicalComposerContext()
  return (
    <div className="demo-toolbar" role="toolbar" aria-label="基础格式工具栏" onMouseDown={(event) => event.preventDefault()}>
      <button type="button" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}><b>B</b></button>
      <button type="button" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}><i>I</i></button>
      <span className="demo-toolbar-sep" />
      <button type="button" onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>撤销</button>
      <button type="button" onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}>重做</button>
    </div>
  )
}

/**
 * 宿主自定义斜杠命令（M5 扩展点实证）：不走墨契壳的菜单数据源，
 * 只用包导出的 `useSlashMenu` 内核钩子 + `MoqiEditor` 的 `plugins` 插槽——
 * 在 `/` 触发时给出自己的候选，↵ / 点击把本块替换成命令文本。
 */
const DEMO_SLASH_ITEMS = [
  { label: '插入签名', hint: 'demo 扩展', text: '—— 来自宿主扩展的签名' },
  { label: '插入日期', hint: 'demo 扩展', text: new Date().toISOString().slice(0, 10) },
]

function filterDemoSlash(query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return DEMO_SLASH_ITEMS
  return DEMO_SLASH_ITEMS.filter((item) => item.label.toLowerCase().includes(needle) || item.hint.includes(needle))
}

function DemoSlashPlugin() {
  const { state, index, choose } = useSlashMenu({
    enabled: true,
    count: (query) => filterDemoSlash(query).length,
    onChoose: (editor, blockId, itemIndex, query) => {
      const item = filterDemoSlash(query)[itemIndex]
      if (!item) return
      editor.update(() => {
        const node = $findBlockNode(blockId)
        if (!node) return
        for (const child of node.getChildren()) if (!$isBlockNode(child)) child.remove()
        node.append($createTextNode(item.text))
        node.selectEnd()
      }, { discrete: true })
    },
  })
  if (!state) return null
  const selection = typeof window === 'undefined' ? null : window.getSelection()
  const rect = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : null
  if (!rect) return null
  const items = filterDemoSlash(state.query)
  return (
    <div className="demo-slash" role="listbox" aria-label="宿主斜杠命令" style={{ top: rect.bottom + 6, left: rect.left }}>
      {items.length === 0 ? <div className="demo-slash-empty">没有匹配的命令</div> : items.map((item, i) => (
        <button key={item.label} type="button" role="option" aria-selected={i === index}
          className={`demo-slash-item ${i === index ? 'is-active' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(i)}>
          <span>{item.label}</span>
          <span className="demo-slash-hint">{item.hint}</span>
        </button>
      ))}
      <div className="demo-slash-foot">↑↓ 选择 · ↵ 插入 · Esc 关闭（宿主扩展）</div>
    </div>
  )
}

function App() {
  const [host] = useState(() => createMemoryEditorHost([...seed().values()]))
  const [snapshot, setSnapshot] = useState<Block[]>(() => host.read())
  const [changes, setChanges] = useState(0)
  const [saves, setSaves] = useState(0)
  const handleChange = useCallback((next: Block[]) => {
    setSnapshot(next)
    setChanges((value) => value + 1)
  }, [])
  const handleSave = useCallback(() => { setSaves((value) => value + 1) }, [])

  return (
    <main className="demo-page">
      <header className="demo-head">
        <p className="demo-kicker">M3 · EditorHost / 内存宿主</p>
        <h1>墨契编辑器，离开墨契壳</h1>
        <p>同一个 <code>domain</code> 与 <code>editor</code> 端口；最小内存宿主；不接 Tauri、不接页面库、不接同步。</p>
      </header>
      <div className="demo-grid">
        <section className="demo-editor" aria-label="编辑器">
          <MoqiEditor
            host={host}
            toolbar={<DemoToolbar />}
            plugins={<DemoSlashPlugin />}
            onChange={handleChange}
            onSave={handleSave}
            placeholder="开始写…"
          />
        </section>
        <aside className="demo-host" aria-label="宿主状态">
          <h2>内存宿主</h2>
          <p>编辑器只通过 <code>EditorHost.storage</code> 读写一整份快照；真实宿主可以换成 SQLite、localStorage 或远端。</p>
          <dl>
            <div><dt>块数</dt><dd>{snapshot.length}</dd></div>
            <div><dt>变更次数</dt><dd>{changes}</dd></div>
            <div><dt>落盘次数</dt><dd>{saves}</dd></div>
          </dl>
          <details>
            <summary>宿主收到的快照</summary>
            <pre>{JSON.stringify(snapshot, null, 2)}</pre>
          </details>
        </aside>
      </div>
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('找不到 #root')
createRoot(root).render(<App />)
