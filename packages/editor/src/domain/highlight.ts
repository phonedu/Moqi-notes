/**
 * 轻量语法着色（代码块）：**纯函数** `tokenize(code, lang)` → 带类别的片段序列。
 *
 * 边界（刻意划死）：只认四类记号——注释 / 字符串 / 数字 / 关键字；其余按原文。不做 AST、
 * 不做语言服务、不做括号匹配（那是编辑器内核级能力，包体与回归面都不划算）。
 * 认不出的语言一律整段当原文返回（**不猜**），渲染侧因此永远安全。
 */

export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword'

export type CodeToken = { text: string; kind: TokenKind }

type LangSpec = {
  /** 关键字（去重表；大小写照语言惯例给）。 */
  keywords: Set<string>
  /** 行注释前缀（可多个）。 */
  lineComment: string[]
  /** 块注释的起止；没有就不配。 */
  blockComment?: [string, string]
  /** 引号字符（可多个）。 */
  quotes: string[]
}

const JS_KEYWORDS = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'class', 'extends', 'new', 'this', 'super', 'import', 'from', 'export', 'default', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'async', 'await', 'yield', 'true', 'false', 'null', 'undefined', 'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly', 'as', 'satisfies']

const PY_KEYWORDS = ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'yield', 'global', 'nonlocal', 'pass', 'in', 'is', 'not', 'and', 'or', 'True', 'False', 'None', 'async', 'await']

const RUST_KEYWORDS = ['fn', 'let', 'mut', 'const', 'struct', 'enum', 'impl', 'trait', 'pub', 'use', 'mod', 'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'break', 'continue', 'move', 'ref', 'where', 'self', 'Self', 'crate', 'super', 'as', 'in', 'async', 'await', 'dyn', 'unsafe', 'true', 'false']

const GO_KEYWORDS = ['func', 'package', 'import', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer', 'select', 'case', 'default', 'if', 'else', 'for', 'range', 'switch', 'return', 'break', 'continue', 'fallthrough', 'goto', 'nil', 'true', 'false']

const JAVA_KEYWORDS = ['class', 'interface', 'enum', 'extends', 'implements', 'public', 'private', 'protected', 'static', 'final', 'void', 'int', 'long', 'double', 'float', 'boolean', 'char', 'String', 'new', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'throws', 'import', 'package', 'null', 'true', 'false', 'this', 'super']

const BASH_KEYWORDS = ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'export', 'local', 'echo', 'cd', 'set', 'unset', 'source', 'exit']

const SQL_KEYWORDS = ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'index', 'drop', 'alter', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'limit', 'offset', 'and', 'or', 'not', 'null', 'as', 'distinct', 'union', 'all', 'case', 'when', 'then', 'else', 'end']

