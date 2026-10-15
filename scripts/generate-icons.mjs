import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

const size = 256;
const palette = {
  green: [141, 160, 121],
  cream: [255, 247, 233],
  pink: [227, 189, 174],
  eye: [116, 113, 91],
  nose: [196, 158, 139],
};
const triangle = (x, y, ax, ay, bx, by, cx, cy) => {
  const d = (x1, y1, x2, y2, x3, y3) =>
    (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const a = d(x, y, ax, ay, bx, by),
    b = d(x, y, bx, by, cx, cy),
    c = d(x, y, cx, cy, ax, ay);
  return !((a < 0 || b < 0 || c < 0) && (a > 0 || b > 0 || c > 0));
};
const ellipse = (x, y, cx, cy, rx, ry) =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;
function color(x, y) {
  const dx = Math.max(Math.abs(x - 64) - 32, 0),
    dy = Math.max(Math.abs(y - 64) - 32, 0);
  if (dx * dx + dy * dy > 32 * 32) return [0, 0, 0, 0];
  let fill = palette.green;
  if (
    ellipse(x, y, 64, 76, 43, 33) ||
    triangle(x, y, 26, 25, 27, 66, 57, 44) ||
    triangle(x, y, 102, 25, 101, 66, 71, 44)
  )
    fill = palette.cream;
  if (
    triangle(x, y, 32, 34, 34, 53, 47, 45) ||
    triangle(x, y, 96, 34, 94, 53, 81, 45)
  )
    fill = palette.pink;
  if (ellipse(x, y, 45, 71, 3.6, 5.8) || ellipse(x, y, 83, 71, 3.6, 5.8))
    fill = palette.eye;
  if (triangle(x, y, 60, 78, 68, 78, 64, 83)) fill = palette.nose;
  const mouth =
    (Math.abs(Math.hypot(x - 57, y - 85) - 7) < 1.4 && y >= 85) ||
    (Math.abs(Math.hypot(x - 71, y - 85) - 7) < 1.4 && y >= 85) ||
    (x > 62.7 && x < 65.3 && y >= 82 && y <= 88);
  if (mouth) fill = palette.eye;
  return [...fill, 255];
}
const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const total = [0, 0, 0, 0];
    for (let sy = 0; sy < 2; sy++)
      for (let sx = 0; sx < 2; sx++) {
        const c = color((x + (sx + 0.5) / 2) / 2, (y + (sy + 0.5) / 2) / 2);
        c.forEach((v, i) => (total[i] += v / 4));
      }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    total.forEach((v, i) => (raw[offset + i] = Math.round(v)));
  }
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
function chunk(name, data) {
  const type = Buffer.from(name);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  type.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return result;
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
await mkdir("resources", { recursive: true });
await writeFile("resources/icon.png", png);
await writeFile("resources/tray.png", png);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
await writeFile("resources/icon.ico", Buffer.concat([ico, png]));
console.log("已生成应用与托盘图标");
