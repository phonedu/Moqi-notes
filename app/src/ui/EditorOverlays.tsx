import { BlockTypeMenu, FindDialog, InsertMenu, KeyboardDialog, MediaPreview, MoreMenu, OutlinePop, StatDialog, TagMenu, CardMenu, EmbedSourceDialog } from './Overlays'
import { TagMergeDialog, ConfirmDialog } from './Dialogs'
import { AddPropertyDialog } from './Property'
import { LibraryFilterPanel } from './LibraryFilterPanel'
import { SearchOverlay } from './SearchOverlay'
import { BulkDeleteDialog, DiscardAiBlockDialog, LinkDialog, PickDialog, PromptDialog } from './Dialogs'
import { Icon } from '@moqi/editor'
import { blockTypeName, insertRoute } from './menuItems'
import type { EditorAppRuntime } from './useEditorRuntime'
import { AI_ACTION_LABEL, type BlockType } from '@moqi/editor'
import { aiSourcePlan } from '@moqi/editor'
import { DEFAULT_FIELD } from '@moqi/editor'
import { owningPageId } from '@moqi/editor'
import { BlockFlybar } from './BlockTools'
import { Popover } from './Popover'
import { saveMediaCopy } from './shellSupport'
import { toggleBlockFormat } from '@moqi/editor'


