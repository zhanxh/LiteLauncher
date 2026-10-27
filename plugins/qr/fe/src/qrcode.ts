/**
 * 离线 QR 编码器：ISO/IEC 18004 的一个够用子集——字节模式（UTF-8）、纠错等级 M、
 * 版本 1–20，8 种掩码全试后按罚分择优。纯计算、零 DOM、零依赖。
 *
 * 为什么手写而不引第三方库：插件 fe 只允许 import `@ll/sdk` / `solid-js` / `@ll/ui`
 * 和自己的相对文件；而借道公共图片 API 意味着断网即不可用，且待编码的内容（常常是
 * 内网地址、口令、私人链接）会原样发给第三方。
 *
 * 为什么裁到 v20-M（≈666 字节）：再长的内容本来就在屏幕上扫不出来，而把 4 个纠错
 * 等级 × 40 个版本的字典表搬进来只放大转录出错面，换不到可用收益。
 */

/** 字节模式指示符（spec 8.4.2） */
const MODE_BYTE = 0b0100;
/** 补位字节，交替使用（spec 8.4.9） */
const PAD_FIRST = 0xec;
const PAD_SECOND = 0x11;
/** 留白模块数：spec 要求 4。必须画进图里——贴到深色背景上时透明留白会让码扫不出来 */
const QUIET_ZONE = 4;
/** 等级 M 在格式信息里的类型位（L=01 / M=00 / Q=11 / H=10） */
const FORMAT_TYPE_BITS_M = 0b00;
/** 格式信息 BCH 生成多项式与固定掩码（spec 8.9） */
const G15 = 0b10100110111;
const G15_MASK = 0b101010000010010;
/** 版本信息 BCH 生成多项式（spec 8.10，仅 v≥7 用到） */
const G18 = 0b1111100100101;
const MIN_VERSION = 1;
const MAX_VERSION = 20;

/**
 * 等级 M 的分块表（v1…v20）：每项是若干 `[块数, 块总码字, 块数据码字]` 三元组。
 * 纠错码字数 = 总码字 − 数据码字，同版本各块一致。
 *
 * 这张表只能抄对、没法推导，因此加了 sum 校验的常驻单测（见 tools/test-fe-plugins.mjs
 * 的 testQrcodeModule），并与参考实现的矩阵逐条比对。
 */
const RS_BLOCKS_M: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  [[1, 26, 16]],
  [[1, 44, 28]],
  [[1, 70, 44]],
  [[2, 50, 32]],
  [[2, 67, 43]],
  [[4, 43, 27]],
  [[4, 49, 31]],
  [[2, 60, 38], [2, 61, 39]],
  [[3, 58, 36], [2, 59, 37]],
  [[4, 69, 43], [1, 70, 44]],
  [[1, 80, 50], [4, 81, 51]],
  [[6, 58, 36], [2, 59, 37]],
  [[8, 59, 37], [1, 60, 38]],
  [[4, 64, 40], [5, 65, 41]],
  [[5, 65, 41], [5, 66, 42]],
  [[7, 73, 45], [3, 74, 46]],
  [[10, 74, 46], [1, 75, 47]],
  [[9, 69, 43], [4, 70, 44]],
  [[3, 70, 44], [11, 71, 45]],
  [[3, 67, 41], [13, 68, 42]],
];

/** 对齐图形中心坐标（v1…v20）；同样是抄来的表，与分块表一起做常驻校验 */
const ALIGNMENT_CENTERS: ReadonlyArray<ReadonlyArray<number>> = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
];

