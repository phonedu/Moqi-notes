import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 结构边界门（编辑器重规划 · 步 1，2026-10-05 成门）。
 *
 * 为什么要有它：`13-编辑器重规划`§2.2 把「内核可替换」列为明文约束，
 * 而约束只有在**有执行者**时才算约束——这份测试就是那三条的第一批执行者。
 * 现状全部成立，规则**只许收紧、不许放宽**：
 *
 *   ① `src/domain/**` 不许碰编辑器内核（`lexical` / `@lexical/*`），也不许向上引用
 *      `editor/` / `ui/`。领域层与内核解耦是这次重规划最大的一笔资产，先锁住。
 *   ② `src/editor/**` 不许反向引用 `ui/`。方向单向：`ui → editor → domain`。
 *   ③ `src/ui/**` 里**直接 import 内核**的文件必须在这份冻结名单里：把内核 API 收进
 *      `editor/` 端口层的过程中，每收干净一个就划掉一个；名单变长 = 又有人在 ui 里
 *      直接碰内核——先在这里拦下，再决定「走端口」还是「改口径」。
 *
 * 2026-10-09 收口扩两条：④ `ui/**` 不许碰平台 API（`@tauri-apps/**`，**静态与动态都算**；已知债务冻结在 `UI_PLATFORM_ALLOWLIST`，只许变短）；
 * ⑤ `ui/**` 不许直连 `adapters/**`——端口一律从**合成根** `src/composition.ts` 取（`06` §6 落点四问第 ② 条，零例外）。
 * 仍不在本门范围：`ui/` 里 import 内核**做什么**（只查 import 事实）；`ui/` 内部互相引用；`application` ↔ `adapters` 两个方向（先出读数，见 `docs:check` ⑩）。
 */

const APP = fileURLToPath(new URL('../../', import.meta.url))
/** 编辑器包根（M4）：domain/ 与 editor/ 住 `packages/editor/src/`，app 只剩壳层。 */
const PKG = fileURLToPath(new URL('../../../packages/editor/src/', import.meta.url))

/**
 * M2（2026-10-25）已收口：`ui/` 与内核零直连，不再有冻结名单。
 * 口径 = 从 `lexical` 或 `@lexical/*` 任一处 import（含 `@lexical/react`）。
 */

/** 源码文件（M4 起双根：domain/editor 在编辑器包、ui/application 在 app），返回绝对路径。 */
function sourceFiles(dir: 'domain' | 'editor' | 'ui' | 'application'): string[] {
  const found: string[] = []
  const base = dir === 'domain' || dir === 'editor' ? PKG : join(APP, 'src')
  const walk = (current: string): void => {
    for (const entry of readdirSync(join(base, current), { withFileTypes: true })) {
      const relative = posix.join(current, entry.name)
      if (entry.isDirectory()) walk(relative)
      else if (/\.tsx?$/.test(entry.name)) found.push(join(base, relative))
    }
  }
  walk(dir)
  return found
}

/** 静态 import、副作用 import 与**动态 import()** 的说明符（2026-10-09 收口：动态也算，`ui/windowChrome.ts` 就这么绕过旧门）。 */
function specifiersOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const fromImports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)]
  const sideEffectImports = [...text.matchAll(/import\s+['"]([^'"]+)['"]/g)]
  const dynamicImports = [...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)]
  return [...fromImports, ...sideEffectImports, ...dynamicImports].map((match) => match[1])
}

const isKernel = (specifier: string): boolean =>
  specifier === 'lexical' || specifier.startsWith('@lexical/')

const referencesLayer = (specifier: string, layer: 'editor' | 'ui'): boolean =>
  new RegExp(`(^|/)${layer}/`).test(specifier)

