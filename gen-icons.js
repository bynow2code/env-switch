// 从 client/public/favicon.svg 渲染生成「打包用 logo」（参考 easy-ops）
//   client/public/logo-1024.png  -> 默认图标（build.icon），electron-builder 自动转 icns 等
//   client/public/logo-win.png   -> 运行时窗口图标（electron-main.js 加载 public/logo-win.png）
//   client/public/logo-mac.png   -> macOS 图标（build.mac.icon）
//   client/public/logo.ico       -> Windows 图标（build.win.icon + NSIS 安装/卸载程序图标）
//
// 注意：根 public/ 是 Vite 构建输出目录（vite.config.js 的 outDir: '../public'），
//       本脚本产出的文件会在 npm run build 时由 Vite 从 client/public 拷贝到 public/，无需手动生成。

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
// png-to-ico 是 ES module 默认导出，CommonJS 环境下取 .default
const pngToIco = require('png-to-ico').default;

// client/public 是打包资源的源目录（与 easy-ops 保持一致）
const clientPublic = path.join(__dirname, 'client', 'public');
// 真正的 logo 源文件：EnvSwitch 自己的 favicon.svg（"Env" 字样）
const svgPath = path.join(clientPublic, 'favicon.svg');

// 从 favicon.svg 直接渲染指定尺寸的 PNG（高清母版，清晰）
async function renderPngBuffer(size) {
  return sharp(fs.readFileSync(svgPath))
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

async function main() {
  if (!fs.existsSync(svgPath)) {
    console.error('找不到 SVG:', svgPath);
    process.exit(1);
  }

  // 母版统一 1024x1024，各平台共用同一张高清图（electron-builder 会按需缩放 / 转换格式）
  fs.writeFileSync(path.join(clientPublic, 'logo-1024.png'), await renderPngBuffer(1024));

  // Windows 运行时窗口图标：256x256 足够清晰，也避免窗口加载过大 PNG
  fs.writeFileSync(path.join(clientPublic, 'logo-win.png'), await renderPngBuffer(256));

  // macOS 图标：1024x1024，electron-builder 会据此生成 icns
  fs.writeFileSync(path.join(clientPublic, 'logo-mac.png'), await renderPngBuffer(1024));

  // Windows ICO：NSIS 安装程序、卸载程序、EXE 自身图标都需要多尺寸 ICO。
  // 先生成各尺寸临时 PNG（放在系统临时目录，避免污染项目），再调用 png-to-ico 合成，最后尽量清理。
  const icoSizes = [256, 128, 64, 48, 32, 16];
  const tmpDir = path.join(os.tmpdir(), `envswitch-gen-icons-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPaths = [];
  for (const size of icoSizes) {
    const tmpPath = path.join(tmpDir, `logo-${size}.png`);
    fs.writeFileSync(tmpPath, await renderPngBuffer(size));
    tmpPaths.push(tmpPath);
  }
  const icoBuffer = await pngToIco(tmpPaths);
  fs.writeFileSync(path.join(clientPublic, 'logo.ico'), icoBuffer);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    // 某些环境（如 WorkBuddy 沙箱的 safe-delete shim）可能拦截 rmSync；
    // 临时目录在系统 %TEMP% 下，不影响项目，忽略即可。
    console.warn('[WARN] 无法清理系统临时目录，忽略:', tmpDir);
  }

  console.log('已生成 logo-1024.png / logo-win.png / logo-mac.png / logo.ico');
  console.log('完成!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
