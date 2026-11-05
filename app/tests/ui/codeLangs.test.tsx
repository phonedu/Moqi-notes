import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LangPickerDialog } from '../../src/ui/LangPicker'
import { CODE_LANG_CATALOG, DEFAULT_CODE_LANGS, defaultUiPrefs, loadUiPrefs } from '../../src/ui/uiPrefs'

/**
 * 代码块语言选择器的数据面与弹窗形状（块 ⋯ 菜单「语言…」）：默认子集＝候选清单（十门类上下、
 * mermaid 在列）；目录与子集都是**纯界面偏好**——选择器带自由输入兜底，任意语言照存，不构成白名单。
 * 这里钉三件事：默认集在目录内且 mermaid 在列、loadUiPrefs 对坏值回落默认集（目录外的合法值照收）、
 * 选择器画候选＋高亮当前语言＋清除入口（无语言时清除禁用）。
 */

test('默认子集：全部在目录内、mermaid 在列、十门类上下；默认 prefs 带同一子集', () => {
  assert.ok(DEFAULT_CODE_LANGS.length >= 8 && DEFAULT_CODE_LANGS.length <= 14, `默认子集 ${DEFAULT_CODE_LANGS.length} 门`)
  for (const lang of DEFAULT_CODE_LANGS) assert.ok(CODE_LANG_CATALOG.includes(lang), `${lang} 不在目录里`)
  assert.ok(DEFAULT_CODE_LANGS.includes('mermaid'), 'mermaid 必须在列')
  assert.deepEqual(defaultUiPrefs.codeLangs, DEFAULT_CODE_LANGS)
})

test('loadUiPrefs：坏值（非数组 / 全空）回落默认集；目录外的合法值照收（纯界面偏好）', () => {
  const withStorage = (raw: string, run: () => void) => {
    const original = globalThis.localStorage
    globalThis.localStorage = { getItem: () => raw, setItem: () => undefined } as unknown as Storage
    try { run() } finally { globalThis.localStorage = original }
  }
  let restored: string[] = []
  withStorage(JSON.stringify({ codeLangs: ['graphql', 42, '', 'zig'] }), () => { restored = loadUiPrefs().codeLangs })
  assert.deepEqual(restored, ['graphql', 'zig'])
  let fellBack: string[] = []
  withStorage(JSON.stringify({ codeLangs: [42, null] }), () => { fellBack = loadUiPrefs().codeLangs })
  assert.deepEqual(fellBack, DEFAULT_CODE_LANGS)
})

test('语言选择器：画候选与当前高亮、自由输入与清除入口在；无语言时清除禁用', () => {
  const html = renderToStaticMarkup(
    <LangPickerDialog current="python" codeLangs={['python', 'rust']} onSetLang={() => undefined} onClose={() => undefined} />,
  )
  assert.ok(html.includes('lang-chip'))
  assert.ok(html.includes('>python<') && html.includes('>rust<'))
  assert.ok(html.includes('is-cur'), '当前语言要高亮')
  assert.ok(html.includes('自定义语言') && html.includes('清除语言'))
  const none = renderToStaticMarkup(
    <LangPickerDialog current={null} codeLangs={['rust']} onSetLang={() => undefined} onClose={() => undefined} />,
  )
  assert.ok(!none.includes('is-cur'))
  assert.ok(none.includes('disabled'), '无语言时清除按钮禁用')
})
