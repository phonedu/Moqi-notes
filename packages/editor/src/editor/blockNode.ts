import {
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  DecoratorNode,
  ElementNode,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type SerializedLexicalNode,
  type SerializedTextNode,
} from 'lexical'
import type { AiMeta, Block, BlockAsset, BlockType, ContentFragment, InlineRefBinding, Mark, RefKind } from '../domain/block'
import { AI_ACTION_LABEL } from '../domain/block'
import { aiSourceLabel } from '../domain/aiOps'

export type SerializedBlockNode = SerializedElementNode & {
  entityId: string
  blockUid: string
  blockType: BlockType
  collapsed: boolean
  checked: boolean
  isObject: boolean
}

export class BlockNode extends ElementNode {
  __entityId: string
  __blockUid: string
  __blockType: BlockType
  __collapsed: boolean
  __checked: boolean
  __isObject: boolean
  __aiMeta: AiMeta | null
  /**
   * 媒体 payload（13-媒体设计（已归档） §2；只有 image / file 有值）。
   * 与 `__aiMeta` 同理：**只挂在节点属性上、不写进编辑器的子节点**（那一层归 Lexical 管），
   * 卡片样式由 CSS 读 `data-asset-*`；图片地址由装饰层从资产端口换成显示 URL 写进 `--asset-url`。
   */
  __asset: BlockAsset | null

  static getType(): string { return 'moqi-block' }

  static clone(node: BlockNode): BlockNode {
    return new BlockNode(node.__entityId, node.__blockUid, node.__blockType, node.__collapsed, node.__checked, node.__isObject, node.__aiMeta, node.__asset, node.__key)
  }

  constructor(entityId: string, blockUid: string, blockType: BlockType, collapsed = false, checked = false, isObject = false, aiMeta: AiMeta | null = null, asset: BlockAsset | null = null, key?: NodeKey) {
    super(key)
    this.__entityId = entityId
    this.__blockUid = blockUid
    this.__blockType = blockType
    this.__collapsed = collapsed
    this.__checked = checked
    this.__isObject = isObject
    this.__aiMeta = aiMeta
    this.__asset = asset
  }

  static importJSON(serializedNode: SerializedBlockNode): BlockNode {
    return new BlockNode(
      serializedNode.entityId,
      serializedNode.blockUid,
      serializedNode.blockType,
      serializedNode.collapsed,
      serializedNode.checked,
      serializedNode.isObject ?? false,
    ).updateFromJSON(serializedNode)
  }

  exportJSON(): SerializedBlockNode {
    return {
      ...super.exportJSON(),
      type: BlockNode.getType(),
      entityId: this.__entityId,
      blockUid: this.__blockUid,
      blockType: this.__blockType,
      collapsed: this.__collapsed,
      checked: this.__checked,
      isObject: this.__isObject,
    }
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const tag = tagForBlockType(this.__blockType)
    const dom = document.createElement(tag)
    dom.dataset.entityId = this.__entityId
    dom.dataset.blockUid = this.__blockUid
    dom.dataset.blockType = this.__blockType
    dom.dataset.collapsed = String(this.__collapsed)
    dom.dataset.checked = String(this.__checked)
    dom.dataset.blockObject = String(this.__isObject)
    dom.className = `moqi-block ${blockTypeClassName(this.__blockType)}`
    if (this.__collapsed) dom.classList.add('is-collapsed')
    if (this.__checked) dom.classList.add('is-checked')
    applyOwnLineFlag(dom, this)
    decorateAi(dom, this.__aiMeta)
    decorateAsset(dom, this.__asset)
    return dom
  }

