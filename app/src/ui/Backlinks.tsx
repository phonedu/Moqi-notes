import { Icon } from '@moqi/editor'

export type BacklinkCard = {
  sourceId: string
  /** 来源路径，如「周报归档 › 第 37 周」。 */
  path: string
  preview: string
  kind: 'object' | 'block'
}

type BacklinkSectionProps = {
  targetName: string
  entries: BacklinkCard[]
  onJump: (sourceId: string) => void
}

/**
 * 正文底部反向链接（docs/09 §4.3）：反向链接是正文的一部分，不再占用右侧常驻侧栏。
 * 只有存在反链时才渲染该分区；卡片点击直接跳转到来源块。
 */
export function BacklinkSection({ targetName, entries, onJump }: BacklinkSectionProps) {
  if (entries.length === 0) return null
  return (
    <section className="backlinks" aria-label="反向链接">
      <h4><Icon name="link" size={16} decorative />反向链接 · {entries.length}</h4>
      {entries.map((entry) => (
        <button type="button" className="bl-card" key={entry.sourceId} onClick={() => onJump(entry.sourceId)}>
          <div className="src">{entry.kind === 'block' ? '¶ ' : '📄 '}{entry.path}</div>
          <div className="body">{highlight(entry.preview, targetName)}</div>
        </button>
      ))}
    </section>
  )
}

/** 在来源摘要里标出被引用页面名，帮助判断这条反链说的是什么。 */
function highlight(preview: string, name: string) {
  if (!name) return preview
  const parts = preview.split(name)
  if (parts.length === 1) return preview
  return parts.map((part, index) => (
    <span key={index}>
      {part}
      {index < parts.length - 1 ? <mark>{name}</mark> : null}
    </span>
  ))
}
