# EnvSwitch

ENV 配置管理工具 — 可视化管理和切换多个项目的 `.env` 环境配置。

## 功能特性

- **多项目管理** — 支持添加多个项目目录，集中管理所有项目的环境配置
- **一键切换环境** — 列出项目目录下的 `.env.xxx` 文件，点击即可将对应配置覆盖到 `.env`
- **实时监控** — 使用 chokidar 监控 `.env` 文件变化，通过 Socket.IO 实时推送更新到界面
- **拖拽排序** — 支持拖拽调整项目卡片顺序，排序结果自动持久化
- **WSL 支持** — 兼容 Windows Subsystem for Linux 路径（如 `\\wsl.localhost\Ubuntu\...`）
- **Electron 桌面应用** — 可打包为 Windows 安装程序（NSIS），独立运行

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron |
| 后端 | Express + Socket.IO |
| 前端 | React + Vite |
| 拖拽 | @dnd-kit |
| 文件监控 | chokidar |
| 打包 | electron-builder (NSIS) |

## 项目结构

```
EnvSwitch/
├── electron-main.js      # Electron 主进程
├── server/
│   └── index.js          # Express 服务端（API + 静态文件 + Socket.IO）
├── client/               # React 前端
│   ├── src/
│   │   ├── App.jsx       # 主组件
│   │   ├── App.css       # 样式
│   │   └── main.jsx      # 入口
│   └── public/
│       ├── favicon.svg
│       ├── icon.png
│       └── icon.ico
├── gen-icons.js          # 图标生成脚本
└── package.json
```

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装依赖

```bash
npm install
cd client && npm install
```

### 开发模式

同时启动 Express 服务端和 React 前端开发服务器：

```bash
npm run dev
```

- 服务端：`http://localhost:3001`
- 前端（Vite）：`http://localhost:5173`

### Electron 开发模式

构建前端后在 Electron 窗口中运行：

```bash
npm run electron-dev
```

### 打包为 Windows 应用

```bash
npm run electron-build
```

打包产物输出到 `release/` 目录，生成 NSIS 安装程序。

## 使用说明

### 添加项目

1. 点击右上角 **"+ 添加项目"** 按钮
2. 输入项目的根目录路径（需包含 `.env` 文件），支持本地路径和 WSL 路径
3. 点击确定

### 切换环境

1. 项目卡片会显示当前 `.env` 中的 `APP_NAME` 和 `APP_ENV`
2. 在"环境配置切换"区域，点击对应 `.env.xxx` 文件旁的 **"切换"** 按钮
3. 该配置文件的内容将被复制到 `.env`，界面实时更新

### 排序与删除

- **拖拽排序**：按住拖拽手柄（⠿）拖动项目卡片调整顺序
- **删除项目**：点击卡片右上角的"删除"按钮移除项目

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects` | 获取所有项目列表 |
| GET | `/api/projects/:id` | 获取单个项目详情 |
| POST | `/api/projects` | 添加项目（body: `{ dir }`） |
| PUT | `/api/projects/reorder` | 更新排序（body: `{ ids }`） |
| DELETE | `/api/projects/:id` | 删除项目 |
| POST | `/api/projects/:id/switch` | 切换环境（body: `{ envFileName }`） |
| GET | `/api/projects/:id/env-file/:fileName` | 获取指定 env 文件内容 |

## 数据存储

项目数据存储在 `server/data.json`（开发模式）或 Electron 用户数据目录（打包模式）。Electron 模式下路径为 `app.getPath('userData')/data/data.json`。