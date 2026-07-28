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

// 日志策略：默认静默，仅保留「出错」日志，减少运行噪声。
//   · 信息类日志：一律不再输出（已整体移除，仅保留错误日志链路）
//   · 错误日志(console.error / console.warn / logErr)：按运行模式分流
//       - 开发模式(dev，未打包)：直接输出到终端，方便实时调试
//       - 打包模式(prod)：写入程序日志文件 userData/logs/main.log（终端不可见）
// 注：日志目录用真实 userData 固定（开发模式会把 userData 重定向到临时缓存目录，
// 但日志需落在原始 userData 下），故此处不能现取 app.getPath('userData')。

const IS_DEV = !app.isPackaged

// 安全格式化：字符串原样，Error 取 stack，对象转 JSON（循环引用降级为 String）
const fmtLog = (args) => args.map(a => {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || a.message
  try { return JSON.stringify(a) } catch (e) { return String(a) }
}).join(' ')

// 日志目录：在开发模式「重定向 userData 到临时缓存目录」之前用真实 userData 固定下来
const LOG_DIR = path.join(REAL_USER_DATA, 'logs')

// 追加一行到 LOG_DIR/main.log（打包模式下错误日志的落盘位置）
function appendLog(line) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(path.join(LOG_DIR, 'main.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch (e) { /* 日志写入失败不阻塞主流程 */ }
}

// 保留原始方法，避免递归调用
const _origConsoleErr = console.error.bind(console)
const _origConsoleWarn = console.warn.bind(console)

// 错误日志：dev 输出终端，prod 写入日志文件
console.error = (...args) => {
  const msg = fmtLog(args)
  if (IS_DEV) _origConsoleErr(...args)
  else appendLog('[ERROR] ' + msg)
}
console.warn = (...args) => {
  const msg = fmtLog(args)
  if (IS_DEV) _origConsoleWarn(...args)
  else appendLog('[WARN] ' + msg)
}
// 彻底屏蔽所有 info 级输出（含第三方依赖的 console.log），仅错误日志链路生效
console.log = () => {}

// 错误日志便捷方法：带模块前缀，最终走上方 console.error 的 dev/prod 分流
function logErr(tag, ...args) { console.error(`[${tag}]`, ...args) }

// 未捕获异常也走错误日志（dev 终端 / prod 文件）
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
  execSync(cmd, { stdio: 'pipe', timeout: 5000 });
}

// 通过 wsl.exe 读取文件内容（用于 WSL 路径）
function wslReadFile(filePath) {
  const parsed = parseWslPath(filePath);
  if (!parsed) throw new Error('无法解析 WSL 路径');
  const cmd = `wsl.exe -d ${parsed.distro} cat "${parsed.linuxPath}"`;
  return execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
}

// 判断是否为 WSL 路径
function isWslPath(filePath) {
  return /^\\\\wsl(?:\.localhost)?\\/i.test(filePath);
}

