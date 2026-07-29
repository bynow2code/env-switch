import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // ─── 全局忽略 ───────────────────────────────────────────────
  // dist         —— Vite 构建产物（vite.config.js 中 outDir: 'dist'），无需 lint
  // node_modules —— 第三方依赖，flat config 默认已忽略，此处显式声明更直观
  globalIgnores(['dist', 'node_modules']),

  {
    // 项目仅使用 JSX（无 TypeScript），匹配 client 下所有 .js / .jsx 文件
    files: ['**/*.{js,jsx}'],
    extends: [
      // ESLint 官方推荐规则集（no-undef、no-unused-vars 等基础规则）
      js.configs.recommended,
      // React Hooks 规则（rules-of-hooks、exhaustive-deps、set-state-in-effect 等）
      reactHooks.configs.flat.recommended,
      // React Refresh HMR 兼容性检查（Vite 专用配置，确保组件导出不影响热更新）
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      // 浏览器环境全局变量：fetch、console、document、window、alert 等
      // 本项目为 Electron 渲染进程，运行在 Chromium 环境中，浏览器全局均可用
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',    // 使用最新 ECMAScript 语法（可选链 ?.、空值合并 ?? 等）
        sourceType: 'module',     // ES 模块（import / export），与 package.json "type": "module" 一致
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // ─── 通用规则 ───────────────────────────────────────────
      // 未使用变量降为 warn（不阻塞开发），并忽略以 _ 开头的参数 / 变量
      // preload.js 的 onUpdateEvent 回调签名 (_event, data) 中 _event 不使用，需豁免
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // 项目大量使用 console.log / console.error 排查前后端通信，不限制
      'no-console': 'off',

      // ─── React Hooks 规则 ───────────────────────────────────
      // hooks 调用规则违反直接报错（条件渲染中调用 hooks 等致命问题）
      'react-hooks/rules-of-hooks': 'error',
      // 依赖数组检查保持 warn（提醒潜在 stale closure，但不阻塞开发）
      'react-hooks/exhaustive-deps': 'warn',
      // v7 新增规则：在 effect 中同步调用 setState 会触发级联渲染。
      // 本项目的标准模式（useEffect 中调 loadProjects() 加载数据、setSocket() 初始化连接）
      // 属于合理的副作用同步场景，降级为 warn 避免误报阻塞开发。
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
])