/** GF(256) 指数/对数表，本原多项式 x⁸+x⁴+x³+x²+1 */
const { GF_EXP, GF_LOG } = (() => {
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if ((x & 0x100) !== 0) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255];
  return { GF_EXP: exp, GF_LOG: log };
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function bitLength(value: number): number {
  let bits = 0;
  let v = value;
  while (v > 0) {
    bits += 1;
    v >>>= 1;
  }
  return bits;
}

/**
 * BCH 余数：把 `num` 当作多项式对 `gen` 取模（按最高次对齐逐次消元）。
 * 传进来的是**已按校验位数左移**的消息（如 `data << 10`），不是原始数据——
 * 余数就是校验位本身，这一步弄错会让格式/版本信息整体算歪，码照样能画出来但扫不出来。
 */
function bchRemainder(num: number, gen: number): number {
  const genDegree = bitLength(gen) - 1;
  let rem = num;
  while (rem !== 0 && bitLength(rem) - 1 >= genDegree) {
    rem ^= gen << (bitLength(rem) - 1 - genDegree);
  }
  return rem;
}

function blocksOf(version: number) {
  return RS_BLOCKS_M[version - MIN_VERSION];
}

/** 该版本等级 M 的数据码字数（含交织前的总位宽） */
function dataCodewords(version: number): number {
  let sum = 0;
  for (const [count, , data] of blocksOf(version)) sum += count * data;
  return sum;
}

/** 字节计数字段位宽：v1–9 用 8 位，v10+ 用 16 位（spec Table 3） */
function charCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/** 某版本能装下的 UTF-8 字节数上限（扣掉模式指示符与计数字段） */
function byteCapacity(version: number): number {
  const availableBits = dataCodewords(version) * 8;
  return Math.floor((availableBits - 4 - charCountBits(version)) / 8);
}

/** 全部内容都编不进 v1–20 时返回的版本 20 上限（给用户的提示要用这个数字） */
export const MAX_BYTE_LENGTH = byteCapacity(MAX_VERSION);

/** RS 生成多项式，首项系数 1 省略，剩余 `degree` 个系数按最高次在前存储 */
function rsGenerator(degree: number): Uint8Array {
  let poly = Uint8Array.of(1);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  const gen = new Uint8Array(degree);
  gen.set(poly.subarray(1), 0);
  return gen;
}

/** 求一个数据块的纠错码字（多项式取模的余数） */
function rsEncode(data: Uint8Array, ecLength: number): Uint8Array {
  const gen = rsGenerator(ecLength);
  const rem = new Uint8Array(ecLength);
  for (const byte of data) {
    const lead = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLength - 1] = 0;
    if (lead !== 0) {
      for (let i = 0; i < ecLength; i += 1) rem[i] ^= gfMul(gen[i], lead);
    }
  }
  return rem;
}

/**
 * 掩码函数（spec Table 12），返回 true 表示该模块需要反色。
 * `row`/`col` 为矩阵坐标，左上角是 (0,0)。
 */
function maskBit(pattern: number, row: number, col: number): boolean {
  switch (pattern) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/** 罚分用的 1:1:3:1:1 图形（spec 8.8.2.4），前后各带 4 个亮模块 */
const FINDER_LIKE = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const FINDER_LIKE_REVERSED = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

function sameWindow(modules: Uint8Array[], line: number, from: number, pattern: number[], vertical: boolean): boolean {
  for (let k = 0; k < pattern.length; k += 1) {
    const value = vertical ? modules[from + k][line] : modules[line][from + k];
    if (value !== pattern[k]) return false;
  }
  return true;
}

/**
 * 掩码罚分（spec 8.8.2）：连续同色、2×2 同色块、类定位图形、深色比例四项相加。
 * 罚分只影响"好不好扫"，选错掩码不会导致解不出来，但会让纠错裕度变差。
 */
function penalty(modules: Uint8Array[], size: number): number {
  let total = 0;

  // N1：行/列上长度 ≥5 的同色连续段
  const scoreRuns = (read: (index: number) => number) => {
    let runLength = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && read(i) === read(i - 1)) {
        runLength += 1;
      } else {
        if (runLength >= 5) total += 3 + (runLength - 5);
        runLength = 1;
      }
    }
  };
  for (let line = 0; line < size; line += 1) {
    scoreRuns((i) => modules[line][i]);
    scoreRuns((i) => modules[i][line]);
  }

  // N2：2×2 同色块，每块 3 分
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const a = modules[row][col];
      if (a === modules[row][col + 1] && a === modules[row + 1][col] && a === modules[row + 1][col + 1]) {
        total += 3;
      }
    }
  }

  // N3：类定位图形，每处 40 分
  for (let line = 0; line < size; line += 1) {
    for (let from = 0; from + FINDER_LIKE.length <= size; from += 1) {
      if (sameWindow(modules, line, from, FINDER_LIKE, false)) total += 40;
      if (sameWindow(modules, line, from, FINDER_LIKE_REVERSED, false)) total += 40;
      if (sameWindow(modules, line, from, FINDER_LIKE, true)) total += 40;
      if (sameWindow(modules, line, from, FINDER_LIKE_REVERSED, true)) total += 40;
    }
  }

  // N4：深色比例每偏离 50% 一个 5% 档扣 10 分
  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) dark += modules[row][col];
  }
  const cells = size * size;
  total += Math.floor(Math.abs(dark * 20 - cells * 10) / cells) * 10;

  return total;
}

