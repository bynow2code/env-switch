const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const chokidar = require('chokidar');
const { execSync } = require('child_process');

// 先固定「真实的」userData 路径：下方开发模式会把 userData 重定向到临时缓存目录以解决
// Chromium 缓存写权限问题，但日志目录与项目数据（data.json）需落在原始 userData 下，故先捕获。
// 放在最顶部，确保日志工具定义时即可引用（日志目录在开发模式重定向之前就已锁定）。
const REAL_USER_DATA = app.getPath('userData');

// 统一日志工具（对齐 easy-ops：同时输出到控制台 + 写入 userData/logs/main.log）
// 思路：覆盖 console.log/error/warn，使每次输出都追加到日志文件；
// 这样无论通过 log(tag, ...) 还是直接 console.*，打包后都能在
// %APPDATA%/<appName>/logs/main.log 查看（与 easy-ops 的 logs/main.log 一致）。

// 安全格式化：字符串原样，Error 取 stack，对象转 JSON（循环引用降级为 String）
const fmtLog = (args) => args.map(a => {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || a.message
  try { return JSON.stringify(a) } catch (e) { return String(a) }
}).join(' ')

// 日志目录：在开发模式「重定向 userData 到临时缓存目录」之前用真实 userData 固定下来，
// 这样无论开发还是打包，日志都统一落在 %APPDATA%/EnvSwitch/logs/main.log（与 easy-ops 一致）。
// 注：此处不能在 appendLog 内现取 app.getPath('userData')，否则开发模式会误落到临时缓存目录。
const LOG_DIR = path.join(REAL_USER_DATA, 'logs');

// 追加一行到 LOG_DIR/main.log（与 easy-ops 路径一致）
function appendLog(line) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(path.join(LOG_DIR, 'main.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch (e) { /* 日志写入失败不阻塞主流程 */ }
}

// 保存原始 console 方法，避免递归调用
const _origConsoleLog = console.log.bind(console)
const _origConsoleErr = console.error.bind(console)
const _origConsoleWarn = console.warn.bind(console)

// 覆盖 console.*：原样打印 + 落盘（每次只追加一次，无重复）
console.log = (...args) => { _origConsoleLog(...args); appendLog('[INFO] ' + fmtLog(args)) }
console.error = (...args) => { _origConsoleErr(...args); appendLog('[ERROR] ' + fmtLog(args)) }
console.warn = (...args) => { _origConsoleWarn(...args); appendLog('[WARN] ' + fmtLog(args)) }

// 带模块前缀的便捷方法（最终都走被覆盖的 console.*，自动落盘）
function log(tag, ...args) { console.log(`[${tag}]`, ...args) }
function logErr(tag, ...args) { console.error(`[${tag}]`, ...args) }

// 未捕获异常也写入日志（对齐 easy-ops 的健壮做法）
process.on('uncaughtException', (err) => {
  logErr('FATAL', 'uncaughtException:', err && err.stack || err)
})
process.on('unhandledRejection', (reason) => {
  logErr('FATAL', 'unhandledRejection:', reason)
})

// 开发模式：将 Chromium 缓存（HTTP 磁盘缓存 + GPU 缓存）重定向到用户临时目录下可写目录，
// 规避 Windows 上默认 userData 缓存目录出现「拒绝访问 (0x5) / Unable to move the cache /
// Gpu Cache Creation failed」等无害噪声日志。仅开发模式生效；打包后沿用默认 userData，数据落点不变。
if (!app.isPackaged) {
  const devCacheDir = path.join(app.getPath('temp'), 'envswitch-dev-cache');
  log('MAIN', '开发模式：重定向 Chromium 缓存到', devCacheDir);
  try {
    fs.mkdirSync(devCacheDir, { recursive: true });
    app.setPath('userData', devCacheDir); // 缓存随之落到临时目录，GPU 缓存也一并解决
  } catch (e) {
    logErr('MAIN', '无法重定向开发缓存目录，忽略:', e.message);
  }
}

let mainWindow;
let server;
let io;
const watchers = new Map();

// 自动更新相关状态（与 easy-ops 一致：仅用户手动触发检查，不在启动时自动检查）
let updaterInitialized = false; // 防止 ipcMain.handle 重复注册（mac 重新激活窗口时会再次进入）
let isChecking = false;        // 防重入：正在检查更新
let isDownloading = false;     // 防重入：正在下载更新

// 获取应用数据目录（固定返回真实的 userData，不受上方开发模式重定向影响）
const getAppDataPath = () => {
  return REAL_USER_DATA;
};

// 确保数据目录存在
const DATA_DIR = path.join(getAppDataPath(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// 读取存储的项目数据
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('加载数据失败:', e.message);
  }
  return { projects: [] };
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('保存数据失败:', e.message);
  }
}

