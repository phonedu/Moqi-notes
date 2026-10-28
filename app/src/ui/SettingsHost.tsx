import type { ComponentProps, ReactNode } from 'react'
import { Dialog } from './Dialogs'
import { SettingsView } from './SettingsView'

type SettingsHostProps = {
  open: boolean
  onClose: () => void
  noticeSlot: ReactNode
  settings: ComponentProps<typeof SettingsView> | null
}

/**
 * 设置模态宿主（模块化 M1.3a）：`Dialog` 外壳、`set-body` 与顶部就地提示带。
 *
 * `SettingsView` 的字段暂时仍由外壳传入（M1.3b 再收成 `SettingsHost` 自己的 props）；
 * 这一刀只把「设置是居中模态」的形态从 `EditorShell` 拿走，DOM 不变。
 */
export function SettingsHost({ open, onClose, noticeSlot, settings }: SettingsHostProps) {
  if (!open || !settings) return null
  return (
    <Dialog title="设置" className="set-dlg" onClose={onClose}>
      <div className="set-body">
        {noticeSlot}
        <SettingsView {...settings} />
      </div>
    </Dialog>
  )
}
