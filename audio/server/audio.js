import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './db.js';

const BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

function mp3FrameInfo(buf, pos) {
  if (pos + 4 > buf.length) return null;
  if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (buf[pos + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (buf[pos + 1] >> 1) & 0x03; // 1=Layer III
  if (versionBits === 1 || layerBits === 0) return null;
  const bitrateIdx = (buf[pos + 2] >> 4) & 0x0f;
  const srIdx = (buf[pos + 2] >> 2) & 0x03;
  if (bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;
  const padding = (buf[pos + 2] >> 1) & 0x01;
  const table = versionBits === 3 ? BITRATES_V1L3 : BITRATES_V2L3;
  const bitrate = table[bitrateIdx] * 1000;
  const sampleRate = SAMPLE_RATES[versionBits][srIdx];
  const isLayer1 = layerBits === 3;
  let frameLen;
  if (isLayer1) frameLen = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
  else if (layerBits === 1 && versionBits !== 3) frameLen = Math.floor((72 * bitrate) / sampleRate) + padding;
  else frameLen = Math.floor((144 * bitrate) / sampleRate) + padding;
  if (!Number.isFinite(frameLen) || frameLen < 24) return null;
  const samples = versionBits === 3 ? (isLayer1 ? 384 : 1152) : isLayer1 ? 384 : 576;
  return { frameLen, duration: samples / sampleRate, bitrate, sampleRate };
}

export function probeMp3Duration(buf) {
  let pos = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    pos = 10 + size;
  }
  // 找到第一个有效帧
  while (pos < buf.length - 4) {
    if (mp3FrameInfo(buf, pos) && mp3FrameInfo(buf, pos + (mp3FrameInfo(buf, pos)?.frameLen || 0))) break;
    pos++;
  }
  let duration = 0;
  let frames = 0;
  while (pos < buf.length - 4) {
    const info = mp3FrameInfo(buf, pos);
    if (!info) {
      pos++;
      continue;
    }
    duration += info.duration;
    frames++;
    pos += info.frameLen;
  }
  return frames > 2 ? duration : null;
}

export function probeWav(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    return null;
  }
  let pos = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 16 <= buf.length) byteRate = buf.readUInt32LE(pos + 16);
    if (id === 'data') {
      dataSize = Math.min(size, buf.length - pos - 8);
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!byteRate || !dataSize) return null;
  return dataSize / byteRate;
}

function probeM4aDuration(buf) {
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size < 8) break;
    if (type === 'moov') {
      const end = Math.min(buf.length, pos + size);
      let p = pos + 8;
      while (p + 8 <= end) {
        const s2 = buf.readUInt32BE(p);
        const t2 = buf.toString('latin1', p + 4, p + 8);
        if (s2 < 8) break;
        if (t2 === 'mvhd') {
          const version = buf[p + 8];
          if (version === 1) {
            const timescale = buf.readUInt32BE(p + 8 + 20);
            const duration = Number(buf.readBigUInt64BE(p + 8 + 24));
            return timescale ? duration / timescale : null;
          }
          const timescale = buf.readUInt32BE(p + 8 + 12);
          const duration = buf.readUInt32BE(p + 8 + 16);
          return timescale ? duration / timescale : null;
        }
        p += s2;
      }
      return null;
    }
    pos += size;
  }
  return null;
}

export function probeDuration(filePath) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 8 * 1024 * 1024);
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);
    fd = null;
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (ext === 'mp3' || ext === 'mp2') return probeMp3Duration(buf);
    if (ext === 'wav') return probeWav(buf);
    if (ext === 'm4a' || ext === 'mp4' || ext === 'aac') return probeM4aDuration(buf);
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 将过大的录音切分为可提交给 ASR 的分片。
 * 目前支持 mp3（按帧边界）与 wav（按采样块），其余格式给出明确提示。
 */
