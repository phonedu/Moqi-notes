/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as React from 'react'
import type { SVGProps } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BarChart3,
  Bold,
  Brackets,
  Calendar,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDot,
  CircleHelp,
  ClipboardPaste,
  CodeXml,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileText,
  Files,
  GripVertical,
  Hash,
  Heading,
  Highlighter,
  History,
  Image,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Keyboard,
  LayoutGrid,
  Link2,
  List,
  ListFilter,
  ListOrdered,
  ListTree,
  Maximize2,
  Menu,
  Minus,
  Moon,
  MoreHorizontal,
  MoreVertical,
  PanelLeft,
  PanelRight,
  PanelTop,
  Paperclip,
  PenLine,
  Plus,
  Quote,
  Redo2,
  RefreshCw,
  Save,
  Scissors,
  Search,
  Send,
  Settings,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareCheck,
  SquareDashed,
  Star,
  Strikethrough,
  Sun,
  Tag,
  Trash2,
  TriangleAlert,
  Type,
  Underline,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react'

/*
 * 统一图标源（docs/08 §8 本地图标系统）。
 *
 * 图标一律取自 **Lucide**（ISC 协议：可商用、可修改、可再分发，除保留版权声明外无任何限制），
 * 依赖随包打进产物，运行时不联网，符合 `04` §7「本地 SVG 组件」的要求。
 * 24 网格、圆角线帽与连接，颜色继承语义文本色。名字保持项目内的短名（`grip` / `more-vertical` …）。
 *
 * **线宽随尺寸补偿（2026-10-09 用户点名「太细了看不见」）**：Lucide 的 2 是按 **24 网格**标的——
 * 把 24 网格的图标直接缩到 12px，物理线宽只剩 `2 × 12/24 = 1.0px`（比一个像素还细）。全站图标七成是
 * 15 / 14 / 13 / 12px，所以按尺寸补偿，让**物理线宽保持 ≈1.3–1.6px**（判据 = `strokeWidth × size / 24`）。
 */
export const ICON_STROKE = 2

/** 按渲染尺寸给线宽：≥18px 用 Lucide 标准 2；越小越补偿（最小 12px 用 2.75 ⇒ 物理 1.38px）。 */
export function iconStroke(size: number): number {
  if (size >= 18) return ICON_STROKE
  if (size >= 16) return 2.25
  if (size >= 14) return 2.5
  return 2.75
}

export type IconName =
  | 'menu'
  | 'arrow-left'
  | 'search'
  | 'filter'
  | 'grid'
  | 'file'
  | 'file-text'
  | 'image'
  | 'paperclip'
  | 'embed'
  | 'list'
  | 'list-numbered'
  | 'list-tree'
  | 'panel-left'
  | 'panel-right'
  | 'properties'
  | 'link'
  | 'star'
  | 'star-filled'
  | 'more'
  | 'more-vertical'
  | 'plus'
  | 'minus'
  | 'trash'
  | 'eye'
  | 'eye-off'
  | 'chevron-down'
  | 'chevron-up'
  | 'chevron-right'
  | 'chevron-left'
  | 'sparkles'
  | 'save'
  | 'archive'
  | 'x'
  | 'check'
  | 'undo'
  | 'redo'
  | 'grip'
  | 'settings'
  | 'heading'
  | 'check-square'
  | 'quote'
  | 'code'
  | 'inline-code'
  | 'indent'
  | 'outdent'
  | 'download'
  | 'keyboard'
  | 'moon'
  | 'sun'
  | 'tag'
  | 'hash'
  | 'help'
  | 'graph'
  | 'chart'
  | 'expand'
  | 'zoom-in'
  | 'zoom-out'
  | 'share'
  | 'history'
  | 'copy'
  | 'file-copy'
  | 'scissors'
  | 'underline'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'highlight'
  | 'brackets'
  | 'send'
  | 'refresh'
  | 'restore'
  | 'minimize'
  | 'maximize'
  | 'window-restore'
  | 'alert'
  // 属性类型五件套（2026-10-08 T3，`docs/08` §8 属性类型批）：圆圈点 = 单选 / T = 文本 /
  // hash = 数字（保留名由此首次实使用）/ calendar = 日期 / check-square = 勾选（复用既有名）。
  | 'circle-dot'
  | 'type'
  | 'calendar'
  // 移动骨架（2026-10-11，`10` §4.3）：底栏「✎ 编辑」键（此前全站没有笔形图标）。
  | 'pen-line'
  // 工具栏批（`10` §6.3 定稿，2026-10-14）：插入面板的「拍照」格 · 链接子菜单「外部链接」·
  // 气泡「粘贴」（原用 `file-copy`，语义不对）· 三勾去歧义后的「全选」= 虚线选框。
  | 'camera'
  | 'external-link'
  | 'clipboard-paste'
  | 'square-dashed'

