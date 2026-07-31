const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const chokidar = require('chokidar');
const { execSync } = require('child_process');
const crypto = require('crypto');

// 先固定「真实的」userData 路径：下方开发模式会把 userData 重定向到临时缓存目录以解决
// Chromium 缓存写权限问题，但日志目录与项目数据（data.json）需落在原始 userData 下，故先捕获。
// 放在最顶部，确保日志工具定义时即可引用（日志目录在开发模式重定向之前就已锁定）。
const REAL_USER_DATA = app.getPath('userData');

// 日志策略（对齐 easy-ops）：log() 同时输出到控制台（[Main] 前缀、无时间戳）
// 与程序日志文件（userData/logs/main.log、带 ISO 时间戳）。开发模式与打包模式行为一致，
// 不做静默——只要调用 log()，控制台和文件都会记录，便于排查问题。
// 注：日志目录用真实 userData 固定（开发模式会把 userData 重定向到临时缓存目录，
// 但日志需落在原始 userData 下），故写入 REAL_USER_DATA/logs/main.log。

// 安全格式化：字符串原样，Error 取 stack，对象转 JSON（循环引用降级为 String）
const fmtLog = (args) => args.map(a => {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || a.message
  try { return JSON.stringify(a) } catch (e) { return String(a) }
}).join(' ')

// 主日志函数（对齐 easy-ops，使用 function 声明以获得 hoisting，确保早期异常回调也能安全调用）：
// 控制台打印 `[Main] <message>`，同时追加 `[<ISO时间戳>] <message>` 到 userData/logs/main.log
function log(message) {
  console.log(`[Main] ${message}`)
  try {
    const logDir = path.join(REAL_USER_DATA, 'logs')
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(path.join(logDir, 'main.log'), `[${new Date().toISOString()}] ${message}\n`)
  } catch (e) { /* 日志写入失败不阻塞主流程 */ }
}

// 错误日志便捷方法：带模块前缀（如 [FATAL]/[SERVER]），最终同样走 log() 的双写通道
function logErr(tag, ...args) { log(`[${tag}] ${fmtLog(args)}`) }

// 崩溃兜底（对齐 easy-ops 的 showFatal 机制）：未捕获异常 / 未处理拒绝时，
// 既写日志（[FATAL]）又弹系统错误框，让用户看到崩溃原因而非静默闪退。

// 致命错误统一处理：写日志 + 弹系统错误框，弹窗内附带日志路径方便用户自查。
// 使用 function 声明（而非 const 箭头）以获得 hoisting，确保早期异常回调也能安全调用，
// 避免 TDZ 导致「Cannot access 'showFatal' before initialization」崩溃（与 log() 同理）。
function showFatal(title, detail) {
  logErr('FATAL', `${title}: ${detail}`)
  let logPathHint = ''
  try {
    // 日志实际落在 REAL_USER_DATA 下（dev 模式 userData 被重定向到临时目录，日志不受影响）
    logPathHint = `\n\n日志已保存，可查看详情：\n${path.join(REAL_USER_DATA, 'logs', 'main.log')}`
  } catch (e) {
    logPathHint = '\n\n（无法定位日志目录，请检查应用数据目录下的 logs/main.log）'
  }
  try {
    dialog.showErrorBox(`EnvSwitch 启动失败 - ${title}`, `${detail}${logPathHint}`)
  } catch (e) {}
}

// 判断是否为「更新器专属」错误：这类错误已在更新弹窗（update modal）中向用户展示，
// 此处过滤掉，避免 unhandledRejection 又弹一次致命错误框造成重复打扰。
// 关键约束（对齐 easy-ops）：正则只匹配「更新器特有的、具体」的签名，
// 绝不能匹配 update / release 这类泛词——否则 "failed to update cache"、
// "release the port" 等普通崩溃也会被误吞，真实闪退被静默掩盖，反而更难排查。
function isUpdateRelatedError(reason) {
  const msg = (reason && reason.message) || String(reason)
  return /Cannot download|net::|ERR_UPDATER|Update check failed|electron-updater|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|status\s*\d{3}/i.test(msg)
}

process.on('uncaughtException', (err) => {
  showFatal('Uncaught Exception', err && err.stack ? err.stack : String(err))
})
process.on('unhandledRejection', (reason) => {
  // 更新类 rejection 已被更新弹窗覆盖，只记日志不弹窗，避免重复打扰
  if (isUpdateRelatedError(reason)) {
    logErr('UPDATE-REJECTION', reason)
    return
  }
  showFatal('Unhandled Promise Rejection', reason && reason.stack ? reason.stack : String(reason))
})

