import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Attachment, ChatMessage } from "../shared/types";

const mediaName = /^[0-9a-f-]{36}\.(png|jpg|gif|webp|mp3|wav|ogg)$/;
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
  if (bytes.length > 16 * 1024 * 1024) throw new Error("媒体文件超过 16 MB");
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

export async function inlineAttachment(
  directory: string,
  attachment: Attachment,
): Promise<Attachment> {
  if (!attachment.dataUrl.startsWith("mai-media:")) return attachment;
  const file = mediaFile(directory, attachment.dataUrl);
  const extension = file.slice(file.lastIndexOf(".") + 1);
  const mime = (
    {
      png: "image/png",
      jpg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
    } as Record<string, string>
  )[extension];
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
