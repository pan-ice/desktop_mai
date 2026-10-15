import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  inlineAttachment,
  mediaFile,
  pruneMedia,
  saveAttachment,
} from "../electron/media";
import { parseReply, pluginFrameSchema } from "../electron/protocol";

let folder = "";
afterEach(async () => {
  if (folder) {
    await rm(folder, { recursive: true, force: true });
    folder = "";
  }
});
it("附件分离保存，导出可还原内容，清理只触及失去引用的媒体", async () => {
  await mkdir(resolve(".cache/tests"), { recursive: true });
  folder = await mkdtemp(resolve(".cache/tests/media-"));
  const original = {
    type: "image" as const,
    dataUrl: "data:image/png;base64,aGVsbG8=",
    name: "test",
  };
  const saved = await saveAttachment(folder, original);
  expect(saved.dataUrl).toMatch(/^mai-media:\/\/attachment\//);
  expect((await readFile(mediaFile(folder, saved.dataUrl))).toString()).toBe(
    "hello",
  );
  expect(await inlineAttachment(folder, saved)).toEqual(original);
  expect(() =>
    mediaFile(folder, "mai-media://attachment/../../state.json"),
  ).toThrow();
  await pruneMedia(folder, []);
  await expect(readFile(mediaFile(folder, saved.dataUrl))).rejects.toThrow();
});

it.each(["wav", "ogg"])(
  "协议接收的 %s 语音可以保存、读取、导出和清理",
  async (format) => {
    await mkdir(resolve(".cache/tests"), { recursive: true });
    folder = await mkdtemp(resolve(".cache/tests/media-"));
    const original = {
      type: "audio" as const,
      dataUrl: `data:audio/${format};base64,aGVsbG8=`,
    };
    const frame = pluginFrameSchema.parse({
      v: 1,
      type: "reply",
      id: "audio-reply",
      sessionId: "session",
      segments: [original],
    });
    if (frame.type !== "reply") throw new Error("错误测试数据");
    const saved = await saveAttachment(
      folder,
      parseReply(frame).attachments[0],
    );
    expect(saved.dataUrl.endsWith(`.${format}`)).toBe(true);
    expect((await readFile(mediaFile(folder, saved.dataUrl))).toString()).toBe(
      "hello",
    );
    expect(await inlineAttachment(folder, saved)).toEqual(original);
    await pruneMedia(folder, []);
    await expect(readFile(mediaFile(folder, saved.dataUrl))).rejects.toThrow();
  },
);