export function splitForAsr(filePath, maxBytes = 20 * 1024 * 1024) {
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) return { chunks: [{ path: filePath, offset: 0 }], cleanup: () => {} };

  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'mp3') return splitMp3(filePath, maxBytes);
  if (ext === 'wav') return splitWav(filePath, maxBytes);
  throw new Error(
    `文件大小 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过单次转写上限，当前仅支持自动切分 MP3 / WAV；请转换格式或安装 ffmpeg 后重试`,
  );
}

function splitMp3(filePath, maxBytes) {
  const buf = fs.readFileSync(filePath);
  let pos = 0;
  if (buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    pos = 10 + size;
  }
  while (pos < buf.length - 4 && !mp3FrameInfo(buf, pos)) pos++;

  const parts = [];
  let curStart = pos;
  let p = pos;
  while (p < buf.length - 4) {
    const info = mp3FrameInfo(buf, p);
    if (!info) {
      p++;
      continue;
    }
    if (p - curStart + info.frameLen > maxBytes && p > curStart) {
      parts.push({ start: curStart, end: p });
      curStart = p;
    }
    p += info.frameLen;
  }
  if (curStart < buf.length) parts.push({ start: curStart, end: buf.length });

  const baseName = path.basename(filePath).replace(/\.[^.]+$/, '');
  let elapsed = 0;
  const chunks = [];
  const dir = path.join(UPLOAD_DIR, 'chunks');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const slice = buf.subarray(part.start, part.end);
    const chunkPath = path.join(dir, `${baseName}.part${i + 1}.mp3`);
    fs.writeFileSync(chunkPath, slice);
    chunks.push({ path: chunkPath, offset: elapsed, duration: probeMp3Duration(slice) || 0 });
    elapsed += chunks[i].duration;
  }
  return {
    chunks,
    cleanup() {
      for (const c of chunks) {
        if (c.path !== filePath) fs.rmSync(c.path, { force: true });
      }
    },
  };
}

function splitWav(filePath, maxBytes) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('latin1', 0, 4) !== 'RIFF') throw new Error('WAV 文件头无效，无法切分');
  let pos = 12;
  let fmt = null;
  let dataStart = -1;
  let dataSize = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = buf.subarray(pos, pos + 8 + size);
    if (id === 'data') {
      dataStart = pos + 8;
      dataSize = Math.min(size, buf.length - pos - 8);
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataStart < 0) throw new Error('WAV 文件缺少 fmt/data 数据块');
  const channels = fmt.readUInt16LE(10);
  const bitsPerSample = fmt.readUInt16LE(22);
  const blockAlign = Math.max(1, channels * (bitsPerSample / 8));
  const byteRate = fmt.readUInt32LE(16);
  const perChunk = Math.floor(maxBytes / blockAlign) * blockAlign;

  const dir = path.join(UPLOAD_DIR, 'chunks');
  fs.mkdirSync(dir, { recursive: true });
  const baseName = path.basename(filePath).replace(/\.[^.]+$/, '');
  const chunks = [];
  let elapsed = 0;
  for (let offset = 0, i = 0; offset < dataSize; offset += perChunk, i++) {
    const len = Math.min(perChunk, dataSize - offset);
    const data = buf.subarray(dataStart + offset, dataStart + offset + len);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'latin1');
    header.write('fmt ', 12, 'latin1');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(fmt.readUInt32LE(12), 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36, 'latin1');
    header.writeUInt32LE(data.length, 40);
    const chunkPath = path.join(dir, `${baseName}.part${i + 1}.wav`);
    fs.writeFileSync(chunkPath, Buffer.concat([header, data]));
    const duration = byteRate ? data.length / byteRate : 0;
    chunks.push({ path: chunkPath, offset: elapsed, duration });
    elapsed += duration;
  }
  return {
    chunks,
    cleanup() {
      for (const c of chunks) fs.rmSync(c.path, { force: true });
    },
  };
}
