import type { ComponentProps, ReactNode } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'

/**
 * LexicalComposer 的宿主包装（模块化 M1.7）：`ui/EditorChrome` 不再直接 import 内核，
 * 只从 `editor/` 拿这个组件。换内核时替换点也在这里。
 */
export function EditorComposer({ initialConfig, children }: {
  initialConfig: ComponentProps<typeof LexicalComposer>['initialConfig']
  children: ReactNode
}) {
  return <LexicalComposer initialConfig={initialConfig}>{children}</LexicalComposer>
}
