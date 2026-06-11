// 从 client/public/favicon.svg 渲染生成 icon.png 和 icon.ico
// 小尺寸用 4x 超采样再缩回，保证 "Env" 清晰
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const publicDir = path.join(__dirname, 'client', 'public');
const svgPath = path.join(publicDir, 'favicon.svg');
const pngPath = path.join(publicDir, 'icon.png');
const icoPath = path.join(publicDir, 'icon.ico');

const sizes = [16, 32, 48, 64, 128, 256];

// 生成指定尺寸的 SVG，使用完整的 "Env"
function envSvg(size, padRatio, fontSizeRatio) {
  const pad = Math.max(1, Math.round(size * padRatio));
  const inner = size - 2 * pad;
  const r = Math.round(size * 0.22);
  const fontSize = Math.round(size * fontSizeRatio);
  // 用 y 坐标使文字在视觉上居中（SVG text baseline 偏下）
  const textY = Math.round(size * 0.62);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${pad}" y="${pad}" width="${inner}" height="${inner}" rx="${r}" ry="${r}" fill="#1E1E1E"/>
  <text x="${size / 2}" y="${textY}" font-family="Consolas, 'Courier New', monospace" font-size="${fontSize}" font-weight="bold" fill="#FFFFFF" text-anchor="middle">Env</text>
</svg>`;
}

async function main() {
  if (!fs.existsSync(svgPath)) {
    console.error('找不到 SVG:', svgPath);
    process.exit(1);
  }
  const svgBuf = fs.readFileSync(svgPath);

  // 1) 512x512 PNG（直接从 favicon.svg 渲染）
  await sharp(svgBuf)
    .resize(512, 512, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 6 })
    .toFile(pngPath);
  console.log('已生成 512x512 PNG:', pngPath);

  // 2) ICO：小尺寸(16/32)用 4x 超采样，大尺寸直接渲染
  const pngBuffers = [];

  for (const size of sizes) {
    if (size <= 32) {
      // 4 倍超采样：先在 4x 尺寸 SVG 上渲染，再缩回
      const oversample = 4;
      const renderSize = size * oversample;
      const svg = envSvg(renderSize, 0.025, 0.48);
      const buf = await sharp(Buffer.from(svg))
        .resize(size, size, { kernel: sharp.kernel.lanczos3 })
        .png({ compressionLevel: 6 })
        .toBuffer();
      pngBuffers.push(buf);
      console.log(`  已渲染 ${size}x${size} (4x 超采样)`);
    } else {
      const buf = await sharp(svgBuf)
        .resize(size, size, { kernel: sharp.kernel.lanczos3 })
        .png({ compressionLevel: 6 })
        .toBuffer();
      pngBuffers.push(buf);
      console.log(`  已渲染 ${size}x${size}`);
    }
  }

  const icoBuf = await pngToIco(pngBuffers);
  fs.writeFileSync(icoPath, icoBuf);
  console.log('已生成多尺寸 ICO:', icoPath);
  console.log('完成!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});