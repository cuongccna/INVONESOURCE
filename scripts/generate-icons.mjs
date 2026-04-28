/**
 * generate-icons.mjs
 * Generates all PWA + webapp icons from INVONE_new.png
 * Run: node scripts/generate-icons.mjs
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'INVONE_new.png');
const PUB = path.join(ROOT, 'frontend', 'public');
const ICONS_DIR = path.join(PUB, 'icons');

// Teal brand color sampled from INVONE_new.png background
const BRAND_TEAL = { r: 14, g: 165, b: 173, alpha: 1 }; // ~#0ea5ad

// Ensure icons directory exists
fs.mkdirSync(ICONS_DIR, { recursive: true });

// ──────────────────────────────────────────────────────────────────────────────
// Regular PWA icons — simple resize
// ──────────────────────────────────────────────────────────────────────────────
const PWA_SIZES = [72, 96, 128, 144, 152, 180, 192, 384, 512];

async function generateRegular() {
  for (const size of PWA_SIZES) {
    const outPath = path.join(ICONS_DIR, `icon-${size}x${size}.png`);
    await sharp(SRC)
      .resize(size, size, { fit: 'cover', position: 'center' })
      .png({ compressionLevel: 9, palette: true })
      .toFile(outPath);
    console.log(`✓ ${path.relative(ROOT, outPath)}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Maskable icons — icon at 80% centered on solid teal background
// The safe zone for maskable is the inner 80% circle; padding ensures no clipping
// ──────────────────────────────────────────────────────────────────────────────
const MASKABLE_SIZES = [192, 512];

async function generateMaskable() {
  for (const size of MASKABLE_SIZES) {
    const iconSize = Math.round(size * 0.8); // 80% of target — stays within safe zone
    const padding = Math.round((size - iconSize) / 2);

    // Resize source to 80% of target
    const resizedIcon = await sharp(SRC)
      .resize(iconSize, iconSize, { fit: 'cover', position: 'center' })
      .png()
      .toBuffer();

    const outPath = path.join(ICONS_DIR, `icon-${size}x${size}-maskable.png`);
    await sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: BRAND_TEAL,
      },
    })
      .composite([{ input: resizedIcon, top: padding, left: padding }])
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    console.log(`✓ ${path.relative(ROOT, outPath)}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Favicons in /public root
// ──────────────────────────────────────────────────────────────────────────────
async function generateFavicons() {
  // favicon-16x16.png
  await sharp(SRC)
    .resize(16, 16, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toFile(path.join(PUB, 'favicon-16x16.png'));
  console.log('✓ frontend/public/favicon-16x16.png');

  // favicon-32x32.png
  await sharp(SRC)
    .resize(32, 32, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toFile(path.join(PUB, 'favicon-32x32.png'));
  console.log('✓ frontend/public/favicon-32x32.png');

  // apple-touch-icon.png — 180x180, no rounded corners added (iOS applies its own mask)
  await sharp(SRC)
    .resize(180, 180, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toFile(path.join(PUB, 'apple-touch-icon.png'));
  console.log('✓ frontend/public/apple-touch-icon.png');

  // OG image / share thumbnail — 1200x630 with centered icon + teal letterbox
  const ogIconSize = 400;
  const ogWidth = 1200;
  const ogHeight = 630;
  const ogIcon = await sharp(SRC)
    .resize(ogIconSize, ogIconSize, { fit: 'cover' })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: ogWidth,
      height: ogHeight,
      channels: 4,
      background: BRAND_TEAL,
    },
  })
    .composite([{
      input: ogIcon,
      top: Math.round((ogHeight - ogIconSize) / 2),
      left: Math.round((ogWidth - ogIconSize) / 2),
    }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(PUB, 'og-image.png'));
  console.log('✓ frontend/public/og-image.png');
}

// ──────────────────────────────────────────────────────────────────────────────
// favicon.ico — multi-size (16, 32, 48) using raw ICO construction
// Sharp outputs PNG; we build a minimal ICO binary manually
// ──────────────────────────────────────────────────────────────────────────────
async function buildIco(sizes, destPath) {
  const pngBuffers = await Promise.all(
    sizes.map((s) =>
      sharp(SRC).resize(s, s, { fit: 'cover' }).png().toBuffer()
    )
  );

  // ICO header: ICONDIR
  const count = sizes.length;
  const headerSize = 6 + count * 16; // ICONDIR + n × ICONDIRENTRY
  let offset = headerSize;

  const entries = [];
  for (let i = 0; i < count; i++) {
    const buf = pngBuffers[i];
    entries.push({ size: sizes[i], data: buf, offset });
    offset += buf.length;
  }

  const totalSize = offset;
  const ico = Buffer.alloc(totalSize);

  // ICONDIR
  ico.writeUInt16LE(0, 0);     // reserved
  ico.writeUInt16LE(1, 2);     // type: 1 = ICO
  ico.writeUInt16LE(count, 4); // count

  // ICONDIRENTRY × n
  for (let i = 0; i < count; i++) {
    const e = entries[i];
    const base = 6 + i * 16;
    ico.writeUInt8(e.size === 256 ? 0 : e.size, base);     // width (0=256)
    ico.writeUInt8(e.size === 256 ? 0 : e.size, base + 1); // height
    ico.writeUInt8(0, base + 2);   // color count (0 = no palette)
    ico.writeUInt8(0, base + 3);   // reserved
    ico.writeUInt16LE(1, base + 4);  // planes
    ico.writeUInt16LE(32, base + 6); // bit count
    ico.writeUInt32LE(e.data.length, base + 8);  // size of image data
    ico.writeUInt32LE(e.offset, base + 12);       // offset of image data
  }

  // Image data
  for (const e of entries) {
    e.data.copy(ico, e.offset);
  }

  fs.writeFileSync(destPath, ico);
  console.log(`✓ ${path.relative(ROOT, destPath)}`);
}

async function generateIco() {
  // /public/favicon.ico — 16, 32, 48
  await buildIco([16, 32, 48], path.join(PUB, 'favicon.ico'));
  // /public/icons/favicon.ico — same
  await buildIco([16, 32, 48], path.join(ICONS_DIR, 'favicon.ico'));
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n📦 Generating INVONE icons from INVONE_new.png...\n');

  if (!fs.existsSync(SRC)) {
    console.error(`❌ Source not found: ${SRC}`);
    process.exit(1);
  }

  await generateRegular();
  await generateMaskable();
  await generateFavicons();
  await generateIco();

  console.log('\n✅ All icons generated successfully!\n');
  console.log('Files created:');
  console.log('  frontend/public/favicon.ico              — multi-size (16/32/48px)');
  console.log('  frontend/public/favicon-16x16.png');
  console.log('  frontend/public/favicon-32x32.png');
  console.log('  frontend/public/apple-touch-icon.png     — 180×180 (iOS home screen)');
  console.log('  frontend/public/og-image.png             — 1200×630 (social share)');
  console.log('  frontend/public/icons/icon-{size}x{size}.png   — 72/96/128/144/152/180/192/384/512');
  console.log('  frontend/public/icons/icon-192x192-maskable.png');
  console.log('  frontend/public/icons/icon-512x512-maskable.png');
  console.log('  frontend/public/icons/favicon.ico');
})();