  updateDOM(previous: BlockNode, dom: HTMLElement, _config: EditorConfig): boolean {
    if (tagForBlockType(previous.__blockType) !== tagForBlockType(this.__blockType)) return true
    // text/bullet/numbered/todo all render as <p>, so a type change here does
    // not recreate the element. The type class must be swapped in place or the
    // list marker / checkbox styles would not appear until a reload.
    if (previous.__blockType !== this.__blockType) {
      dom.classList.remove(blockTypeClassName(previous.__blockType))
      dom.classList.add(blockTypeClassName(this.__blockType))
    }
    dom.dataset.entityId = this.__entityId
    dom.dataset.blockUid = this.__blockUid
    dom.dataset.blockType = this.__blockType
    dom.dataset.collapsed = String(this.__collapsed)
    dom.dataset.checked = String(this.__checked)
    dom.dataset.blockObject = String(this.__isObject)
    dom.classList.toggle('is-collapsed', this.__collapsed)
    dom.classList.toggle('is-checked', this.__checked)
    applyOwnLineFlag(dom, this)
    decorateAi(dom, this.__aiMeta)
    decorateAsset(dom, this.__asset)
    return false
  }

  isIsolated(): boolean { return false }
  canBeEmpty(): boolean { return true }
  getEntityId(): string { return this.__entityId }
  getBlockUid(): string { return this.__blockUid }
  getBlockType(): BlockType { return this.__blockType }
  isCollapsed(): boolean { return this.__collapsed }
  isChecked(): boolean { return this.__checked }
  isPageObject(): boolean { return this.__isObject }
  getAiMeta(): AiMeta | null { return this.__aiMeta }

  getAsset(): BlockAsset | null { return this.__asset }

  setAsset(asset: BlockAsset | null): void {
    this.getWritable().__asset = asset
  }

  setCollapsed(collapsed: boolean): void {
    this.getWritable().__collapsed = collapsed
  }

  setChecked(checked: boolean): void {
    this.getWritable().__checked = checked
  }

  setBlockType(blockType: BlockType): void {
    this.getWritable().__blockType = blockType
  }

  setAiMeta(aiMeta: AiMeta | null): void {
    this.getWritable().__aiMeta = aiMeta
  }
}

/**
 * 块「自己那一行」是否存在（显式 DOM 标记，docs/04 §1；不靠 `:has()` 猜结构）。
 *
 * 块有子块、但自己没有任何行内内容时，它**没有行盒**：`padding` 之上直接就是第一个子块。
 * 自绘在块左上角的那些元素（有序列表编号、项目圆点、待办复选框、折叠箭头）是按「块自己那一行」
 * 定位的，于是它们会落到第一个子块那一行上——用户实测：「缩进到空的列表项里，直接重叠」。
 * 标记为 `missing` 后由 CSS 补出这一行（见 app.css `.moqi-block[data-own-line='missing']`）。
 */
function applyOwnLineFlag(dom: HTMLElement, node: BlockNode): void {
  const children = node.getChildren()
  dom.dataset.ownLine = ownLineFlag({
    // 页面容器按**名字行文字量**算（`D-072`）：行盒持有者不算字——按 `inlineTextSize` 算的话
    // 空名字行的占位（`data-own-line='missing'` 的 ::before「未命名页面」）会消失。
    inlineText: node.isPageObject() ? nameRowTextSize(node) : inlineTextSize(node),
    blocks: children.filter($isBlockNode).length,
    isObject: node.isPageObject(),
  })
}

/**
 * 「自己那一行」的判定（纯函数，供 `app/tests/behavior/editor.behavior.test.ts` 看护）。
 *
 * 看的是**可见文字的有无**，不是行内子节点的个数：页面容器的名字行永远持有一个**空**的
 * 名字行锚点（见 `$ensureNameLineAnchor`），按个数算会把它误判成「这一行有内容」，
 * 于是占位与空行一起消失——空页面又变成一片空白。
 */
export function ownLineFlag(counts: { inlineText: number; blocks: number; isObject?: boolean }): 'missing' | 'present' {
  if (counts.inlineText > 0) return 'present'
  // 页面容器必须永远有「名字那一行」（docs/04 §3.1）：空页面就只有一个空行，没有这一行的话
  // 编辑器看起来完全空白、连块都没有（用户实测 2026-09-28）。
  if (counts.isObject || counts.blocks > 0) return 'missing'
  // 普通空块自己就有一行（Lexical 渲染 <br>），不需要补。
  return 'present'
}

