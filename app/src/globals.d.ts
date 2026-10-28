import type { ChangelogRelease } from './changelog'

/*
 * 构建期注入的全局值（docs/06 §10）。声明在这里，tsc 才能对 src/version.ts 做类型检查；
 * 具体取值由 vite.config.ts 的 define 决定，浏览器里不存在这些全局变量。
 */
declare global {
  /** app/package.json 的 version，版本号的唯一真相源。 */
  const __APP_VERSION__: string
  /** app/package.json 的 moqi.stage，对应文档里的阶段号（V1 / V2a / V2b / V2c / V3）。 */
  const __APP_STAGE__: string
  /** 构建时刻（ISO 字符串）。 */
  const __APP_BUILD__: string
  /** app/CHANGELOG.md 解析结果。 */
  const __APP_CHANGELOG__: ChangelogRelease[]
}

export {}
