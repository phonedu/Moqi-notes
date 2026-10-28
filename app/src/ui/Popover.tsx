import { useEffect, useState, useRef, type ReactNode } from 'react'

/** 触发元素的视口矩形；下拉一律锚定在触发按钮正下方。 */
export type AnchorRect = { top: number; left: number; right: number; bottom: number; width: number; height: number }

export function anchorOf(element: HTMLElement | null | undefined): AnchorRect | null {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
}

type PopoverProps = {
  anchor: AnchorRect
  /** 面板与触发按钮的横向对齐方式。 */
  align?: 'left' | 'right'
  width: number
  maxHeight?: number
  className?: string
  label: string
  onClose: () => void
  children: ReactNode
}

const GAP = 6
const EDGE = 12

/**
 * 锚定浮层：在触发按钮正下方就地展开，空间不足时上翻。
 * 关闭路径统一为「Esc / 点空白 / 选中条目」，与原型一致。
 */
export function Popover({ anchor, align = 'left', width, maxHeight, className = '', label, onClose, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  // 视口尺寸要**订阅**而不是只在渲染时读一次：打开瞬间（尤其移动端键盘收起 / WebView 首帧）
  // innerHeight 还在变——旧做法只在父级重渲染时重算 limit，于是面板「先一小截、过会儿变大」
 // （用户 报，手机 ⋮ 更多菜单）。订阅 resize / visualViewport resize 后随动。
  const [viewport, setViewport] = useState(() => ({ h: typeof window === 'undefined' ? 800 : window.innerHeight, w: typeof window === 'undefined' ? 1200 : window.innerWidth }))
  useEffect(() => {
    const read = () => setViewport({ h: window.innerHeight, w: window.innerWidth })
    window.addEventListener('resize', read)
    window.visualViewport?.addEventListener('resize', read)
    return () => {
      window.removeEventListener('resize', read)
      window.visualViewport?.removeEventListener('resize', read)
    }
  }, [])

  useEffect(() => {
    const panel = ref.current
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (panel && target && panel.contains(target)) return
      // **触发元素自己那一块不关**：它的 `click` 负责 toggle（再点一次收起，标准菜单语义）。
      // 否则 mousedown 先关、随后的 click 又开，表现成「点按钮关不掉」。用锚点矩形判定，
      // 免得把元素引用穿过每一层菜单组件。
      const insideAnchor = event.clientX >= anchor.left - 2 && event.clientX <= anchor.right + 2
        && event.clientY >= anchor.top - 2 && event.clientY <= anchor.bottom + 2
      if (insideAnchor) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose, anchor.top, anchor.left, anchor.right, anchor.bottom])

  const viewportHeight = viewport.h
  const viewportWidth = viewport.w
  const availableBelow = viewportHeight - anchor.bottom - GAP - EDGE
  const availableAbove = anchor.top - GAP - EDGE
  const flip = availableBelow < Math.min(maxHeight ?? 320, 220) && availableAbove > availableBelow
  /* 窄档（≤700 = compact 档）按视口再收一道：真机上 ⋯ 菜单量到 520/800 = 0.65 屏，维护者点名「好大」。
     桌面不受影响（窄档才收）；数值取 46% —— 菜单类浮层在手机上不超过半屏多一点，余下留给正文。 */
  const narrowView = viewport.w <= 700
  const viewCap = narrowView ? Math.round(viewport.h * 0.46) : Number.POSITIVE_INFINITY
  const limit = Math.max(160, Math.min(maxHeight ?? 420, viewCap, flip ? availableAbove : availableBelow))

  let left = align === 'right' ? anchor.right - width : anchor.left
  left = Math.max(EDGE, Math.min(left, viewportWidth - width - EDGE))

  return (
    <div
      ref={ref}
      className={`pop ${className}`}
      role="menu"
      aria-label={label}
      style={{
        width,
        left,
        top: flip ? undefined : anchor.bottom + GAP,
        bottom: flip ? viewportHeight - anchor.top + GAP : undefined,
        maxHeight: limit,
      }}
    >
      {children}
    </div>
  )
}