// 开发模式：将 Chromium 缓存（HTTP 磁盘缓存 + GPU 缓存）重定向到用户临时目录下可写目录，
// 规避 Windows 上默认 userData 缓存目录出现「拒绝访问 (0x5) / Unable to move the cache /
// Gpu Cache Creation failed」等无害噪声日志。仅开发模式生效；打包后沿用默认 userData，数据落点不变。
if (!app.isPackaged) {
  const devCacheDir = path.join(app.getPath('temp'), 'envswitch-dev-cache');
  try {
    fs.mkdirSync(devCacheDir, { recursive: true });
    app.setPath('userData', devCacheDir); // 缓存随之落到临时目录，GPU 缓存也一并解决
    log(`[MAIN] 开发模式：重定向 Chromium 缓存到 ${devCacheDir}`);
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
    log(`[SERVER] 加载数据失败: ${e.message}`);
  }
  return { projects: [] };
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log(`[SERVER] 保存数据失败: ${e.message}`);
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
  log(`[WSL] copy ${sourcePath} -> ${targetPath}`);
  execSync(cmd, { stdio: 'pipe', timeout: 5000 });
}

// 通过 wsl.exe 读取文件内容（用于 WSL 路径）
function wslReadFile(filePath) {
  const parsed = parseWslPath(filePath);
  if (!parsed) throw new Error('无法解析 WSL 路径');
  const cmd = `wsl.exe -d ${parsed.distro} cat "${parsed.linuxPath}"`;
  log(`[WSL] read ${filePath}`);
  return execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
}

// 判断是否为 WSL 路径
function isWslPath(filePath) {
  return /^\\\\wsl(?:\.localhost)?\\/i.test(filePath);
}

// 读取文件原始内容（兼容 WSL 路径），读不到返回空串
function readRawFile(fp) {
  try {
    if (isWslPath(fp)) return wslReadFile(fp)
    return fs.readFileSync(fp, 'utf-8')
  } catch (e) {
    return ''
  }
}

// 反推「当前激活的是哪个 .env.xxx」：直接比对 .env 与各 .env.xxx 的文件内容（md5）。
// 切换时 .env 是 .env.xxx 的逐字节拷贝，故能精确命中；
// 若用户手动改过 .env 而不匹配任何文件，则视为「未关联」，UI 不高亮任何行。
// 返回文件名（如 .env.dev），无匹配时返回空串。
function getActiveEnvFile(projectDir, envFiles) {
  if (!envFiles || envFiles.length === 0) return ''
  const envHash = crypto.createHash('md5').update(readRawFile(path.join(projectDir, '.env'))).digest('hex')
  if (!envHash) return '' // .env 不存在或读不到
  for (const f of envFiles) {
    const h = crypto.createHash('md5').update(readRawFile(path.join(projectDir, f))).digest('hex')
    if (h && h === envHash) return f
  }
  return ''
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
      log(`[FILE] 解析 ${filePath}`);
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
    log(`[FILE] Error parsing ${filePath}: ${e.message}`);
  }
  return result;
}

// 获取项目信息
// 当前在用配置：严格用 md5 实时比对 .env 与各 .env.xxx 判定（见下方实现）。
// 不读 data.json 的"上次选择"做兜底——否则当用户手动改 .env 使其与所有源文件都不一致时，
// 仍会被旧记录强行标成「使用中」，造成"内容不一样却显示使用中"的假阳性。
// 切换/重新套用按钮在每行常驻，用户可随时重新套用，故无需该兜底。
function getProjectInfo(projectDir) {
  const envPath = path.join(projectDir, '.env');
  const envVars = parseEnvFile(envPath);
  log(`[PROJECT] 读取项目信息 ${projectDir}`);

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
        if (file.startsWith('.env.') && file !== '.env.example') {
          envFiles.push(file);
        }
      }
    }
  } catch (e) {
    log(`[PROJECT] 获取项目信息失败: ${e.message}`);
  }

  // 当前在用配置：严格用 md5 实时比对 .env 与各 .env.xxx 的原始内容判定。
  // 切换时 .env 是源文件的逐字节拷贝（本地 readFileSync→writeFileSync / WSL wsl.exe cp），
  // 故 md5 完全一致才能命中；
  // 一旦 .env 与所有 .env.xxx 都不一致（手动改过 .env、或源文件被外部改动），
  // 则返回空串、不高亮任何行——这是真实状态，保持诚实。
  // 注意：不回退到 data.json 的"上次选择"，否则会制造"内容不一样却显示使用中"的假阳性。
  const activeEnvFile = getActiveEnvFile(projectDir, envFiles);

  return {
    appName: envVars['APP_NAME'] || '',
    appEnv: envVars['APP_ENV'] || '',
    allEnvVars: envVars,
    envFiles,
    // 当前在用配置：md5 实时比对优先，失配时回退持久化选择（前端用于高亮 + 标记"使用中"）
    activeEnvFile
  };
}