test('领域层不许 import 编辑器内核，也不许向上引用 editor/ 或 ui/，不许依赖宿主层（M4）', () => {
  const offenders: string[] = []
  for (const file of sourceFiles('domain')) {
    for (const specifier of specifiersOf(file)) {
      if (
        isKernel(specifier)
        || referencesLayer(specifier, 'editor')
        || referencesLayer(specifier, 'ui')
        || /(^|\/)application\//.test(specifier)
        || /(^|\/)adapters\//.test(specifier)
      ) {
        offenders.push(`${file} → ${specifier}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `领域层出现了越界引用（「13-编辑器重规划」§2.2 约束 1）：\n${offenders.join('\n')}`)
})

test('editor/ 不许反向引用 ui/（方向单向：ui → editor → domain）', () => {
  const offenders: string[] = []
  for (const file of sourceFiles('editor')) {
    for (const specifier of specifiersOf(file)) {
      if (referencesLayer(specifier, 'ui')) offenders.push(`${file} → ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [], `editor/ 反向引用了 ui/（「13-编辑器重规划」§2.2 约束 2）：\n${offenders.join('\n')}`)
})

test('编辑器包（domain/ 与 editor/）不依赖合成根 / 适配器 / 平台 API（M3/M4）', () => {
  const offenders: string[] = []
  for (const file of [...sourceFiles('editor'), ...sourceFiles('domain')]) {
    for (const specifier of specifiersOf(file)) {
      if (
        specifier.includes('composition')
        || /(^|\/)adapters\//.test(specifier)
        || /(^|\/)application\//.test(specifier)
        || specifier.startsWith('@tauri-apps/')
      ) offenders.push(`${file} → ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [], `编辑器包依赖了宿主/平台实现（M3/M4 要求宿主注入）：\n${offenders.join('\n')}`)
})

test('ui/ 不直接 import 内核（M2 收口，零例外）', () => {
  const offenders = sourceFiles('ui').filter((file) => specifiersOf(file).some(isKernel)).sort()
  assert.deepEqual(
    offenders,
    [],
    `ui/ 里出现了直接 import 内核的文件（走 editor/ 端口层）：\n${offenders.join('\n')}`,
  )
})

/**
 * ④（2026-10-09 收口）`src/ui/**` 不许碰平台 API（`@tauri-apps/**`）——静态与动态都算。
 *    已知债务冻结在名单里（**只许变短**）：`ui/windowChrome.ts` 的无边框窗口控制（该收进 adapters 的一小块）。
 */
const UI_PLATFORM_ALLOWLIST = [join(APP, 'src', 'ui', 'windowChrome.ts')]

test('ui 层不许 import 平台 API（@tauri-apps），已知债务冻结在名单里', () => {
  const offenders: string[] = []
  for (const file of sourceFiles('ui')) {
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith('@tauri-apps/') && !UI_PLATFORM_ALLOWLIST.includes(file)) offenders.push(`${file} → ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [], `ui/ 里出现新的平台 API 依赖（静态或动态；「UI 不直接访问 Tauri API」是硬约束）：\n${offenders.join('\n')}\n修法：走 adapters 端口`)
})

test('冻结名单里的文件若已不再依赖平台 API，必须从名单划掉', () => {
  const stale = UI_PLATFORM_ALLOWLIST.filter((file) => !specifiersOf(file).some((s) => s.startsWith('@tauri-apps/')))
  assert.deepEqual(stale, [], `这些文件已经不依赖平台 API 了，请从 UI_PLATFORM_ALLOWLIST 划掉：\n${stale.join('\n')}`)
})

/**
 * ⑤（2026-10-09 收口）`src/ui/**` 不许直接 import `../adapters/**`——**只许从合成根 `src/composition.ts` 取端口**。
 *    这一条是 `06` §6 落点四问第 ② 条的机器执行者；零例外。
 */
test('ui 层不许直连 adapters（端口一律从合成根 composition.ts 取）', () => {
  const offenders: string[] = []
  for (const file of sourceFiles('ui')) {
    for (const specifier of specifiersOf(file)) {
      if (/(^|\/)adapters\//.test(specifier)) offenders.push(`${file} → ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [], `ui/ 直连了 adapters（要换实现就得改 UI）：\n${offenders.join('\n')}\n修法：改从 ../composition 取`)
})

/*
 * ⑥ 应用层不许反向引用 adapters（2026-10-09 收口 D6）——六边形的方向：**端口由上层定义、适配器实现它**
 *   （`application/aiPort.ts` 就是这么来的）；`application → adapters` 会把方向倒过来（换实现要动
 *   应用逻辑）。合成根 `src/composition.ts` 不在 `application/` 里，它同时引两边是它的本职。
 *   立这条门时读数已经从 1 归零（那 1 处就是 `aiService.ts` 的端口类型导入）——钉住，别让它回来。
 */
test('application 层不许反向引用 adapters（端口由应用层定义、适配器实现）', () => {
  const offenders: string[] = []
  for (const file of sourceFiles('application')) {
    for (const specifier of specifiersOf(file)) {
      if (/(^|\/)adapters\//.test(specifier)) offenders.push(`${file} → ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [], `application/ 引了 adapters（方向倒置）：\n${offenders.join('\n')}\n修法：端口类型上提到应用层（照 application/aiPort.ts），adapters 侧 re-export`)
})
