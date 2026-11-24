// A QR code encoder for short texts such as addresses: byte mode, error correction level L,
// versions 1 to 10, mask 0. ISO/IEC 18004.

const RAW = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ECC = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const BLOCKS = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The modules of the QR code of `text`, dark as true, or null when it does not fit version 10. */
export function qrMatrix(text: string): boolean[][] | null {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 0;
  let dataLen = 0;
  for (let v = 1; v <= 10; v++) {
    dataLen = RAW[v - 1] - ECC[v - 1] * BLOCKS[v - 1];
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataLen * 8) {
      ver = v;
      break;
    }
  }
  if (!ver) return null;

  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(4, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataLen * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < dataLen; pad ^= 0xec ^ 0x11) data.push(pad);

  const eccLen = ECC[ver - 1];
  const numBlocks = BLOCKS[ver - 1];
  const raw = RAW[ver - 1];
  const divisor: number[] = Array(eccLen).fill(0);
  divisor[eccLen - 1] = 1;
  for (let i = 0, root = 1; i < eccLen; i++) {
    for (let j = 0; j < eccLen; j++) {
      divisor[j] = gfMul(divisor[j], root);
      if (j + 1 < eccLen) divisor[j] ^= divisor[j + 1];
    }
    root = gfMul(root, 2);
  }
  const remainder = (block: number[]) => {
    const res: number[] = Array(eccLen).fill(0);
    for (const b of block) {
      const factor = b ^ (res.shift() as number);
      res.push(0);
      divisor.forEach((c, i) => {
        res[i] ^= gfMul(c, factor);
      });
    }
    return res;
  };
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = remainder(dat);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= numShort) codewords.push(b[i]);
    });
  }

  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const fn = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    m[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const al = ALIGN[ver - 1];
  al.forEach((ay, i) =>
    al.forEach((ax, j) => {
      const last = al.length - 1;
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }),
  );

  // format information: level L, mask 0
  let rem = 1 << 3;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const format = (((1 << 3) << 10) | rem) ^ 0x5412;
  const formatBit = (i: number) => ((format >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, formatBit(i));
  set(8, 7, formatBit(6));
  set(8, 8, formatBit(7));
  set(7, 8, formatBit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, formatBit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, formatBit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, formatBit(i));
  set(8, size - 8, true);

  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const version = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      const dark = ((version >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      set(a, c, dark);
      set(c, a, dark);
    }
  }

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) {
          m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!fn[y][x] && (x + y) % 2 === 0) m[y][x] = !m[y][x];
    }
  }
  return m;
}

/** The QR code of `text` as an SVG element with a quiet zone. */
export function qrSvg(text: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const m = qrMatrix(text);
  if (!m) return svg;
  const quiet = 3;
  svg.setAttribute("viewBox", `0 0 ${m.length + 2 * quiet} ${m.length + 2 * quiet}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code of the deposit address");
  let d = "";
  m.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }),
  );
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#16202b");
  svg.append(path);
  return svg;
}