// 设置文件监控
// WSL 路径兜底：chokidar 无法可靠监听 Linux 文件系统（Electron 主进程跑在 Windows 侧，
// 经 \\wsl.localhost 挂载监听不可靠），故改用「定时轮询 + md5 快照比对」：
//   - 通过 wsl.exe 列举 .env 与所有 .env.*（排除 .env.example），用 readRawFile 读内容算 md5；
//   - 与上次快照比对，任一文件新增/删除/内容变更都推 env-changed 让前端刷新
//     （含 md5 实时重算「使用中」高亮）。
// 封装成带 close() 的对象存入 watchers，复用现有清理逻辑（删项目 / before-quit）。
// WSL 定时轮询间隔（毫秒），可由「设置」调整；默认值 5000（比 3000 省约 40% 的 wsl.exe 调用、感知延迟仍无感、转圈更舒缓），合法范围 [500, 600000]。
// 启动即从 data.json 读取已保存值（若存在且合法），否则用默认。运行时保存设置会更新此变量，
// 并已运行中的 WSL 轮询器会被重建以套用新间隔（见 PUT /api/settings）。
let wslPollInterval = 5000;
try {
  const _initData = loadData();
  if (typeof _initData.wslPollInterval === 'number' && _initData.wslPollInterval >= 500 && _initData.wslPollInterval <= 600000) {
    wslPollInterval = Math.floor(_initData.wslPollInterval);
  }
} catch (_e) {}

