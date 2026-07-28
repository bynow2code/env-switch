// 从 client/public/favicon.svg 渲染生成「打包用 logo」（PNG 方案，参考 easy-ops）
//   client/public/logo-1024.png  -> 默认图标（build.icon），electron-builder 自动转 ico/icns
//   client/public/logo-win.png   -> Windows 图标（build.win.icon）
//   client/public/logo-mac.png   -> macOS 图标（build.mac.icon）
// 运行时窗口图标也统一用上面的 PNG（electron-main.js 加载 public/logo-win.png），
// 不再单独维护 .ico / icon.png，避免多套图标互相冗余。
//
// 注意：根 public/ 是 Vite 构建输出目录（vite.config.js 的 outDir: '../public'），
//       本脚本产出的文件会在 npm run build 时由 Vite 从 client/public 拷贝到 public/，无需手动生成。

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// client/public 是打包资源的源目录（与 easy-ops 保持一致）
const clientPublic = path.join(__dirname, 'client', 'public');
// 真正的 logo 源文件：EnvSwitch 自己的 favicon.svg（"Env" 字样）
const svgPath = path.join(clientPublic, 'favicon.svg');

// 从 favicon.svg 直接渲染指定尺寸的 PNG（高清母版，清晰）
async function renderPng(size) {
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
  const master = await renderPng(1024);
  fs.writeFileSync(path.join(clientPublic, 'logo-1024.png'), master);
  fs.writeFileSync(path.join(clientPublic, 'logo-win.png'), master);  // Windows
  fs.writeFileSync(path.join(clientPublic, 'logo-mac.png'), master);  // macOS
  console.log('已生成 logo-1024.png / logo-win.png / logo-mac.png');

  console.log('完成!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