/** 块自己的行内**文字**子节点（名字行锚点这类结构性节点不算文字）。 */
export function $inlineTextChildren(block: BlockNode): LexicalNode[] {
  return block.getChildren().filter((child) => !$isBlockNode(child) && !$isNameLineAnchor(child))
}

/**
 * 页面容器的**名字行文字量**（`D-072` 的维护口径）：只数真正的文字，不含名字行锚点与
 * **行盒持有者**（下面的 `$ensureNameLineHolder`）——`inlineTextSize` 会把持有者那个 `\n`
 * 算进去，按它算会把空名字行误判成「有字」（占位消失、行末判据失灵）。
 */
export function nameRowTextSize(block: BlockNode): number {
  return block.getChildren().reduce((total, child) => {
    if ($isBlockNode(child) || $isNameLineAnchor(child) || $isLineBreakNode(child)) return total
    return total + child.getTextContentSize()
  }, 0)
}


/** 块自己的行内文字量（锚点这类零宽节点不计入）。 */
export function inlineTextSize(block: BlockNode): number {
  return $inlineTextChildren(block).reduce((total, child) => total + child.getTextContentSize(), 0)
}

/**
 * 在 Lexical 读取 / 更新上下文里按 entityId 找到 BlockNode。
 *
 * 原住在 `ui/BlockTools.tsx`（名字行收口 T5 时下沉到这里）：编辑器层（`editor/nameLine.ts`）
 * 也要它，而 `editor/` 不许反向引用 `ui/`（边界门）。UI 侧原名由 `BlockTools` 转出，调用点不用改。
 */
export function $findBlockNode(entityId: string): BlockNode | null {
  let found: BlockNode | null = null
  const visit = (node: LexicalNode): void => {
    if (found) return
    if ($isBlockNode(node) && node.getEntityId() === entityId) { found = node; return }
    if ('getChildren' in node && typeof node.getChildren === 'function') {
      for (const child of node.getChildren()) visit(child)
    }
  }
  for (const child of $getRoot().getChildren()) visit(child)
  return found
}

/**
 * 名字行锚点：页面容器**永远**持有的那个零宽行内节点（docs/04 §3.1 R04-NAME-11）。
 *
 * 名字 = 容器块自己那一行文字（R04-NAME-1）。这一行**空**的时候（新建页面、名字被删光、
 * 首行开头 Enter 把文字全拆走），容器在编辑器里就一个行内节点都没有：那一行只剩 CSS 装饰，
 * 而 Lexical 的归一会把指向它的光标全部压走（机制与实测见 `07` 的「规则理由 · R04-NAME-11」）：
 * - `$normalizePoint` 把元素点 (容器, 0) **下压进第一个子块**的文本 ⇒ 点占位没反应、
 *   新建页面后光标画在下面那一块上、删光名字后光标掉进下一个块；
 * - `$normalizeTextNode` 把空文本节点直接删掉 ⇒ 连「空」的落脚点都不剩。
 *
 * 锚点是一个**叶子行内节点**（同 LineBreakNode 的形态），三个性质都必要：
 * - 既不是元素也不是文本 ⇒ `$normalizePoint` 的下降循环在它这里 `break`，
 *   指向它的光标停在「容器自己那一行」这个位置，打字就写进这一行（不会掉进子块）；
 * - 零宽、无文字 ⇒ `getTextContentSize()` 恒为 0，不参与块内字符偏移的计算；
 * - 不是文本节点 ⇒ 适配器序列化时天然忽略它，不落进领域数据。
 */
export class NameLineAnchorNode extends DecoratorNode<null> {
  static getType(): string { return 'moqi-name-line-anchor' }

  static clone(node: NameLineAnchorNode): NameLineAnchorNode { return new NameLineAnchorNode(node.__key) }

  static importJSON(): NameLineAnchorNode { return new NameLineAnchorNode() }

  createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement('span')
    dom.className = 'moqi-name-line-anchor'
    dom.setAttribute('aria-hidden', 'true')
    return dom
  }

  updateDOM(): boolean { return false }

  exportJSON(): SerializedLexicalNode { return { type: NameLineAnchorNode.getType(), version: 1 } }

  /** 无文字、无形：这一行的高与宽都由行内文字（或占位）决定。 */
  getTextContent(): string { return '' }

  /** 光标能跨过它，但不能把它当节点选中（否则方向键会选出一个看不见的节点）。 */
  isKeyboardSelectable(): boolean { return false }
}

export function $createNameLineAnchor(): NameLineAnchorNode {
  return new NameLineAnchorNode()
}

/** 是不是名字行锚点。 */
export function $isNameLineAnchor(node: LexicalNode | null | undefined): node is NameLineAnchorNode {
  return node instanceof NameLineAnchorNode
}

/**
 * 名字行锚点的自维护不变式：页面容器**永远**持有这个名字行锚点。返回是否补过。
 *
 * 两个调用点：载入路径（`blockToNode`）与编辑器里的一个 `registerNodeTransform`
 * （删除最后一个字、Enter 拆行、粘贴、撤销重放都会把它弄丢）。规则只有这一处实现。
 *
 * 位置排在行内文字之后、子块之前。名字行有文字时也**必须留着**：它还是「删光名字」那一下
 * 光标修复的落点基准（删掉最后一个字时 Lexical 把光标修到父块的 element 点，锚点在，
 * 光标就停在名字行；不在，就被下压进子块）。代价是它会挡住 Lexical 沿「上一个节点」做的
 * 光标移动与合并，所以 `src/editor/inputRules.ts` 的 `decideNameRowCross` 显式补上那几条键。
 */
export function $ensureNameLineAnchor(block: BlockNode): boolean {
  if (!block.isPageObject()) return false
  if (block.getChildren().some($isNameLineAnchor)) return false
  const firstBlockIndex = block.getChildren().findIndex($isBlockNode)
  block.splice(firstBlockIndex === -1 ? block.getChildrenSize() : firstBlockIndex, 0, [$createNameLineAnchor()])
  return true
}

/**
 * 哪些 AI 块在界面上**有** AI 外观：生成中与待采用的块有；已接受（accepted）的块没有——
 * 用户 2026-09-29 裁决的方案 A：采用后只留数据、什么都不显示（连块角的 ✦ 也不做）。
 */
/**
 * 媒体块的数据属性（`R09-BLOCK-19/20`）：名字 / 原名 / 大小 / 类型摊在这里，
 * CSS 与装饰层只读属性——**不改写编辑器托管的子节点**（与 `decorateAi` 同一条纪律）。
 * 显示 URL 不在这里（那要问资产端口）：装饰层拿到后写进 `--asset-url`。
 */
function decorateAsset(dom: HTMLElement, asset: BlockAsset | null): void {
  const isMedia = dom.dataset.blockType === 'image' || dom.dataset.blockType === 'file'
  if (!isMedia || !asset) {
    delete dom.dataset.assetName
    delete dom.dataset.assetFile
    delete dom.dataset.assetSize
    delete dom.dataset.assetMime
    delete dom.dataset.assetRatio
    return
  }
  dom.dataset.assetName = asset.originalName
  dom.dataset.assetFile = asset.fileName
  dom.dataset.assetSize = String(asset.size)
  dom.dataset.assetMime = asset.mime
  // 占位卡按真实比例留位（有尺寸时才写；没有就按 16:9 兜底）
  if (asset.width && asset.height) dom.dataset.assetRatio = String(asset.width / asset.height)
  else delete dom.dataset.assetRatio
}

export function aiDecorationShown(aiMeta: AiMeta | null): boolean {
  return aiMeta !== null && aiMeta.status !== 'accepted'
}