// 检测是否为 WSL 路径，并返回 { distro, linuxPath }
function parseWslPath(windowsPath) {
  const match = windowsPath.match(/^\\\\wsl(?:\.localhost)?\\([^\\]+)\\(.+)$/i);
  if (!match) return null;
  const distro = match[1];
  const linuxPath = '/' + match[2].replace(/\\/g, '/');
  return { distro, linuxPath };
}

// 通过 wsl.exe 执行文件复制（用于 WSL 路径）
function wslCopyFile(sourcePath, targetPath) {
  const source = parseWslPath(sourcePath);
  const target = parseWslPath(targetPath);
  if (!source || !target || source.distro !== target.distro) {
    throw new Error('无法解析 WSL 路径');
  }
  const cmd = `wsl.exe -d ${source.distro} cp "${source.linuxPath}" "${target.linuxPath}"`;
  log('WSL', 'copy', sourcePath, '->', targetPath);
  execSync(cmd, { stdio: 'pipe', timeout: 5000 });
}

// 通过 wsl.exe 读取文件内容（用于 WSL 路径）
function wslReadFile(filePath) {
  const parsed = parseWslPath(filePath);
  if (!parsed) throw new Error('无法解析 WSL 路径');
  const cmd = `wsl.exe -d ${parsed.distro} cat "${parsed.linuxPath}"`;
  log('WSL', 'read', filePath);
  return execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
}

// 判断是否为 WSL 路径
function isWslPath(filePath) {
  return /^\\\\wsl(?:\.localhost)?\\/i.test(filePath);
}

// 解析 .env 文件内容为键值对
function parseEnvFile(filePath) {
  const result = {};
  log('FILE', '解析', filePath);
  try {
    let content;
    if (isWslPath(filePath)) {
      try {
        content = wslReadFile(filePath);
      } catch (e) {
        // 文件不存在或读取失败，返回空
        return result;
      }
    } else {
      if (!fs.existsSync(filePath)) return result;
      content = fs.readFileSync(filePath, 'utf-8');
    }
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      let value = trimmed.substring(eqIdx + 1).trim();
      // 移除引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  } catch (e) {
    console.error(`Error parsing ${filePath}:`, e.message);
  }
  return result;
}

// 获取项目信息
function getProjectInfo(projectDir) {
  log('PROJECT', '读取项目信息', projectDir);
  const envPath = path.join(projectDir, '.env');
  const envVars = parseEnvFile(envPath);

  // 读取所有 .env.xxx 文件，排除 .env.example
  const envFiles = [];
  try {
    let files;
    if (isWslPath(projectDir)) {
      const parsed = parseWslPath(projectDir);
      // 使用 sh -c 执行以支持 glob 展开
      const cmd = `wsl.exe -d ${parsed.distro} sh -c "ls -1a ${parsed.linuxPath}/.env.* 2>/dev/null || true"`;
      try {
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
        if (output) {
          files = output.split('\n').map(f => {
            // ls 可能返回完整路径，只取文件名
            const basename = f.trim().split('/').pop();
            return basename;
          }).filter(f => f && f.startsWith('.env.') && f !== '.env.example');
        }
      } catch (e) {
        files = [];
      }
    } else {
      if (fs.existsSync(projectDir)) {
        files = fs.readdirSync(projectDir);
      }
    }
    if (files) {
      for (const file of files) {
        const name = typeof file === 'string' ? file : file;
        if (name.startsWith('.env.') && name !== '.env.example') {
          envFiles.push(name);
        }
      }
    }
  } catch (e) {
    console.error('获取项目信息失败:', e.message);
  }

  return {
    appName: envVars['APP_NAME'] || '',
    appEnv: envVars['APP_ENV'] || '',
    allEnvVars: envVars,
    envFiles
  };
}

