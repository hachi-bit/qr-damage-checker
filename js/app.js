import { analyze } from './analyze.js';

const { prepareZXingModule, readBarcodes } = window.ZXingWASM;

const READER_OPTIONS = {
  formats: ['QRCode', 'MicroQRCode', 'RMQRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  // 訂正しきれなかったQRコードも「読み取り不可」として表示するため、エラーの結果も受け取る
  returnErrors: true,
  maxNumberOfSymbols: 32,
};
// カメラは毎フレーム読むので、重い試行は減らす
const CAMERA_OPTIONS = { ...READER_OPTIONS, tryRotate: false, maxNumberOfSymbols: 8 };
const MAX_IMAGE_SIDE = 4096;
const SCAN_INTERVAL_MS = 250;

const $ = (id) => document.getElementById(id);
const els = {
  file: $('file'),
  drop: $('drop'),
  cameraStart: $('camera-start'),
  camera: $('camera'),
  video: $('video'),
  cameraHint: $('camera-hint'),
  cameraCapture: $('camera-capture'),
  cameraStop: $('camera-stop'),
  status: $('status'),
  output: $('output'),
  canvas: $('canvas'),
  results: $('results'),
  showDamage: $('show-damage'),
};

els.showDamage.addEventListener('change', () => {
  if (last) drawOverlay(last.source, last.results);
});

const ready = prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith('.wasm') ? new URL(`../vendor/zxing-wasm/${path}`, import.meta.url).href : prefix + path,
  },
  fireImmediately: true,
});

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

/* ---------- 解析と表示 ---------- */

async function analyzeCanvas(canvas, options = READER_OPTIONS) {
  await ready;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const raw = await readBarcodes(imageData, options);
  return raw.map(analyze).filter((r) => r.valid || r.damage === Infinity);
}

function percent(damage) {
  return `${Math.round(damage * 100)}%`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

function ratingColor(key) {
  return cssVar(`--${key}`);
}

/** 単位正方形 (0,0)-(1,1) を四角形 p に写す射影変換を返す */
function squareToQuad(p) {
  const { topLeft: a, topRight: b, bottomRight: c, bottomLeft: d } = p;
  const sx = a.x - b.x + c.x - d.x;
  const sy = a.y - b.y + c.y - d.y;
  let g = 0;
  let h = 0;
  if (sx !== 0 || sy !== 0) {
    const dx1 = b.x - c.x;
    const dx2 = d.x - c.x;
    const dy1 = b.y - c.y;
    const dy2 = d.y - c.y;
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  const m = [b.x - a.x + g * b.x, d.x - a.x + h * d.x, a.x, b.y - a.y + g * b.y, d.y - a.y + h * d.y, a.y];
  return (u, v) => {
    const w = g * u + h * v + 1;
    return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w];
  };
}

const DAMAGE_COLOR = { data: '--danger', function: '--warn' };

/** 写真の上に、壊れているマスを塗る */
function drawDamageOnPhoto(ctx, r) {
  const map = r.damageMap;
  if (!map || !r.position || map.damaged.length === 0) return;
  const toImage = squareToQuad(r.position);
  const n = map.size;
  ctx.save();
  ctx.globalAlpha = 0.65;
  for (const d of map.damaged) {
    ctx.fillStyle = cssVar(DAMAGE_COLOR[d.kind]);
    const corners = [[d.x, d.y], [d.x + 1, d.y], [d.x + 1, d.y + 1], [d.x, d.y + 1]].map(([x, y]) => toImage(x / n, y / n));
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawOverlay(source, results) {
  const canvas = els.canvas;
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const line = Math.max(3, Math.round(Math.min(canvas.width, canvas.height) / 200));
  if (els.showDamage.checked) results.forEach((r) => drawDamageOnPhoto(ctx, r));
  results.forEach((r, i) => {
    const p = r.position;
    if (!p) return;
    const color = ratingColor(r.rating.key);
    ctx.strokeStyle = color;
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(p.topLeft.x, p.topLeft.y);
    ctx.lineTo(p.topRight.x, p.topRight.y);
    ctx.lineTo(p.bottomRight.x, p.bottomRight.y);
    ctx.lineTo(p.bottomLeft.x, p.bottomLeft.y);
    ctx.closePath();
    ctx.stroke();

    const radius = line * 5;
    const cx = p.topLeft.x;
    const cy = p.topLeft.y;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${radius * 1.2}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), cx, cy);
  });
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function row(label, value) {
  return [el('dt', {}, label), el('dd', {}, value)];
}

/** QRコードの拡大図を描き、壊れているマスを塗る */
function renderZoom(map) {
  const n = map.size;
  const quiet = 2;
  const cell = Math.max(3, Math.floor(280 / (n + quiet * 2)));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = (n + quiet * 2) * cell;
  canvas.className = 'zoom';
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (map.grid[y * n + x]) ctx.fillRect((x + quiet) * cell, (y + quiet) * cell, cell, cell);
    }
  }
  ctx.globalAlpha = 0.75;
  for (const d of map.damaged) {
    ctx.fillStyle = cssVar(DAMAGE_COLOR[d.kind]);
    ctx.fillRect((d.x + quiet) * cell, (d.y + quiet) * cell, cell, cell);
  }
  return canvas;
}