/** 编辑器浮层（模块化 M1.7）：菜单、弹窗、搜索、筛选与提示。 */
export function EditorOverlays({ runtime }: { runtime: EditorAppRuntime }) {
  const { activeBlockId, activeFormatsValue, activePage, activePageId, aiState, features, applyEmbedSource, applyExternalLink, assetPort, blockMenuTarget, blockTypeOfCursor, cancelAi, clearEmbedSource, closeDialog, closeMenu, compact, convertCurrentBlock, copyLink, copySelection, copySelectionToClipboard, createAndAddProperty, cutSelection, deleteSelection, dialog, discardAiBlock, duplicatePage, editorRef, exitSelection, findHits, findQuery, hasGeneratingAiBlock, jumpToBlock, libraryCards, libraryFilter, listAnchorRect, listAnchorVisible, menu, mergeTag, mountProperty, moveBlockStepById, movePageToTrash, notify, openDialog, openExportPage, openMenu, openPage, openSettingsView, openSidePanel, outlineEntries, outlineMove, pageStats, pickInsert, prefs, proceedClose, purgePages, refPanelOpen, registry, removeTagFromAll, renameTag, requestDeleteSelection, runAi, searchPort, selectedIds, selectionRect, setAskTargetMode, setBriefOpen, setFindQuery, setFocusMode, setLibraryFilter, setRefPanelOpen, setSearchScope, store, tagSummaries, toggleCollapse, togglePin, toggleStar, touchEditId, view, visibleCards } = runtime
  const overlayLayer = (
    <>
          {/* ---------- 浮层 ---------- */}
          {/* 编辑器自己的浮层（大纲 / ⋯ 菜单 / 块类型 / 插入 / 筛选 / 块工具栏）都以**视口坐标**挂在整个
              视图之外（这里排在所有 `<section>` 之后），所以必须显式按视图门住：不然切到设置 / 回收站时
              它们会继续悬浮在新视图上面（用户实测 2026-10-03）。状态由下面那个「离开编辑器就清掉」的
              effect 一并收拾，免得切回来时又冒出来。 */}
          {view === 'editor' && menu?.kind === 'outline' ? (
            <OutlinePop anchor={menu.anchor} entries={outlineEntries} onJump={jumpToBlock} onClose={() => closeMenu()} />
          ) : null}
          {view === 'editor' && menu?.kind === 'more' ? (
            <MoreMenu
              anchor={menu.anchor}
              refOpen={refPanelOpen}
              showRefPanel={features.backlinks}
              onToggleRef={() => {
                if (refPanelOpen) { setRefPanelOpen(false); return }
                openSidePanel('ref')
              }}
              onFind={() => openDialog({ kind: 'find' })}
              onStats={() => openDialog({ kind: 'stat' })}
              onFocus={() => setFocusMode(true)}
              onCopyLink={() => { if (activePageId) void copyLink(activePageId, activePage?.objectName ?? '未命名页面') }}
              onDuplicate={() => { if (activePageId) duplicatePage(activePageId) }}
              onExport={() => openExportPage(true)}
              onDelete={() => { if (activePageId) openDialog({ kind: 'deletePage', pageId: activePageId, name: activePage?.objectName ?? '未命名页面' }) }}
              starred={activePage?.starred ?? false}
              onToggleStar={() => { if (activePageId) toggleStar(activePageId) }}
              onOpenProperties={() => {
                // §0-1/§0-9（2026-10-10 裁决）：⋯ 的「属性」入口——**标签行直接加进面板**（摩擦归零）、
                // 面板展开（是用户点出来的），同时开「添加属性」弹层供添加其他属性。
                mountProperty(DEFAULT_FIELD.tags)
                setBriefOpen(true)
                openDialog({ kind: 'addProperty' })
              }}
              onClose={() => closeMenu()}
            />
          ) : null}
          {view === 'editor' && menu?.kind === 'blockType' ? (
            <BlockTypeMenu
              anchor={menu.anchor}
              current={blockTypeOfCursor}
              onPick={(type) => {
                const editor = editorRef.current
                if (!editor) return
                const targets = selectedIds.length > 0 ? selectedIds : activeBlockId ? [activeBlockId] : []
                if (targets.length === 0) return
                for (const id of targets) convertCurrentBlock(editor, id, type as BlockType)
                exitSelection()
              }}
              onClose={() => closeMenu()}
            />
          ) : null}
          {view === 'editor' && menu?.kind === 'blockMenu' ? (
            <Popover anchor={menu.anchor} width={214} label="块操作" onClose={() => closeMenu()}>
              <button type="button" onClick={() => { if (menu.element) openMenu('blockType', menu.element) }}>
                <span className="mi"><Icon name="heading" size={16} decorative /></span>
                <span>转换为</span>
                <span className="d">▸</span>
              </button>
              {/* 剪贴板三条（`R09-BEDIT-10`/`R09-KEY-21`）：**「复制」= 系统剪贴板（⌘C 同一动作）**、
                  「创建副本」= duplicate——同名会把用户带沟里（旧账已纠）。 */}
              {blockMenuTarget && (blockMenuTarget.type === 'image' || blockMenuTarget.type === 'file') ? (
                <>
                  {blockMenuTarget.type === 'image' ? (
                    <button type="button" onClick={() => { openDialog({ kind: 'mediaPreview', blockId: blockMenuTarget.entityId }); closeMenu() }}>
                      <span className="mi"><Icon name="image" size={16} decorative /></span>
                      <span>查看大图</span>
                    </button>
                  ) : null}
                  <button type="button" onClick={() => { void saveMediaCopy({ asset: blockMenuTarget.asset, notify, saveCopy: (diskName, displayName) => assetPort.saveCopy(diskName, displayName) }); closeMenu() }}>
                    <span className="mi"><Icon name="download" size={16} decorative /></span>
                    <span>保存副本</span>
                  </button>
                  <hr />
                </>
              ) : null}
              {/* 嵌入块（`R09-BLOCK-24`）：空态/悬空 = 选来源，有来源 = 更换 + 跳到来源。 */}
              {blockMenuTarget && blockMenuTarget.type === 'embed' ? (
                <>
                  <button type="button" onClick={() => { openDialog({ kind: 'embedSource', blockId: blockMenuTarget.entityId }); closeMenu() }}>
                    <span className="mi"><Icon name="embed" size={16} decorative /></span>
                    <span>{store.embedView(blockMenuTarget.entityId) ? '更换来源' : '选择来源'}</span>
                  </button>
                  {store.embedView(blockMenuTarget.entityId)?.state === 'ok' ? (
                    <button type="button" onClick={() => { closeMenu(); const view = store.embedView(blockMenuTarget.entityId); if (view?.sourcePageId) jumpToBlock(view.sourcePageId) }}>
                      <span className="mi"><Icon name="link" size={16} decorative /></span>
                      <span>跳到来源</span>
                    </button>
                  ) : null}
                  {store.embedView(blockMenuTarget.entityId) ? (
                    <button type="button" onClick={() => { closeMenu(); clearEmbedSource(blockMenuTarget.entityId) }}>
                      <span className="mi"><Icon name="x" size={16} decorative /></span>
                      <span>去掉来源</span>
                    </button>
                  ) : null}
                  <hr />
                </>
              ) : null}
              <button type="button" onClick={() => { void copySelectionToClipboard('plain'); closeMenu() }}>
                <span className="mi"><Icon name="copy" size={16} decorative /></span>
                <span>复制</span>
                <span className="d">⌘C</span>
              </button>
              <button type="button" onClick={() => { void copySelectionToClipboard('ref'); closeMenu() }}>
                <span className="mi"><Icon name="link" size={16} decorative /></span>
                <span>复制为块引用</span>
              </button>
              <button type="button" onClick={() => { void cutSelection(); closeMenu() }}>
                <span className="mi"><Icon name="scissors" size={16} decorative /></span>
                <span>剪切</span>
                <span className="d">⌘X</span>
              </button>
              <button type="button" onClick={() => { copySelection(); closeMenu() }}>
                <span className="mi"><Icon name="file-copy" size={16} decorative /></span>
                <span>创建副本</span>
              </button>
              {blockMenuTarget ? (
                <>
                  <button type="button" onClick={() => { closeMenu(); moveBlockStepById(blockMenuTarget.entityId, -1) }}>
                    <span className="mi"><Icon name="chevron-up" size={16} decorative /></span>
                    <span>上移</span>
                  </button>
                  <button type="button" onClick={() => { closeMenu(); moveBlockStepById(blockMenuTarget.entityId, 1) }}>
                    <span className="mi"><Icon name="chevron-down" size={16} decorative /></span>
                    <span>下移</span>
                  </button>
                </>
              ) : null}
              {blockMenuTarget && blockMenuTarget.children.length > 0 ? (
                <button type="button" onClick={() => { const editor = editorRef.current; if (editor) toggleCollapse(editor, blockMenuTarget.entityId); closeMenu() }}>
                  <span className="mi"><Icon name="chevron-down" size={16} decorative /></span>
                  <span>{blockMenuTarget.collapsed ? '展开' : '折叠'}</span>
                </button>
              ) : null}
              {/* AI ▸ 一项已删（`R09-BEDIT-10`：与浮动栏 `✦AI▾` 重复；操作集合仍在 `AI_UI_OPS`）。 */}
              <hr />
              <button type="button" className="is-danger" onClick={() => { requestDeleteSelection(); closeMenu() }}>
                <span className="mi"><Icon name="trash" size={16} decorative /></span>
                <span>删除</span>
              </button>
            </Popover>
          ) : null}
          {view === 'editor' && menu?.kind === 'insert' ? (
            <InsertMenu
              anchor={menu.anchor} compact={compact} media={features.media}
              onPick={(kind) => {
                const editor = editorRef.current
                if (!editor) return
                // 菜单自己会后关闭（`InsertMenu` 的 onClick 里 `onPick` 之后跟 `onClose`）——这里只管落点。
                pickInsert(editor, kind)
              }}
              onClose={() => closeMenu()}
            />
          ) : null}
          {menu?.kind === 'filter' ? (
            <LibraryFilterPanel
              anchor={menu.anchor}
              filter={libraryFilter}
              resultCount={visibleCards.length}
              totalCount={libraryCards.length}
              tags={tagSummaries}
              properties={registry.properties}
              onChange={setLibraryFilter}
              onClose={() => closeMenu()}
            />
          ) : null}
          {menu?.kind === 'card' && listAnchorVisible && listAnchorRect ? (
            <CardMenu
              anchor={listAnchorRect}
              card={menu.card}
              onCopyLink={() => void copyLink(menu.card.id, menu.card.name)}
              onDelete={() => openDialog({ kind: 'deletePage', pageId: menu.card.id, name: menu.card.name })}
              onExport={() => openExportPage(true)}
              canPin={store.canPin(menu.card.id)}
              onTogglePin={() => togglePin(menu.card.id)}
              onToggleStar={() => toggleStar(menu.card.id)}
              onClose={() => closeMenu()} compact={compact} onOpen={() => openPage(menu.card.id)}
            />
          ) : null}
          {menu?.kind === 'tag' && listAnchorVisible && listAnchorRect ? (
            <TagMenu
              anchor={listAnchorRect}
              tag={menu.tag}
              onRename={() => openDialog({ kind: 'tagRename', tag: menu.tag })}
              onMerge={() => openDialog({ kind: 'tagMerge', tag: menu.tag })}
              onRemoveAll={() => openDialog({ kind: 'tagRemoveAll', tag: menu.tag })}
              onClose={() => closeMenu()}
            />
          ) : null}

          {/* 块浮动工具栏 = 桌面形态（`R09-PAIR-22`）；compact 档块选中走块胶囊，这里让位。 */}
          {view === 'editor' && !compact && selectedIds.length > 0 && selectionRect ? (
            <BlockFlybar
              rect={selectionRect}
              count={selectedIds.length}
              activeFormats={activeFormatsValue}
              onToggleFormat={(format) => {
                const editor = editorRef.current
                if (editor) toggleBlockFormat(editor, selectedIds, format)
              }}
              onConvert={(event) => openMenu('blockType', event.currentTarget)}
              onIndent={() => { const editor = editorRef.current; if (editor) for (const id of selectedIds) outlineMove(editor, 'indent', id) }}
              onOutdent={() => { const editor = editorRef.current; if (editor) for (const id of selectedIds) outlineMove(editor, 'outdent', id) }}
              onAi={features.ai ? (action) => void runAi(action, aiSourcePlan({ selectedBlocks: selectedIds, pageId: activePageId })) : undefined}
              onDelete={() => requestDeleteSelection(selectedIds)}
              onOpenAiPanel={features.ai ? () => openSidePanel('ai') : undefined}
              onOpenBlockMenu={(event) => openMenu('blockMenu', event.currentTarget, { blockIds: selectedIds })}
              onEscape={() => { exitSelection(); editorRef.current?.focus() }}
            />
          ) : null}

          {/* ---------- 弹窗 ---------- */}
          {dialog?.kind === 'search' ? (
            <SearchOverlay
              searchPort={searchPort}
              tags={tagSummaries}
              pageNameOf={(hit) => {
                // 块结果要说清「在哪一页」——全局搜索下同一句话可能出现在很多页里（R09-SEARCH-2）。
                const pageId = owningPageId(store.read(), hit.entityId)
                return (pageId ? store.get(pageId)?.objectName : null) ?? ''
              }}
              onJump={jumpToBlock}
              onAskAi={features.ai ? (sourceIds) => {
                // 关闭搜索、打开 AI 助手，并把这次的命中当范围（面板输入行会写明范围）。
                // 落点默认「新建一页」：范围来自全库检索时**没有**天然的家，落进当时碰巧打开的那一页
                // 是缺陷级的意外（台账 D-016）——跨页提问不猜。
                setSearchScope({ sourceIds, label: `检索命中的 ${sourceIds.length} 块` })
                setAskTargetMode('new')
                closeDialog()
                openSidePanel('ai')
              } : undefined}
              onClose={() => { setSearchScope(null); closeDialog() }}
            />
          ) : null}
          {dialog?.kind === 'find' ? (
            <FindDialog
              pageName={activePage?.objectName ?? ''}
              hits={findHits}
              query={findQuery}
              onQuery={setFindQuery}
              onJump={jumpToBlock}
              onClose={() => { closeDialog(); setFindQuery('') }}
            />
          ) : null}
          {dialog?.kind === 'mediaPreview' ? (() => {
            const block = store.get(dialog.blockId)
            const asset = block?.asset ?? null
            const src = asset ? assetPort.displayUrl(asset.fileName) : null
            if (!asset || !src) return null
            return (
              <MediaPreview
                src={src} mode={compact && touchEditId === null ? 'viewer' : 'tools'} /* θ17：只读态 = 关闭/保存/分享；编辑态与桌面 = 图标化工具条 */
                name={asset.originalName}
                onSaveCopy={() => { void saveMediaCopy({ asset, notify, saveCopy: (diskName, displayName) => assetPort.saveCopy(diskName, displayName) }) }}
                onClose={() => closeDialog()}
              />
            )
          })() : null}
          {dialog?.kind === 'keyboard' ? <KeyboardDialog onClose={() => closeDialog()} /> : null}
          {dialog?.kind === 'stat' ? <StatDialog stats={pageStats} onClose={() => closeDialog()} /> : null}
          {dialog?.kind === 'embedSource' ? (
            <EmbedSourceDialog
              blockId={dialog.blockId}
              findTargets={(query, fromId) => store.embedSourceTargets(query, fromId)}
              onPick={(targetId) => { const id = dialog.blockId; closeDialog(); applyEmbedSource(id, targetId) }}
              onClose={() => closeDialog()}
            />
          ) : null}
          {dialog?.kind === 'addProperty' ? (
            <AddPropertyDialog
              defs={registry.properties}
              mounted={[...(activePage?.propertyShown ?? []), ...(activePage?.properties.map((item) => item.defId) ?? [])]}
              recentIds={prefs.recentProperties}
              onAdd={mountProperty}
              onCreate={createAndAddProperty}
              onOpenSettings={() => { closeDialog(); openSettingsView() }}
              onClose={() => closeDialog()}
            />
          ) : null}
          {dialog?.kind === 'externalLink' ? (
            <LinkDialog
              initialText={dialog.text}
              onSubmit={(text, url) => { applyExternalLink(dialog, text, url); closeDialog() }}
              onClose={() => closeDialog()}
            />
          ) : null}
          {dialog?.kind === 'deletePage' ? (
            <ConfirmDialog
              title="移至回收站"
              confirmLabel="移入回收站"
              danger
              body={<>
                <p>将把「<b>{dialog.name}</b>」和它下面的所有块整体移入回收站。</p>
                <p className="dlg-note">30 天内可恢复。</p>
              </>}
              onConfirm={() => { movePageToTrash(dialog.pageId); closeDialog() }}
              onClose={() => closeDialog()}
            />
          ) : null}
          {dialog?.kind === 'purgePages' ? (
            <ConfirmDialog
              title={dialog.pageIds.length === 1 ? '从本机彻底删除' : `从本机彻底删除 ${dialog.pageIds.length} 个页面`}
              confirmLabel="彻底删除"
              danger
              body={<>
                <p>
                  将把 {dialog.pageIds.length === 1
                    ? <>「<b>{dialog.names[0]}</b>」</>
                    : <b>{dialog.names.slice(0, 5).join('、')}{dialog.names.length > 5 ? ` 等 ${dialog.names.length} 个页面` : ''}</b>}
                  和它下面的所有块从本机删除，<b>不可恢复</b>。
                </p>
                {dialog.losers.length > 0 ? (
                  <p className="dlg-note">
                    以下页面将失去指向它的双链：{dialog.losers.slice(0, 8).join('、')}
                    {dialog.losers.length > 8 ? ` 等 ${dialog.losers.length} 个` : ''}。
                  </p>
                ) : null}
                <p className="dlg-note">
                  只从这台设备删除；开启同步后，其他设备的副本会移入那边的回收站。
                </p>
              </>}
              onConfirm={() => { void purgePages(dialog.pageIds); closeDialog() }}
              onClose={() => closeDialog()}
            />
          ) : null}
          {dialog?.kind === 'bulkDelete' ? (
            <BulkDeleteDialog
              count={dialog.count}
              refs={dialog.refs}
              hasChildren={dialog.hasChildren}
              onConfirm={() => { deleteSelection(dialog.ids); closeDialog() }}
              onClose={() => closeDialog()}
            />
          ) : null}
          {dialog?.kind === 'discardAiBlock' ? (
            <DiscardAiBlockDialog
              onConfirm={() => { discardAiBlock(dialog.blockId); closeDialog() }}
              onClose={() => closeDialog()}
            />
          ) : null}
          {dialog?.kind === 'closeWindow' ? (
            <ConfirmDialog
              title="AI 正在生成"
              confirmLabel="直接关闭"
              cancelLabel="继续生成"
              body={<>
                <p>有 AI 块正在生成，直接关闭会丢掉这次生成的内容。</p>
                <p className="dlg-note">选「继续生成」就不丢；已完成的编辑不受影响，关闭前会先落盘。</p>
              </>}
              onConfirm={() => { closeDialog(); void proceedClose() }}
              onClose={() => closeDialog()}
            />
          ) : null}
          {dialog?.kind === 'tagRename' ? (
            <PromptDialog
              title="重命名标签"
              label="新名称"
              initialValue={dialog.tag.name}
              submitLabel="重命名"
              onSubmit={(value) => { renameTag(dialog.tag, value); closeDialog() }}
              onClose={() => closeDialog()}
            />
          ) : null}
          {dialog?.kind === 'tagMerge' ? (
            <PickDialog
              title={`合并 #${dialog.tag.name}`}
              label={`选择目标标签（${dialog.tag.count} 篇页面将改为目标标签）`}
              items={tagSummaries.filter((tag) => tag.id !== dialog.tag.id)}
              emptyText="没有其它标签可以合并，可直接重命名。"
              onPick={(target) => { openDialog({ kind: 'tagMergeConfirm', tag: dialog.tag, target }) }}
              onClose={() => closeDialog()}
            />
          ) : null}
          {dialog?.kind === 'tagMergeConfirm' ? (
            <TagMergeDialog
              sourceName={dialog.tag.name}
              sourceCount={dialog.tag.count}
              targetName={dialog.target.name}
              onConfirm={() => { mergeTag(dialog.tag, dialog.target); closeDialog() }}
              onClose={() => closeDialog()}
            />
          ) : null}
          {dialog?.kind === 'tagRemoveAll' ? (
            <ConfirmDialog
              title="从所有页面移除标签"
              confirmLabel="移除关联"
              danger
              body={<p>将在 <b>{dialog.tag.count}</b> 篇页面中移除 #{dialog.tag.name} 关联，<b>正文文字保留</b>。</p>}
              onConfirm={() => { removeTagFromAll(dialog.tag); closeDialog() }}
              onClose={() => closeDialog()}
            />
          ) : null}

          {aiState.status === 'running' && !hasGeneratingAiBlock ? (
            <div className="busy" role="status">
              <span>{aiState.action ? `正在生成${AI_ACTION_LABEL[aiState.action]}…` : 'AI 生成中…'}</span>
              <button type="button" onClick={() => cancelAi()}>停止</button>
            </div>
          ) : null}
    </>
  )


  return overlayLayer
}