// 设置文件监控
function setupWatcher(projectId, projectDir) {
  log('WATCHER', '设置监控', 'projectId=' + projectId, projectDir);
  // 清理旧的 watcher
  if (watchers.has(projectId)) {
    const old = watchers.get(projectId);
    try { old.close(); } catch (e) {}
    if (old._dirWatcher) {
      try { old._dirWatcher.close(); } catch (e) {}
    }
    watchers.delete(projectId);
  }

  const envPath = path.join(projectDir, '.env');

  // WSL 路径不支持 chokidar 监控，跳过
  if (isWslPath(projectDir)) {
    log('WATCHER', 'WSL 路径，跳过文件监控', projectDir);
    return;
  }

  // 只监控文件，如果 .env 是目录则跳过
  try {
    if (fs.existsSync(envPath) && fs.statSync(envPath).isDirectory()) {
      log('WATCHER', 'envPath 是目录，跳过', envPath);
      return;
    }
  } catch (e) {
    log('WATCHER', '无法访问 envPath，跳过', envPath, e.message);
    return;
  }

  const watcher = chokidar.watch(envPath, {
    persistent: true,
    ignoreInitial: true
  });

  watcher.on('change', () => {
    log('WATCHER', 'env 变更 (change)', projectId);
    const info = getProjectInfo(projectDir);
    io.emit('env-changed', { projectId, ...info });
  });

  watcher.on('error', (err) => {
    logErr('WATCHER', '监控错误', projectDir, err.message);
  });

  // 也监控目录中新增/删除 .env.xxx 文件
  const dirWatcher = chokidar.watch(path.join(projectDir, '.env.*'), {
    persistent: true,
    ignoreInitial: true
  });

  dirWatcher.on('add', () => {
    log('WATCHER', 'env 文件新增 (add)', projectId);
    const info = getProjectInfo(projectDir);
    io.emit('env-changed', { projectId, ...info });
  });

  dirWatcher.on('unlink', () => {
    log('WATCHER', 'env 文件删除 (unlink)', projectId);
    const info = getProjectInfo(projectDir);
    io.emit('env-changed', { projectId, ...info });
  });

  dirWatcher.on('error', (err) => {
    logErr('WATCHER', '目录监控错误', projectDir, err.message);
  });

  watchers.set(projectId, watcher);
  // 存储 dirWatcher 引用以便清理
  watcher._dirWatcher = dirWatcher;
}

