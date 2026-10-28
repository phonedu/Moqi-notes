import type { EditorThemeClasses } from 'lexical'

/**
 * 编辑器行内格式的主题类（docs/09 §6.10「行内格式 · 双端同构的样式契约」）。
 *
 * Lexical 渲染文本节点时**每个节点只能给一个标签**：外层 <code>/<mark>，内层 <strong>/<em>，
 * 删除线压根没有标签（见 lexical/src/nodes/LexicalTextNode.ts 的 getElementOuterTag / getElementInnerTag）。
 * 多出来的格式**只能靠主题类**表达——不配主题就会出现「加了斜体、加了删除线，屏幕上没变化」，
 * 以及「加粗 + 高亮 / 加粗 + 斜体」只显示其中一个。
 *
 * 类名沿用 `docs/09` §6.10 与页面库静态渲染共用的那一套（`app.css` 的 `.tx-*`），
 * 保证编辑器里看到的行内样式和别处一致；`tests/ui/theme.test.ts` 看护「类名在 CSS 里真的存在」。
 */
export const EDITOR_THEME: EditorThemeClasses = {
  text: {
    bold: 'tx-b',
    italic: 'tx-i',
    // 下划线（0.5，`R09-TXBAR-12`）：Lexical 原生 format 位，靠主题类渲染。
    underline: 'tx-u',
    strikethrough: 'tx-s',
    code: 'tx-c',
    highlight: 'tx-h',
  },
}
