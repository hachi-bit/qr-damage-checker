// QRコード用のリード・ソロモン復号（GF(256)、原始多項式 x^8+x^4+x^3+x^2+1）
// 誤りの位置を知るために自前で実装している（読み取りライブラリは位置を返さないため）

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a, b) => (a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]);
const inv = (a) => EXP[255 - LOG[a]];

/** 昇べきの多項式 p を x で評価する */
function evalPoly(p, x) {
  let y = 0;
  for (let i = p.length - 1; i >= 0; i--) y = mul(y, x) ^ p[i];
  return y;
}

/**
 * 1ブロックを復号する。
 * @param {number[]} block データ＋誤り訂正コードワード（先頭が最高次）
 * @param {number} numEcc 誤り訂正コードワード数
 * @returns {{corrected:number[], errorPositions:number[]} | null} 訂正できなければ null
 */
export function rsDecode(block, numEcc) {
  const n = block.length;
  // シンドローム S_j = r(α^j)（QRの生成多項式の根は α^0〜α^(numEcc-1)）
  const S = new Array(numEcc);
  let clean = true;
  for (let j = 0; j < numEcc; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s = mul(s, EXP[j]) ^ block[i];
    S[j] = s;
    if (s) clean = false;
  }
  if (clean) return { corrected: block.slice(), errorPositions: [] };

  // バーレカンプ・マッシー法で誤り位置多項式 Λ を求める
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let k = 0; k < numEcc; k++) {
    let d = S[k];
    for (let i = 1; i <= L; i++) d ^= mul(C[i] ?? 0, S[k - i]);
    if (d === 0) {
      m++;
      continue;
    }
    const coef = div(d, b);
    const next = C.slice();
    for (let i = 0; i < B.length; i++) {
      next[i + m] = (next[i + m] ?? 0) ^ mul(coef, B[i]);
    }
    for (let i = 0; i < next.length; i++) next[i] ??= 0;
    if (2 * L <= k) {
      B = C;
      L = k + 1 - L;
      b = d;
      m = 1;
    } else {
      m++;
    }
    C = next;
  }
  if (2 * L > numEcc) return null;

  // チェン探索で誤り位置を探す。位置 i（先頭から）の次数は n-1-i
  const positions = [];
  const locators = [];
  for (let i = 0; i < n; i++) {
    const X = EXP[(n - 1 - i) % 255];
    if (evalPoly(C, inv(X)) === 0) {
      positions.push(i);
      locators.push(X);
    }
  }
  if (positions.length !== L) return null;

  // フォーニーの公式で誤りの値を求める（Ω = S·Λ mod x^numEcc）
  const omega = new Array(numEcc).fill(0);
  for (let i = 0; i < numEcc; i++) {
    for (let j = 0; j < C.length && i + j < numEcc; j++) omega[i + j] ^= mul(S[i], C[j]);
  }
  const deriv = C.map((c, i) => (i % 2 === 1 ? c : 0)).slice(1);
  const corrected = block.slice();
  for (let k = 0; k < positions.length; k++) {
    const Xinv = inv(locators[k]);
    const denom = evalPoly(deriv, Xinv);
    if (denom === 0) return null;
    corrected[positions[k]] ^= mul(locators[k], div(evalPoly(omega, Xinv), denom));
  }
  return { corrected, errorPositions: positions };
}