// 启动 Express 服务器
async function startServer() {
  log('SERVER', '启动 Express 服务器 …');
  const expressApp = express();
  server = http.createServer(expressApp);
  io = new Server(server, { cors: { origin: '*' } });

  expressApp.use(cors());
  expressApp.use(express.json());
  // 请求日志：记录每个 API / 静态请求，方便排查前后端通信
  expressApp.use((req, res, next) => {
    log('SERVER', req.method, req.url);
    next();
  });

  // 静态文件服务（前端构建产物：client/dist，对齐 easy-ops 的 client/dist 方案）
  const clientDist = path.join(__dirname, 'client', 'dist');
  expressApp.use(express.static(clientDist));

  // API 路由
  expressApp.get('/api/projects', (req, res) => {
    const data = loadData();
    const projects = data.projects.map(p => {
      const info = getProjectInfo(p.dir);
      return {
        id: p.id,
        name: p.name,
        dir: p.dir,
        appName: info.appName,
        appEnv: info.appEnv,
        envFiles: info.envFiles
      };
    });
    res.json(projects);
  });

  expressApp.get('/api/projects/:id', (req, res) => {
    const data = loadData();
    const project = data.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const info = getProjectInfo(project.dir);
    res.json({
      id: project.id,
      name: project.name,
      dir: project.dir,
      appName: info.appName,
      appEnv: info.appEnv,
      allEnvVars: info.allEnvVars,
      envFiles: info.envFiles
    });
  });

  expressApp.post('/api/projects', (req, res) => {
    const { dir } = req.body;
    if (!dir) return res.status(400).json({ error: '请提供项目目录' });

    // WSL 路径保持原样，本地路径做规范化
    const normalizedDir = isWslPath(dir) ? dir : path.resolve(dir);

    // 检查目录是否存在
    let exists;
    if (isWslPath(normalizedDir)) {
      const parsed = parseWslPath(normalizedDir);
      try {
        const cmd = `wsl.exe -d ${parsed.distro} test -d "${parsed.linuxPath}" && echo OK || echo NO`;
        const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
        exists = result === 'OK';
      } catch (e) {
        exists = false;
      }
    } else {
      exists = fs.existsSync(normalizedDir);
    }

    if (!exists) {
      return res.status(400).json({ error: '目录不存在' });
    }

    const data = loadData();

    // 检查是否已存在（统一用小写比较）
    if (data.projects.find(p => p.dir.toLowerCase() === normalizedDir.toLowerCase())) {
      return res.status(400).json({ error: '该项目已添加' });
    }

    const projectName = path.basename(normalizedDir);
    const project = {
      id: Date.now().toString(),
      name: projectName,
      dir: normalizedDir
    };

    data.projects.push(project);
    saveData(data);

    // 设置文件监控
    setupWatcher(project.id, normalizedDir);
    log('SERVER', '项目已添加', project.id, normalizedDir);

    const info = getProjectInfo(normalizedDir);
    res.json({
      id: project.id,
      name: project.name,
      dir: project.dir,
      appName: info.appName,
      appEnv: info.appEnv,
      envFiles: info.envFiles
    });
  });

  expressApp.delete('/api/projects/:id', (req, res) => {
    const data = loadData();
    const idx = data.projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '项目不存在' });

    // 清理 watcher
    if (watchers.has(req.params.id)) {
      const w = watchers.get(req.params.id);
      w.close();
      if (w._dirWatcher) w._dirWatcher.close();
      watchers.delete(req.params.id);
    }

    data.projects.splice(idx, 1);
    saveData(data);
    res.json({ success: true });
  });

  expressApp.post('/api/projects/:id/switch', (req, res) => {
    const { envFileName } = req.body;
    if (!envFileName) return res.status(400).json({ error: '请提供 env 文件名' });

    const data = loadData();
    const project = data.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const sourcePath = path.join(project.dir, envFileName);
    const targetPath = path.join(project.dir, '.env');

    if (!fs.existsSync(sourcePath)) {
      return res.status(400).json({ error: `${envFileName} 文件不存在` });
    }

    try {
      const isWsl = isWslPath(project.dir);

      if (isWsl) {
        // WSL 路径：通过 wsl.exe 进行文件复制
        wslCopyFile(sourcePath, targetPath);
      } else {
        // 本地路径：直接读写
        const sourceContent = fs.readFileSync(sourcePath, 'utf-8');

        // 如果目标 .env 文件存在，先尝试移除只读属性（Windows）
        if (fs.existsSync(targetPath)) {
          try {
            fs.chmodSync(targetPath, 0o666);
          } catch (chmodErr) {
            // 忽略
          }
        }

        fs.writeFileSync(targetPath, sourceContent, 'utf-8');

        try {
          fs.chmodSync(targetPath, 0o666);
        } catch (chmodErr) {
          // 忽略
        }
      }

      const info = getProjectInfo(project.dir);
      io.emit('env-changed', { projectId: project.id, ...info });
      log('SERVER', '环境切换成功', project.id, '->', envFileName);
      res.json({
        success: true,
        projectId: project.id,
        appName: info.appName,
        appEnv: info.appEnv,
        envFiles: info.envFiles
      });
    } catch (e) {
      logErr('SERVER', '环境切换失败', project.id, envFileName, e.message);
      res.status(500).json({ error: '切换失败: ' + e.message });
    }
  });

  expressApp.get('/api/projects/:id/env-file/:fileName', (req, res) => {
    const data = loadData();
    const project = data.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const filePath = path.join(project.dir, req.params.fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: '文件不存在' });
    }

    const envVars = parseEnvFile(filePath);
    res.json({ fileName: req.params.fileName, vars: envVars });
  });

  // Socket.IO 连接处理
  io.on('connection', (socket) => {
    log('SOCKET', 'Client connected');
    socket.on('disconnect', () => {
      log('SOCKET', 'Client disconnected');
    });
  });

  // 启动时恢复所有 watcher
  const data = loadData();
  data.projects.forEach(p => {
    try {
      setupWatcher(p.id, p.dir);
    } catch (e) {
      console.error(`[WARN] 恢复监控失败 ${p.dir}:`, e.message);
    }
  });

  // 系统分配端口方案（参考 easy-ops）：监听 0 号端口，由操作系统分配一个
  // 全局唯一的空闲端口，彻底避免与其它应用或自身多实例争抢固定端口导致的「串台」。
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      // listen(0) 之后从 server.address() 取回操作系统实际分配的端口
      const addr = server.address();
      const port = addr ? addr.port : 0;
      log('SERVER', 'Server running on http://127.0.0.1:' + port + ' (系统分配端口)');
      resolve(port);
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// 创建主窗口
async function createWindow() {
  log('MAIN', '创建主窗口 …');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 预加载脚本：向渲染进程暴露 window.electronAPI（更新等能力），隔离环境下唯一安全通道
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'client', 'dist', 'logo-win.png')
  });

  // 隐藏菜单栏
  Menu.setApplicationMenu(null);

  // 外部链接（http/https，如 App Info 里的 GitHub Source）一律用系统默认浏览器打开，
  // 不在 Electron 应用内开新窗口。返回 { action: 'deny' } 阻止内置窗口打开。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      log('MAIN', '外部链接交由系统默认浏览器打开:', url);
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 启动服务器
  const port = await startServer();

  // 加载前端页面
  const startUrl = `http://127.0.0.1:${port}`;
  log('MAIN', '加载前端', startUrl);
  mainWindow.loadURL(startUrl);

  // 开发模式下打开开发者工具
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// ---------------------------------------------------------------------------
// 自动更新（参考 easy-ops）
// Windows：electron-updater + GitHub Releases 作为更新源（NSIS 安装包，个人发布无需签名）
// 关键约束：更新检查完全由用户点击「检查更新」触发，不在应用启动时自动检查
// ---------------------------------------------------------------------------
function initAutoUpdater() {
  if (updaterInitialized) return; // 仅注册一次（mac 重新激活窗口会再次进入 createWindow）
  updaterInitialized = true;

  // 无论是否打包，先注册 app:get-info，供前端「App Info」关于弹窗展示应用信息
  ipcMain.handle('app:get-info', () => {
    log('IPC', 'get-info')
    return {
      version: app.getVersion(),          // 应用版本（取 package.json 的 version）
      isDev: !app.isPackaged,             // 是否开发模式（反向即是否打包）
      dataFilePath: DATA_FILE,            // 项目数据文件 data.json 完整路径
      logFilePath: path.join(LOG_DIR, 'main.log'), // 主进程日志路径
      repoUrl: 'https://github.com/bynow2code/env-switch' // 源码仓库地址
    }
  });

  // 开发模式（未打包）：不连 GitHub，注册桩 handler，让前端走「dev mode」提示分支
  if (!app.isPackaged) {
    console.log('[UPDATE] 开发模式：跳过真实更新检查（打包后才会真正连 GitHub）');
    ipcMain.handle('app:check-updates', async () => {
      if (mainWindow) {
        mainWindow.webContents.send('update-event', {
          type: 'error',
          message: 'Running in dev mode. Auto-update only works in packaged builds.'
        });
      }
    });
    ipcMain.handle('app:download-update', () => {});
    ipcMain.handle('app:start-update', () => {});
    return;
  }

  // 打包环境：防御性加载 electron-updater，避免未正确打包时报错崩溃
  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    console.error('[UPDATE] electron-updater 不可用:', e.message);
    ipcMain.handle('app:check-updates', async () => {
      if (mainWindow) mainWindow.webContents.send('update-event', { type: 'error', message: 'Updater not available.' });
    });
    ipcMain.handle('app:download-update', () => {});
    ipcMain.handle('app:start-update', () => {});
    return;
  }

  // 不在后台自动下载，等用户点「下载并更新」再下载；退出时自动安装已下载的更新
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // 更新源：GitHub Releases（仓库 bynow2code/env-switch）
  // 前置条件：把 electron-builder 产出的 .exe 与 latest.yml 上传到对应版本（v<version>）的 GitHub Release
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'bynow2code',
    repo: 'env-switch'
  });
  console.log('[UPDATE] feedURL 已设置: provider=github, owner=bynow2code, repo=env-switch');

  // 统一的事件转发：主进程 autoUpdater 事件 -> 渲染进程（update-event 通道）
  const send = (payload) => {
    if (mainWindow) mainWindow.webContents.send('update-event', payload);
  };

  // 每个 autoUpdater 事件都打日志（带 [UPDATE] 前缀，方便从终端/打包日志排查）
  autoUpdater.on('checking-for-update', () => {
    console.log('[UPDATE] 事件: checking-for-update（开始连接更新源）');
    send({ type: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[UPDATE] 事件: update-available, version =', info && info.version);
    send({ type: 'available', version: info.version, releaseNotes: info.releaseNotes || '' });
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log('[UPDATE] 事件: update-not-available, version =', info && info.version);
    send({ type: 'not-available', version: info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    const percent = Math.round(p.percent || 0);
    console.log('[UPDATE] 事件: download-progress', percent + '%');
    send({ type: 'downloading', progress: percent });
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[UPDATE] 事件: update-downloaded, version =', info && info.version);
    send({ type: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    const msg = (err && err.message) || String(err);
    console.error('[UPDATE] 事件: error:', msg);
    send({ type: 'error', message: msg });
  });

  // IPC：检查更新（带防重入 + 超时兜底）
  // 问题背景：国内网络访问 GitHub（api.github.com / Releases）常不通或挂起，
  // electron-updater 的 checkForUpdates() 无响应时既不 resolve 也不 reject，
  // 前端会永远停在「正在检查更新…」。用 Promise.race 加 20s 超时，超时即报 error 事件。
  ipcMain.handle('app:check-updates', async () => {
    if (isChecking) {
      console.log('[UPDATE] checkForUpdates 忽略 - 正在检查中');
      return;
    }
    isChecking = true;
    console.log('[UPDATE] 开始 checkForUpdates() …（最多等待 20s）');
    const timeout = new Promise((_, reject) =>
      setTimeout(() => {
        console.warn('[UPDATE] 20s 超时触发：放弃等待 checkForUpdates（通常是网络连不上 GitHub）');
        reject(new Error('检查更新超时（可能网络无法访问 GitHub，请检查网络或代理）'));
      }, 20000)
    );
    try {
      const result = await Promise.race([autoUpdater.checkForUpdates(), timeout]);
      console.log('[UPDATE] checkForUpdates 正常返回:', result ? '有结果（见后续事件）' : result);
    } catch (e) {
      console.error('[UPDATE] checkForUpdates 失败/超时:', e.message);
      send({ type: 'error', message: e.message });
    } finally {
      isChecking = false;
      console.log('[UPDATE] checkForUpdates 流程结束 (isChecking=false)');
    }
  });

  // IPC：下载更新（带防重入）
  ipcMain.handle('app:download-update', async () => {
    if (isDownloading) {
      console.log('[UPDATE] downloadUpdate 忽略 - 正在下载中');
      return;
    }
    isDownloading = true;
    log('UPDATE', 'download-update 开始');
    try {
      await autoUpdater.downloadUpdate();
      log('UPDATE', 'download-update 完成');
    } catch (e) {
      console.error('[UPDATE] downloadUpdate 失败:', e.message);
      send({ type: 'error', message: e.message });
    } finally {
      isDownloading = false;
    }
  });

  // IPC：退出并安装更新
  ipcMain.handle('app:start-update', () => {
    log('UPDATE', 'start-update 开始 (quitAndInstall)');
    try {
      // quitAndInstall(isSilent, isForceRunAfter) -> 先退出再强制安装并重启
      autoUpdater.quitAndInstall(false, true);
    } catch (e) {
      console.error('[UPDATE] quitAndInstall 失败:', e.message);
      send({ type: 'error', message: e.message });
    }
  });
}

// 单实例锁（参考 easy-ops「防止串台」）：保证同一时间只有一个 EnvSwitch 在运行，
// 第二个启动实例会聚焦已有窗口，而不是再起一个后端/窗口与之争抢资源。
const gotTheLock = app.requestSingleInstanceLock();
log('MAIN', 'requestSingleInstanceLock ->', gotTheLock ? '主实例' : '次实例(将退出)');

if (!gotTheLock) {
  // 没拿到锁说明已有实例在运行，当前（第二个）实例直接退出
  log('MAIN', '已有实例在运行，当前实例退出');
  app.quit();
} else {
  // 第二个实例尝试启动时：只聚焦已有窗口，不重复创建
  app.on('second-instance', () => {
    log('MAIN', 'second-instance：聚焦已有窗口');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 当 Electron 准备好时创建窗口
  app.whenReady().then(() => {
    log('MAIN', '=== EnvSwitch 启动 (isPackaged=' + app.isPackaged + ') ===')
    log('MAIN', 'app ready，创建窗口');
    createWindow();

    // 窗口建好后再初始化自动更新（事件转发依赖 mainWindow）
    initAutoUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        log('MAIN', 'activate：重建窗口');
        createWindow();
      }
    });
  });
}

// 当所有窗口关闭时退出应用
app.on('window-all-closed', () => {
  log('MAIN', '所有窗口关闭');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出时清理
app.on('before-quit', () => {
  log('MAIN', 'before-quit：关闭 server 与 watchers');
  if (server) {
    server.close();
  }
  // 关闭所有 watcher
  watchers.forEach(w => {
    try { w.close(); } catch (e) {}
    if (w._dirWatcher) {
      try { w._dirWatcher.close(); } catch (e) {}
    }
  });
});
