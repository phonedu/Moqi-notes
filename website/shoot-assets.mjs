/**
 * 生成官网页面的产品配图 —— 全部从 prototype/ui/*.html 截取。
 *
 * 为什么不用真实应用截图：%TEMP%\moqi-acceptance\shots\ 里那 181 张全是验收测试数据
 * （页名「验收·拖拽」、正文「gdjd」「很很快乐的」），不能对外。原型里的演示数据
 * （副业探索 / 平台分发策略 /《纳瓦尔宝典》读书笔记）才是干净的。
 *
 * 用法（在 app/ 下执行，因为要借用它的 playwright-core）：
 *   cd app && node ../website/shoot-assets.mjs
 *
 * 依赖：Microsoft Edge（playwright-core 不自带浏览器，直接驱动系统 Edge）
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const require = createRequire(fileURLToPath(new URL('../app/package.json', import.meta.url)));
const { chromium } = require('playwright-core');

// 用 fileURLToPath / join 走原生路径：目录名含中文，URL.pathname 会百分号编码，
// 再交给 pathToFileURL 就会二次编码成 %25E9… 而找不到文件。
const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(HERE, 'assets');
const UI = join(HERE, '..', 'prototype', 'ui');
const DESKTOP = pathToFileURL(join(UI, 'desktop-interactive.html')).href;
const MOBILE = pathToFileURL(join(UI, 'mobile-interactive.html')).href;

mkdirSync(OUT, { recursive: true });

// playwright-core 不自带浏览器，直接驱动系统里的 Edge
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

/**
 * 原型画了、但产品尚未实现或明确置灰的东西，截图里必须去掉，
 * 否则官网等于替产品宣称了不存在的能力。依据 docs/01-软件说明.md:88-107。
 *   .toast            原型自己的引导气泡，不是产品的一部分
 *   .blb              「N 条反向链接 · 查看图谱」——关系图谱未排期
 *   [data-action=export]  导出 Markdown —— V3 才做
 */
const HIDE_UNSHIPPED = `
  #toast, .toast, [class*="hint"] { display: none !important; }
  .blb { display: none !important; }
  [data-action="export"] { display: none !important; }
`;

const browser = await chromium.launch({ executablePath: EDGE, headless: true });

async function desktopPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(DESKTOP, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: HIDE_UNSHIPPED });
  await page.waitForTimeout(800);
  return page;
}

async function scrollTop(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0;
  });
  await page.waitForTimeout(300);
}

// ── 页面库 ──
let page = await desktopPage();
await page.screenshot({ path: join(OUT, 'library.png') });
console.log('✓ library.png');

// ── 编辑器（Hero） ──
await page.locator('text=副业探索').first().click();
await page.waitForTimeout(900);
await page.addStyleTag({ content: HIDE_UNSHIPPED });
await page.screenshot({ path: join(OUT, 'hero.png') });
console.log('✓ hero.png');

// 悬停第一段，让块把手 / 行尾 ＋ 露出来
await page.locator('.block.para').first().hover();
await page.waitForTimeout(400);
await scrollTop(page);

// ── 两个特写 ──
// 用块自身的坐标算裁剪区，别写死像素——改了原型就用不着重新量。
const geom = await page.evaluate(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
  };
  return {
    title: rect('.doc-title'),
    t3: rect('.block.t3'),
    embed: rect('.block.embed-block'),
    ai: rect('.block.ai-block'),
  };
});

const X = 470;
const W = 760;

// 大纲：页名 → H3，含层级、待办、块把手
if (geom.title && geom.t3) {
  const y = Math.max(0, geom.title.top - 16);
  const bottom = geom.t3.bottom + 12;
  await page.screenshot({ path: join(OUT, 'outline.png'), clip: { x: X, y, width: W, height: bottom - y } });
  console.log(`✓ outline.png  y=${y} h=${bottom - y}`);
}

// 双链：[[页面引用]] + 嵌入块 + ((块引用))，裁到 AI 块之前避免切进它的虚线边框
if (geom.embed && geom.ai) {
  const y = geom.embed.top - 80;
  const bottom = geom.ai.top - 4;
  await page.screenshot({ path: join(OUT, 'links.png'), clip: { x: X, y, width: W, height: bottom - y } });
  console.log(`✓ links.png  y=${y} h=${bottom - y}`);
}

// AI 块特写
const aiBox = await page.locator('.block.ai-block').first().boundingBox();
if (aiBox) {
  await page.locator('.block.ai-block').first().screenshot({ path: join(OUT, 'ai-block.png') });
  console.log('✓ ai-block.png');
}

// ── 深色主题 ──
await page.evaluate(() => document.querySelector('[data-action="theme"]')?.click());
await page.waitForTimeout(800);
await page.screenshot({ path: join(OUT, 'dark.png') });
console.log('✓ dark.png');
await page.close();

// ── 移动端 ──
// ⚠️ 这张图目前**没有用在页面上**：它是移动端设计原型的图，而窄屏适配
// 在 docs/01-软件说明.md:85 的口径是「真实移动设备未验」，移动端专项触控
// 是 0.6.0 未开工。放上去等于宣称有移动端 App。等它真做出来再用。
const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await mob.goto(MOBILE, { waitUntil: 'networkidle' });
await mob.addStyleTag({ content: HIDE_UNSHIPPED });
await mob.waitForTimeout(1200);
await mob.screenshot({ path: join(OUT, 'mobile.png') });
console.log('✓ mobile.png（备而不用，见上方注释）');
await mob.close();

await browser.close();
console.log('\n完成。配图在 website/assets/');