/**
 * AI 结果块的可视标记（docs/09 §6.11）：虚线框与来源标记由领域数据驱动，
 * **已接受（accepted）的块在界面上与普通块完全一样**——不写任何 `data-ai-*`、不加类名、不留提示，
 * 来源与操作类型只活在领域数据里（R09-AIB-7「保留至采用或丢弃」，用户 2026-09-29 裁决方案 A）。
 * 标签文字用属性承载，避免改写编辑器托管的子节点。
 */
function decorateAi(dom: HTMLElement, aiMeta: AiMeta | null): void {
  const shown = aiDecorationShown(aiMeta)
  dom.classList.toggle('ai-block', shown)
  if (!shown || aiMeta === null) {
    delete dom.dataset.aiOp
    delete dom.dataset.aiSrc
    delete dom.dataset.aiStatus
    if (dom.title) dom.removeAttribute('title')
    return
  }
  const statusLabel = aiMeta.status === 'generating'
    ? 'AI 生成中'
    : aiMeta.status === 'cancelled' ? 'AI 生成已停止' : aiMeta.status === 'error' ? 'AI 生成失败' : 'AI 生成'
  // 来源文案说**范围**（基于全篇 / 基于本段 / 基于选中的 N 段），不数块数（R09-AIB-7）。
  const sourceLabel = aiSourceLabel({ sourceCount: aiMeta.sourceBlockIds.length, scope: aiMeta.sourceScope })
  dom.dataset.aiOp = AI_ACTION_LABEL[aiMeta.action]
  dom.dataset.aiSrc = sourceLabel
  dom.dataset.aiStatus = aiMeta.status
  const stateLabel = aiMeta.status === 'generating' ? '生成中，可停止' : aiMeta.status === 'needs-confirmation' ? '需人工确认' : aiMeta.status === 'complete' ? '待采用' : '已结束'
  dom.title = `${statusLabel} · ${AI_ACTION_LABEL[aiMeta.action]} · ${sourceLabel}（${stateLabel}）`
}

export function $createBlockNode(block: Pick<Block, 'entityId' | 'blockUid' | 'type' | 'collapsed' | 'checked' | 'isObject' | 'aiMeta' | 'asset'>): BlockNode {
  return new BlockNode(block.entityId, block.blockUid, block.type, block.collapsed, block.checked, block.isObject, block.aiMeta, block.asset ?? null)
}

export function $isBlockNode(node: LexicalNode | null | undefined): node is BlockNode {
  return node instanceof BlockNode
}

export type SerializedInlineFragmentNode = SerializedTextNode & {
  fragmentType: ContentFragment['t']
  fragmentValue: string
  refKind?: RefKind
  refTargetId?: string
  /** 外部链接地址（`link` 片段，0.5 起）。 */
  url?: string
}

/**
 * Keeps non-text ContentFragment kinds lossless until their interactive nodes
 * are added in V2a. T13 `inline-ref` fragments additionally carry their jump
 * target so display text and target identity stay independent.
 */
export class InlineFragmentNode extends TextNode {
  __fragmentType: ContentFragment['t']
  __refKind: RefKind | null
  __refTargetId: string | null
  __url: string | null

  static getType(): string { return 'moqi-inline-fragment' }

  static clone(node: InlineFragmentNode): InlineFragmentNode {
    return new InlineFragmentNode(node.__text, node.__fragmentType, node.__refKind, node.__refTargetId, node.__url, node.__key)
  }

  constructor(text: string, fragmentType: ContentFragment['t'], refKind: RefKind | null = null, refTargetId: string | null = null, url: string | null = null, key?: NodeKey) {
    super(text, key)
    this.__fragmentType = fragmentType
    this.__refKind = refKind
    this.__refTargetId = refTargetId
    this.__url = url
  }

  static importJSON(serializedNode: SerializedInlineFragmentNode): InlineFragmentNode {
    return new InlineFragmentNode(
      serializedNode.fragmentValue,
      serializedNode.fragmentType,
      serializedNode.refKind ?? null,
      serializedNode.refTargetId ?? null,
      serializedNode.url ?? null,
    ).updateFromJSON(serializedNode)
  }