export interface QRCode {
  version: number;
  /** 矩阵边长（模块数，不含留白） */
  size: number;
  /** `modules[row][col]`：1 = 深色 */
  modules: Uint8Array[];
  mask: number;
}

export type EncodeResult =
  | { ok: true; code: QRCode }
  | { ok: false; reason: 'too-long'; bytes: number; capacity: number };

/** 位流写入器：QR 的头部字段是按位（不是按字节）拼接的 */
class BitBuffer {
  private bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  /** 补齐到整字节，再按容量交替补 0xEC/0x11（spec 8.4.9） */
  toCodewords(capacityCodewords: number): Uint8Array {
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    const out = new Uint8Array(capacityCodewords);
    for (let i = 0; i < this.bits.length / 8 && i < capacityCodewords; i += 1) {
      let byte = 0;
      for (let b = 0; b < 8; b += 1) byte = (byte << 1) | this.bits[i * 8 + b];
      out[i] = byte;
    }
    for (let i = this.bits.length / 8; i < capacityCodewords; i += 1) {
      out[i] = (i - this.bits.length / 8) % 2 === 0 ? PAD_FIRST : PAD_SECOND;
    }
    return out;
  }
}

/** 选出版本：取能装下的最小一档；全部装不下返回 null */
function pickVersion(byteLength: number): number | null {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
    if (byteLength <= byteCapacity(version)) return version;
  }
  return null;
}

/** 数据码字 → 按块切分 → RS 编码 → 交织成最终码字序列（spec 8.6） */
function interleave(codewords: Uint8Array, version: number): Uint8Array {
  const groups = blocksOf(version);
  // 同一版本各块的纠错码字数相同（= 块总码字 − 块数据码字）
  const ecLength = groups[0][1] - groups[0][2];
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, , data] of groups) {
    for (let i = 0; i < count; i += 1) {
      const block = codewords.subarray(offset, offset + data);
      offset += data;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecLength));
    }
  }

  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) out.push(block[i]);
    }
  }
  for (let i = 0; i < ecLength; i += 1) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return Uint8Array.from(out);
}

