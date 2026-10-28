import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * 渲染期错误边界（D-102）：Lexical 初始化 / 渲染抛错不再裸奔——交给宿主的
 * `onError` ＋ 一段兜底 UI。挂载期错误（initialConfig.onError）同一条出口。
 * key 由调用方控制：重载 / 换文档时连同边界一起重挂载，错误态随之清空。
 */
export class EditorErrorBoundary extends Component<
  { onError?: (error: unknown) => void; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error)
    if (typeof console !== 'undefined') console.error('moqi-editor 渲染错误：', info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="moqi-editor-error" role="alert">
          编辑器出错了：{this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}
