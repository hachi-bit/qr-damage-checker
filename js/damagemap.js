// 読み取ったQRコード（モデル2）の各マスを「本来あるべき模様」と比べ、壊れているマスを探す。
//
// 手順:
//   1. 読み取りライブラリが返すマスの白黒（symbol）からデータ部分を取り出し、
//      マスクを外してコードワード列に戻す
//   2. ブロックに分けてリード・ソロモン復号し、正しいコードワードを得る
//   3. 正しいコードワードと、規格どおりの位置検出パターンなどから理想の模様を作る
//   4. 写っていた模様と1マスずつ比べる
import { getBlockInfo, ALIGNMENT_CENTERS } from './tables.js';
import { rsDecode } from './reedsolomon.js';

const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** BCH 符号の剰余を付ける */
function bch(value, poly, shift) {
  const msb = (v) => 31 - Math.clz32(v);
  let r = value << shift;
  while (r && msb(r) >= msb(poly)) r ^= poly << (msb(r) - msb(poly));
  return (value << shift) | r;
}

/**
 * 機能パターン（データ以外）の理想の模様を作る。
 * @returns {{size:number, func:Uint8Array, ideal:Int8Array}} func=1 が機能パターン、ideal は 1=黒 0=白 -1=未定
 */
function buildFunctionPatterns(version, ecLevel, mask) {
  const n = 17 + 4 * version;
  const func = new Uint8Array(n * n);
  const ideal = new Int8Array(n * n).fill(-1);
  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    func[y * n + x] = 1;
    ideal[y * n + x] = dark ? 1 : 0;
  };

  // 位置検出パターンと分離パターン
  for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        set(fx + dx, fy + dy, d !== 2 && d <= 3);
      }
    }
  }
  // タイミングパターン
  for (let i = 8; i < n - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  // 位置合わせパターン（位置検出パターンと重なるものは除く）
  const centers = ALIGNMENT_CENTERS[version - 1];
  for (const cy of centers) {
    for (const cx of centers) {
      const inFinder = (cx < 9 && cy < 9) || (cx > n - 9 && cy < 9) || (cx < 9 && cy > n - 9);
      if (inFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // 形式情報（誤り訂正レベルとマスク）
  const format = bch((EC_BITS[ecLevel] << 3) | mask, 0x537, 10) ^ 0x5412;
  const formatCoords = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  for (let i = 0; i < 15; i++) {
    const bit = (format >> i) & 1;
    set(formatCoords[i][0], formatCoords[i][1], bit);
    if (i < 8) set(n - 1 - i, 8, bit);
    else set(8, n - 15 + i, bit);
  }
  set(8, n - 8, true); // 常に黒のマス
  // 型番情報（バージョン7以上）
  if (version >= 7) {
    const info = bch(version, 0x1f25, 12);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        const bit = (info >> (i * 3 + j)) & 1;
        set(i, n - 11 + j, bit);
        set(n - 11 + j, i, bit);
      }
    }
  }
  return { size: n, func, ideal };
}

/** データを置くマスの座標を、規格の配置順（右下から2列ずつ上下に往復）で返す */
function dataCoordinates(n, func) {
  const coords = [];
  let upward = true;
  for (let right = n - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < n; k++) {
      const y = upward ? n - 1 - k : k;
      for (const x of [right, right - 1]) if (!func[y * n + x]) coords.push([x, y]);
    }
    upward = !upward;
  }
  return coords;
}

/** 総コードワード列をブロックごとに分ける（インターリーブを戻す） */
function splitBlocks(codewords, info) {
  const { totalCodewords, blocks: numBlocks, eccPerBlock } = info;
  const totalData = totalCodewords - numBlocks * eccPerBlock;
  const shortLen = Math.floor(totalData / numBlocks);
  const numLong = totalData % numBlocks;
  const blocks = [];
  const indexes = []; // 各ブロックのコードワードが、総コードワード列の何番目か
  for (let b = 0; b < numBlocks; b++) {
    blocks.push([]);
    indexes.push([]);
  }
  let p = 0;
  for (let i = 0; i <= shortLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i === shortLen && b < numBlocks - numLong) continue;
      blocks[b].push(codewords[p]);
      indexes[b].push(p++);
    }
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      blocks[b].push(codewords[p]);
      indexes[b].push(p++);
    }
  }
  return { blocks, indexes };
}

function decodeGrid(grid, n, version, ecLevel, mask) {
  const { func, ideal } = buildFunctionPatterns(version, ecLevel, mask);
  const info = getBlockInfo('QR', version, ecLevel);
  const coords = dataCoordinates(n, func);
  const maskFn = MASKS[mask];

  // マスクを外してコードワードに戻す（余りビットは使わない）
  const codewords = new Array(info.totalCodewords).fill(0);
  for (let i = 0; i < info.totalCodewords * 8; i++) {
    const [x, y] = coords[i];
    const bit = grid[y * n + x] ^ (maskFn(x, y) ? 1 : 0);
    codewords[i >> 3] |= bit << (7 - (i & 7));
  }

  const { blocks, indexes } = splitBlocks(codewords, info);
  const fixed = codewords.slice();
  let maxErrors = 0;
  for (let b = 0; b < blocks.length; b++) {
    const res = rsDecode(blocks[b], info.eccPerBlock);
    if (!res) return null;
    maxErrors = Math.max(maxErrors, res.errorPositions.length);
    res.corrected.forEach((v, i) => (fixed[indexes[b][i]] = v));
  }

  // 正しいコードワードをマスクして理想の模様にする
  for (let i = 0; i < coords.length; i++) {
    const [x, y] = coords[i];
    if (i < info.totalCodewords * 8) {
      const bit = (fixed[i >> 3] >> (7 - (i & 7))) & 1;
      ideal[y * n + x] = bit ^ (maskFn(x, y) ? 1 : 0);
    }
  }

  const damaged = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const want = ideal[y * n + x];
      if (want !== -1 && want !== grid[y * n + x]) damaged.push({ x, y, kind: func[y * n + x] ? 'function' : 'data' });
    }
  }
  return { damaged, maxErrors };
}

/**
 * @param {{width:number,height:number,data:Uint8Array|Uint8ClampedArray}} symbol 読み取ったマスの白黒（0=黒）
 * @param {number} version 1〜40
 * @param {string} ecLevel L/M/Q/H
 * @param {number} mask 0〜7
 * @returns {{size:number, grid:Uint8Array, damaged:{x:number,y:number,kind:'data'|'function'}[], maxErrors:number} | null}
 *   grid は 1=黒。座標は symbol と同じ向き。復号できなければ null
 */
export function findDamage(symbol, version, ecLevel, mask) {
  const n = 17 + 4 * version;
  if (!symbol || symbol.width !== n || symbol.height !== n || !getBlockInfo('QR', version, ecLevel)) return null;
  if (!(mask >= 0 && mask <= 7)) return null;
  const grid = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) grid[i] = symbol.data[i] < 128 ? 1 : 0;

  // 鏡像のQRコードは縦横が入れ替わった向きで返ることがあるので、両方試して壊れたマスが少ない方を採る
  const transposed = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) transposed[x * n + y] = grid[y * n + x];

  const a = decodeGrid(grid, n, version, ecLevel, mask);
  const b = decodeGrid(transposed, n, version, ecLevel, mask);
  if (!a && !b) return null;
  if (a && (!b || a.damaged.length <= b.damaged.length)) return { size: n, grid, ...a };
  return {
    size: n,
    grid,
    maxErrors: b.maxErrors,
    damaged: b.damaged.map((d) => ({ ...d, x: d.y, y: d.x })),
  };
}
