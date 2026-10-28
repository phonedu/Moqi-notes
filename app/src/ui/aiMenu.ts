import type { IconName } from '@moqi/editor'
import type { AiAction } from '@moqi/editor'

/**
 * AI 指令单一数据源（docs/09 §6.10）：**文本选中工具栏的 AI 菜单**、**块浮动工具栏的 `✦AI▾` 下拉**
 * （`R09-BEDIT-5`：六项 + 分隔线 + 打开 AI 助手）与**AI 助手面板六宫格**都由这里渲染，集合永不漂移。
 * 常驻格式栏的 `✦ AI` 不走集合——它是镜像层（`R09-FMT-1`），按钮直接打开 AI 助手面板。
 *
 * **V2c 起六项全部可用**：四项新指令走同一条 AI 块链路（三态生命周期、落点规则、来源标签都不变），
 * 只是提示词不同。规则 `R09-AIPANEL-3b` 仍然在——**将来**再加未实现的指令时，渲染方必须禁用并在
 * 按钮上直接标注「后续版本」（`pnpm accept` 的 `R09-SCOPE-17` 断言是它的执行者，现在的形态是
 * 「六项都不带标注」）。
 */
export type AiUiOp = { op: string; label: string; icon: IconName; hint: string; action: AiAction | null }

export const AI_UI_OPS: AiUiOp[] = [
  { op: 'polish', label: '润色', icon: 'highlight', hint: '保留原意，只调整表达与语序', action: 'polish' },
  { op: 'summarize', label: '总结', icon: 'list', hint: '提炼核心观点', action: 'summary' },
  { op: 'expand', label: '扩写', icon: 'plus', hint: '补充细节与例子，不引入原文没有的事实', action: 'expand' },
  { op: 'extract', label: '提取行动', icon: 'check-square', hint: '识别待办 → 生成 todo 块', action: 'actions' },
  { op: 'askback', label: '反问我', icon: 'help', hint: '针对本段提 3 个问题，引导深想', action: 'askback' },
  { op: 'reframe', label: '换角度', icon: 'refresh', hint: '换立场 / 换读者 / 换时间尺度重写', action: 'reframe' },
]

export const aiActionLabel: Record<AiAction, string> = {
  summary: '总结',
  actions: '提取行动',
  ask: '自由问答',
  polish: '润色',
  expand: '扩写',
  askback: '反问我',
  reframe: '换角度',
}