const SPECS: Record<string, LangSpec> = {
  javascript: { keywords: new Set(JS_KEYWORDS), lineComment: ['//'], blockComment: ['/*', '*/'], quotes: ['"', "'", '`'] },
  typescript: { keywords: new Set(JS_KEYWORDS), lineComment: ['//'], blockComment: ['/*', '*/'], quotes: ['"', "'", '`'] },
  json: { keywords: new Set(['true', 'false', 'null']), lineComment: ['//'], quotes: ['"'] },
  python: { keywords: new Set(PY_KEYWORDS), lineComment: ['#'], quotes: ['"', "'"] },
  rust: { keywords: new Set(RUST_KEYWORDS), lineComment: ['//'], blockComment: ['/*', '*/'], quotes: ['"'] },
  go: { keywords: new Set(GO_KEYWORDS), lineComment: ['//'], blockComment: ['/*', '*/'], quotes: ['"', '`'] },
  java: { keywords: new Set(JAVA_KEYWORDS), lineComment: ['//'], blockComment: ['/*', '*/'], quotes: ['"', "'"] },
  kotlin: { keywords: new Set([...JAVA_KEYWORDS, 'val', 'var', 'fun', 'when', 'object', 'companion', 'data', 'sealed', 'suspend']), lineComment: ['//'], blockComment: ['/*', '*/'], quotes: ['"'] },
  swift: { keywords: new Set(['func', 'let', 'var', 'class', 'struct', 'enum', 'protocol', 'extension', 'import', 'return', 'if', 'else', 'guard', 'for', 'while', 'switch', 'case', 'default', 'break', 'continue', 'in', 'nil', 'true', 'false', 'self', 'init', 'deinit', 'throws', 'try', 'catch']), lineComment: ['//'], blockComment: ['/*', '*/'], quotes: ['"'] },
  bash: { keywords: new Set(BASH_KEYWORDS), lineComment: ['#'], quotes: ['"', "'"] },
  sh: { keywords: new Set(BASH_KEYWORDS), lineComment: ['#'], quotes: ['"', "'"] },
  sql: { keywords: new Set([...SQL_KEYWORDS, ...SQL_KEYWORDS.map((word) => word.toUpperCase())]), lineComment: ['--'], blockComment: ['/*', '*/'], quotes: ["'", '"'] },
  css: { keywords: new Set([]), lineComment: [], blockComment: ['/*', '*/'], quotes: ['"', "'"] },
  html: { keywords: new Set([]), lineComment: [], blockComment: ['<!--', '-->'], quotes: ['"', "'"] },
  yaml: { keywords: new Set(['true', 'false', 'null']), lineComment: ['#'], quotes: ['"', "'"] },
  mermaid: { keywords: new Set(['graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'erDiagram', 'gantt', 'pie', 'subgraph', 'end', 'participant', 'actor']), lineComment: ['%%'], quotes: ['"'] },
}

/** 这个语言有没有着色规则（没有 = 整段原文，渲染侧不着色）。 */
export function isHighlightLang(lang: string | null | undefined): boolean {
  if (!lang) return false
  return Object.prototype.hasOwnProperty.call(SPECS, lang.toLowerCase())
}

/** 关键字判定大小写敏感：SQL 两套都配了；其余按语言惯例（这里是精确匹配）。 */
function isKeyword(spec: LangSpec, word: string): boolean {
  return spec.keywords.has(word)
}

/**
 * 分词：一行扫描器（不回溯、不嵌套），四类记号之外的字符原样累积。
 * 输出保证 `tokens.map(t => t.text).join('') === code`（渲染侧因此可以无损拼回）。
 */
export function tokenize(code: string, lang: string | null | undefined): CodeToken[] {
  const spec = lang ? SPECS[lang.toLowerCase()] : undefined
  if (!spec || code.length === 0) return code.length === 0 ? [] : [{ text: code, kind: 'plain' }]

  const tokens: CodeToken[] = []
  let plain = ''
  let index = 0
  const flush = () => {
    if (plain) { tokens.push({ text: plain, kind: 'plain' }); plain = '' }
  }
  const push = (text: string, kind: TokenKind) => { flush(); tokens.push({ text, kind }) }

  while (index < code.length) {
    const rest = code.slice(index)

    // 块注释
    if (spec.blockComment && rest.startsWith(spec.blockComment[0])) {
      const end = code.indexOf(spec.blockComment[1], index + spec.blockComment[0].length)
      const stop = end === -1 ? code.length : end + spec.blockComment[1].length
      push(code.slice(index, stop), 'comment')
      index = stop
      continue
    }
    // 行注释
    const lineHit = spec.lineComment.find((mark) => rest.startsWith(mark))
    if (lineHit) {
      const end = code.indexOf('\n', index)
      const stop = end === -1 ? code.length : end
      push(code.slice(index, stop), 'comment')
      index = stop
      continue
    }
    // 字符串（引号起、同引号止；反斜杠转义跳过下一个字符）
    const quote = spec.quotes.find((mark) => rest.startsWith(mark))
    if (quote) {
      let cursor = index + 1
      while (cursor < code.length) {
        if (code[cursor] === '\\') { cursor += 2; continue }
        if (code[cursor] === quote) { cursor += 1; break }
        if (code[cursor] === '\n') break
        cursor += 1
      }
      push(code.slice(index, cursor), 'string')
      index = cursor
      continue
    }
    // 数字
    if (/[0-9]/.test(code[index]) && (index === 0 || !/[A-Za-z_$]/.test(code[index - 1]))) {
      const match = /^[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?[a-zA-Z%]*/.exec(rest)
      if (match) { push(match[0], 'number'); index += match[0].length; continue }
    }
    // 标识符 / 关键字
    if (/[A-Za-z_$@]/.test(code[index])) {
      const match = /^[A-Za-z_$@][A-Za-z0-9_$]*/.exec(rest)!
      const word = match[0]
      if (isKeyword(spec, word)) push(word, 'keyword')
      else plain += word
      index += word.length
      continue
    }
    plain += code[index]
    index += 1
  }
  flush()
  return tokens
}