function renderDamageSection(r) {
  const title = el('h3', {}, '破損箇所');
  if (r.damage === Infinity) {
    return el('section', { class: 'damage-map' }, title, el('p', { class: 'note' }, '読み取れないため、正しい模様が分からず破損箇所は表示できません。'));
  }
  if (!r.damageMap) {
    return el('section', { class: 'damage-map' }, title, el('p', { class: 'note' }, 'この規格では破損箇所の表示に対応していません（通常のQRコード モデル2のみ対応）。'));
  }
  const data = r.damageMap.damaged.filter((d) => d.kind === 'data').length;
  const func = r.damageMap.damaged.length - data;
  const legend = el(
    'ul',
    { class: 'legend' },
    el('li', {}, el('span', { class: 'swatch data' }), `データ部分の傷：${data}マス（破損率に入る）`),
    el('li', {}, el('span', { class: 'swatch function' }), `目印などの傷：${func}マス（破損率には入らない）`),
  );
  const note = data + func === 0 ? el('p', { class: 'note' }, '壊れているマスはありません。') : null;
  return el('section', { class: 'damage-map' }, title, renderZoom(r.damageMap), legend, note);
}

function renderCard(r, index) {
  const failed = r.damage === Infinity;
  const known = r.damage !== null && !failed;

  const head = el('h2', {}, el('span', { class: 'badge' }, String(index + 1)), r.formatName);

  const damage = el(
    'div',
    { class: 'damage' },
    el('span', { class: 'value' }, known ? percent(r.damage) : '—'),
    el('span', { class: 'label' }, r.rating.label),
  );
  const width = failed ? 100 : known ? Math.min(100, r.damage * 100) : 0;
  const meter = el('div', { class: 'meter', role: 'presentation' }, el('span', { style: `width:${width}%` }));

  let detailText;
  if (failed) {
    detailText = 'QRコードは見つかりましたが、傷が誤り訂正の上限を超えているため読み取れません。';
  } else if (r.blocks && r.blocks.corrected !== null) {
    detailText = `訂正したコードワード数：${r.blocks.corrected} / 上限 ${r.blocks.maxCorrectable}（全${r.blocks.blocks}ブロックのうち最も傷んだブロック）`;
  } else if (known) {
    detailText = 'この規格はブロック構成表を持っていないため、読み取りライブラリが返す訂正余力から算出しています。';
  } else {
    detailText = '破損率を取得できませんでした。';
  }
  const detail = el('p', { class: 'damage-detail' }, detailText);

  const rows = [];
  const v = r.version;
  rows.push(...row('バージョン', v.size ? `${v.label}（${v.size} モジュール）` : v.label || '不明'));
  rows.push(...row('誤り訂正レベル', r.ecLevel ? `${r.ecLevel}${r.ecRecovery ? `（復元能力 ${r.ecRecovery}）` : ''}` : '—'));
  rows.push(...row('マスクパターン', r.mask === null ? '—' : String(r.mask)));
  if (r.blocks) {
    const ecc = r.blocks.blocks * r.blocks.eccPerBlock;
    rows.push(...row('コードワード数', `全${r.blocks.totalCodewords}（うち誤り訂正用 ${ecc}）`));
  }
  const notes = [];
  if (r.inverted) notes.push('白黒反転');
  if (r.mirrored) notes.push('鏡像');
  if (notes.length) rows.push(...row('備考', notes.join('・')));
  if (!failed) rows.push(...row('内容', el('span', { class: 'content' }, r.text)));

  return el(
    'article',
    { class: `card rating-${r.rating.key}` },
    head,
    damage,
    meter,
    detail,
    el('dl', {}, ...rows),
    renderDamageSection(r),
  );
}

