import type { ChangelogRelease } from './changelog'

/*
 * 版本元信息的唯一读取口（docs/06 §10）。
 * 四个值都由构建期注入（vite.config.ts 的 define），不在运行时调用 Tauri API：
 * 浏览器预览、桌面外壳和测试环境必须看到同一份值，不能靠外壳才知道自己是什么版本。
 * 未经构建的环境（tsx 直接跑单测、裸加载模块）读到空值，不抛错。
 */

/** 构建时间按本机时区显示成 `YYYY-MM-DD HH:mm`；非法或缺失时返回空串。 */
export function formatBuildTime(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
export const APP_STAGE: string = typeof __APP_STAGE__ === 'string' ? __APP_STAGE__ : ''
export const APP_BUILD: string = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : ''
export const APP_CHANGELOG: ChangelogRelease[] = Array.isArray(__APP_CHANGELOG__) ? __APP_CHANGELOG__ : []
export const APP_BUILD_LABEL: string = formatBuildTime(APP_BUILD)