function setupWslPoller(projectId, projectDir) {
  const parsed = parseWslPath(projectDir);
  if (!parsed) {
    log(`[WATCHER] WSL 路径解析失败，跳过轮询 ${projectDir}`);
    return;
  }
  log(`[WATCHER] WSL 路径，改用定时轮询（${wslPollInterval}ms）${projectDir}`);

  // 采集当前快照：{ 文件名: md5 }（含 .env 与所有 .env.xxx，排除 .env.example）
  // 文件不存在/读不到时记为 '__missing__'，便于检测「被删除」与内容变更区分。
  function snapshot() {
    const map = {};
    // 复用与 getProjectInfo 一致的列举方式（wsl.exe + ls）
    const cmd = `wsl.exe -d ${parsed.distro} sh -c "ls -1a ${parsed.linuxPath}/.env.* 2>/dev/null || true"`;
    let files = [];
    try {
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (output) {
        files = output.split('\n')
          .map(f => f.trim().split('/').pop())
          .filter(f => f && f.startsWith('.env.') && f !== '.env.example');
      }
    } catch (e) {
      // 列举失败：保持空列表，下一轮重试
    }
    // 候选 = .env 本体 + 各 .env.xxx
    const candidates = ['.env', ...files];
    for (const f of candidates) {
      const content = readRawFile(path.join(projectDir, f)); // readRawFile 兼容 WSL 路径
      map[f] = content === '' ? '__missing__' : crypto.createHash('md5').update(content).digest('hex');
    }
    return map;
  }

  let prev = null;
  let stopped = false;

  // 本轮轮询检查结束：通知前端该卡片停转圈。
  // 延迟 500ms 才 emit，保证旋转动画在界面上可见（实际检查是同步 execSync，耗时极短，
  // 若不延迟前端几乎看不到转圈）；用 setTimeout 非阻塞，并在回调内检查 stopped，
  // 避免项目已被删 / watcher 已关闭后仍向前端发事件。
  function endCheck() {
    if (!io) return;
    // 注意：此处刻意不检查 stopped。原因——若本 poller 在「已 emit env-checking、尚未 emit env-checked」
    // 期间被外部重建（例如用户在「设置」里改了 WSL 间隔，PUT /api/settings 会 close 旧 poller 再新建），
    // 旧的 stopped 会被置 true，从而把这次 env-checked 吞掉，前端 wslChecking[id] 永久为 true → 卡片卡在转圈。
    // 因此无论如何都把 env-checked 发出来让前端停转圈；多 emit 一次（项目已删 / 已被新 poller 接管）对前端无害（只是置 false）。
    setTimeout(() => {
      io.emit('env-checked', { projectId });
    }, 500);
  }

  const timer = setInterval(() => {
    if (stopped) return;
    // 通知前端：本 WSL 项目开始本轮轮询检查（对应卡片刷新按钮转圈）
    if (io) io.emit('env-checking', { projectId });
    let snap;
    try {
      snap = snapshot();
    } catch (e) {
      log(`[WATCHER] WSL 轮询失败 ${projectDir}: ${e.message}`);
      endCheck(); // 异常也结束检查态（前端停转圈）
      return; // 轮询异常不影响下次；保留 prev，避免误判为「变更」
    }
    if (prev === null) { prev = snap; endCheck(); return; } // 首轮仅建立基线，不触发变更，但结束检查态
    // 比对：文件集合变化 或 任一 md5 变化（含缺失标记变化）
    const keysA = Object.keys(prev).sort().join(',');
    const keysB = Object.keys(snap).sort().join(',');
    let changed = keysA !== keysB;
    if (!changed) {
      for (const k of Object.keys(snap)) {
        if (prev[k] !== snap[k]) { changed = true; break; }
      }
    }
    if (changed) {
      prev = snap;
      log(`[WATCHER] WSL env 变更（轮询）${projectId}`);
      const info = getProjectInfo(projectDir);
      io.emit('env-changed', { projectId, ...info });
    }
    endCheck(); // 无论是否变更，本轮检查结束 → 前端停转圈
  }, wslPollInterval);

  // 封装成带 close() 的对象，复用现有 watchers 清理逻辑（before-quit / 删项目）
  watchers.set(projectId, {
    _isWsl: true,
    close() { stopped = true; clearInterval(timer); }
  });
}

