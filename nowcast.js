// 気象庁の高解像度降水ナウキャスト（250mメッシュ）を読み込み、Leaflet のタイルとして重ねる。
//
// 気象庁ホームページ自身が使っているエンドポイントで、公式に文書化されたAPIではない。
// 認証は不要で CORS も通る。**タイルは気象庁が色を塗った状態で配信される**ので、
// こちらに配色の裁量はなく、そのまま重ねるだけ。加工しないという方針とも合っている。
//
// 時刻は雲量の地図（1時間刻み・78時間）とまったく別の軸（5分刻み・過去3時間〜+1時間）。
// 1本にまとめられないので、画面側で時刻コントロールごと切り替える。

import { RAIN_COLORS, THUNDER_COLORS, THUNDER_LABELS } from './colors.js';

const BASE = 'https://www.jma.go.jp/bosai/jmatile/data/nowc';

// 実況（レーダー観測）と予測で時刻一覧が分かれている
const TARGET_TIMES = {
    observed: `${BASE}/targetTimes_N1.json`,
    forecast: `${BASE}/targetTimes_N2.json`
};

// 気象庁のページと同じく、降水強度は hrpns
const ELEMENT = 'hrpns';

// "20260925013500" → Date（この時刻一覧は UTC）
function parseStamp(stamp) {
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`
        + `T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`;
    return new Date(iso);
}

function buildTileUrl(frame, element) {
    return `${BASE}/${frame.basetime}/none/${frame.validtime}/surf/${element}/{z}/{x}/{y}.png`;
}

export function tileUrl(frame) {
    return buildTileUrl(frame, ELEMENT);
}

// 実況としてさかのぼる時間。取得できるのは3時間ぶんだが、
// 軸に15分おきのラベルを並べる都合と、再生時の取得枚数を抑える都合で1時間に絞る
const OBSERVED_MINUTES = 60;

// 実況と予測をつないで、古い順に並べた1本のコマ列にする
export async function loadFrames() {
    const [observed, forecast] = await Promise.all(
        [TARGET_TIMES.observed, TARGET_TIMES.forecast].map(async (url) => {
            const res = await fetch(url, { cache: 'no-cache' });
            if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
            return res.json();
        })
    );

    const toFrames = (list, isForecast) => list
        .filter((entry) => entry.elements.includes(ELEMENT))
        .map((entry) => ({
            basetime: entry.basetime,
            validtime: entry.validtime,
            time: parseStamp(entry.validtime),
            isForecast
        }));

    const all = [...toFrames(observed, false), ...toFrames(forecast, true)];
    all.sort((a, b) => a.time - b.time);

    const newestObserved = all.filter((f) => !f.isForecast).pop();
    const from = newestObserved
        ? newestObserved.time.getTime() - OBSERVED_MINUTES * 60 * 1000
        : -Infinity;
    const frames = all.filter((f) => f.time.getTime() >= from);

    // 同じ時刻が実況と予測の両方に出ることがある。実況を優先する
    return frames.filter((frame, i) => i === 0 || frame.validtime !== frames[i - 1].validtime);
}

// 気象庁が中身を用意しているズーム。ここ以外は 404 ではなく
// **HTTP 200 で完全に透明な 334 バイトの PNG** が返るので、応答コードでは気付けない。
// 雨のある領域で実測したところ、奇数ズームは実況・予測のどのコマでも中身が空だった。
const MIN_NATIVE_ZOOM = 4;

// Leaflet が取りに行くタイルのズームは Math.round(地図のズーム) なので、
// 素のままだと地図が z7.25 になった瞬間に z7（空）を取りに行き、レイヤーが消える。
// ここで偶数に丸めておけば、Leaflet が取得したタイルを拡大・縮小して表示してくれる。
// 切り上げると取得枚数が4倍になり再生が重くなるので、切り下げ側に寄せる。
//
// 上限のズーム（maxNativeZoom）は降水と雷の面で別にしてある。降水（hrpns）はズーム10まで
// 中身があるが、雷の面（thns）は実測でズーム10のタイルが常に空だった（同じ地点・同じコマで
// ズーム8にだけ着色）。1kmメッシュはそこまで細かい解像度を持たないためとみられる
function makeNowcastLayerClass(maxNativeZoom) {
    return L.TileLayer.extend({
        _clampZoom(zoom) {
            const even = Math.floor(zoom / 2) * 2;
            return Math.min(maxNativeZoom, Math.max(MIN_NATIVE_ZOOM, even));
        }
    });
}

const RainLayer = makeNowcastLayerClass(10);
const ThunderAreaLayer = makeNowcastLayerClass(8);

// 降水のタイル。コマを差し替えて動かすので、URL を張り替えられるようにしてある。
// Leaflet は表示中のタイルしか取りに行かないので、先読みは画面内だけで済む
export function createLayer() {
    return new RainLayer('', {
        opacity: 0.8,
        // 差し替え中に前のコマを消さない。ちらつきを抑える
        keepBuffer: 4,
        className: 'nowcast-tile'
    });
}

// 雷の面（thns）のタイル。ズームの上限だけ createLayer と違う
export function createThunderAreaLayer() {
    return new ThunderAreaLayer('', {
        opacity: 0.8,
        keepBuffer: 4,
        className: 'nowcast-tile'
    });
}

// 雷ナウキャスト。面（thns・10分刻み）と落雷地点（liden・5分刻み）の
// 時刻一覧が1本のファイルに同居している。降水と違い basetime/validtime の
// ペアがそのまま実況・予測の両方をカバーするので、ファイルをまたぐ結合は不要
const THUNDER_TIMES = `${BASE}/targetTimes_N3.json`;

// 実況としてさかのぼる時間。降水と揃える
const THUNDER_OBSERVED_MINUTES = 60;

// 面（thns）は10分刻み、落雷地点（liden）は5分刻みで、同じ時刻一覧の中に混在する。
// 5分きざみのコマ全部を1本のタイムラインにして、thns が無いコマでは
// 面レイヤーの更新をスキップする（直前のコマの面がそのまま残る＝データの捏造にはならない）
export async function loadThunderFrames() {
    const res = await fetch(THUNDER_TIMES, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${THUNDER_TIMES}: HTTP ${res.status}`);
    const list = await res.json();

    const all = list.map((entry) => ({
        basetime: entry.basetime,
        validtime: entry.validtime,
        time: parseStamp(entry.validtime),
        isForecast: entry.validtime > entry.basetime,
        hasArea: entry.elements.includes('thns'),
        hasStrikes: entry.elements.includes('liden')
    }));
    all.sort((a, b) => a.time - b.time);

    const newestObserved = all.filter((f) => !f.isForecast).pop();
    const from = newestObserved
        ? newestObserved.time.getTime() - THUNDER_OBSERVED_MINUTES * 60 * 1000
        : -Infinity;
    const frames = all.filter((f) => f.time.getTime() >= from);

    // 面（thns）を持たないコマ（liden だけの5分刻み）のために、直近で面を持っていたコマへの
    // 参照をあらかじめ持たせておく。逐次再生なら「1つ前のコマ」で足りるが、リセットやドラッグで
    // 位置がいきなり飛ぶこともあるので、どのコマから見ても「その時点で分かる一番新しい面」に
    // 一貫してたどり着けるようにしておく
    let carry = null;
    for (const frame of frames) {
        if (frame.hasArea) carry = frame;
        frame.areaFrame = carry;
    }

    return frames;
}

