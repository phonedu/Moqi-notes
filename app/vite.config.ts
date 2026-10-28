import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { parseChangelog } from './src/changelog'

/*
 * 版本元信息在构建期注入（docs/06 §10）：版本号只从 package.json 读，更新日志只从
 * CHANGELOG.md 读，界面里显示的更新日志和仓库里的文件永远是同一份数据。
 * 不在运行时调用 Tauri API，浏览器预览和桌面外壳因此看到同样的版本号。
 * 改动 CHANGELOG.md 后需要重启 dev server，define 不参与热更新。
 */
const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
  moqi?: { stage?: string }
}
const changelog = parseChangelog(readFileSync(new URL('./CHANGELOG.md', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_STAGE__: JSON.stringify(packageJson.moqi?.stage ?? ''),
    __APP_BUILD__: JSON.stringify(new Date().toISOString()),
    __APP_CHANGELOG__: JSON.stringify(changelog),
  },
  server: {
    host: true,
    allowedHosts: [],
  },
})