/** 一张待写入的矩阵：图形模块与"已占用"标记分开记录 */
class MatrixBuilder {
  readonly size: number;
  readonly modules: Uint8Array[];
  readonly reserved: Uint8Array[];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Uint8Array(this.size));
    this.reserved = Array.from({ length: this.size }, () => new Uint8Array(this.size));
  }

  /** 写功能图形：值固定，且永远不参与掩码与数据摆放 */
  setFunction(row: number, col: number, value: number): void {
    if (row < 0 || col < 0 || row >= this.size || col >= this.size) return;
    this.modules[row][col] = value;
    this.reserved[row][col] = 1;
  }

  /** 只占位（格式/版本信息的数值要等掩码定了再写） */
  markReserved(row: number, col: number): void {
    if (row < 0 || col < 0 || row >= this.size || col >= this.size) return;
    this.reserved[row][col] = 1;
  }

  placeFinder(row: number, col: number): void {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        // 7×7 的环：d=3 与 d≤1 深色，d=2 亮；外围一圈分隔符恒亮
        const dark = r < 0 || r > 6 || c < 0 || c > 6 ? 0 : ring === 3 || ring <= 1 ? 1 : 0;
        this.setFunction(row + r, col + c, dark);
      }
    }
  }

  placeTiming(): void {
    for (let i = 8; i < this.size - 8; i += 1) {
      const value = i % 2 === 0 ? 1 : 0;
      this.setFunction(6, i, value);
      this.setFunction(i, 6, value);
    }
  }

  placeAlignments(): void {
    const centers = ALIGNMENT_CENTERS[this.version - MIN_VERSION];
    const last = centers.length - 1;
    for (let i = 0; i <= last; i += 1) {
      for (let j = 0; j <= last; j += 1) {
        // 只有落在三个定位图形角落上的中心不画（i/j 的首末组合）。
        // 不能拿 reserved 判断：v7 起中心会落在定时线上，那些对齐图形照样要画。
        const onFinder =
          (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
        if (onFinder) continue;
        const row = centers[i];
        const col = centers[j];
        for (let r = -2; r <= 2; r += 1) {
          for (let c = -2; c <= 2; c += 1) {
            const ring = Math.max(Math.abs(r), Math.abs(c));
            this.setFunction(row + r, col + c, ring === 1 ? 0 : 1);
          }
        }
      }
    }
  }

  reserveFormatAreas(): void {
    for (let i = 0; i <= 8; i += 1) {
      if (i === 6) continue; // 第 6 行/列是定时线，不属于格式信息
      this.markReserved(8, i);
      this.markReserved(i, 8);
    }
    for (let i = 0; i < 8; i += 1) {
      this.markReserved(8, this.size - 1 - i);
      this.markReserved(this.size - 1 - i, 8);
    }
    // 恒定暗模块（spec 8.8）
    this.setFunction(this.size - 8, 8, 1);
  }

  placeVersionInfo(): void {
    if (this.version < 7) return;
    const shifted = this.version << 12;
    const bits = shifted | bchRemainder(shifted, G18);
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        const value = (bits >>> (i * 3 + j)) & 1;
        this.setFunction(this.size - 11 + j, i, value);
        this.setFunction(i, this.size - 11 + j, value);
      }
    }
  }

  placeFormatInfo(mask: number): void {
    const data = (FORMAT_TYPE_BITS_M << 3) | mask;
    const shifted = data << 10;
    const bits = ((shifted | bchRemainder(shifted, G15)) ^ G15_MASK) >>> 0;
    const bitAt = (i: number) => (bits >>> i) & 1;
    // setFunction 的坐标是 (row, col)：左列沿 col=8 向下，顶行沿 row=8 向左
    for (let i = 0; i <= 5; i += 1) this.setFunction(i, 8, bitAt(i));
    this.setFunction(7, 8, bitAt(6));
    this.setFunction(8, 8, bitAt(7));
    this.setFunction(8, 7, bitAt(8));
    for (let i = 9; i < 15; i += 1) this.setFunction(8, 14 - i, bitAt(i));
    for (let i = 0; i < 8; i += 1) this.setFunction(8, this.size - 1 - i, bitAt(i));
    for (let i = 8; i < 15; i += 1) this.setFunction(this.size - 15 + i, 8, bitAt(i));
    this.setFunction(this.size - 8, 8, 1);
  }

  /** 码字按"两列一组、从右下角蛇形向上"写入空闲模块（spec 8.5） */
  placeCodewords(codewords: Uint8Array): void {
    let index = 0;
    const totalBits = codewords.length * 8;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // 跳过第 6 列（垂直定时线）
      const upward = ((right + 1) & 2) === 0;
      for (let step = 0; step < this.size; step += 1) {
        for (let j = 0; j < 2; j += 1) {
          const col = right - j;
          const row = upward ? this.size - 1 - step : step;
          if (this.reserved[row][col] === 1) continue;
          // 装不满的余数位（remainder bits）保持为 0，随后照样参与掩码
          const bit = index < totalBits ? (codewords[index >>> 3] >>> (7 - (index & 7))) & 1 : 0;
          this.modules[row][col] = bit;
          index += 1;
        }
      }
    }
  }

  clone(): MatrixBuilder {
    const copy = new MatrixBuilder(this.version);
    for (let i = 0; i < this.size; i += 1) {
      copy.modules[i].set(this.modules[i]);
      copy.reserved[i].set(this.reserved[i]);
    }
    return copy;
  }

  applyMask(mask: number): void {
    for (let row = 0; row < this.size; row += 1) {
      for (let col = 0; col < this.size; col += 1) {
        if (this.reserved[row][col] === 1) continue;
        if (maskBit(mask, row, col)) this.modules[row][col] ^= 1;
      }
    }
  }
}

