// zxing-wasm の読み取り結果から、表示用の規格情報と破損率を組み立てる
import { getBlockInfo } from './tables.js';
import { findDamage } from './damagemap.js';

const EC_RECOVERY = { L: '約7%', M: '約15%', Q: '約25%', H: '約30%' };

/** 破損率（誤り訂正能力の消費率 0〜1）から判定を返す */
export function rate(damage) {
  if (damage === null) return { key: 'unknown', label: '不明' };
  if (damage > 1) return { key: 'fail', label: '読み取り不可' };
  if (damage === 0) return { key: 'perfect', label: '無傷' };
  if (damage < 0.25) return { key: 'good', label: '良好' };
  if (damage < 0.5) return { key: 'fair', label: '軽度の破損' };
  if (damage < 0.75) return { key: 'warn', label: '要注意' };
  return { key: 'danger', label: '危険（読み取り限界に近い）' };
}

function parseExtra(extra) {
  try {
    return extra ? JSON.parse(extra) : {};
  } catch {
    return {};
  }
}

/** バージョン文字列（"10" / "M3" / "R11x27"）を解釈する */
function parseVersion(format, versionStr) {
  const v = String(versionStr ?? '');
  if (format === 'MicroQRCode') {
    const n = Number(v.replace(/^M/, ''));
    return { kind: 'MicroQR', number: n, label: `M${n}`, size: n ? `${9 + 2 * n}×${9 + 2 * n}` : '' };
  }
  if (format === 'RMQRCode') {
    const m = v.match(/^R?(\d+)x(\d+)$/);
    return { kind: 'rMQR', number: null, label: m ? `R${m[1]}x${m[2]}` : v, size: m ? `${m[1]}×${m[2]}` : '' };
  }
  const n = Number(v);
  return { kind: 'QR', number: n, label: String(n), size: n ? `${17 + 4 * n}×${17 + 4 * n}` : '' };
}

function formatName(format, symbologyIdentifier) {
  if (format === 'MicroQRCode') return 'マイクロQRコード';
  if (format === 'RMQRCode') return 'rMQRコード（長方形）';
  // シンボル識別子 ]Q0 はモデル1、それ以外はモデル2
  return symbologyIdentifier === ']Q0' ? 'QRコード モデル1' : 'QRコード モデル2';
}

/**
 * @param {object} r zxing-wasm の ReadResult
 */
export function analyze(r) {
  const extra = parseExtra(r.extra);
  const version = parseVersion(r.format, extra.Version ?? r.version);
  const isModel1 = r.symbologyIdentifier === ']Q0';
  const ecLevel = extra.ECLevel ?? r.ecLevel ?? '';
  const uec = typeof extra.UEC === 'number' && extra.UEC >= 0 ? extra.UEC : null;

  // 読み取れなかった（誤り訂正の上限を超えた）ものは破損率 100% 超として扱う
  let damage;
  if (!r.isValid) damage = /checksum/i.test(r.error) ? Infinity : null;
  else damage = uec === null ? null : Math.round((1 - uec) * 100) / 100;

  // ブロック構成が分かる場合は、最も傷んだブロックで訂正したコードワード数を求める。
  // UEC = 1 - 使った誤り訂正コードワード数 / ブロックの誤り訂正コードワード数（全ブロックの最小値）で、
  // 誤り1つにつき誤り訂正コードワードを2つ使う。1ブロックの誤り訂正コードワード数は最大30なので、
  // 小数2桁の UEC からでも整数に丸めれば正確に戻せる。戻せた場合は破損率を
  // 「訂正したコードワード数 / 訂正できる上限」で計算し直す（上限ちょうどで 100% になる）。
  let blocks = null;
  const info = isModel1 ? null : getBlockInfo(version.kind, version.number, ecLevel);
  if (info) {
    const maxCorrectable = Math.floor(info.eccPerBlock / 2);
    let corrected = null;
    if (r.isValid && uec !== null) {
      corrected = Math.round(((1 - uec) * info.eccPerBlock) / 2);
      damage = corrected / maxCorrectable;
    }
    blocks = { ...info, maxCorrectable, corrected };
  }

  // 壊れているマスの位置（QRコード モデル2で、読み取れたものだけ）
  let damageMap = null;
  if (r.isValid && version.kind === 'QR' && !isModel1 && typeof extra.DataMask === 'number') {
    damageMap = findDamage(r.symbol, version.number, ecLevel, extra.DataMask);
  }

  return {
    text: r.text,
    formatName: formatName(r.format, r.symbologyIdentifier),
    version,
    ecLevel,
    ecRecovery: EC_RECOVERY[ecLevel] ?? '',
    mask: typeof extra.DataMask === 'number' ? extra.DataMask : null,
    damage,
    rating: rate(damage),
    blocks,
    damageMap,
    valid: r.isValid,
    inverted: !!r.isInverted,
    mirrored: !!r.isMirrored,
    position: r.position,
  };
}
