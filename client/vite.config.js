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

    proxy: {
      // REST API 代理 → 独立后端 server/index.js（默认监听 3001 端口）
      // 开发模式下 npm run dev 通过 concurrently 同时启动 server 和 client
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        timeout: 10000,
      },
      // WebSocket 代理 → Socket.IO 实时推送 .env 文件变更事件
      // ws: true 启用 WebSocket 代理；proxyTimeout 控制 WS 握手超时
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
        timeout: 10000,
        proxyTimeout: 10000,
      },
    },
  },
})