/** 项目短名 → Lucide 官方图标。 */
const GLYPHS: Record<IconName, LucideIcon> = {
  menu: Menu,
  'arrow-left': ArrowLeft,
  search: Search,
  filter: ListFilter,
  grid: LayoutGrid,
  file: File,
  'file-text': FileText,
  image: Image,
  paperclip: Paperclip,
  embed: PanelTop,
  list: List,
  'list-numbered': ListOrdered,
  'list-tree': ListTree,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  properties: SlidersHorizontal,
  link: Link2,
  star: Star,
  'star-filled': Star,
  more: MoreHorizontal,
  'more-vertical': MoreVertical,
  plus: Plus,
  minus: Minus,
  trash: Trash2,
  eye: Eye,
  'eye-off': EyeOff,
  'chevron-down': ChevronDown,
  'chevron-up': ChevronUp,
  'chevron-right': ChevronRight,
  'chevron-left': ChevronLeft,
  sparkles: Sparkles,
  save: Save,
  archive: Archive,
  x: X,
  check: Check,
  undo: Undo2,
  redo: Redo2,
  grip: GripVertical,
  settings: Settings,
  heading: Heading,
  'check-square': SquareCheck,
  quote: Quote,
  code: CodeXml,
  'inline-code': CodeXml,
  indent: IndentIncrease,
  outdent: IndentDecrease,
  download: Download,
  keyboard: Keyboard,
  moon: Moon,
  sun: Sun,
  tag: Tag,
  hash: Hash,
  help: CircleHelp,
  graph: Share2,
  chart: BarChart3,
  expand: Maximize2,
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  share: Share2,
  history: History,
  copy: Copy,
  'file-copy': Files,
  scissors: Scissors,
  underline: Underline,
  bold: Bold,
  italic: Italic,
  strike: Strikethrough,
  highlight: Highlighter,
  brackets: Brackets,
  send: Send,
  refresh: RefreshCw,
  restore: ArchiveRestore,
  // 无边框窗口的三个按钮字形（docs/09 §3.1）：最小化 / 最大化 / 还原。
  minimize: Minus,
  maximize: Square,
  'window-restore': Copy,
  alert: TriangleAlert,
  // 属性类型五件套（2026-10-08 T3）：单选 / 文本 / 数字（`hash`）/ 日期 / 勾选（`check-square`）。
  'circle-dot': CircleDot,
  type: Type,
  calendar: Calendar,
  'pen-line': PenLine,
  camera: Camera,
  'external-link': ExternalLink,
  'clipboard-paste': ClipboardPaste,
  'square-dashed': SquareDashed,
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
  label?: string
  title?: string
  decorative?: boolean
}

/** 本地图标组件：颜色继承 currentColor，`decorative` 时对辅助技术隐藏。 */
export function Icon({ name, size = 18, label, title, decorative = false, ...rest }: IconProps) {
  const Glyph = GLYPHS[name]
  return (
    <Glyph
      width={size}
      height={size}
      strokeWidth={iconStroke(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill={name === 'star-filled' ? 'currentColor' : 'none'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : label ?? name}
      role={decorative ? undefined : 'img'}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
    </Glyph>
  )
}
