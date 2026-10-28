/**
 * 媒体块（`R09-BLOCK-19/20`）的显示地址与真比例落到 CSS 变量：调用方把「磁盘名 → 显示地址」
 * 解析好的结果传进来，这里只负责写块元素（属性驱动，不动子节点）；拿不到地址 = 文件缺失 /
 * 端口未就绪 ⇒ 打 `is-asset-missing`，由 CSS 画占位卡（数据合法、界面降级）。
 *
 * 为什么比例也要写：CSS 那条 `aspect-ratio: var(--asset-ratio, 16/9)` 曾长期没人写值——
 * 竖屏图被压进 16:9 的板里 `contain`、两侧留空（θ17 用户走查点名；顺带修好命中区）。
 * 从 `BlockTools.tsx` 搬出（θ17 归位批，配合 `check:size` 修复通道收线；行为一字未改）。
 */
export function applyAssetVars(element: HTMLElement, url: string | null): void {
  if (url) {
    element.classList.remove('is-asset-missing')
    element.style.setProperty('--asset-url', 'url("' + url + '")')
    const ratio = element.dataset.assetRatio
    if (ratio) element.style.setProperty('--asset-ratio', ratio)
    else element.style.removeProperty('--asset-ratio')
  } else {
    element.classList.add('is-asset-missing')
    element.style.removeProperty('--asset-url')
    element.style.removeProperty('--asset-ratio')
  }
}
