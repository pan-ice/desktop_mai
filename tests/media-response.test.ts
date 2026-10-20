import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaResponse } from "../electron/media";

let directory: string;
const name = "a16ff8b7-0ac7-407f-b447-61a3bfd37c00.mp3";
const url = `mai-media://attachment/${name}`;
const bytes = Buffer.from("0123456789abcdef");
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mai-media-response-"));
  await mkdir(join(directory, "media"));
  await writeFile(join(directory, "media", name), bytes);
});
afterEach(() => rm(directory, { recursive: true, force: true }));

it("媒体完整响应声明类型、长度及范围能力", async () => {
  const response = await mediaResponse(directory, new Request(url));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
  expect(response.headers.get("Content-Length")).toBe("16");
  expect(response.headers.get("Accept-Ranges")).toBe("bytes");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});

it.each([
  ["bytes=4-7", 4, 7],
  ["bytes=10-", 10, 15],
  ["bytes=-4", 12, 15],
  ["bytes=14-99", 14, 15],
  ["bytes=-99", 0, 15],
  ["bytes=0-0", 0, 0],
])("媒体范围 %s 只返回对应字节", async (range, start, end) => {
  const response = await mediaResponse(
    directory,
    new Request(url, { headers: { Range: range } }),
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Range")).toBe(
    `bytes ${start}-${end}/16`,
  );
  expect(response.headers.get("Content-Length")).toBe(String(end - start + 1));
  expect(Buffer.from(await response.arrayBuffer())).toEqual(
    bytes.subarray(start, end + 1),
  );
});

it.each([
  "bytes=16-",
  "bytes=8-7",
  "bytes=-0",
  "bytes=-",
  "bytes=no",
  "bytes=0-1,4-5",
  "bytes=99999999999999999-",
])("拒绝不可满足的范围 %s", async (range) => {
  const response = await mediaResponse(
    directory,
    new Request(url, { headers: { Range: range } }),
  );
  expect(response.status).toBe(416);
  expect(response.headers.get("Content-Range")).toBe("bytes */16");
  expect((await response.arrayBuffer()).byteLength).toBe(0);
});

it("HEAD 返回长度但不读取音频正文，无效路径不暴露文件", async () => {
  const response = await mediaResponse(
    directory,
    new Request(url, { method: "HEAD" }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Length")).toBe("16");
  expect((await response.arrayBuffer()).byteLength).toBe(0);
  expect(
    (
      await mediaResponse(
        directory,
        new Request("mai-media://attachment/state.json"),
      )
    ).status,
  ).toBe(404);
  expect(
    (await mediaResponse(directory, new Request(url, { method: "POST" })))
      .status,
  ).toBe(405);
});
