// 実際にQRコードを生成し、わざと壊して読み取らせて、解析結果を確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readBarcodes, writeBarcode, prepareZXingModule } from 'zxing-wasm/full';
import { analyze } from '../js/analyze.js';
import { getBlockInfo } from '../js/tables.js';

prepareZXingModule({
  overrides: {
    wasmBinary: fs.readFileSync(new URL('../node_modules/zxing-wasm/dist/full/zxing_full.wasm', import.meta.url)),
  },
});

const SCALE = 6;
const QUIET = 4;

/** シンボルを画像にする。flip(x, y) が true のモジュールは白黒を反転させる */
function render(symbol, flip = () => false) {
  const W = (symbol.width + QUIET * 2) * SCALE;
  const H = (symbol.height + QUIET * 2) * SCALE;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < symbol.height; y++) {
    for (let x = 0; x < symbol.width; x++) {
      const dark = (symbol.data[y * symbol.width + x] < 128) !== flip(x, y);
      if (!dark) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const i = (((y + QUIET) * SCALE + dy) * W + (x + QUIET) * SCALE + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: W, height: H, colorSpace: 'srgb' };
}

async function make(format, options, text = 'https://example.com/qr-damage-checker') {
  const w = await writeBarcode(text, { format, options });
  assert.equal(w.error, '');
  return w.symbol;
}

async function read(image) {
  const results = await readBarcodes(image, { formats: [], tryHarder: true, returnErrors: true });
  return results.map(analyze);
}

test('無傷のQRコードは破損率0%', async () => {
  const symbol = await make('QRCode', 'ecLevel=M,version=5,dataMask=3');
  const [r] = await read(render(symbol));
  assert.equal(r.formatName, 'QRコード モデル2');
  assert.equal(r.version.label, '5');
  assert.equal(r.version.size, '37×37');
  assert.equal(r.ecLevel, 'M');
  assert.equal(r.mask, 3);
  assert.equal(r.damage, 0);
  assert.equal(r.rating.key, 'perfect');
  assert.deepEqual(r.blocks, { totalCodewords: 134, blocks: 2, eccPerBlock: 24, maxCorrectable: 12, corrected: 0 });
});

test('壊したコードワードの数がそのまま訂正数として出る（バージョン1-H）', async () => {
  const symbol = await make('QRCode', 'ecLevel=H,version=1', 'HELLO');
  // バージョン1のコードワードは右下から2列幅・4行ずつジグザグに並ぶ
  const up = [[17, 20], [13, 16], [9, 12]];
  const down = [...up].reverse();
  const codewords = [
    ...up.map((r) => [19, r]),
    ...down.map((r) => [17, r]),
    ...up.map((r) => [15, r]),
  ];
  const flipFirst = (k) => (x, y) =>
    codewords.slice(0, k).some(([c, [a, b]]) => (x === c || x === c + 1) && y >= a && y <= b);

  for (let k = 0; k <= 8; k++) {
    const [r] = await read(render(symbol, flipFirst(k)));
    assert.equal(r.valid, true, `${k}個壊したとき`);
    assert.equal(r.blocks.corrected, k, `${k}個壊したとき`);
    assert.equal(r.blocks.maxCorrectable, 8);
    assert.equal(r.damage, k / 8);
  }
  // 上限（8個）を超えると、QRコードとして見つかるが訂正できない
  const [r] = await read(render(symbol, flipFirst(9)));
  assert.equal(r.valid, false);
  assert.equal(r.damage, Infinity);
  assert.equal(r.rating.key, 'fail');
  assert.equal(r.version.label, '1');
  assert.equal(r.ecLevel, 'H');
});

test('破損を増やすと破損率が上がり、限界を超えると読み取り不可になる', async () => {
  const symbol = await make('QRCode', 'ecLevel=L,version=3');
  const n = symbol.width;
  let last = -1;
  let failed = false;
  for (let s = 1; s <= 12; s++) {
    // 右下（データ領域）を s×s モジュールぶん反転
    const flip = (x, y) => x >= n - 1 - s && x < n - 1 && y >= n - 1 - s && y < n - 1;
    const rs = await read(render(symbol, flip));
    if (rs.length === 0 || !rs[0].valid) {
      failed = true;
      if (rs.length) assert.equal(rs[0].rating.key, 'fail');
      break;
    }
    assert.ok(rs[0].damage >= last, `s=${s}`);
    assert.ok(rs[0].blocks.corrected <= rs[0].blocks.maxCorrectable);
    last = rs[0].damage;
  }
  assert.ok(last > 0);
  assert.ok(failed, '最後には読めなくなるはず');
});

test('マイクロQRコードとrMQRコードの規格を判別できる', async () => {
  const [micro] = await read(render(await make('MicroQRCode', 'ecLevel=M,version=4', 'MICRO')));
  assert.equal(micro.formatName, 'マイクロQRコード');
  assert.equal(micro.version.label, 'M4');
  assert.equal(micro.version.size, '17×17');
  assert.equal(micro.damage, 0);
  assert.equal(micro.blocks.eccPerBlock, 10);

  const [rmqr] = await read(render(await make('RMQRCode', 'ecLevel=H', 'RMQR')));
  assert.equal(rmqr.formatName, 'rMQRコード（長方形）');
  assert.match(rmqr.version.label, /^R\d+x\d+$/);
  assert.equal(rmqr.damage, 0);
  assert.equal(rmqr.blocks, null);
});

test('ブロック構成表の整合性', () => {
  for (let v = 1; v <= 40; v++) {
    for (const l of ['L', 'M', 'Q', 'H']) {
      const b = getBlockInfo('QR', v, l);
      assert.ok(b.blocks * b.eccPerBlock < b.totalCodewords, `${v}-${l}`);
      assert.ok(b.eccPerBlock <= 30, `${v}-${l}`);
    }
  }
  assert.deepEqual(getBlockInfo('QR', 40, 'H'), { totalCodewords: 3706, blocks: 81, eccPerBlock: 30 });
});
