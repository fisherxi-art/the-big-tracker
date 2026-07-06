import { existsSync, renameSync, statSync, unlinkSync } from "fs";
import { basename, dirname, extname, join } from "path";

function storeMaxPx() {
  const n = Number(process.env.RECEIPT_STORE_MAX_PX);
  return Number.isFinite(n) && n >= 400 ? Math.min(4096, Math.floor(n)) : 1600;
}

function storeJpegQuality() {
  const n = Number(process.env.RECEIPT_STORE_JPEG_QUALITY);
  return Number.isFinite(n) && n >= 50 ? Math.min(95, Math.floor(n)) : 80;
}

/**
 * Resize + JPEG-compress a receipt for disk storage. Caller should run AI on the
 * original file first, then call this and delete/replace the original.
 * @param {string} originalPath Absolute path to uploaded file
 * @returns {Promise<{ filename: string, image_path: string, mimeType: string, bytes: number }>}
 */
export async function compressReceiptForStorage(originalPath) {
  const sharp = (await import("sharp")).default;
  const dir = dirname(originalPath);
  const base = basename(originalPath, extname(originalPath));
  const outName = `${base}.jpg`;
  const outPath = join(dir, outName);
  const tmpPath = `${outPath}.tmp`;

  await sharp(originalPath)
    .rotate()
    .resize({
      width: storeMaxPx(),
      height: storeMaxPx(),
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: storeJpegQuality(), mozjpeg: true })
    .toFile(tmpPath);

  if (existsSync(outPath)) unlinkSync(outPath);
  renameSync(tmpPath, outPath);
  if (originalPath !== outPath && existsSync(originalPath)) {
    try {
      unlinkSync(originalPath);
    } catch {
      /* ignore */
    }
  }

  const bytes = statSync(outPath).size;
  return {
    filename: outName,
    image_path: `/uploads/${outName}`,
    mimeType: "image/jpeg",
    bytes,
  };
}