  exportJSON(): SerializedInlineFragmentNode {
    const serialized: SerializedInlineFragmentNode = {
      ...super.exportJSON(),
      type: InlineFragmentNode.getType(),
      fragmentType: this.__fragmentType,
      fragmentValue: this.getTextContent(),
    }
    if (this.__refKind && this.__refTargetId) {
      serialized.refKind = this.__refKind
      serialized.refTargetId = this.__refTargetId
    }
    if (this.__url) serialized.url = this.__url
    return serialized
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config)
    this.decorateDOM(dom)
    return dom
  }

  updateDOM(previous: this, dom: HTMLElement, config: EditorConfig): boolean {
    if (previous.__fragmentType !== this.__fragmentType || previous.__refKind !== this.__refKind || previous.__refTargetId !== this.__refTargetId || previous.__url !== this.__url) return true
    return super.updateDOM(previous, dom, config)
  }

  getFragmentType(): ContentFragment['t'] { return this.__fragmentType }

  getRef(): InlineRefBinding | null {
    return this.__refKind && this.__refTargetId ? { kind: this.__refKind, targetId: this.__refTargetId } : null
  }

  /** 外部链接的目标地址（`link` 片段才有；`R09-ELINK-3` 的 `.el` 靠它打开）。 */
  getUrl(): string | null {
    return this.__url
  }

  private decorateDOM(dom: HTMLElement): void {
    // 外部链接（0.5，`R09-ELINK-3`）：`.el` 类 + `data-url`——点击交给外壳，节点不认识浏览器。
    if (this.__fragmentType === 'link') {
      dom.classList.add('el')
      if (this.__url) dom.dataset.url = this.__url
      return
    }
    if (this.__fragmentType !== 'inline-ref') return
    for (const name of inlineRefClassNames(this.__refKind)) dom.classList.add(name)
    if (this.__refTargetId) dom.dataset.refTarget = this.__refTargetId
    if (this.__refKind) dom.dataset.refKind = this.__refKind
  }
}

/**
 * 行内片段节点（`[[双链]]` / `((块引用))` 等）。
 *
 * **不可合并**（`toggleUnmergeable`）：链接是一个整体，光标贴在它旁边接着打字时，Lexical 的
 * 归一化会把新输入的文本**并进这个节点**——下划线与底背景就跟着空格一路长出去（用户实测
 * 2026-09-29：「[[ / (( 双链的样式，下划线会随着空格一直出现，块链接样式的背景也是」）。
 * `unmergeable` 只挡相邻文本的合并与删除，不影响在链接**内部**编辑（光标在链接文字中间时
 * 照旧可改）。链接边上的空白由 `$trimInlineRef` 挪到链接之外（光标跟着走）。
 */
export function $createInlineFragmentNode(fragment: Pick<ContentFragment, 't' | 'v' | 'ref' | 'url'>): InlineFragmentNode {
  return new InlineFragmentNode(fragment.v, fragment.t, fragment.ref?.kind ?? null, fragment.ref?.targetId ?? null, fragment.url ?? null).toggleUnmergeable()
}

export function $isInlineFragmentNode(node: LexicalNode | null | undefined): node is InlineFragmentNode {
  return node instanceof InlineFragmentNode
}

/**
 * 行内引用**首尾不留空白**（`R04-CARET-5`）：链接是一个整体，用户在链接边上敲的空白属于
 * 链接**之外**的普通文本。把 `[[目标页面]]` 后面的空格留在链接里，下划线与底背景就会跟着空格
 * 一路长出去（用户实测 2026-09-29：「下划线会随着空格一直出现，块链接样式的背景也是」）。
 * 内部空格保留（页面名可以是「项目 B」）。
 *
 * **光标跟着挪走的那截空白**：用户刚敲的空格被挪到链接之外后，光标也跟到链接外面（落在那截
 * 空白的末尾）——否则光标仍停在链接文字里，接着敲的字又会被塞进链接，空格问题会以「下一个字
 * 又并进来」的形式复发。
 */
