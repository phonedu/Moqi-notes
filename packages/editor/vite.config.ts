import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 包的独立构建（M4 完成判据）：react / react-dom / lexical 全部 external，
 * 产物只验证「包能离开墨契壳编译成单文件」；类型声明与发布产物在 M6 收口。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      external: (id: string) =>
        id === 'react'
        || id === 'react-dom'
        || id === 'react/jsx-runtime'
        || id === 'lexical'
        || id.startsWith('@lexical/'),
    },
  },
})