let last = null;

function showResults(source, results) {
  last = { source, results };
  drawOverlay(source, results);
  els.results.replaceChildren(...results.map(renderCard));
  els.output.hidden = false;
  if (results.length === 0) {
    setStatus('QRコードが見つかりませんでした。明るさやピント、写す大きさを変えて試してください。', true);
  } else {
    setStatus(`${results.length}個のQRコードが見つかりました。`);
  }
}

/* ---------- 画像の入力 ---------- */

async function handleImage(blob) {
  if (!blob || !blob.type.startsWith('image/')) {
    setStatus('画像ファイルを選んでください。', true);
    return;
  }
  stopCamera();
  setStatus('解析中…');
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    showResults(canvas, await analyzeCanvas(canvas));
  } catch (e) {
    console.error(e);
    setStatus(`画像を読み込めませんでした（${e.message}）。`, true);
  }
}

els.file.addEventListener('change', () => {
  handleImage(els.file.files[0]);
  els.file.value = '';
});

els.drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.drop.classList.add('over');
});
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('over');
  handleImage(e.dataTransfer.files[0]);
});

document.addEventListener('paste', (e) => {
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
  if (item) handleImage(item.getAsFile());
});

/* ---------- カメラ ---------- */

let stream = null;
let scanTimer = null;
let scanning = false;
const frame = document.createElement('canvas');

function grabFrame() {
  const { videoWidth: w, videoHeight: h } = els.video;
  if (!w || !h) return null;
  frame.width = w;
  frame.height = h;
  frame.getContext('2d', { willReadFrequently: true }).drawImage(els.video, 0, 0, w, h);
  return frame;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('このブラウザではカメラを使えません（https で開いているか確認してください）。', true);
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) {
    setStatus(`カメラを起動できませんでした（${e.name}）。カメラの使用を許可してください。`, true);
    return;
  }
  els.video.srcObject = stream;
  await els.video.play();
  els.camera.hidden = false;
  els.cameraHint.textContent = 'QRコードを枠の中に写してください';
  setStatus('');
  scanning = true;
  scheduleScan();
}

function stopCamera() {
  scanning = false;
  clearTimeout(scanTimer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  els.video.srcObject = null;
  els.camera.hidden = true;
}

function scheduleScan() {
  if (scanning) scanTimer = setTimeout(scanOnce, SCAN_INTERVAL_MS);
}

async function scanOnce() {
  const canvas = grabFrame();
  if (!canvas) return scheduleScan();
  let results;
  try {
    results = await analyzeCanvas(canvas, CAMERA_OPTIONS);
  } catch (e) {
    console.error(e);
    return scheduleScan();
  }
  if (!scanning) return;
  if (results.some((r) => r.valid)) {
    const still = cloneCanvas(canvas);
    stopCamera();
    showResults(still, results);
    return;
  }
  els.cameraHint.textContent = results.length
    ? 'QRコードは見えていますが、訂正しきれず読み取れません。「この画面で判定」で結果を確定できます。'
    : 'QRコードを枠の中に写してください';
  scheduleScan();
}

function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

els.cameraStart.addEventListener('click', startCamera);
els.cameraStop.addEventListener('click', stopCamera);
els.cameraCapture.addEventListener('click', async () => {
  const canvas = grabFrame();
  if (!canvas) return;
  const still = cloneCanvas(canvas);
  stopCamera();
  setStatus('解析中…');
  showResults(still, await analyzeCanvas(still));
});

ready.catch((e) => {
  console.error(e);
  setStatus('読み取りエンジンを読み込めませんでした。ページを再読み込みしてください。', true);
});
