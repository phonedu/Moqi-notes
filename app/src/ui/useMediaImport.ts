import type { AssetPort, ExportPort } from '../composition'
import type { DomainStore } from '../application/store'
import type { Block, BlockAsset, MetadataRegistry } from '@moqi/editor'
import { guessMimeFromName, mediaKindOf } from '@moqi/editor'
import { parseMarkdownDocument } from '@moqi/editor'
import { applyImportedAssets, collectInlineTags, collectMediaRefs, resolveExternalLinks, resolveInlineRefs, resolvePageRefs } from '@moqi/editor'
import { coercePropertyValue, createPropertyDef, ensureTagDef, inferPropertyType, propertyNameProblem } from '@moqi/editor'
import { entryBaseName, planPackage, resolvePackageImage } from '@moqi/editor'
import { loadUiPrefs } from './uiPrefs'

/**
 * 媒体三管道 ＋ Markdown 导入 ＋ 嵌入块来源（外壳拆分第六刀之一，2026-10-09 从 `EditorShell` 抽出）。
 *
 * **与编辑器的耦合收成两个能力**（`currentAnchorId` / `syncEditorNow`），不 import 内核——
 * 这样这个模块保持"零内核"，内核冻结名单不必再重定基（那条名单的意图是"看得见谁在碰内核"）。
 *
 * 不变式（原注释照搬）：**先写文件、后写事务**（文件是内容、块是索引）；写失败 = 不建块 + 如实提示。
 */
/** front-matter 的 ISO 时间戳 → 毫秒（写不出来 / 解析不了就 `undefined`，页面用「现在」）。 */
function timestampOf(value: string | null): number | undefined {
  if (!value) return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : undefined
}

type Deps = {
  /** 光标所在块（插入媒体的落点）。 */
  currentAnchorId: () => string | null
  /** 把编辑器镜像落盘（`syncEditorChanges`），插入前先同步一次。 */
  syncEditorNow: () => void
  assetPort: AssetPort
  exportPort: ExportPort
  store: DomainStore
  registry: MetadataRegistry
  updateRegistry: (next: MetadataRegistry) => void
  persist: (changedIds: Iterable<string>) => void
  reloadFromStore: () => void
  openPage: (pageId: string) => void
  notify: (message: string, actionLabel?: string, onAction?: () => void) => void
  setAssetNames: (updater: (current: Set<string>) => Set<string>) => void
}