export function thunderTileUrl(frame) {
    return buildTileUrl(frame, 'thns');
}

// 落雷地点。実データで確認したところ properties は {id, obstimeJST, type} で、
// 見たかぎり type は常に 4 だった。意味は未確認（気象庁のページはCG/CC・経過時間で
// 色分けしているが、対応する定義は取れなかった）ので、種別による描き分けはしない。
// 1コマぶん（その5分間の新規の点だけ）を返す。累積ではない
export async function loadStrikes(frame) {
    if (!frame.hasStrikes) return [];
    const url = `${BASE}/${frame.basetime}/none/${frame.validtime}/surf/liden/data.geojson?id=liden`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const geojson = await res.json();
    return geojson.features || [];
}

// 気象庁が塗った降水強度の色。日本全域 × 先15時間ぶんのタイル（降水短時間予報も同じ配色）を
// 走査して実際に出てくる色を数えたところ、ちょうど8色だけで中間色は無かった。
// 中間色が無いということは、色から階級を引き戻せるということ。値は colors.js を参照

export function intensityColor(rank) {
    return `#${RAIN_COLORS[rank - 1]}`;
}

const RANK_BY_RGB = new Map(RAIN_COLORS.map((hex, i) => [parseInt(hex, 16), i + 1]));

// 地点の値を読むズーム。中身のある一番細かいズーム
const SAMPLE_ZOOM = 10;

