import { PhotonImage, SamplingFilter, resize } from '@cf-wasm/photon';

/**
 * Banner ads are delivered at a fixed 468×60 (IAB Full Banner). Inputs of any
 * compatible aspect ratio get scaled to this exact box so the integrator can
 * pin display size with `width="468" height="60"` and never see layout shift.
 *
 * Output is always PNG — picking one format keeps the storage key extension
 * and Content-Type predictable, and at 468×60 the size delta vs JPEG is
 * negligible (~20-50 KB worst case).
 */
export const BANNER_WIDTH = 468;
export const BANNER_HEIGHT = 60;
export const BANNER_OUTPUT_MIME = 'image/png' as const;
export const BANNER_OUTPUT_EXT = 'png' as const;

export type ResizedBanner = {
  bytes: Uint8Array;
  mime: typeof BANNER_OUTPUT_MIME;
  width: number;
  height: number;
};

/**
 * Decode the input bytes, downsample to 468×60 with a Lanczos3 kernel, and
 * re-encode as PNG. Throws on malformed input; caller should surface a
 * user-visible error in that case.
 *
 * Both PhotonImage instances are explicitly `.free()`-d to release the WASM
 * memory promptly; otherwise garbage collection in workerd can defer the
 * reclamation past the request's CPU budget.
 */
export function resizeBanner(input: Uint8Array): ResizedBanner {
  const img = PhotonImage.new_from_byteslice(input);
  try {
    const resized = resize(img, BANNER_WIDTH, BANNER_HEIGHT, SamplingFilter.Lanczos3);
    try {
      const bytes = resized.get_bytes();
      return {
        bytes,
        mime: BANNER_OUTPUT_MIME,
        width: BANNER_WIDTH,
        height: BANNER_HEIGHT,
      };
    } finally {
      resized.free();
    }
  } finally {
    img.free();
  }
}
