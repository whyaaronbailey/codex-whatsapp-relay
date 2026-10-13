import { unwrapMessage } from "./store.mjs";

export const DEFAULT_MEDIA_LIMIT = 25 * 1024 * 1024;

export function extractAttachment(message) {
  const payload = unwrapMessage(message);
  for (const [key, fallback] of [["documentMessage", "document"], ["imageMessage", "image.jpg"], ["videoMessage", "video.mp4"]]) {
    const media = payload?.[key];
    if (!media) continue;
    const size = Number(media.fileLength ?? 0);
    return {
      filename: media.fileName || fallback,
      mimetype: media.mimetype || "application/octet-stream",
      caption: typeof media.caption === "string" ? media.caption : "",
      size: Number.isFinite(size) && size >= 0 ? size : null
    };
  }
  return null;
}

export async function collectMediaStream(stream, { maxBytes = DEFAULT_MEDIA_LIMIT, timeoutMs = 60_000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MEDIA_LIMIT) {
    stream.destroy?.();
    throw new Error("Invalid media size limit (maximum 25 MiB).");
  }
  const timer = setTimeout(() => stream.destroy?.(new Error("Media download timed out.")), timeoutMs);
  timer.unref?.();
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new Error(`Attachment exceeds the ${maxBytes}-byte limit.`);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    stream.destroy?.();
  }
}

// Baileys can wait for HTTP headers or a reupload before returning a stream.
// Bound that phase too and close any stream that arrives after the deadline.
export async function downloadBoundedMedia(download, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  let expired = false;
  let timer;
  let stream;
  const pending = Promise.resolve().then(download).then((value) => {
    stream = value;
    if (expired) {
      stream.destroy?.();
      throw new Error("Media download timed out.");
    }
    return collectMediaStream(stream, options);
  });
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        stream?.destroy?.();
        reject(new Error("Media download timed out."));
      }, timeoutMs);
      timer.unref?.();
    })]);
  } finally {
    clearTimeout(timer);
  }
}