/** 按容量挑版本、编 RS、摆图形、试 8 种掩码取罚分最小者 */
export function encodeQR(text: string): EncodeResult {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  if (version === null) {
    return { ok: false, reason: 'too-long', bytes: bytes.length, capacity: MAX_BYTE_LENGTH };
  }

  const capacity = dataCodewords(version);
  const buffer = new BitBuffer();
  buffer.push(MODE_BYTE, 4);
  buffer.push(bytes.length, charCountBits(version));
  for (const byte of bytes) buffer.push(byte, 8);
  const codewords = buffer.toCodewords(capacity);

  const builder = new MatrixBuilder(version);
  builder.placeFinder(0, 0);
  builder.placeFinder(0, builder.size - 7);
  builder.placeFinder(builder.size - 7, 0);
  builder.placeTiming();
  builder.placeAlignments();
  builder.reserveFormatAreas();
  builder.placeVersionInfo();
  builder.placeCodewords(interleave(codewords, version));

  let best: MatrixBuilder | null = null;
  let bestMask = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const attempt = builder.clone();
    attempt.applyMask(mask);
    attempt.placeFormatInfo(mask);
    const score = penalty(attempt.modules, attempt.size);
    if (score < bestScore) {
      bestScore = score;
      best = attempt;
      bestMask = mask;
    }
  }

  /* 8 个掩码都会算出有限罚分，best 不可能为空——只为类型收窄 */
  const chosen = best as MatrixBuilder;
  return {
    ok: true,
    code: { version, size: chosen.size, modules: chosen.modules, mask: bestMask },
  };
}

/**
 * 矩阵 → 自包含 SVG 的 data URL（面板行图标只吃 `<img src>`）。
 *
 * 两个刻意的取舍：白底与 4 模块留白画进图里（暗色主题下透明底扫不出来），
 * 深色模块合并成**单个** `<path>`（逐模块 `<rect>` 会让 v20 的 data URL 涨到几百 KB，
 * 而每次击键都要换一遍 `<img src>`）。
 */
export function toSVGDataURL(code: QRCode): string {
  const edge = code.size + QUIET_ZONE * 2;
  const runs: string[] = [];
  for (let row = 0; row < code.size; row += 1) {
    let col = 0;
    while (col < code.size) {
      if (code.modules[row][col] === 0) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < code.size && code.modules[row][col] === 1) col += 1;
      const x = start + QUIET_ZONE;
      const y = row + QUIET_ZONE;
      runs.push(`M${x} ${y}h${col - start}v1h-${col - start}z`);
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${edge}" height="${edge}" ` +
    `viewBox="0 0 ${edge} ${edge}" shape-rendering="crispEdges">` +
    `<rect width="${edge}" height="${edge}" fill="#fff"/>` +
    `<path fill="#000" d="${runs.join('')}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 供测试与提示使用：版本 → 边长（不含留白） */
export function moduleCount(version: number): number {
  return version * 4 + 17;
}

export { byteCapacity, dataCodewords, RS_BLOCKS_M, ALIGNMENT_CENTERS, QUIET_ZONE };
