import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Attachment, ChatMessage } from "../shared/types";
import { MAX_AUDIO_BYTES } from "../shared/media-limits";

const mediaName = /^[0-9a-f-]{36}\.(png|jpg|gif|webp|mp3|wav|ogg)$/;
const mediaTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};
export async function saveAttachment(
  directory: string,
  attachment: Attachment,
): Promise<Attachment> {
  const match =
    /^data:(image\/(?:png|jpeg|gif|webp)|audio\/(?:mpeg|wav|ogg));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
      attachment.dataUrl,
    );
  if (!match) throw new Error("不支持的消息媒体格式");
  const bytes = Buffer.from(match[2], "base64");
  const audio = match[1].startsWith("audio/");
  if (bytes.length > (audio ? MAX_AUDIO_BYTES : 16 * 1024 * 1024))
    throw new Error(audio ? "音频文件超过 100 MiB" : "图片文件超过 16 MiB");
  const extension = (
    {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "audio/ogg": "ogg",
    } as Record<string, string>
  )[match[1]];
  const file = `${randomUUID()}.${extension}`;
  await mkdir(join(directory, "media"), { recursive: true });
  await writeFile(join(directory, "media", file), bytes);
  return { ...attachment, dataUrl: `mai-media://attachment/${file}` };
}

export function mediaFile(directory: string, request: string): string {
  const url = new URL(request);
  const name = url.pathname.slice(1);
  if (url.hostname !== "attachment" || !mediaName.test(name))
    throw new Error("无效的媒体路径");
  return join(directory, "media", name);
}

/** Chromium 需要文件长度和正确的范围响应才能计算时长、跳转播放。 */
export async function mediaResponse(
  directory: string,
  request: Request,
): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  let file: string, size: number;
  try {
    file = mediaFile(directory, request.url);
    const info = await stat(file);
    if (!info.isFile()) throw new Error();
    size = info.size;
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers({
    "Content-Type": mediaTypes[file.slice(file.lastIndexOf(".") + 1)],
    "Content-Length": String(size),
    "Accept-Ranges": "bytes",
    // 仅服务已校验的本机媒体；Web Audio 采样跨 scheme 的声音需要 CORS。
    "Access-Control-Allow-Origin": "*",
  });
  let start = 0,
    end = size - 1,
    status = 200;
  const range = request.method === "GET" ? request.headers.get("Range") : null;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    let valid = Boolean(match && (match[1] || match[2]) && size > 0);
    if (valid && match) {
      if (!match[1]) {
        const suffix = Number(match[2]);
        valid = Number.isSafeInteger(suffix) && suffix > 0;
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]);
        const requestedEnd = match[2] ? Number(match[2]) : size - 1;
        valid =
          Number.isSafeInteger(start) &&
          Number.isSafeInteger(requestedEnd) &&
          start < size &&
          requestedEnd >= start;
        end = Math.min(requestedEnd, size - 1);
      }
    }
    if (!valid) {
      headers.set("Content-Range", `bytes */${size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
  }
  if (request.method === "HEAD" || !size)
    return new Response(null, { status, headers });
  const stream = createReadStream(file, { start, end, signal: request.signal });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status,
    headers,
  });
}

export async function inlineAttachment(
  directory: string,
  attachment: Attachment,
): Promise<Attachment> {
  if (!attachment.dataUrl.startsWith("mai-media:")) return attachment;
  const file = mediaFile(directory, attachment.dataUrl);
  const extension = file.slice(file.lastIndexOf(".") + 1);
  const mime = mediaTypes[extension];
  return {
    ...attachment,
    dataUrl: `data:${mime};base64,${(await readFile(file)).toString("base64")}`,
  };
}

export async function removeHistoryMedia(
  directory: string,
  history: ChatMessage[],
) {
  for (const message of history)
    for (const attachment of message.attachments || []) {
      if (!attachment.dataUrl.startsWith("mai-media:")) continue;
      try {
        await unlink(mediaFile(directory, attachment.dataUrl));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
}

export async function pruneMedia(directory: string, history: ChatMessage[]) {
  const used = new Set(
    history.flatMap((message) =>
      (message.attachments || []).map((attachment) => attachment.dataUrl),
    ),
  );
  let files: string[];
  try {
    files = await readdir(join(directory, "media"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const file of files)
    if (mediaName.test(file) && !used.has(`mai-media://attachment/${file}`))
      await unlink(join(directory, "media", file));
}
