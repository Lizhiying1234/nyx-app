#!/usr/bin/env node
// 扫描 PNG 每一行有多少「非背景」像素 —— 内容到底画在哪，用数字回答。
//
// 为什么存在：2026-08-25 我在缩略图上「看见」顶部多了一条 Tab 栏，查了半天，
// 最后逐行扫像素才发现那是系统状态栏图标。眼睛在缩放过的图上不可靠。
//
//   node tools/device/rows.mjs shot.png [--bg RRGGBB] [--tol 12] [--from Y] [--to Y]
//
// 输出：每一段连续「有内容」的行区间 + 该段的最大 ink 值。
// 空行段（ink=0）用来判断内容边界、被裁的位置、以及两块之间的真实间距。

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('用法: node tools/device/rows.mjs shot.png [--bg RRGGBB] [--tol 12] [--from Y] [--to Y]');
  process.exit(2);
}
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const tol = Number(flag('tol', 12));
const from = Number(flag('from', 0));
const toArg = flag('to', null);

// ── 最小 PNG 解码：只认 8-bit RGB / RGBA，非隔行。screencap 出来的就是这种。
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error('只支持 8-bit，实际 ' + depth);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const ch = color === 2 ? 3 : color === 6 ? 4 : 0;
  if (!ch) throw new Error('只支持 RGB/RGBA，colorType=' + color);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, ch, data: out };
}

const img = decodePng(readFileSync(file));
const { width, height, ch, data } = img;
const to = toArg === null ? height : Math.min(Number(toArg), height);

// 背景色：默认取第一行的众数（screencap 顶部通常是纯背景）
let bg;
const bgFlag = flag('bg', null);
if (bgFlag) {
  bg = [parseInt(bgFlag.slice(0, 2), 16), parseInt(bgFlag.slice(2, 4), 16), parseInt(bgFlag.slice(4, 6), 16)];
} else {
  const tally = new Map();
  for (let x = 0; x < width; x++) {
    const i = x * ch;
    const k = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  bg = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
}

const ink = new Array(height).fill(0);
for (let y = from; y < to; y++) {
  let n = 0;
  const base = y * width * ch;
  for (let x = 0; x < width; x++) {
    const i = base + x * ch;
    if (Math.abs(data[i] - bg[0]) > tol ||
        Math.abs(data[i + 1] - bg[1]) > tol ||
        Math.abs(data[i + 2] - bg[2]) > tol) n++;
  }
  ink[y] = n;
}

console.log(`${file}  ${width}x${height}  bg=#${bg.map((v) => v.toString(16).padStart(2, '0')).join('')}  tol=${tol}  扫描 y=${from}..${to}`);
console.log('段落  y 区间            高   峰值 ink');
let start = -1, peak = 0, segs = 0;
for (let y = from; y <= to; y++) {
  const on = y < to && ink[y] > 0;
  if (on && start < 0) { start = y; peak = 0; }
  if (on) peak = Math.max(peak, ink[y]);
  if (!on && start >= 0) {
    segs++;
    console.log(`${String(segs).padStart(4)}  ${String(start).padStart(5)}..${String(y - 1).padEnd(6)} ${String(y - start).padStart(5)}  ${String(peak).padStart(6)}`);
    start = -1;
  }
}
if (!segs) console.log('（整段没有任何非背景像素）');
