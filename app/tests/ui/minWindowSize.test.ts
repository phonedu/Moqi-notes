import assert from 'node:assert/strict'
import test from 'node:test'
import { MQ, TIER_MAX_WIDTH, TIER_START_WIDTH } from '../../src/ui/breakpoints'
import { MIN_WINDOW_FLOOR, WORK_AREA_SHARE, minWindowWidth } from '../../src/ui/minWindowSize'

/** 判据的口径与理由在 `docs/09` §八 `R09-RESP-19`——这里只钉住算式与边界。 */

test('R09-RESP-19 版面要求：按档起点取（验证期 compact = 绝对下限 = 手机档最窄 360）', () => {
  assert.equal(MIN_WINDOW_FLOOR, 360, '绝对下限 = 手机档已验证的最窄宽度')
  assert.equal(minWindowWidth({ floorTier: 'compact', cssToLogical: 1, workAreaWidth: 1920 }).width, MIN_WINDOW_FLOOR)
  assert.equal(minWindowWidth({ floorTier: 'tablet', cssToLogical: 1, workAreaWidth: 1920 }).width, TIER_START_WIDTH.tablet, '701')
  assert.equal(minWindowWidth({ floorTier: 'desktop', cssToLogical: 1, workAreaWidth: 1920 }).width, TIER_START_WIDTH.desktop, '900')
  assert.equal(minWindowWidth({ floorTier: 'wide', cssToLogical: 1, workAreaWidth: 1920 }).width, TIER_START_WIDTH.wide, '1280')
})

test('界面缩放乘进版面要求：页面放大 150% ⇒ 同一档要更宽的逻辑 px', () => {
  assert.equal(minWindowWidth({ floorTier: 'desktop', cssToLogical: 1.5, workAreaWidth: 2560 }).width, 1350)
  assert.equal(minWindowWidth({ floorTier: 'desktop', cssToLogical: 0.8, workAreaWidth: 2560 }).width, 720, '缩小到 80% 只需要 80% 的逻辑宽')
  assert.equal(minWindowWidth({ floorTier: 'compact', cssToLogical: 0.8, workAreaWidth: 2560 }).width, MIN_WINDOW_FLOOR, '绝对下限不许被缩放穿透')
})

test('屏幕封顶：工作区放不下版面要求时按工作区 × 0.9，并如实标 limited', () => {
  const small = minWindowWidth({ floorTier: 'desktop', cssToLogical: 1, workAreaWidth: 990 })
  assert.deepEqual(small, { width: Math.floor(990 * WORK_AREA_SHARE), limited: 'screen' }, '900 的版面要求要 1000 以上的工作区才放得下')
  assert.equal(minWindowWidth({ floorTier: 'desktop', cssToLogical: 1, workAreaWidth: 1920 }).limited, 'layout')
})

test('屏幕封顶可以压到绝对下限之下（放不下就得更窄，窗口必须落在这块屏幕上）', () => {
  const tiny = minWindowWidth({ floorTier: 'desktop', cssToLogical: 1, workAreaWidth: 300 })
  assert.equal(tiny.width, 270, '300 × 0.9 = 270 < 320——以屏幕为准')
  assert.equal(tiny.limited, 'screen')
})

test('读数非法时不放大也不封顶：缩放按 1、工作区缺失则不封顶', () => {
  assert.equal(minWindowWidth({ floorTier: 'desktop', cssToLogical: 0, workAreaWidth: 1920 }).width, 900)
  assert.equal(minWindowWidth({ floorTier: 'desktop', cssToLogical: Number.NaN, workAreaWidth: 1920 }).width, 900)
  assert.equal(minWindowWidth({ floorTier: 'desktop', cssToLogical: 1, workAreaWidth: 0 }).width, 900)
  assert.equal(minWindowWidth({ floorTier: 'desktop', cssToLogical: 1, workAreaWidth: Number.NaN }).width, 900)
})

test('断点表：四档边界与媒体条件同值（`08` 的四档表；CSS 一致性由 check:breakpoints 看住）', () => {
  assert.deepEqual(TIER_MAX_WIDTH, { compact: 700, tablet: 899, desktop: 1279 })
  assert.deepEqual(Object.values(TIER_START_WIDTH), [0, 701, 900, 1280])
  assert.deepEqual(MQ, { compact: '(max-width: 700px)', belowDesktop: '(max-width: 899px)', belowWide: '(max-width: 1279px)' })
})
