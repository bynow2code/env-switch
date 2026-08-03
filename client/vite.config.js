import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // React 19 + 自动 JSX 运行时（无需手动 import React，由 @vitejs/plugin-react v6 处理）
  plugins: [react()],

  // 相对路径基准：Electron 通过 file:// 或 http://127.0.0.1:<port> 加载页面，
  // 必须使用 './' 否则打包后资源路径会指向磁盘根目录导致 404
  base: './',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Electron 内置 Chromium 版本较新（v43+），直接使用 ESNext 语法，
    // 无需降级兼容旧浏览器，减小产物体积并保留原生特性
    target: 'esnext',
    // 生产构建关闭 sourcemap：个人工具无需对外暴露源码，减小产物体积
    sourcemap: false,
  },

  server: {
    // 仅监听本地回环地址，避免开发服务器暴露到局域网
    // （Electron 模式下后端也绑定了 127.0.0.1，前后端一致）
    host: '127.0.0.1',
    port: 5173,
    // 说明：EnvSwitch 的后端内嵌于 Electron 主进程（electron-main.js 的 startServer），
    // 通过 Electron 窗口加载页面，前后端同源（系统分配端口），无需 Vite dev server 代理。
    // 故这里不配置 /api、/socket.io 代理（旧版曾指向已删除的独立 server/index.js :3001，已移除）。
  },
})
