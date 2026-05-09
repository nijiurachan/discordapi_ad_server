import type { Attachment } from '../discord/types.ts';
import type { FormatRules } from './rules.ts';

export type ImageValidationResult = { ok: true } | { ok: false; errors: string[] };

export function validateImage(rules: FormatRules, attachment: Attachment): ImageValidationResult {
  const errors: string[] = [];

  // MIME check. Defensively strip any parameter (e.g., "image/png; charset=utf-8")
  // and lowercase before comparing — Discord normally sends a bare MIME, but the
  // same hygiene we apply in ad-submit avoids surprises if that ever changes.
  const rawMime = attachment.content_type ?? '';
  const mime = rawMime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!rules.allowedMimes.includes(mime)) {
    errors.push(`画像 MIME タイプが許可されていません (${mime || '未設定'})`);
  }

  // Extension check (extract from URL path)
  const ext = extractExtension(attachment.url) ?? extractExtension(attachment.filename ?? '');
  if (!ext || !rules.allowedExtensions.includes(ext.toLowerCase())) {
    errors.push(`画像の拡張子が許可されていません (${ext ?? '不明'})`);
  }

  // Size
  if (attachment.size > rules.maxBytes) {
    errors.push(`画像サイズが上限を超えています (${attachment.size} > ${rules.maxBytes} bytes)`);
  }

  // Dimensions
  if (
    rules.minWidth !== null &&
    attachment.width !== undefined &&
    attachment.width < rules.minWidth
  ) {
    errors.push(`画像幅が最小値未満です (${attachment.width} < ${rules.minWidth})`);
  }
  if (
    rules.maxWidth !== null &&
    attachment.width !== undefined &&
    attachment.width > rules.maxWidth
  ) {
    errors.push(`画像幅が最大値を超えています (${attachment.width} > ${rules.maxWidth})`);
  }
  if (
    rules.minHeight !== null &&
    attachment.height !== undefined &&
    attachment.height < rules.minHeight
  ) {
    errors.push(`画像高さが最小値未満です (${attachment.height} < ${rules.minHeight})`);
  }
  if (
    rules.maxHeight !== null &&
    attachment.height !== undefined &&
    attachment.height > rules.maxHeight
  ) {
    errors.push(`画像高さが最大値を超えています (${attachment.height} > ${rules.maxHeight})`);
  }

  // Aspect ratio (only if rules has aspectRatios and the attachment has both dims)
  if (
    rules.aspectRatios &&
    rules.aspectRatios.length > 0 &&
    attachment.width !== undefined &&
    attachment.height !== undefined &&
    attachment.height > 0
  ) {
    const actual = attachment.width / attachment.height;
    const ok = rules.aspectRatios.some((r) => {
      const parts = r.split(':').map(Number);
      // Skip malformed entries: must be exactly "W:H" with two numeric parts.
      // A non-numeric part (e.g., "1:foo") yields NaN from Number(), and
      // dividing by it produces NaN comparisons that silently succeed —
      // explicitly reject so a typo in config can't pass validation.
      if (parts.length !== 2) return false;
      const w = parts[0];
      const h = parts[1];
      // Reject zero or negative components — negative target would invert the
      // sign of the ratio and `<= tolerance` would silently false-pass.
      if (
        w === undefined ||
        h === undefined ||
        Number.isNaN(w) ||
        Number.isNaN(h) ||
        w <= 0 ||
        h <= 0
      )
        return false;
      const target = w / h;
      return Math.abs(actual - target) / target <= rules.aspectTolerance;
    });
    if (!ok) {
      const tolPct = (rules.aspectTolerance * 100).toFixed(1);
      errors.push(
        `画像のアスペクト比が許可されていません (許容: ${rules.aspectRatios.join(', ')} ±${tolPct}%)`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

function extractExtension(s: string): string | null {
  if (!s) return null;
  // Strip query string
  const path = s.split('?')[0] ?? '';
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) return null;
  return path.slice(dot + 1);
}

const MAGIC_BYTES = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpegFFD8: [0xff, 0xd8, 0xff],
  gif87a: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
  gif89a: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  // WebP: 'RIFF' + 4 bytes size + 'WEBP'
  webpRiff: [0x52, 0x49, 0x46, 0x46],
} as const;

export type DetectedMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

function bytesEqual(buf: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (buf.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (buf[offset + i] !== signature[i]) return false;
  }
  return true;
}

export function validateMagicBytes(buffer: Uint8Array): DetectedMime | null {
  if (bytesEqual(buffer, MAGIC_BYTES.png)) return 'image/png';
  if (bytesEqual(buffer, MAGIC_BYTES.jpegFFD8)) return 'image/jpeg';
  if (bytesEqual(buffer, MAGIC_BYTES.gif87a) || bytesEqual(buffer, MAGIC_BYTES.gif89a))
    return 'image/gif';
  if (
    bytesEqual(buffer, MAGIC_BYTES.webpRiff) &&
    bytesEqual(buffer, [0x57, 0x45, 0x42, 0x50], 8) // 'WEBP' at offset 8
  )
    return 'image/webp';
  return null;
}
