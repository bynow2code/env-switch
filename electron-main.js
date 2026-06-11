const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const chokidar = require('chokidar');
const { execSync } = require('child_process');

let mainWindow;
let server;
let io;
const watchers = new Map();

// 获取应用数据目录
const getAppDataPath = () => {
  return app.getPath('userData');
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
    console.log(`[INFO] WSL 路径 ${projectDir}，跳过文件监控`);
    return;
  }

  // 只监控文件，如果 .env 是目录则跳过
  try {
    if (fs.existsSync(envPath) && fs.statSync(envPath).isDirectory()) {
      console.log(`[WARN] ${envPath} 是一个目录，跳过文件监控`);
      return;
    }
  } catch (e) {
    console.log(`[WARN] 无法访问 ${envPath}，跳过文件监控`);
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
    console.error(`[WARN] 监控错误 ${projectDir}:`, err.message);
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
    console.error(`[WARN] 目录监控错误 ${projectDir}:`, err.message);
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

  // 静态文件服务
  const clientDist = path.join(__dirname, 'public');
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
    console.log('Client connected');
    socket.on('disconnect', () => {
      console.log('Client disconnected');
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

  // port.txt 方案：动态分配端口
  const PORT_FILE = path.join(__dirname, 'public', 'port.txt');
  const START_PORT = 3001;

  function isPortFree(port) {
    return new Promise((resolve) => {
      const tester = require('net').createServer();
      tester.once('error', (err) => {
        if (err.code === 'EADDRINUSE') resolve(false);
        else resolve(false);
      });
      tester.once('listening', () => {
        tester.close();
        resolve(true);
      });
      tester.listen(port, '127.0.0.1');
    });
  }

  async function findAvailablePort() {
    // 优先读取 port.txt 中的端口
    let savedPort = null;
    try {
      if (fs.existsSync(PORT_FILE)) {
        savedPort = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
      }
    } catch (e) { /* ignore */ }

    if (savedPort && savedPort >= 1024 && savedPort <= 65535) {
      if (await isPortFree(savedPort)) {
        console.log(`[PORT] 使用保存的端口: ${savedPort}`);
        return savedPort;
      }
      console.log(`[PORT] 保存的端口 ${savedPort} 已被占用，重新分配`);
    }

    // 从 3001 开始找一个可用端口
    let port = START_PORT;
    while (port < 3200) {
      if (await isPortFree(port)) {
        console.log(`[PORT] 找到可用端口: ${port}`);
        return port;
      }
      port++;
    }
    return START_PORT;
  }

  const chosenPort = await findAvailablePort();

  return new Promise((resolve, reject) => {
    server.listen(chosenPort, '127.0.0.1', () => {
      // 写入 port.txt
      try {
        const portDir = path.dirname(PORT_FILE);
        if (!fs.existsSync(portDir)) fs.mkdirSync(portDir, { recursive: true });
        fs.writeFileSync(PORT_FILE, String(chosenPort));
        console.log(`Server running on http://127.0.0.1:${chosenPort}`);
      } catch (e) {
        console.log(`[PORT] 写入 port.txt 失败:`, e.message);
      }
      resolve(chosenPort);
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
      contextIsolation: true
    },
    icon: path.join(__dirname, 'public', 'icon.ico')
  });

  // 隐藏菜单栏
  Menu.setApplicationMenu(null);

  // 启动服务器
  const port = await startServer();

  // 加载前端页面
  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  // 开发模式下打开开发者工具
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// 当 Electron 准备好时创建窗口
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

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
