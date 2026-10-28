import assert from 'node:assert/strict'
import test from 'node:test'
import { browserClipboardBackend, createDefaultClipboardPort, LayeredClipboardPort, type ClipboardBackend } from '../../src/adapters/clipboard'

/**
 * `ClipboardPort` 的分层判据（`04` `R04-CLIP-1`；台账 `D-090`）。
 *
 * 真机事实（2026-10-24）：Android WebView 的 `navigator.clipboard.writeText` 在真实手势下
 * 仍报 `NotAllowedError: Write permission denied`；`execCommand('copy')` 同机可用。
 * 因此端口必须满足三件事：① 原生插件可用时**只走原生**；② 原生失败时**退回浏览器层**，
 * 不把这次复制静默丢掉；③ 两层都失败才抛错，让界面如实提示。读同理（读不到 = 不摆「粘贴」）。
 */
function backend(name: string, log: string[], outcome: 'ok' | 'fail' = 'ok'): ClipboardBackend {
  return {
    async writeText() {
      log.push(`${name}:write`)
      if (outcome === 'fail') throw new Error(`${name} write failed`)
    },
    async readText() {
      log.push(`${name}:read`)
      if (outcome === 'fail') throw new Error(`${name} read failed`)
      return `${name}-text`
    },
  }
}

test('SELECT-10 剪贴板端口：原生可用时写读都走原生，不碰浏览器层', async () => {
  const log: string[] = []
  const port = new LayeredClipboardPort(async () => backend('native', log), backend('browser', log))
  await port.writeText('hello')
  assert.equal(await port.readText(), 'native-text')
  assert.deepEqual(log, ['native:write', 'native:read'])
})

test('SELECT-10 剪贴板端口：原生写失败时降级到浏览器层（不丢这次复制）', async () => {
  const log: string[] = []
  const port = new LayeredClipboardPort(async () => backend('native', log, 'fail'), backend('browser', log))
  await port.writeText('hello')
  assert.deepEqual(log, ['native:write', 'browser:write'])
})

test('SELECT-10 剪贴板端口：两层都写失败才抛错（界面据此提示）', async () => {
  const log: string[] = []
  const port = new LayeredClipboardPort(async () => backend('native', log, 'fail'), backend('browser', log, 'fail'))
  await assert.rejects(port.writeText('hello'), /browser write failed/)
})

test('MOBILE-BUBBLE-1 剪贴板端口：原生读不到时降级；两层都读不到就抛错（粘贴按钮不出现）', async () => {
  const log: string[] = []
  const fallback = new LayeredClipboardPort(async () => backend('native', log, 'fail'), backend('browser', log))
  assert.equal(await fallback.readText(), 'browser-text')
  const broken = new LayeredClipboardPort(async () => backend('native', log, 'fail'), backend('browser', log, 'fail'))
  await assert.rejects(broken.readText(), /browser read failed/)
})

test('SELECT-10 原生通道：Tauri 环境调用 plugin:clipboard-manager 的读写命令', async () => {
  const calls: { command: string; args: unknown }[] = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: unknown) => {
          calls.push({ command, args })
          return command.endsWith('read_text') ? 'native-text' : undefined
        },
      },
    },
  })
  try {
    const port = createDefaultClipboardPort()
    await port.writeText('hello')
    assert.equal(await port.readText(), 'native-text')
    assert.deepEqual(calls.map((call) => call.command), [
      'plugin:clipboard-manager|write_text',
      'plugin:clipboard-manager|read_text',
    ])
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  }
})

test('SELECT-10 浏览器通道：async 写被拒时用 execCommand 兜底（WebView 真机同款）', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let copied: string | null = null
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        async writeText() { throw new Error('Write permission denied') },
        async readText() { return 'browser-text' },
      },
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body: { appendChild() {} },
      createElement: () => ({
        value: '',
        style: {},
        setAttribute() {},
        focus() {},
        select() {},
        setSelectionRange() {},
        remove() {},
      }),
      execCommand: (command: string) => {
        copied = command
        return true
      },
    },
  })
  try {
    await browserClipboardBackend.writeText('hello')
    assert.equal(copied, 'copy', 'async 写被拒后必须真的走 execCommand，而不是静默丢掉')
    assert.equal(await browserClipboardBackend.readText(), 'browser-text')
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  }
})