function setupWatcher(projectId, projectDir) {
  log(`[WATCHER] 设置监控 projectId=${projectId} ${projectDir}`);
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

  // WSL 路径：chokidar 无法可靠监听 Linux 文件系统（Electron 跑在 Windows 侧），
  // 改用定时轮询兜底（见 setupWslPoller）。
  if (isWslPath(projectDir)) {
    setupWslPoller(projectId, projectDir);
    return;
  }

  // 只监控文件，如果 .env 是目录则跳过
  try {
    if (fs.existsSync(envPath) && fs.statSync(envPath).isDirectory()) {
      log(`[WATCHER] envPath 是目录，跳过 ${envPath}`);
      return;
    }
  } catch (e) {
    log(`[WATCHER] 无法访问 envPath，跳过 ${envPath}: ${e.message}`);
    return;
  }

  const watcher = chokidar.watch(envPath, {
    persistent: true,
    ignoreInitial: true
  });

  watcher.on('change', () => {
    log(`[WATCHER] env 变更 (change) ${projectId}`);
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
    log(`[WATCHER] env 文件新增 (add) ${projectId}`);
    const info = getProjectInfo(projectDir);
    io.emit('env-changed', { projectId, ...info });
  });

  dirWatcher.on('unlink', () => {
    log(`[WATCHER] env 文件删除 (unlink) ${projectId}`);
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
  log('[SERVER] 启动 Express 服务器 …');
  const expressApp = express();
  server = http.createServer(expressApp);
  io = new Server(server, { cors: { origin: '*' } });

  expressApp.use(cors());
  expressApp.use(express.json());
  // 请求日志：记录每个 API / 静态请求，方便排查前后端通信
  expressApp.use((req, res, next) => {
    log(`[SERVER] ${req.method} ${req.url}`);
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
        envFiles: info.envFiles,
        activeEnvFile: info.activeEnvFile
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
      envFiles: info.envFiles,
      activeEnvFile: info.activeEnvFile
    });
  });

  // 设置 —— 读取当前配置（目前仅 WSL 轮询间隔，后续可扩展更多项）
  expressApp.get('/api/settings', (req, res) => {
    res.json({ wslPollInterval });
  });

  // 设置 —— 更新 WSL 轮询间隔并即时生效
  // 校验：必须是 500–600000 之间的整数（毫秒）；过短会频繁 wsl.exe 调用拖累性能，过长则变更感知延迟。
  expressApp.put('/api/settings', (req, res) => {
    const raw = req.body && req.body.wslPollInterval;
    const val = Number(raw);
    if (!Number.isFinite(val) || !Number.isInteger(val) || val < 500 || val > 600000) {
      return res.status(400).json({ error: 'Interval must be an integer between 500 and 600000 ms.' });
    }
    const data = loadData();
    data.wslPollInterval = val;
    saveData(data);
    wslPollInterval = val; // 更新运行中变量：后续新建的轮询器立即用新值
    // 重建所有 WSL 项目的轮询器，使新间隔立即生效（setupWatcher 会先关闭旧的再建新的）
    for (const p of data.projects) {
      if (isWslPath(p.dir)) {
        try { setupWatcher(p.id, p.dir); } catch (e) { log(`[SERVER] 重启 WSL 轮询失败 ${p.id}: ${e.message}`); }
      }
    }
    log(`[SERVER] WSL 轮询间隔已更新为 ${val}ms`);
    res.json({ wslPollInterval: val });
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
    log(`[SERVER] 项目已添加 ${project.id} ${normalizedDir}`);
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
      envFiles: info.envFiles,
      activeEnvFile: info.activeEnvFile
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

      // 「当前选中配置」以 md5 实时比对为准（见 getProjectInfo），不再持久化到 data.json，
      // 避免手动改 .env 后旧记录仍被强行标成「使用中」。

      const info = getProjectInfo(project.dir);
      io.emit('env-changed', { projectId: project.id, ...info });
      log(`[SERVER] 环境切换成功 ${project.id} -> ${envFileName}`);
      res.json({
        success: true,
        projectId: project.id,
        appName: info.appName,
        appEnv: info.appEnv,
        envFiles: info.envFiles,
        activeEnvFile: info.activeEnvFile
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
    log('[SOCKET] Client connected');
    socket.on('disconnect', () => {
      log('[SOCKET] Client disconnected');
    });
  });

  // 启动时恢复所有 watcher
  const data = loadData();
  data.projects.forEach(p => {
    try {
      setupWatcher(p.id, p.dir);
    } catch (e) {
      log(`[WATCHER] 恢复监控失败 ${p.dir}: ${e.message}`);
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
      log(`[SERVER] Server running on http://127.0.0.1:${port} (系统分配端口)`);
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// 创建主窗口
async function createWindow() {
  log('[MAIN] 创建主窗口 …');
  mainWindow = new BrowserWindow({
    // 窗口默认尺寸：根据 1080p/2K 显示器实测反推——之前默认 1200×800 在宽屏上
    // 居中放置后，窗口外侧两侧大片桌面背景，截图看起来像"窗口两边大量空白"。
    // 改大到 1500×900：CSS 的 .app width:100% + .project-list grid auto-fill
    // 会自动在更大空间里铺满（grid 实际本来就铺满窗口，问题只是窗口本身偏小）。
    width: 1200,
    height: 720,
    minWidth: 900,
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
    log(`[MAIN] 外部链接交由系统默认浏览器打开: ${url}`);
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
  log(`[MAIN] 加载前端 ${startUrl}`);

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
    log('[IPC] get-info');
    return {
      version: app.getVersion(),          // 应用版本（取 package.json 的 version）
      isDev: !app.isPackaged,             // 是否开发模式（反向即是否打包）
      dataFilePath: DATA_FILE,            // 项目数据文件 data.json 完整路径
      logFilePath: path.join(REAL_USER_DATA, 'logs', 'main.log'), // 主进程日志路径
      repoUrl: 'https://github.com/bynow2code/env-switch' // 源码仓库地址
    }
  });

  // 调起系统文件夹选择器（添加项目弹窗的「浏览…」按钮）：返回选中的目录绝对路径，用户取消返回 null。
  // 必须用 mainWindow 作为 parent，否则在部分系统上对话框会失去焦点 / 无模态。
  ipcMain.handle('app:select-folder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择项目根目录',
      properties: ['openDirectory', 'createDirectory'] // 仅选文件夹，且允许在对话框里新建目录
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  });

  // 开发模式（未打包）：不连 GitHub，注册桩 handler，让前端走「dev mode」提示分支
  if (!app.isPackaged) {
    log('[UPDATE] 开发模式：跳过真实更新检查（打包后才会真正连 GitHub）');
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
    log(`[UPDATE] electron-updater 不可用: ${e.message}`);
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
  log('[UPDATE] feedURL 已设置: provider=github, owner=bynow2code, repo=env-switch');

  // 统一的事件转发：主进程 autoUpdater 事件 -> 渲染进程（update-event 通道）
  const send = (payload) => {
    if (mainWindow) mainWindow.webContents.send('update-event', payload);
  };

  autoUpdater.on('checking-for-update', () => {
    log('[UPDATE] 事件: checking-for-update（开始连接更新源）');
    send({ type: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    log(`[UPDATE] 事件: update-available, version = ${info && info.version}`);
    send({ type: 'available', version: info.version, releaseNotes: info.releaseNotes || '' });
  });
  autoUpdater.on('update-not-available', (info) => {
    log(`[UPDATE] 事件: update-not-available, version = ${info && info.version}`);
    send({ type: 'not-available', version: info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    const percent = Math.round(p.percent || 0);
    log(`[UPDATE] 事件: download-progress ${percent}%`);
    send({ type: 'downloading', progress: percent });
  });
  autoUpdater.on('update-downloaded', (info) => {
    log(`[UPDATE] 事件: update-downloaded, version = ${info && info.version}`);
    send({ type: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    const msg = (err && err.message) || String(err);
    log(`[UPDATE] 事件: error: ${msg}`);
    send({ type: 'error', message: msg });
  });

  // IPC：检查更新（带防重入 + 20s 超时兜底，避免国内网络访问 GitHub 挂起时前端永久卡住）
  ipcMain.handle('app:check-updates', async () => {
    if (isChecking) {
      log('[UPDATE] checkForUpdates 忽略 - 正在检查中');
      return;
    }
    isChecking = true;
    log('[UPDATE] 开始 checkForUpdates() …（最多等待 20s）');
    const timeout = new Promise((_, reject) =>
      setTimeout(() => {
        log('[UPDATE] 20s 超时触发：放弃等待 checkForUpdates（通常是网络连不上 GitHub）');
        reject(new Error('检查更新超时（可能网络无法访问 GitHub，请检查网络或代理）'));
      }, 20000)
    );
    try {
      const result = await Promise.race([autoUpdater.checkForUpdates(), timeout]);
      log(`[UPDATE] checkForUpdates 正常返回: ${result ? '有结果（见后续事件）' : result}`);
    } catch (e) {
    log(`[UPDATE] checkForUpdates 失败/超时: ${e.message}`);
      send({ type: 'error', message: e.message });
    } finally {
      isChecking = false;
      log('[UPDATE] checkForUpdates 流程结束 (isChecking=false)');
    }
  });

  ipcMain.handle('app:download-update', async () => {
    if (isDownloading) {
      log('[UPDATE] downloadUpdate 忽略 - 正在下载中');
      return;
    }
    isDownloading = true;
    log('[UPDATE] download-update 开始');
    try {
      await autoUpdater.downloadUpdate();
      log('[UPDATE] download-update 完成');
    } catch (e) {
    log(`[UPDATE] downloadUpdate 失败: ${e.message}`);
      send({ type: 'error', message: e.message });
    } finally {
      isDownloading = false;
    }
  });

  ipcMain.handle('app:start-update', () => {
    try {
      // quitAndInstall(isSilent, isForceRunAfter) -> 先退出再强制安装并重启
      log('[UPDATE] start-update 开始 (quitAndInstall)');
      autoUpdater.quitAndInstall(false, true);
    } catch (e) {
    log(`[UPDATE] quitAndInstall 失败: ${e.message}`);
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
    if (isChecking) { log('[UPDATE-MAC] check-updates 忽略 - 正在检查中'); return; }
    isChecking = true;
    log('[UPDATE-MAC] check-updates 开始 …');
    send({ type: 'checking' });
    try {
      const rel = await Promise.race([
        fetchLatestRelease(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('检查更新超时（可能网络无法访问 GitHub）')), 20000))
      ]);
      const current = app.getVersion();
      if (!rel.version || cmpVersion(rel.version, current) <= 0) {
        log(`[UPDATE-MAC] 已是最新版本 ${current}`);
        send({ type: 'not-available', version: current });
      } else if (!rel.asset) {
        log(`[UPDATE-MAC] 找到新版本 ${rel.version}，但未匹配架构(${process.arch})的更新包`);
        send({ type: 'error', message: `未找到匹配当前架构(${process.arch})的更新包` });
      } else {
        pendingAsset = rel.asset;
        pendingVersion = rel.version;
        log(`[UPDATE-MAC] 发现新版本 ${rel.version}（asset: ${rel.asset.name}）`);
        send({ type: 'available', version: rel.version, releaseNotes: rel.releaseNotes });
      }
    } catch (e) {
      log(`[UPDATE-MAC] check-updates 失败: ${e.message}`);
      send({ type: 'error', message: e.message });
    } finally {
      isChecking = false;
      log('[UPDATE-MAC] check-updates 流程结束');
    }
  });

  // IPC：下载更新
  ipcMain.handle('app:download-update', async () => {
    if (isDownloading) return;
    if (!pendingAsset) { log('[UPDATE-MAC] download-update 忽略 - 无待下载更新'); send({ type: 'error', message: '没有可下载的更新（请先检查更新）' }); return; }
    isDownloading = true;
    log(`[UPDATE-MAC] download-update 开始（${pendingAsset.name}）`);
    try {
      const tmpDir = path.join(app.getPath('temp'), 'envswitch-update');
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      const zipPath = path.join(tmpDir, pendingAsset.name);
      await downloadFile(pendingAsset.browser_download_url, zipPath, (percent) => { log(`[UPDATE-MAC] 下载进度 ${percent}%`); send({ type: 'downloading', progress: percent }); });
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
      log(`[UPDATE-MAC] 下载并解压完成，新 .app: ${pendingAppPath}`);
      send({ type: 'downloaded', version: pendingVersion });
    } catch (e) {
      log(`[UPDATE-MAC] download-update 失败: ${e.message}`);
      send({ type: 'error', message: e.message });
    } finally {
      isDownloading = false;
    }
  });

  // IPC：退出并安装更新（后台脚本替换 .app 后重启）
  ipcMain.handle('app:start-update', () => {
    if (!pendingAppPath) { log('[UPDATE-MAC] start-update 忽略 - 尚未下载更新'); send({ type: 'error', message: '尚未下载更新' }); return; }
    try {
      const targetApp = path.resolve(process.execPath, '../../..'); // …/EnvSwitch.app
      log(`[UPDATE-MAC] start-update 开始（替换 ${targetApp}，重启后生效）`);
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
      log(`[UPDATE-MAC] 后台安装脚本已写入 ${scriptPath}，即将退出并交由脚本替换 .app`);
      spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
    } catch (e) {
      log(`[UPDATE-MAC] start-update 失败: ${e.message}`);
      send({ type: 'error', message: e.message });
    }
  });
}

// 单实例锁（参考 easy-ops「防止串台」）：保证同一时间只有一个 EnvSwitch 在运行，
// 第二个启动实例会聚焦已有窗口，而不是再起一个后端/窗口与之争抢资源。
const gotTheLock = app.requestSingleInstanceLock();
log(`[MAIN] requestSingleInstanceLock -> ${gotTheLock ? '主实例' : '次实例(将退出)'}`);

if (!gotTheLock) {
  // 没拿到锁说明已有实例在运行，当前（第二个）实例直接退出
  app.quit();
  log('[MAIN] 已有实例在运行，当前实例退出');
} else {
  // 第二个实例尝试启动时：只聚焦已有窗口，不重复创建
  app.on('second-instance', () => {
    log('[MAIN] second-instance：聚焦已有窗口');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 当 Electron 准备好时创建窗口
  app.whenReady().then(() => {
    log(`[MAIN] === EnvSwitch 启动 (isPackaged=${app.isPackaged}) ===`);
    createWindow();
    log('[MAIN] app ready，创建窗口');

    // 窗口建好后再初始化自动更新（事件转发依赖 mainWindow）
    initAutoUpdater();

    app.on('activate', () => {
      log('[MAIN] activate：重建窗口');
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

// 当所有窗口关闭时退出应用
app.on('window-all-closed', () => {
  log('[MAIN] 所有窗口关闭');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出时清理
app.on('before-quit', () => {
  log('[MAIN] before-quit：关闭 server 与 watchers');
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
