import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function decodeName(buf, flags) {
  if (flags & 0x800) return buf.toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

export function listZipEntries(buffer) {
  const eocdMin = Math.max(0, buffer.length - 66000);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= eocdMin; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('不是有效的 ZIP 文件（未找到中央目录）');

  let count = buffer.readUInt16LE(eocd + 10);
  let cenSize = buffer.readUInt32LE(eocd + 12);
  let cenOffset = buffer.readUInt32LE(eocd + 16);

  if (cenOffset === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buffer.readUInt32LE(locator) === 0x07064b50) {
      const z64 = Number(buffer.readBigUInt64LE(locator + 8));
      if (buffer.readUInt32LE(z64) === 0x06064b50) {
        count = Number(buffer.readBigUInt64LE(z64 + 32));
        cenSize = Number(buffer.readBigUInt64LE(z64 + 40));
        cenOffset = Number(buffer.readBigUInt64LE(z64 + 48));
      }
    }
  }
  if (cenOffset < 0 || cenOffset >= buffer.length) throw new Error('ZIP 中央目录损坏');

  const entries = [];
  let p = cenOffset;
  const end = Math.min(buffer.length, cenOffset + cenSize);
  while (p + 46 <= end && buffer.readUInt32LE(p) === SIG_CEN) {
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    let compSize = buffer.readUInt32LE(p + 20);
    let uncompSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    let localOffset = buffer.readUInt32LE(p + 42);
    const nameBuf = buffer.subarray(p + 46, p + 46 + nameLen);
    const name = decodeName(nameBuf, flags);

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      let ep = p + 46 + nameLen;
      const epEnd = ep + extraLen;
      while (ep + 4 <= epEnd) {
        const id = buffer.readUInt16LE(ep);
        const size = buffer.readUInt16LE(ep + 2);
        if (id === 0x0001) {
          let fp = ep + 4;
          if (uncompSize === 0xffffffff && fp + 8 <= ep + 4 + size) {
            uncompSize = Number(buffer.readBigUInt64LE(fp));
            fp += 8;
          }
          if (compSize === 0xffffffff && fp + 8 <= ep + 4 + size) {
            compSize = Number(buffer.readBigUInt64LE(fp));
            fp += 8;
          }
          if (localOffset === 0xffffffff && fp + 8 <= ep + 4 + size) {
            localOffset = Number(buffer.readBigUInt64LE(fp));
          }
          break;
        }
        ep += 4 + size;
      }
    }

    entries.push({
      name,
      flags,
      method,
      compSize,
      uncompSize,
      localOffset,
      isDir: name.endsWith('/') || name.endsWith('\\'),
      encrypted: (flags & 1) === 1,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZipEntry(buffer, entry) {
  const p = entry.localOffset;
  if (buffer.readUInt32LE(p) !== SIG_LOC) throw new Error(`条目损坏: ${entry.name}`);
  const nameLen = buffer.readUInt16LE(p + 26);
  const extraLen = buffer.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const raw = buffer.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的 ZIP 压缩方式 (${entry.method}): ${entry.name}`);
}

export function isZip(buffer) {
  return buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}