// 解析 .env 文件内容为键值对
function parseEnvFile(filePath) {
  const result = {};
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
    return;
  }

  // 只监控文件，如果 .env 是目录则跳过
  try {
    if (fs.existsSync(envPath) && fs.statSync(envPath).isDirectory()) {
      return;
    }
  } catch (e) {
    return;
  }

  const watcher = chokidar.watch(envPath, {
    persistent: true,
    ignoreInitial: true
  });

  watcher.on('change', () => {
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
    const info = getProjectInfo(projectDir);
    io.emit('env-changed', { projectId, ...info });
  });

  dirWatcher.on('unlink', () => {
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
  const expressApp = express();
  server = http.createServer(expressApp);
  io = new Server(server, { cors: { origin: '*' } });

  expressApp.use(cors());
  expressApp.use(express.json());
  // 请求日志：记录每个 API / 静态请求，方便排查前后端通信
  expressApp.use((req, res, next) => {
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
    socket.on('disconnect', () => {
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
      resolve(port);
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// 创建主窗口
async function createWindow() {
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
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 启动服务器
  const port = await startServer();

  // 加载前端页面
  const startUrl = `http://127.0.0.1:${port}`;
  mainWindow.loadURL(startUrl);

  // 开发模式下打开开发者工具
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// ---------------------------------------------------------------------------
// 自动更新（参考 easy-ops）
// 平台分流（关键）：
//   - Windows：electron-updater + GitHub Releases（NSIS 安装包，未签名也能正常走 Squirrel 流程）
//   - macOS ：自研更新器（见 initMacUpdater）。因为个人发布无 Apple 签名，electron-updater
//             依赖的 Squirrel.Mac 会在 checkForUpdates 时读取运行 App 的代码签名并抛出
//             「Could not get code signature for running application」，故完全绕开 electron-updater，
//             自行下载 GitHub Release 的 zip → ditto 解压 → 后台脚本替换 .app 并去 quarantine。
// 关键约束：更新检查完全由用户点击「检查更新」触发，不在应用启动时自动检查
// ---------------------------------------------------------------------------
function initAutoUpdater() {
  if (updaterInitialized) return; // 仅注册一次（mac 重新激活窗口会再次进入 createWindow）
  updaterInitialized = true;

  // 无论是否打包，先注册 app:get-info，供前端「App Info」关于弹窗展示应用信息
  ipcMain.handle('app:get-info', () => {
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

  // 打包环境：按平台分流选择更新器
  if (process.platform === 'darwin') {
    initMacUpdater();
  } else {
    initWinUpdater();
  }
}

// ==================== Windows：electron-updater（NSIS 流程，未签名可用） ====================
function initWinUpdater() {
  // 防御性加载 electron-updater，避免未正确打包时报错崩溃
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
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'bynow2code',
    repo: 'env-switch'
  });

  // 统一的事件转发：主进程 autoUpdater 事件 -> 渲染进程（update-event 通道）
  const send = (payload) => {
    if (mainWindow) mainWindow.webContents.send('update-event', payload);
  };

  autoUpdater.on('checking-for-update', () => {
    send({ type: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    send({ type: 'available', version: info.version, releaseNotes: info.releaseNotes || '' });
  });
  autoUpdater.on('update-not-available', (info) => {
    send({ type: 'not-available', version: info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    const percent = Math.round(p.percent || 0);
    send({ type: 'downloading', progress: percent });
  });
  autoUpdater.on('update-downloaded', (info) => {
    send({ type: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    const msg = (err && err.message) || String(err);
    console.error('[UPDATE] 事件: error:', msg);
    send({ type: 'error', message: msg });
  });

  // IPC：检查更新（带防重入 + 20s 超时兜底，避免国内网络访问 GitHub 挂起时前端永久卡住）
  ipcMain.handle('app:check-updates', async () => {
    if (isChecking) {
      return;
    }
    isChecking = true;
    const timeout = new Promise((_, reject) =>
      setTimeout(() => {
        console.warn('[UPDATE] 20s 超时触发：放弃等待 checkForUpdates（通常是网络连不上 GitHub）');
        reject(new Error('检查更新超时（可能网络无法访问 GitHub，请检查网络或代理）'));
      }, 20000)
    );
    try {
      const result = await Promise.race([autoUpdater.checkForUpdates(), timeout]);
    } catch (e) {
      console.error('[UPDATE] checkForUpdates 失败/超时:', e.message);
      send({ type: 'error', message: e.message });
    } finally {
      isChecking = false;
    }
  });

  ipcMain.handle('app:download-update', async () => {
    if (isDownloading) {
      return;
    }
    isDownloading = true;
    try {
      await autoUpdater.downloadUpdate();
    } catch (e) {
      console.error('[UPDATE] downloadUpdate 失败:', e.message);
      send({ type: 'error', message: e.message });
    } finally {
      isDownloading = false;
    }
  });

  ipcMain.handle('app:start-update', () => {
    try {
      // quitAndInstall(isSilent, isForceRunAfter) -> 先退出再强制安装并重启
      autoUpdater.quitAndInstall(false, true);
    } catch (e) {
      console.error('[UPDATE] quitAndInstall 失败:', e.message);
      send({ type: 'error', message: e.message });
    }
  });
}

// ==================== macOS：自研更新器（绕开签名 / Squirrel.Mac） ====================
// 参考 easy-ops：个人开发者无 Apple 签名，electron-updater 依赖的 Squirrel.Mac 会在
// checkForUpdates 时读取运行 App 的代码签名并抛出「Could not get code signature for running
// application」。故 macOS 完全绕开 electron-updater，自行下载 GitHub Release 的 zip，
// 解压后由后台脚本替换 /Applications 里的 .app 并去除 quarantine 标记，从而无需签名即可更新。
const GH_OWNER = 'bynow2code'
const GH_REPO = 'env-switch'

function initMacUpdater() {
  const https = require('https');
  const { spawn } = require('child_process');
  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-event', payload);
  };

  // 简单 semver 比较：a > b 返回 1，相等 0，a < b 返回 -1
  const cmpVersion = (a, b) => {
    const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  };

  // GET JSON（带 User-Agent，GitHub API 必需；自动跟随重定向）
  const httpsGetJson = (url) => new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'EnvSwitch', 'Accept': 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGetJson(res.headers.location).then(resolve, reject);
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('解析 GitHub 响应失败: ' + e.message)); }
      });
    });
    req.on('error', reject);
  });

  // 拉取最新 Release，返回 { version, releaseNotes, asset }
  const fetchLatestRelease = async () => {
    const json = await httpsGetJson(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`);
    const version = String(json.tag_name || '').replace(/^v/, '');
    const arch = process.arch; // 'arm64' | 'x64'
    const assets = Array.isArray(json.assets) ? json.assets : [];
    const asset = assets.find(a => typeof a.name === 'string' && a.name.endsWith(`-${arch}.zip`))
               || assets.find(a => typeof a.name === 'string' && a.name.endsWith('.zip'));
    return { version, releaseNotes: json.body || '', asset };
  };

  // 下载文件（带进度），保存到 destPath
  const downloadFile = (url, destPath, onProgress) => new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, { headers: { 'User-Agent': 'EnvSwitch' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(() => {});
        return downloadFile(res.headers.location, destPath, onProgress).then(resolve, reject);
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) onProgress(Math.round((received / total) * 100));
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    });
    req.on('error', (e) => { file.close(() => {}); reject(e); });
    file.on('error', (e) => { file.close(() => {}); reject(e); });
  });

  let pendingAsset = null;     // 检查到的新版本资产
  let pendingVersion = null;   // 新版本号
  let pendingAppPath = null;   // 下载解压后的新 .app 路径

  // IPC：检查更新（带 20s 超时兜底）
  ipcMain.handle('app:check-updates', async () => {
    if (isChecking) return;
    isChecking = true;
    send({ type: 'checking' });
    try {
      const rel = await Promise.race([
        fetchLatestRelease(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('检查更新超时（可能网络无法访问 GitHub）')), 20000))
      ]);
      const current = app.getVersion();
      if (!rel.version || cmpVersion(rel.version, current) <= 0) {
        send({ type: 'not-available', version: current });
      } else if (!rel.asset) {
        send({ type: 'error', message: `未找到匹配当前架构(${process.arch})的更新包` });
      } else {
        pendingAsset = rel.asset;
        pendingVersion = rel.version;
        send({ type: 'available', version: rel.version, releaseNotes: rel.releaseNotes });
      }
    } catch (e) {
      send({ type: 'error', message: e.message });
    } finally {
      isChecking = false;
    }
  });

  // IPC：下载更新
  ipcMain.handle('app:download-update', async () => {
    if (isDownloading) return;
    if (!pendingAsset) { send({ type: 'error', message: '没有可下载的更新（请先检查更新）' }); return; }
    isDownloading = true;
    try {
      const tmpDir = path.join(app.getPath('temp'), 'envswitch-update');
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      const zipPath = path.join(tmpDir, pendingAsset.name);
      await downloadFile(pendingAsset.browser_download_url, zipPath, (percent) => send({ type: 'downloading', progress: percent }));
      // 解压（macOS 内置 ditto，无需额外依赖）
      const extractDir = path.join(tmpDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      await new Promise((resolve, reject) => {
        const p = spawn('ditto', ['-x', '-k', zipPath, extractDir]);
        p.on('error', reject);
        p.on('close', (code) => code === 0 ? resolve() : reject(new Error('解压失败 (ditto exit ' + code + ')')));
      });
      const apps = fs.readdirSync(extractDir).filter(n => n.endsWith('.app'));
      if (apps.length === 0) throw new Error('更新包内未找到 .app');
      pendingAppPath = path.join(extractDir, apps[0]);
      send({ type: 'downloaded', version: pendingVersion });
    } catch (e) {
      send({ type: 'error', message: e.message });
    } finally {
      isDownloading = false;
    }
  });

  // IPC：退出并安装更新（后台脚本替换 .app 后重启）
  ipcMain.handle('app:start-update', () => {
    if (!pendingAppPath) { send({ type: 'error', message: '尚未下载更新' }); return; }
    try {
      const targetApp = path.resolve(process.execPath, '../../..'); // …/EnvSwitch.app
      const script = `#!/bin/bash
set -e
PID="${process.pid}"
NEW_APP="${pendingAppPath}"
TARGET_APP="${targetApp}"

for i in $(seq 1 60); do
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 0.5
done
sleep 0.5

if rm -rf "$TARGET_APP" 2>/dev/null && ditto "$NEW_APP" "$TARGET_APP" 2>/dev/null; then
  :
else
  osascript -e "do shell script \\"rm -rf '$TARGET_APP' && ditto '$NEW_APP' '$TARGET_APP'\\" with administrator privileges"
fi

xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true
open "$TARGET_APP"
`;
      const scriptPath = path.join(app.getPath('temp'), 'envswitch-update', 'install.sh');
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, script, { mode: 0o755 });
      spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
    } catch (e) {
      send({ type: 'error', message: e.message });
    }
  });
}

// 单实例锁（参考 easy-ops「防止串台」）：保证同一时间只有一个 EnvSwitch 在运行，
// 第二个启动实例会聚焦已有窗口，而不是再起一个后端/窗口与之争抢资源。
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 没拿到锁说明已有实例在运行，当前（第二个）实例直接退出
  app.quit();
} else {
  // 第二个实例尝试启动时：只聚焦已有窗口，不重复创建
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 当 Electron 准备好时创建窗口
  app.whenReady().then(() => {
    createWindow();

    // 窗口建好后再初始化自动更新（事件转发依赖 mainWindow）
    initAutoUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

// 当所有窗口关闭时退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出时清理
app.on('before-quit', () => {
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
