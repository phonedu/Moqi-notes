import assert from 'node:assert/strict'
import test from 'node:test'
import { closeAction, saveThenClose } from '../../src/ui/closeFlow'

test('SAVE-CHAIN-1: close waits for the complete save task', async () => {
  let release!: () => void
  let closed = false
  const pending = new Promise<void>((resolve) => { release = resolve })
  const result = saveThenClose(() => pending, async () => { closed = true; return true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closed, false)
  release()
  assert.equal(await result, true)
  assert.equal(closed, true)
})

test('SAVE-CHAIN-2: save failure or timeout never destroys the window', async () => {
  let closed = false
  const close = async () => { closed = true; return true }
  await assert.rejects(saveThenClose(async () => { throw new Error('disk') }, close), /disk/)
  await assert.rejects(saveThenClose(() => new Promise(() => undefined), close, 5), /保存超时/)
  assert.equal(closed, false)
})

test('WIN-CLOSE-1 没在生成：直接落盘再关（docs/09 §3.1 关闭语义）', () => {
  assert.equal(closeAction({ closing: false, generating: false }), 'flush-then-close')
})

test('WIN-CLOSE-2 AI 生成中：先让用户选（继续生成 / 直接关闭）', () => {
  assert.equal(closeAction({ closing: false, generating: true }), 'confirm-generating')
})

test('SAVE-CHAIN-2: repeated close requests cannot bypass an in-flight save', () => {
  assert.equal(closeAction({ closing: true, generating: false }), 'ignore')
  assert.equal(closeAction({ closing: true, generating: true }), 'ignore')
})
