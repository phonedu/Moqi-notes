import type { EditorAppRuntime } from './useEditorRuntime'
import { APP_BUILD_LABEL, APP_CHANGELOG, APP_STAGE, APP_VERSION } from '../version'
import { textContent, type BlockType } from '@moqi/editor'
import { aiPanelGate, aiSourcePlan } from '@moqi/editor'
import { clipboardPort } from '../composition'
import { crossNameRow, nameRowEdge, selectNameRow } from '@moqi/editor'
import { leaveListOnBackspace } from '@moqi/editor'
import { moveBlockGroup } from './shellSupport'
import { resolveInlineRefs } from '@moqi/editor'
import { saveAiConfig } from './uiPrefs'
import { suggestReferences } from '@moqi/editor'
import { syncPresentation } from './Sidebar'

import { EditorSurface, type EditorSurfaceModel } from './EditorSurface'
import { PageLibraryHost } from './PageLibraryHost'
import { SettingsHost } from './SettingsHost'
import { EditorPlugins } from './editorPlugins'
import { pickPropertyOption } from './libraryFilter'
import { blockTypeName } from './menuItems'
import { insertDateText } from './format'

/** 编辑区主内容（模块化 M1.7）：编辑列 + 页面列 + 设置宿主 + Lexical 插件宿主。 */
export function EditorMainContent({ runtime }: { runtime: EditorAppRuntime }) {
  const { acceptAiBlock, activateTouchBlock, activeLibraryTagId, activePage, activePageId, adoptRootContent, aiAnswers, aiConfig, aiGridGates, aiPanelOpen, aiQuestions, aiReady, aiState, applyExternalLink, askAi, askTargetMode, assetNames, assetPort, assetsReady, backlinkCards, backupSummary, band, blockTitleForAsk, blockTypeOfCursor, briefOpen, cancelAi, captureEditor, caretBlockInPage, caretRangeInBlock, clearLinkConvert, closeMenu, closeSettingsView, compact, contentElement, convertCurrentBlock, convertSelectionToLink, copySelectionToClipboard, createPage, createProperty, cutSelection, deleteProperty, deviceIdLabel, docColRef, editorRef, exitSelection, exitTouchEdit, exportBusy, exportChoice, exportPort, exportTagChoices, features, fileOps, filterCount, flushPendingEnter, focusMode, followTouchBlock, formatSnapshot, handleAddPropertyOption, handleMove, handleMoveProperty, handleMovePropertyOption, handleRemovePropertyOption, handleRenameProperty, handleRenamePropertyOption, handleSlashCommand, historyStep, includeDeleted, indexStatus, insertAnswerAsBlock, insertBlockOfType, insertEmbedPlaceholder, insertMediaBlock, insertReference, insertSibling, isLinkConvert, jumpToBlock, libraryCards, moveBlocksStep, nameProblemText, nameRowFacts, notify, onChange, onEnter, openDialog, openDrawerOverlay, openExternalLinkDialog, openExternalUrl, openMenu, openPage, openSettingsView, openSidePanel, outgoingCards, outlineMove, pageColumnVisible, pageStats, patchPrefs, persist, pickInsert, pickMediaFile, prefs, propertyCallbacks, propertyRows, propertyUsage, recentPages, refPanelOpen, registry, reloadFromStore, requestDeleteSelection, resolvePeek, resolveRefTitle, revision, runAi, runExportFromPage, runSyncOnce, saveState, searchScope, selectBlock, selectedIds, setActiveBlockId, setAiConfig, setAiPanelOpen, setAskTargetMode, setBriefOpen, setContentElement, setExportChoice, setFocusMode, setIncludeDeleted, setLibraryFilter, setRefPanelOpen, setSearchScope, setSettingsLevel, setSettingsSection, setSyncDirectory, setView, settingsLevel, settingsOpen, settingsSection, startResize, store, syncEditorChanges, syncState, syncStatus, tagSummaries, tagUsage, toggleChecked, toggleCollapse, toggleInlineFormat, toggleSidebar, toggleStar, toggleTagFilter, touchBlankTap, touchEditId, updatePrefs, view, visibleCards, wideEnoughForColumn } = runtime
  const editorSurface: EditorSurfaceModel = {
    editorActive: view === 'editor',
    features,
    compact,
    touchEditId,
    focusMode,
    activePage: activePage ?? null,
    hasProperties: propertyRows.length > 0,
    noticeSlot: band(settingsOpen),
    topbar: {
      compact,
      saveError: saveState === 'error',
      canEnterEdit: compact && touchEditId === null && activePageId !== null,
      blockTypeLabel: blockTypeName(blockTypeOfCursor),
      onBackToLibrary: () => { exitTouchEdit(); closeMenu(); setAiPanelOpen(false); setRefPanelOpen(false); setView('editor'); updatePrefs({ ...prefs, listColumnCollapsed: false }) },
      onEnterEdit: () => { if (activePageId) activateTouchBlock(activePageId) },
      onOpenBlockType: (event) => openMenu('blockType', event.currentTarget),
      onOpenInsert: (event) => openMenu('insert', event.currentTarget),
      onOpenFind: () => openDialog({ kind: 'find' }),
      onOpenOutline: (event) => openMenu('outline', event.currentTarget),
      onOpenAi: () => openSidePanel('ai'),
      showAi: features.ai,
      onOpenMore: (event) => openMenu('more', event.currentTarget),
    },
    propertyBrief: activePage && propertyRows.length > 0 ? {
      rows: propertyRows,
      open: briefOpen,
      onToggle: () => setBriefOpen((value) => !value),
      onOpenAddProperty: () => openDialog({ kind: 'addProperty' }),
      tagChoices: tagUsage,
      ...propertyCallbacks,
      onFilterOption: (defId, optionId) => {
        setLibraryFilter((current) => pickPropertyOption(current, defId, optionId))
        setView('editor')
        if (prefs.listColumnCollapsed) updatePrefs({ ...prefs, listColumnCollapsed: false })
      },
      onFilterTag: (tagId) => {
        toggleTagFilter(tagId)
        if (prefs.listColumnCollapsed) updatePrefs({ ...prefs, listColumnCollapsed: false })
      },
    } : null,
    contentElement,
    setContentElement,
    onChange,
    docColRef,
    backlinks: {
      targetName: activePage?.objectName ?? '',
      entries: backlinkCards,
      onJump: (sourceId) => jumpToBlock(sourceId),
    },
    decoration: {
      selectedIds,
      revision,
      onSelect: selectBlock,
      onInsertAfter: (blockId) => { const editor = editorRef.current; if (editor) insertSibling(editor, blockId) },
      onMove: (dragId, targetId, position) => { const editor = editorRef.current; if (editor) handleMove(editor, dragId, targetId, position) },
      onToggleCollapse: (blockId) => { const editor = editorRef.current; if (editor) toggleCollapse(editor, blockId) },
      onToggleChecked: (blockId) => { const editor = editorRef.current; if (editor) toggleChecked(editor, blockId) },
      assetUrl: (diskName) => (assetsReady && assetNames.has(diskName) ? assetPort.displayUrl(diskName) : null),
      onOpenMedia: (blockId) => { if (compact && touchEditId !== null) return; if (compact) editorRef.current?.getRootElement()?.blur(); openDialog({ kind: 'mediaPreview', blockId }) },
      embedView: (blockId) => store.embedView(blockId),
      onPickEmbedSource: (blockId) => openDialog({ kind: 'embedSource', blockId }),
      onOpenEmbedSource: (blockId) => {
        const view = store.embedView(blockId)
        if (view?.sourcePageId) jumpToBlock(view.sourcePageId)
      },
    },
    aiBars: {
      onStop: () => cancelAi(),
      onAccept: acceptAiBlock,
      onRegenerate: (blockId) => { const meta = store.get(blockId)?.aiMeta; if (meta) void runAi(meta.action, { sourceIds: meta.sourceBlockIds, scope: meta.sourceScope ?? 'selection', byBlockSelection: false }, { targetBlockId: blockId }) },
      onDiscard: (blockId) => openDialog({ kind: 'discardAiBlock', blockId }),
      onFollow: () => openSidePanel('ai'),
      onEscape: () => editorRef.current?.focus(),
    },
    refPanel: {
      open: refPanelOpen && !focusMode,
      outgoing: outgoingCards,
      incoming: backlinkCards.map((card) => ({ id: card.sourceId, title: card.path, meta: '', preview: card.preview, isBlock: card.kind === 'block' })),
      includeDeleted,
      onToggleIncludeDeleted: () => setIncludeDeleted((value) => !value),
      onJump: (id) => jumpToBlock(id),
      onClose: () => setRefPanelOpen(false),
    },
    aiPanel: {
      open: aiPanelOpen && !focusMode,
      pageName: activePage?.objectName ?? '',
      aiReady,
      running: aiState.status === 'running',
      answers: aiAnswers,
      questions: aiQuestions,
      onQuick: (_op, action) => {
        if (!action) return
        // 点击这一刻的判据用**实时**光标（渲染期的禁用态走 `aiGridGates`，同一个纯函数、同一套过滤）。
        const gate = aiPanelGate({ action, selectedBlocks: selectedIds, caretBlockId: caretBlockInPage(), pageId: activePageId })
        if (gate.kind === 'blocked') { notify(gate.reason); return }
        void runAi(action, gate.plan)
      },
      gates: aiGridGates,
      onAsk: (question) => void askAi(question, searchScope ?? undefined),
      onJumpSource: (blockId) => { setAiPanelOpen(false); jumpToBlock(blockId) },
      sourceTitleOf: blockTitleForAsk,
      askScopeLabel: searchScope?.label ?? null,
      onClearAskScope: () => setSearchScope(null),
      askDestination: {
        mode: askTargetMode,
        label: askTargetMode === 'new' ? '新建一页' : (activePage?.objectName ?? '未命名页面'),
      },
      onAskDestinationChange: setAskTargetMode,
      onInsert: (answer) => {
        // created = 落点 id（当前页 = AI 块、存新页 = 新页）。存新页时把用户带过去（落点切回当前页）；
        // 窄档一律收 Sheet 让人看见落点（`10` §6.4）；桌面保持面板开着续聊。
        const created = insertAnswerAsBlock(answer, askTargetMode)
        if (created && askTargetMode === 'new') { openPage(created); setAskTargetMode('current') }
        if (created && compact) setAiPanelOpen(false)
      },
      noticeSlot: aiPanelOpen ? band(settingsOpen) : null,
      onCopy: (answer) => { void clipboardPort.writeText(answer.text).catch(() => notify('剪贴板不可用')) },
      onOpenSettings: openSettingsView,
      onClose: () => setAiPanelOpen(false),
    },
    panelBackdrop: compact && (refPanelOpen || aiPanelOpen),
    onClosePanels: () => { setRefPanelOpen(false); setAiPanelOpen(false) },
    pageStats,
    recentPages,
    onOpenPage: openPage,
    onCreatePage: createPage,
    onShowPageList: () => { openDrawerOverlay('listColumn'); updatePrefs({ ...prefs, listColumnCollapsed: false, sidebarCollapsed: false }) },
    onExitFocus: () => setFocusMode(false),
    onExitSelection: exitSelection,
    onContextMenu: (event) => {
      // 右键块体 / 把手 = 打开块菜单（`R09-BEDIT-11`）：与 `⋯ 更多` 同一份清单；页面容器不出菜单；已选中时保持多选。
   // **θ13（ 真机轮）**：compact 档不吃这一手——Android 长按会派发 `contextmenu`（连同桌面文本浮条漏进手机）：桌面语义不上手机。
      const element = (event.target as HTMLElement | null)?.closest<HTMLElement>('.moqi-block[data-entity-id]')
      const blockId = element?.dataset.entityId
      if (compact || !element || !blockId || element.dataset.blockObject === 'true') return
      const ids = selectedIds.includes(blockId) ? selectedIds : [blockId]
      if (!selectedIds.includes(blockId)) selectBlock(blockId, 'single')
      openMenu('blockMenu', element, { blockIds: ids })
    },
  }

  const mainContent = (
    <>
            <section className={`view ${view === 'editor' ? 'is-on' : ''}`} aria-label="编辑器" aria-hidden={view !== 'editor'}>
              {/* 分栏（docs/09 §八）：左侧页面列可折叠，折叠后就是放大写作，编辑器实例始终同一个。 */}
              <div className="ed-split">
                <PageLibraryHost
                  visible={pageColumnVisible}
                  wideEnoughForColumn={wideEnoughForColumn}
                  compact={compact}
                  cards={visibleCards}
                  activeTagName={activeLibraryTagId ? (tagSummaries.find((tag) => tag.id === activeLibraryTagId)?.name ?? registry.tags.find((tag) => tag.id === activeLibraryTagId)?.name ?? null) : null}
                  filterCount={filterCount}
                  mode={prefs.libraryView}
                  activePageId={activePageId}
                  noticeSlot={band(settingsOpen)}
                  onSearch={() => openDialog({ kind: 'search' })}
                  onCreate={createPage}
                  onClearFilter={() => setLibraryFilter((current) => ({ ...current, tagMode: 'any', tagIds: [] }))}
                  onOpen={openPage}
                  onCardMenu={(card, event) => { event.stopPropagation(); openMenu('card', event.currentTarget, { card }) }}
                  onToggleStar={(card) => toggleStar(card.id)}
                  onFilter={(event) => openMenu('filter', event.currentTarget)}
                  onModeChange={(mode) => updatePrefs({ ...prefs, libraryView: mode })}
                  onOpenDrawer={toggleSidebar}
                  onStartResize={startResize('pagecol')}
                  onBackdrop={() => updatePrefs({ ...prefs, listColumnCollapsed: true })}
                />
                <EditorSurface model={editorSurface} />
              </div>
            </section>

            <SettingsHost
              open={settingsOpen}
              onClose={closeSettingsView}
              noticeSlot={settingsOpen ? band() : null}
              settings={settingsOpen ? {
                aiConfig: { baseUrl: aiConfig.baseUrl, apiKey: aiConfig.apiKey, model: aiConfig.model },
                aiReady,
                onSaveAi: (value) => { setAiConfig(value); saveAiConfig(value) },
                properties: registry.properties,
                usage: propertyUsage,
                onCreateProperty: createProperty,
                onRenameProperty: (defId, name) => handleRenameProperty(defId, name),
                onNameProblem: nameProblemText,
                fileOps,
                propertyOps: { onAddOption: handleAddPropertyOption, onRenameOption: handleRenamePropertyOption, onRemoveOption: handleRemovePropertyOption, onMoveOption: handleMovePropertyOption, onMoveProperty: handleMoveProperty },
                onDeleteProperty: deleteProperty,
                themeId: prefs.themeId,
                mode: prefs.mode,
                fontSize: prefs.fontSize,
                lineHeight: prefs.lineHeight,
                columnWidth: prefs.columnWidth,
                onSetAppearance: patchPrefs,
                importInlineTags: prefs.importInlineTags,
                onToggleImportInlineTags: () => patchPrefs({ importInlineTags: !prefs.importInlineTags }),
                onNotify: (message) => notify(message),
                section: settingsSection, compact, onClose: closeSettingsView, level: settingsLevel,
                onSectionChange: setSettingsSection, onLevelChange: setSettingsLevel,
                exportPage: {
                  enabled: exportPort.capabilities.writeFiles,
                  busy: exportBusy,
                  activePageName: activePage?.objectName ?? null,
                  tags: exportTagChoices(),
                  choice: exportChoice,
                  onChoiceChange: setExportChoice,
                  count: exportChoice.kind === 'page' ? (activePageId ? 1 : 0) : exportChoice.kind === 'tag' ? (exportTagChoices().find((tag) => tag.id === exportChoice.tagId)?.count ?? 0) : libraryCards.length,
                  onExport: runExportFromPage,
                  onExportAs: () => runExportFromPage({ pick: 'saveAs' }),
                  onExportToFolder: () => runExportFromPage({ pick: 'folder' }),
                },
                version: APP_VERSION,
                stage: APP_STAGE,
                build: APP_BUILD_LABEL,
                changelog: APP_CHANGELOG,
                syncDirectory: syncState.directory,
                onSyncDirectoryChange: setSyncDirectory,
                syncStatusText: syncPresentation(syncStatus).text,
                onSyncNow: () => void runSyncOnce(),
                deviceIdPreview: deviceIdLabel ?? '（解析中…）',
                indexStatus,
                backup: backupSummary,
              } : null}
            />

            {/* ---------- 编辑器内 Lexical 插件 ---------- */}
            <EditorPlugins
              features={features}
              enabled={view === 'editor'}
              clipboard={clipboardPort}
              touchCompact={compact}
              touchEditId={compact ? touchEditId : null}
              onTouchActivate={activateTouchBlock} onTouchFollow={followTouchBlock} toolbarOps={{ blockKind: touchEditId ? (store.get(touchEditId)?.type ?? 'text') : 'text', onConvertBlock: (kind) => { const editor = editorRef.current; if (editor && touchEditId) convertCurrentBlock(editor, touchEditId, kind as BlockType) }, onIndent: (direction) => { const editor = editorRef.current; if (editor && touchEditId) outlineMove(editor, direction, touchEditId) }, onMoveStep: (direction) => moveBlocksStep(direction), onHistory: (redo) => historyStep(redo), onInsertTile: (tile, sub) => { const editor = editorRef.current; if (!editor) return; if (tile === 'datetime') { pickInsert(editor, sub === 'now' ? 'now' : 'today'); return } if (tile === 'image' || tile === 'camera') { pickMediaFile('image', { capture: tile === 'camera' }); return } if (tile === 'file') { pickMediaFile('file'); return } if (tile === 'embed') { insertEmbedPlaceholder(); return } if (tile === 'divider') { insertBlockOfType(editor, 'divider'); return } pickInsert(editor, tile as 'todo' | 'quote' | 'code') } }}
              onTouchBlank={touchBlankTap}
              onOpenMedia={(blockId) => { if (compact) editorRef.current?.getRootElement()?.blur(); openDialog({ kind: 'mediaPreview', blockId }) }}
              onTouchExit={exitTouchEdit}
              onOpenLinkDialog={openExternalLinkDialog}
              blockOps={{ selectedIds, copy: (scope) => void copySelectionToClipboard(scope), copyRef: () => void copySelectionToClipboard('ref'), cut: () => void cutSelection(), remove: (ids) => requestDeleteSelection(ids), insertSibling: (blockId, where) => { const editor = editorRef.current; if (editor) insertSibling(editor, blockId, where) }, moveStep: moveBlocksStep, indent: (blockId, direction) => { const editor = editorRef.current; if (editor) outlineMove(editor, direction, blockId) }, insertTile: (direction, tile, sub) => { const editor = editorRef.current; if (!editor) return; if (tile === 'link') { if (sub === 'page') convertSelectionToLink(); else openExternalLinkDialog(); return } if (tile === 'datetime') { const anchor = direction === 'above' ? selectedIds[0] : selectedIds[selectedIds.length - 1]; if (anchor) insertBlockOfType(editor, 'text', insertDateText(sub === 'now' ? 'now' : 'today'), anchor); return } if (tile === 'image' || tile === 'camera') { pickMediaFile('image', { capture: tile === 'camera' }); return } if (tile === 'file') { pickMediaFile('file'); return } if (tile === 'embed') { insertEmbedPlaceholder(); return } const anchor = direction === 'above' ? selectedIds[0] : selectedIds[selectedIds.length - 1]; if (!anchor) return; const afterId = direction === 'above' ? (document.querySelector<HTMLElement>(`.moqi-block[data-entity-id="${anchor}"]`)?.previousElementSibling instanceof HTMLElement ? (document.querySelector<HTMLElement>(`.moqi-block[data-entity-id="${anchor}"]`)!.previousElementSibling as HTMLElement).dataset.entityId : undefined) : anchor; if (!afterId) return; insertBlockOfType(editor, tile === 'divider' ? 'divider' : (tile as 'todo' | 'quote' | 'code'), undefined, afterId) }, toggleSelect: (blockId) => selectBlock(blockId, 'toggle'), selectAll: () => { const ids = [...document.querySelectorAll<HTMLElement>('.doc-col .moqi-block[data-entity-id]:not([data-block-object="true"])')].map((element) => element.dataset.entityId ?? '').filter(Boolean); if (ids.length === 0) return; selectBlock(ids[0], 'single'); if (ids.length > 1) selectBlock(ids[ids.length - 1], 'range') }, batchTodo: () => { const editor = editorRef.current; if (!editor) return; /* D-099：二次点击取消（通用 toggle 语义，用户 ）——
               选区已全是待办 ⇒ 整批转回正文；否则整批转待办 */ const allTodo = selectedIds.length > 0 && selectedIds.every((id) => store.read().get(id)?.type === 'todo'); const target = allTodo ? 'text' : 'todo'; for (const id of selectedIds) convertCurrentBlock(editor, id, target) }, batchIndent: () => { const editor = editorRef.current; if (!editor) return; for (const id of selectedIds) outlineMove(editor, 'indent', id) }, moveGroup: (targetId, position) => { const editor = editorRef.current; if (editor) moveBlockGroup({ store, editor, ids: selectedIds, targetId, position }) } }}
              onEnter={onEnter}
              onLeaveList={(editor, event) => leaveListOnBackspace(editor, event, { store, persist, convertCurrentBlock, flushPendingEnter, syncEditorChanges })}
              onIndent={(editor, blockId) => outlineMove(editor, 'indent', blockId)}
              onOutdent={(editor, blockId) => outlineMove(editor, 'outdent', blockId)}
              onToggleCollapse={toggleCollapse}
              onMoveStep={moveBlocksStep}
              onJumpRef={jumpToBlock}
              onOpenExternal={openExternalUrl}
              onPasteUrl={(url) => {
                const editor = editorRef.current
                if (!editor) return
                syncEditorChanges(editor, editor.getEditorState())
                const current = caretRangeInBlock(editor)
                if (current) applyExternalLink(current, '', url)
              }}
              onPasteMedia={(file) => {
                void file.arrayBuffer().then((buffer) => insertMediaBlock({ bytes: new Uint8Array(buffer), originalName: file.name || '粘贴的图片.png', mime: file.type || 'image/png' }))
              }}
              onMarkerTrigger={(blockId, marker) => {
                const editor = editorRef.current
                if (!editor) return
                // 先把编辑器里的字同步回领域：触发词刚打完时，这个块（Enter 新造的）很可能还没落库，
                // convertCurrentBlock 会因 store.get 为空直接返回——accept 实测过一次。
                syncEditorChanges(editor, editor.getEditorState())
                convertCurrentBlock(editor, blockId, marker.type, '', { checked: marker.checked })
              }}
              onPasteOutline={(anchorId, drafts) => {
                const editor = editorRef.current
                if (!editor) return
                // 先把编辑器里已有的字同步进领域，再插——不然这批新块会排在「还没写回的正文」之前
                syncEditorChanges(editor, editor.getEditorState())
                // [[页名]] / ((块名)) 按名还原成行内引用——**与「复制为块引用」写出的语法同一张表**
        // （用户 报的缺口：菜单写出去的语法自己粘回来不认）；认不出的保持字面。
                // 解析放在这一层：EditorPlugins 拿不到 store（领域不认识「名字 → id」这件事）。
                const inline = resolveInlineRefs(drafts, (kind, label) => store.resolveInlineRef(kind, label, anchorId))
                const ids = store.insertOutline(anchorId, inline.drafts)
                if (!ids) return
                reloadFromStore()
              }}
              onActiveBlock={setActiveBlockId}
              onEditor={captureEditor}
              onSlashCommand={(editor, blockId, item, triggerText) => handleSlashCommand(editor, blockId, item, triggerText)}
              findTargets={(kind, query, fromId) => store.findRefTargets(kind, query, fromId)}
              suggestFor={(_kind, query, fromId) => suggestReferences({ blocks: store.read(), fromId, query })}
              onInsertRef={insertReference}
              onAi={(action) => void runAi(action, aiSourcePlan({ selectedBlocks: selectedIds, caretBlockId: caretBlockInPage(), pageId: activePageId }))}
              onOpenAiPanel={() => openSidePanel('ai')}
              resolvePeek={resolvePeek}
              resolveRefTitle={resolveRefTitle}
              onNotify={notify}
              onAdoptRoot={adoptRootContent}
              onNameRowCross={(editor, options) => {
                const facts = nameRowFacts()
                return facts ? crossNameRow(editor, facts, options) : false
              }}
              onNameRowEdge={(editor, end) => {
                const facts = nameRowFacts()
                return facts ? nameRowEdge(editor, facts, end) : false
              }}
              onSelectNameRow={(containerId) => {
                // 只接「点容器自己那一行」且那一行是空的（有文字时点击落在真实文字上，原生行为就对）。
                const editor = editorRef.current
                if (!editor || !containerId || containerId !== activePageId) return false
                const container = store.get(containerId)
                if (!container?.isObject || textContent(container).length > 0) return false
                return selectNameRow(editor, containerId)
              }}
              formats={formatSnapshot.selection}
              onToggleFormat={toggleInlineFormat}
              isLinkConvert={isLinkConvert}
              clearLinkConvert={clearLinkConvert}
              onConvertLink={convertSelectionToLink}
            />
    </>
  )

  return mainContent
}
