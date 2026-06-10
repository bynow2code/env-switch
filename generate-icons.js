const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// SVG 文件路径
const svgPath = path.join(__dirname, 'public', 'favicon.svg');
const outputDir = path.join(__dirname, 'assets', 'icons');

// 确保输出目录存在
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log('开始生成多尺寸 PNG 图标...\n');

// 读取 SVG 文件
const svgBuffer = fs.readFileSync(svgPath);

// 需要生成的尺寸
const sizes = [16, 32, 64, 128, 256, 512];

Promise.all(
  sizes.map(size => {
    const outputPath = path.join(outputDir, `${size}x${size}.png`);
    
    return sharp(svgBuffer)
      .resize(size, size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toFile(outputPath)
      .then(() => {
        console.log(`✓ 已生成 ${size}x${size}.png`);
      })
      .catch(err => {
        console.error(`✗ 生成 ${size}x${size}.png 失败:`, err.message);
      });
  })
).then(() => {
  console.log('\n所有图标生成完成！');
}).catch(err => {
  console.error('生成图标失败:', err.message);
});