export function useMediaImport({
  currentAnchorId, syncEditorNow, assetPort, exportPort, store, registry, updateRegistry, persist, reloadFromStore, openPage, notify, setAssetNames,
}: Deps) {
  async function imageSizeOf(bytes: Uint8Array, kind: 'image' | 'file'): Promise<{ width: number; height: number } | null> {
    if (kind !== 'image') return null
    try {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]))
      const size = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return size
    } catch {
      return null
    }
  }

  /**
   * 三管道的共同落点（13-媒体设计（已归档） §3 的时序）：**先写文件、后写事务**（文件是内容、块是索引）；
   * 写失败 = 不建块 + 如实提示（不留半个块）。块走 `insertOutline`——位置算式与粘贴共用一份。
   */
  async function insertMediaBlock(input: { bytes: Uint8Array; originalName: string; mime: string }) {
    const anchorId = currentAnchorId()
    if (!anchorId) { notify('先选中一个块再插入媒体'); return }
    const kind = mediaKindOf(input.mime)
    const dot = input.originalName.lastIndexOf('.')
    const ext = dot > 0 ? input.originalName.slice(dot) : ''
    const diskName = crypto.randomUUID() + ext
    try {
      const size = await assetPort.write(diskName, input.bytes)
      setAssetNames((current) => new Set(current).add(diskName))
      syncEditorNow()
      const dims = await imageSizeOf(input.bytes, kind)
      const asset: BlockAsset = { fileName: diskName, originalName: input.originalName, mime: input.mime, size, ...(dims ?? {}) }
      const ids = store.insertOutline(anchorId, [{ type: kind, text: '', asset, children: [] }])
      if (!ids) { notify('插入失败：光标所在块找不到了'); return }
      reloadFromStore()
    } catch (error) {
      notify('无法导入文件：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /** 桌面拖入：路径 → Rust 哑复制（原名取源文件名），再建块。 */
  async function importDroppedPaths(paths: string[]) {
    for (const sourcePath of paths) {
      //  拖进来 = **导入一份文档**（建一页），不是插一个媒体块——两条路在这里分流。
      if (/\.zip$/i.test(sourcePath)) {
        try {
          const pack = await exportPort.readPackageEntries(sourcePath)
          const entries = pack.entries.map((entry) => ({ name: entry.name, bytes: Uint8Array.from(atob(entry.base64), (ch) => ch.charCodeAt(0)) }))
          await importZipEntries({ entries, skipped: pack.skipped, label: sourcePath.split(/[\\/]/).pop() ?? '导入包.zip' })
        } catch (error) {
          notify('导入失败：' + (error instanceof Error ? error.message : String(error)))
        }
        continue
      }
      if (/.(md|markdown)$/i.test(sourcePath)) {
        try {
          const text = await exportPort.readTextFile(sourcePath)
          const fileName = sourcePath.split(/[/\\]/).pop() ?? '导入的文档.md'
          const dir = sourcePath.slice(0, sourcePath.length - fileName.length - 1)
          await importMarkdownDocument({ text, fileName, dir: dir.length > 0 ? dir : null })
        } catch (error) {
          notify('导入失败：' + (error instanceof Error ? error.message : String(error)))
        }
        continue
      }
      // **媒体这一支才需要锚点**（要插进某个块）；`.md` / `.zip` 是「导入一份文档 = 建页」，与选中哪块无关
      // （设置页的「选择文件」没有锚点——`T-18`）。
      const anchorId = currentAnchorId()
      if (!anchorId) { notify('先选中一个块再插入媒体'); return }
      const originalName = sourcePath.split(/[\\/]/).pop() ?? '文件'
      const kind = mediaKindOf(guessMimeFromName(originalName))
      const diskName = crypto.randomUUID() + (originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : '')
      try {
        const result = await assetPort.importFromPath(sourcePath, diskName)
        setAssetNames((current) => new Set(current).add(result.diskName))
        syncEditorNow()
        const asset: BlockAsset = {
          fileName: result.diskName,
          originalName: result.originalName,
          mime: guessMimeFromName(result.originalName),
          size: result.sizeBytes,
        }
        store.insertOutline(anchorId, [{ type: kind, text: '', asset, children: [] }])
        reloadFromStore()
      } catch (error) {
        notify('无法导入文件：' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  /**
   * 「选择文件夹」导入（`T-18` 第 2 刀）：列目录 → **逐篇走同一条 `importMarkdownDocument`**——
   * 每篇都带上它自己的 `dir`，相对路径的图由那条既有分支去找（只喂路径，不另开通路）。
   * 单篇失败不挡其余（与其他批量导入同口径）；末尾给一句**落点数**（用户唯一线索）。
   */
  async function importFolder(dirPath: string) {
    let files: string[] = []
    try {
      files = await exportPort.listMarkdownFiles(dirPath)
    } catch (error) {
      notify('打不开这个文件夹：' + (error instanceof Error ? error.message : String(error)))
      return
    }
    if (files.length === 0) { notify('这个文件夹里没有 .md'); return }
    for (const file of files) {
      const fileName = file.split(/[\\/]/).pop() ?? '导入的文档.md'
      const dir = file.slice(0, file.length - fileName.length - 1)
      try {
        await importMarkdownDocument({ text: await exportPort.readTextFile(file), fileName, dir: dir.length > 0 ? dir : null, silent: true })
      } catch { /* 单篇失败不挡其余 */ }
    }
  }

  /** 图片尺寸：**从显示地址量**（导入走路径，手里没有字节；桌面 asset 协议与浏览器 object URL 都能量）。 */
  async function imageSizeOfUrl(url: string): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      const probe = new Image()
      probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight })
      probe.onerror = () => resolve(null)
      probe.src = url
    })
  }

  /**
   * 导入一份 Markdown 文档（13-导出与媒体设计（已归档） §「导入」）：**把 `.md` 拖进正文**就是入口。
   *
   * ① **资产落地**：桌面拖入给的是路径 ⇒ 顺着 `.md` 同目录的 `assets/` 把图与附件真落进数据目录
   * （走 `importFromPath`，与三条媒体管道同一条哑写）；**同目录找不到再试 `assets/<名>`**
   * （Obsidian 的 `![[图.png]]` 两种放法都常见）。浏览器通道只有字节、读不到旁边的 `assets/`
   * ⇒ 那几行**降级成文字**，提示里如实说。找不到的文件一律降级成文字（不静默丢）。
   * ② **建页 + 落块**：页名取文档第一处 `# ` 标题（**围栏里的不算**；没有就取文件名）；正文与页面在
   * **同一个事务**里，一次 ⌘Z 退回整篇。front-matter 的标签按名取 id（没有就建），属性按名对定义
   * （新键按**写法**推断类型：裸数字 / true·false / ISO 日期 / 其余文本——引号化的值一律文本）。
   * ③ **时间戳回读**：front-matter 的 `created` / `modified` 还原到页面上（对齐"属性全量"口径）。
   * ④ **四条还原路**依次跑：媒体落地 → `[名](名.md)` 页面引用 → `[[页]]` / `((块))` 原文引用
   * （含 Obsidian 的 `[[页|别名]]` / `[[路径/页]]`）→ `[文字](url)` 外部链接（→ `link` 片段）。
   * 认不出的**一律保持字面**并把条数报进提示（不凭空造页、不静默丢）。
   */
  async function importMarkdownDocument(input: { text: string; fileName: string; dir: string | null; /** 导入包：按相对引用名提供的包内字节（与 dir 二选一，优先包内）。 */ packageBytes?: Map<string, Uint8Array>; /** 导入包批量：不逐篇弹提示 / 不逐篇跳页，返回结果供汇总。 */ silent?: boolean }) {
    const doc = parseMarkdownDocument(input.text)
    const pageName = (doc.name ?? input.fileName.replace(/\.md$/i, '')).trim() || '导入的文档'
    const refs = collectMediaRefs(doc.roots)
    const assets = new Map<string, BlockAsset>()
    if (input.packageBytes) {
      // 导入包：图在包里（字节在手）——按相对引用名对条目，落进数据目录（与三条媒体管道同一条哑写）。
      for (const ref of refs) {
        const hit = resolvePackageImage(ref.href, [...input.packageBytes.keys()])
        const bytes = hit ? input.packageBytes.get(hit) : undefined
        if (!hit || !bytes) continue
        const dot = hit.lastIndexOf('.')
        const diskName = crypto.randomUUID() + (dot >= 0 ? hit.slice(dot) : '')
        try {
          const size = await assetPort.write(diskName, bytes)
          setAssetNames((current) => new Set(current).add(diskName))
          const asset: BlockAsset = { fileName: diskName, originalName: entryBaseName(ref.href) || entryBaseName(hit), mime: guessMimeFromName(hit), size }
          if (ref.kind === 'image') {
            const url = assetPort.displayUrl(diskName)
            const dims = url ? await imageSizeOfUrl(url) : null
            if (dims) { asset.width = dims.width; asset.height = dims.height }
          }
          assets.set(ref.href, asset)
        } catch { /* 落不了：下面按「缺文件」降级成文字 */ }
      }
    } else if (input.dir !== null) {
      for (const ref of refs) {
        const relative = ref.href.replace(/^\.\//, '')
        if (relative.startsWith('/') || relative.includes('..')) continue
        // 两个候选：正文写的相对路径、以及 `assets/<名>`（Obsidian 的 `![[图.png]]` 常这么放）。
        const candidates = relative.includes('/') ? [relative] : [relative, `assets/${relative}`]
        for (const candidate of candidates) {
          const dot = candidate.lastIndexOf('.')
          const diskName = crypto.randomUUID() + (dot >= 0 ? candidate.slice(dot) : '')
          try {
            const result = await assetPort.importFromPath(input.dir + '/' + candidate, diskName)
            setAssetNames((current) => new Set(current).add(result.diskName))
            const asset: BlockAsset = {
              fileName: result.diskName,
              originalName: ref.label || candidate.split('/').pop() || '文件',
              mime: guessMimeFromName(candidate),
              size: result.sizeBytes,
            }
            if (ref.kind === 'image') {
              const url = assetPort.displayUrl(result.diskName)
              const dims = url ? await imageSizeOfUrl(url) : null
              if (dims) { asset.width = dims.width; asset.height = dims.height }
            }
            assets.set(ref.href, asset)
            break
          } catch { /* 找不到 / 读不了：试下一个候选；都不行下面按「缺文件」降级成文字 */ }
        }
      }
    }
    const landed = applyImportedAssets(doc.roots, assets)
    const missing = landed.missing
    // 引用还原：`[名](名.md)`（导出侧把 `[[ ]]` 降级成的形态）→ 指回库里同名的那一页；
    // 对不上就保持文字（不凭空造页），`unresolved` 进提示。
    const resolved = resolvePageRefs(landed.drafts, (name) => {
      for (const block of store.snapshot().values()) {
        if (block.isObject && !block.deleted && (block.objectName ?? "") === name) return block.entityId
      }
      return null
    })
    // 外来文档里也可能是 [[…]] / ((…))（不是导出的降级形态）——同一套解析再过一遍，认不出仍保持字面。
    const inlineRefs = resolveInlineRefs(resolved.drafts, (kind, label) => store.resolveInlineRef(kind, label, ''))
    // 外部链接（`[文字](url)` / `<https://…>`）→ `link` 片段：模型里本来就有一等公民，转过来链接才是活的。
    const withLinks = resolveExternalLinks(inlineRefs.drafts)

    // front-matter：标签按名取 id（没有就建）、属性按名对定义（新键按写法推断类型建定义）。
    let nextRegistry = registry
    const tagIds: string[] = []
    for (const name of doc.frontMatter.tags) {
      const ensured = ensureTagDef(name, nextRegistry)
      nextRegistry = ensured.registry
      if (!tagIds.includes(ensured.id)) tagIds.push(ensured.id)
    }
    // 正文里的行内标签（Obsidian 的 `#标签`）：**按开关**收成页面标签——只登记、正文一字不动
    // （用户 2026-10-10 裁决；开关在导入页，默认开）。对齐 Obsidian 的语义"行内标签 ⊂ 这篇笔记的标签"。
    // 开关读**当前偏好**（导入页的复选框，落盘在 uiPrefs.importInlineTags，默认开）——现读就永远是
    // 用户刚点的那个值，不必让外壳把值穿进来（壳里每加一个 prop 都占体量门的额度）。
    const inlineTags = loadUiPrefs().importInlineTags ? collectInlineTags(withLinks.drafts) : []
    for (const name of inlineTags) {
      const ensured = ensureTagDef(name, nextRegistry)
      nextRegistry = ensured.registry
      if (!tagIds.includes(ensured.id)) tagIds.push(ensured.id)
    }
    const values: Block['properties'] = []
    for (const item of doc.frontMatter.properties) {
      if (propertyNameProblem(item.key, nextRegistry) !== null) continue
      // 定义按名对上；没有就按**值的写法**建一个（往返时定义本来就在库里，只有外来文档才会新建）。
      const existing = nextRegistry.properties.find((entry) => entry.name === item.key)
      let def = existing ?? null
      if (!def) {
        const created = createPropertyDef(item.key, inferPropertyType(item.raw, item.quoted), nextRegistry)
        if (!created) continue
        def = created.def
        nextRegistry = created.registry
      }
      // checkbox 的值是裸 `true` / `false`（导出侧写的），`coercePropertyValue` 要的是布尔。
      const value = coercePropertyValue(def, def.type === 'checkbox' ? item.raw === 'true' : item.raw)
      if (value) values.push(value)
    }
    if (nextRegistry !== registry) updateRegistry(nextRegistry)

    const created = store.insertDocumentAsPage(withLinks.drafts, pageName, {
      tags: tagIds,
      properties: values,
      created: timestampOf(doc.frontMatter.created),
      modified: timestampOf(doc.frontMatter.modified),
    })
    if (!created) { if (!input.silent) notify('这份文档里没有可导入的内容'); return null }
    persist([created.pageId, ...created.blockIds])
    if (!input.silent) openPage(created.pageId)
    return { pageId: created.pageId, pageName, blocks: created.blockIds.length, assets: assets.size, missing: missing.length, unresolved: resolved.unresolved.length }
  }

  /**
   * 拖入 \`.zip\` = **导入包**（第 13 项「zip 批量导入」，2026-10-11）：一次建 N 个页面（允许同名）。
   * 分拣判据在 \`domain/mdPackage.ts\`（备份包嗅探 / 支持类型 / 报数）——这里是执行与汇总：
   * 逐篇按静默路导入（不逐篇弹提示、不逐篇跳页），最后开第一篇 + 一条总账；包内的图按相对
   * 引用名取字节落地（两条通道同一条哑写）。超限条目由解包层跳过并报数。
   */
  async function importZipEntries(input: { entries: { name: string; bytes: Uint8Array }[]; skipped: number; label: string }) {
    const plan = planPackage(input.entries.map((entry) => entry.name))
    if (plan.isBackup) {
      notify('这个 .zip 是整库备份包（含数据库）——导入只收 Markdown 包；要装回来请走「设置 › 备份与恢复」')
      return
    }
    if (plan.documents.length === 0) {
      notify('导入包「' + input.label + '」里没有可导入的 .md / .txt（' + (plan.skipped + plan.images.length) + ' 个条目不支持）')
      return
    }
    const byName = new Map(input.entries.map((entry) => [entry.name, entry.bytes]))
    const packageBytes = new Map<string, Uint8Array>()
    for (const name of plan.images) {
      const bytes = byName.get(name)
      if (bytes && bytes.length > 0) packageBytes.set(name, bytes)
    }
    const decoder = new TextDecoder()
    let first: string | null = null
    for (const name of plan.documents) {
      const bytes = byName.get(name)
      if (!bytes) continue
      const result = await importMarkdownDocument({ text: decoder.decode(bytes), fileName: entryBaseName(name), dir: null, silent: true, packageBytes })
      if (!result) continue
      if (!first) first = result.pageId
    }
    if (first) openPage(first)
  }

  /** 浏览器拖入：File 对象 → 字节。 */
  async function importDroppedFiles(files: File[]) {
    for (const file of files) {
      // 浏览器通道读不到本机的 ：媒体行会按文字降级，这里如实把 dir 传 null。
      if (/.(md|markdown)$/i.test(file.name)) {
        await importMarkdownDocument({ text: await file.text(), fileName: file.name, dir: null })
        continue
      }
      if (/\.zip$/i.test(file.name)) {
        try {
          // 懒加载：zip 能力不进主包（1ⓓⓔ 的包体读数不吃这一刀）。
          const { unzipSync } = await import('fflate')
          const raw = unzipSync(new Uint8Array(await file.arrayBuffer()))
          let skipped = 0
          const entries = Object.entries(raw)
            .map(([name, bytes]) => ({ name, bytes }))
            .filter((entry) => {
              if (entry.bytes.length > 8 * 1024 * 1024) { skipped += 1; return false }
              return true
            })
          await importZipEntries({ entries, skipped, label: file.name })
        } catch (error) {
          notify('这个 .zip 解不开：' + (error instanceof Error ? error.message : String(error)))
        }
        continue
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      await insertMediaBlock({ bytes, originalName: file.name, mime: file.type || guessMimeFromName(file.name) })
    }
  }

  /** 嵌入块的空态（`R09-BLOCK-24`「选择来源」）：先落成块，来源随后由「选择来源」写进去。 */
  function insertEmbedPlaceholder() {
    const anchorId = currentAnchorId()
    if (!anchorId) { notify('先选中一个块'); return }
    const ids = store.insertOutline(anchorId, [{ type: 'embed', text: '', children: [] }])
    if (!ids) { notify('插入失败：光标所在块找不到了'); return }
    reloadFromStore()
  }

  /**
   * 嵌入块的来源写入（`R09-BLOCK-24`）：选源 / 换源共用一条路——领域里是**一次事务一个撤销步**
   * （先摘旧引用再写新引用），这里只负责落盘 + 给一步撤销。
   */
  function applyEmbedSource(blockId: string, targetId: string) {
    if (!store.setEmbedSource(blockId, targetId)) {
      notify('这一块不能当来源：不能选自己，也不能选自己的上层块')
      return
    }
    persist([blockId, targetId])
  }

  /** 去掉来源（块菜单「去掉来源」）：回到空态卡，引用与反链一起摘掉。 */
  function clearEmbedSource(blockId: string) {
    if (!store.setEmbedSource(blockId, null)) return
    persist([blockId])
    /* B 批：去掉来源成功不弹通知 */
  }

  /** 菜单选文件：同一个 `<input type=file>`（图片限定 `image/*`），选完即走共同落点。 */
  function pickMediaFile(kind: 'image' | 'file', options?: { capture?: boolean }) {
    const input = document.createElement('input')
    input.type = 'file'
    if (kind === 'image') input.accept = 'image/*'
    // `capture` = 拉起系统相机（`10` §6.3 插入面板「拍照」格）：Android 壳走 `ACTION_IMAGE_CAPTURE`。
    if (kind === 'image' && options?.capture) input.capture = 'environment'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      void file.arrayBuffer().then((buffer) => insertMediaBlock({ bytes: new Uint8Array(buffer), originalName: file.name, mime: file.type || guessMimeFromName(file.name) }))
    })
    input.click()
  }

  return { insertMediaBlock, importDroppedPaths, importFolder, imageSizeOfUrl, importMarkdownDocument, importDroppedFiles, insertEmbedPlaceholder, applyEmbedSource, clearEmbedSource, pickMediaFile }
}