// 指定した地点を含むタイルの1画素を読んで [r, g, b] を返す（何も無ければ null）。
// 表示中のタイルから読むのではなく取り直しているのは、画素の位置を自分で決められるから。
// Blob 経由で読み込むので canvas が汚染されず、タイルに crossOrigin を付ける必要もない
async function readPixel(url, lat, lng, zoom) {
    const n = 2 ** zoom;
    const fx = (lng + 180) / 360 * n;
    const sin = Math.sin(lat * Math.PI / 180);
    const fy = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n;
    if (!Number.isFinite(fy) || fy < 0 || fy >= n) return null;

    const x = Math.floor(fx);
    const y = Math.floor(fy);

    let data;
    try {
        const blob = await (await fetch(url(x, y))).blob();
        // 現象が無い区画は334バイト前後の透明PNG。展開するまでもない
        if (blob.size < 400) return null;
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        data = ctx.getImageData(0, 0, 256, 256).data;
    } catch (error) {
        return null;
    }

    const i = (Math.floor((fy - y) * 256) * 256 + Math.floor((fx - x) * 256)) * 4;
    if (data[i + 3] === 0) return null;
    return [data[i], data[i + 1], data[i + 2]];
}

// 地点の降水強度を階級（降っていなければ0）で返す。1コマにつきタイル1枚、実測で1KB前後しかない
export async function sampleAt(frame, lat, lng) {
    const url = (x, y) => `${BASE}/${frame.basetime}/none/${frame.validtime}/surf/${ELEMENT}/${SAMPLE_ZOOM}/${x}/${y}.png`;
    const rgb = await readPixel(url, lat, lng, SAMPLE_ZOOM);
    if (!rgb) return 0;
    return RANK_BY_RGB.get((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) || 0;
}

// 雷の活動度1〜4の色。気象庁の解説ページ「雷ナウキャストの見方」
// (https://www.jma.go.jp/jma/kishou/know/toppuu/thunder2-2.html) の
// 「活動度と行動の対応」表の画像から、スウォッチの画素を実測して取得した。
// 活動度1（faf500・黄）は実際のタイルでも同じ色を確認済み。値は colors.js を参照

export function thunderActivityColor(level) {
    return `#${THUNDER_COLORS[level - 1]}`;
}

export function thunderActivityLabel(level) {
    return THUNDER_LABELS[level - 1];
}

const THUNDER_RANK_BY_RGB = new Map(THUNDER_COLORS.map((hex, i) => [parseInt(hex, 16), i + 1]));

// z10 は実測で常に空だった（同一地点・同一コマの3x3タイルを確認しても全部空、
// z8は着色）ので候補に含めない。1kmメッシュが z10 の解像度を持たないためとみられる。
// z8/z6/z4 の間でも生成ズームによって描画の有無が入れ替わることがあるため、
// 細かい方から順に試し、最初に何か見つかったズームを採用する
const THUNDER_SAMPLE_ZOOMS = [8, 6, 4];

// 地点の雷活動度を階級（0〜4、0は活動度なし）で返す
export async function sampleThunderAt(frame, lat, lng) {
    if (!frame.hasArea) return 0;
    for (const zoom of THUNDER_SAMPLE_ZOOMS) {
        const url = (x, y) => `${BASE}/${frame.basetime}/none/${frame.validtime}/surf/thns/${zoom}/${x}/${y}.png`;
        const rgb = await readPixel(url, lat, lng, zoom);
        if (rgb) return THUNDER_RANK_BY_RGB.get((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) || 0;
    }
    return 0;
}