export function $trimInlineRef(refNode: InlineFragmentNode): boolean {
  const text = refNode.getTextContent()
  const head = /^[\s\u00a0\u3000]+/.exec(text)?.[0] ?? ''
  const tail = /[\s\u00a0\u3000]+$/.exec(text)?.[0] ?? ''
  if (head.length === 0 && tail.length === 0) return false
  const middle = text.slice(head.length, text.length - tail.length)
  const selection = $getSelection()
  const caretInsideRef = $isRangeSelection(selection) && selection.anchor.type === 'text'
    && selection.anchor.key === refNode.getKey() && selection.anchor.offset > middle.length
  let movedTail: TextNode | null = null
  if (head.length > 0) {
    const previous = refNode.getPreviousSibling()
    if ($isTextNode(previous)) previous.setTextContent(previous.getTextContent() + head)
    else refNode.insertBefore($createTextNode(head))
  }
  if (tail.length > 0) {
    const next = refNode.getNextSibling()
    if ($isTextNode(next)) next.setTextContent(tail + next.getTextContent())
    else refNode.insertAfter($createTextNode(tail))
    movedTail = refNode.getNextSibling() as TextNode
  }
  refNode.setTextContent(middle)
  if (caretInsideRef && movedTail) {
    const selection2 = $createRangeSelection()
    selection2.anchor.set(movedTail.getKey(), movedTail.getTextContentSize(), 'text')
    selection2.focus.set(movedTail.getKey(), movedTail.getTextContentSize(), 'text')
    $setSelection(selection2)
  }
  return true
}


/**
 * 行内 `#标签` 已裁决不做：正文里的 `#xxx` 保持普通文字，标签只属于页面级系统字段。
 * 历史数据里的 `mention` 片段由适配器按纯文本加载（见 blockLexicalAdapter），不丢字。
 */

export function blockTypeClassName(type: BlockType): string {
  return `moqi-block-${type}`
}

/**
 * 行内引用的类名（docs/09 §五 行内元素表）：页面链接与块引用必须能一眼区分——
 * `[[页面链接]]` = 主题色下划线文字（`moqi-ref-object`），`((块引用))` = 面板色小块（`moqi-ref-block`）。
 */
export function inlineRefClassNames(kind: RefKind | null): string[] {
  return kind === 'object' ? ['moqi-inline-ref', 'moqi-ref-object'] : ['moqi-inline-ref', 'moqi-ref-block']
}

function tagForBlockType(type: BlockType): keyof HTMLElementTagNameMap {
  switch (type) {
    case 'heading1': return 'h1'
    case 'heading2': return 'h2'
    case 'heading3': return 'h3'
    case 'heading4': return 'h4'
    case 'heading5': return 'h5'
    case 'heading6': return 'h6'
    case 'quote': return 'blockquote'
    case 'code': return 'pre'
    case 'divider': return 'div'
    default: return 'p'
  }
}

export function applyMarks(node: TextNode, marks: Mark[] | undefined): void {
  for (const mark of marks ?? []) {
    if (mark.type === 'bold' || mark.type === 'italic' || mark.type === 'underline' || mark.type === 'code' || mark.type === 'strike' || mark.type === 'highlight') {
      node.toggleFormat(mark.type === 'strike' ? 'strikethrough' : mark.type)
    } else if (mark.type === 'color' && typeof mark.attrs?.color === 'string') {
      node.setStyle(`color: ${mark.attrs.color}`)
    }
  }
}

export function marksFromTextNode(node: TextNode): Mark[] {
  const marks: Mark[] = []
  for (const type of ['bold', 'italic', 'underline', 'code', 'strikethrough', 'highlight'] as const) {
    if (node.hasFormat(type)) marks.push({ type: type === 'strikethrough' ? 'strike' : type })
  }
  const style = node.getStyle()
  const match = /(?:^|;)\s*color:\s*([^;]+)/i.exec(style)
  if (match) marks.push({ type: 'color', attrs: { color: match[1].trim() } })
  return marks
}
