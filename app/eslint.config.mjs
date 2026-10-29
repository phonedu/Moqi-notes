import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // `scripts/.xx.mjs` = 本会话/本机的临时探针（gitignore，不入库）——不参与门禁。
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/target/**', 'scripts/.*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', 'scripts/**/*.ts', 'vite.config.ts'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // 验收脚本：文件自己跑在 Node，`page.evaluate(...)` 里的回调跑在浏览器——两边用到的全局都声明一遍。
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        performance: 'readonly',
        structuredClone: 'readonly',
        getComputedStyle: 'readonly',
        matchMedia: 'readonly',
        // AI 的 SSE stub 在 accept 进程里用定时器分片（`scripts/accept-editor.mjs`）。
        setInterval: 'readonly',
        clearInterval: 'readonly',
        // 性能读数工具的轮询等待（`scripts/perf-read.mjs`：等 CDP 页 / 等首块渲染 / 按键间隔）。
        setTimeout: 'readonly',
        // 性能读数工具的取源探测（`scripts/perf-read.mjs`：探 5173 上是谁在服务，超时兜底）。
        AbortSignal: 'readonly',
        // 状态门：`STATE-SAVE-1` 用 rAF 逐帧采样 + MutationObserver 观察顶栏保存态；
        // `STATE-SAVE-2` 在失败路径上接管 `Storage.prototype.setItem`。
        MutationObserver: 'readonly',
        requestAnimationFrame: 'readonly',
        Storage: 'readonly',
        // 2026-10-07 补齐（`pnpm lint` 是 0.5 关闭条件第 1 条；媒体与导入两批新增的用法用到的）：
        // 事件与浏览器构造器（合成拖放 / 粘贴用例）、以及 Node 侧的 Buffer（造 PNG / CSV 样本）。
        Event: 'readonly',
        MouseEvent: 'readonly',
        DragEvent: 'readonly',
        // 2026-10-12（γ2）：选择模式内拖拽的验收要用**合成指针序列**（`page.evaluate` 里 `new PointerEvent`），
        // 与既有 MouseEvent / DragEvent 同类；`NodeFilter` 是「选择栏不折行」计数里 `createTreeWalker` 的常量。
        // 两个都只出现在 `scripts/**/*.mjs` 的浏览器侧回调里。
        PointerEvent: 'readonly',
        NodeFilter: 'readonly',
        ClipboardEvent: 'readonly',
        DataTransfer: 'readonly',
        File: 'readonly',
        navigator: 'readonly',
        Buffer: 'readonly',
        // 2026-10-08（真机读数工具 `scripts/device-read.mjs`）：Node 侧取 WebView 的 /json 目标表。
        fetch: 'readonly',
        // 2026-10-29：附件用例在 Node 进程里造 1×1 PNG 样本用；Node ≥16 有全局 atob。
        atob: 'readonly',
      },
    },
  },
)
