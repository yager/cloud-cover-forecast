// 気象庁MSMの層別雲量（Open-Meteo のオープンデータ）を読み込み、Leaflet に最近傍で描画する。
//
// データ取得（MsmOmSource）と描画（CloudGridLayer）は分けてある。
// どちらも「GRID 定義 + 層ごとの Uint8Array（0〜100%、MISSING=欠測、行0が南端）」だけでやり取りするので、
// 将来 GitHub Actions で事前変換した uint8 バイナリを読むソースに差し替えても描画側はそのまま使える。
import { OmFileReader, FileBackend, OmDataType } from '@openmeteo/file-reader';
import { WIND_STEPS } from './colors.js';

const OM_BASE = 'https://openmeteo.s3.amazonaws.com/data_spatial/jma_msm';

// MSM の等緯度経度格子（値はセル中心の座標）
export const GRID = { nx: 481, ny: 505, lon0: 120, lat0: 22.4, dlon: 0.0625, dlat: 0.05 };

// セルの外縁（中心から半マス外側）。wxtech タイルの bounds と同じ
export const GRID_BOUNDS = [
    [GRID.lat0 - GRID.dlat / 2, GRID.lon0 - GRID.dlon / 2],
    [GRID.lat0 + (GRID.ny - 0.5) * GRID.dlat, GRID.lon0 + (GRID.nx - 0.5) * GRID.dlon]
];

export const LEVEL_VARIABLES = {
    total: 'cloud_cover',
    lower: 'cloud_cover_low',
    middle: 'cloud_cover_mid',
    upper: 'cloud_cover_high'
};

// 10m の風。u/v はそのままでは使わず、風速と風向に直して持つ
export const WIND_VARIABLES = { u: 'wind_u_component_10m', v: 'wind_v_component_10m' };

export const MISSING = 255;

// 風速の刻み。speed は 0.25 m/s 単位の Uint8（0〜63.75 m/s）で持つ
export const WIND_SPEED_UNIT = 0.25;

// 雲量の配色。黒い下地に重ねるので、雲が多いほど白く濃くなる。
// 区切りは 20/40/60/80/100% の5段階で、20%未満と欠測は透明。
// 濃さはアルファで表すため、レイヤー自体は不透明のまま重ねる
const COLOR_STEPS = [
    { min: 100, rgba: [255, 255, 255, 230] },
    { min: 80, rgba: [235, 240, 248, 185] },
    { min: 60, rgba: [210, 222, 238, 140] },
    { min: 40, rgba: [190, 205, 225, 95] },
    { min: 20, rgba: [175, 192, 215, 55] }
];

// 値(0〜255) → RGBA のルックアップ表
const COLOR_LUT = (() => {
    const lut = new Uint8ClampedArray(256 * 4);
    for (let v = 0; v <= 100; v++) {
        const step = COLOR_STEPS.find(s => v >= s.min);
        if (step) lut.set(step.rgba, v * 4);
    }
    return lut;
})();

// 風速の配色。気象庁の降水の塗りと同じ「弱い=寒色、強い=暖色」にそろえる。
// 降水と雷のタイルは気象庁が色を塗った状態で配信されるので、
// 自分で色を決められるのは風だけ。そこだけ別のルールにすると地図の中で語彙が割れる。
// 10 m/s で寒色から暖色に変え、意味の境目と色相の境目をそろえている。
// 値そのものは colors.js（地図の凡例と共有）を参照

// speed（0.25 m/s 単位）→ RGBA。2 m/s 未満と欠測は透明
const WIND_LUT = (() => {
    const lut = new Uint8ClampedArray(256 * 4);
    for (let v = 0; v < 256; v++) {
        const speed = v * WIND_SPEED_UNIT;
        const step = WIND_STEPS.find(s => speed >= s.min);
        if (step) lut.set(step.rgba, v * 4);
    }
    return lut;
})();

function pad2(n) {
    return String(n).padStart(2, '0');
}

// data_spatial/jma_msm/YYYY/MM/DD/hhmmZ/YYYY-MM-DDThhmm.om
function omUrl(referenceTime, validTime) {
    const r = new Date(referenceTime);
    const v = new Date(validTime);
    const run = `${r.getUTCFullYear()}/${pad2(r.getUTCMonth() + 1)}/${pad2(r.getUTCDate())}/${pad2(r.getUTCHours())}${pad2(r.getUTCMinutes())}Z`;
    const file = `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}T${pad2(v.getUTCHours())}${pad2(v.getUTCMinutes())}`;
    return `${OM_BASE}/${run}/${file}.om`;
}

function toUint8(values) {
    const out = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        out[i] = Number.isNaN(v) ? MISSING : Math.max(0, Math.min(100, Math.round(v)));
    }
    return out;
}

// Open-Meteo の .om ファイルをブラウザで読むソース
export class MsmOmSource {
    constructor() {
        this.referenceTime = null;
        this.frames = new Map(); // validTime -> Promise<{lower, middle, upper}>
    }

    // latest.json を読み、基準時刻と予報対象時刻の一覧を返す
    async loadIndex() {
        const res = await fetch(`${OM_BASE}/latest.json`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`latest.json: HTTP ${res.status}`);
        const latest = await res.json();
        this.referenceTime = new Date(latest.reference_time).toISOString();
        this.frames.clear();
        return {
            baseTime: this.referenceTime,
            times: latest.valid_times.map(t => new Date(t).toISOString())
        };
    }

    // 1コマ分の雲量3種類を読む（同じコマは使い回す）
    loadFrame(validTime) {
        if (!this.frames.has(validTime)) {
            const promise = this._readFrame(validTime);
            promise.catch(() => this.frames.delete(validTime));
            this.frames.set(validTime, promise);
        }
        return this.frames.get(validTime);
    }

    async _readFrame(validTime) {
        // 1コマのファイル（全要素で約800KB）を1回で取得する。
        // 範囲リクエストで雲量だけ読むと転送量は約1/4になるが、往復が二十数回になり3倍以上遅い
        const url = omUrl(this.referenceTime, validTime);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        const reader = await OmFileReader.create(new FileBackend(await res.arrayBuffer()));
        try {
            const entries = await Promise.all(Object.entries(LEVEL_VARIABLES).map(async ([level, name]) => {
                const variable = await reader.getChildByName(name);
                if (!variable) throw new Error(`${name} が見つかりません`);
                try {
                    const dims = variable.getDimensions();
                    if (dims[0] !== GRID.ny || dims[1] !== GRID.nx) {
                        throw new Error(`${name} の格子が想定外です: ${dims.join('x')}`);
                    }
                    const values = await variable.read({
                        type: OmDataType.FloatArray,
                        ranges: dims.map(d => ({ start: 0, end: d }))
                    });
                    return [level, toUint8(values)];
                } finally {
                    variable.dispose();
                }
            }));
            return { ...Object.fromEntries(entries), wind: await this._readWind(reader) };
        } finally {
            reader.dispose();
        }
    }

    // u/v を風速（0.25 m/s 単位）と風向（1周を256分割。風が吹いていく向き）に直す。
    // Float のまま持つと1コマ約2MBになるので、描画に足りる精度まで落としてから保持する
    async _readWind(reader) {
        const read = async (name) => {
            const variable = await reader.getChildByName(name);
            if (!variable) throw new Error(`${name} が見つかりません`);
            try {
                const dims = variable.getDimensions();
                return await variable.read({
                    type: OmDataType.FloatArray,
                    ranges: dims.map(d => ({ start: 0, end: d }))
                });
            } finally {
                variable.dispose();
            }
        };
        const [u, v] = await Promise.all([read(WIND_VARIABLES.u), read(WIND_VARIABLES.v)]);

        const speed = new Uint8Array(u.length);
        const direction = new Uint8Array(u.length);
        for (let i = 0; i < u.length; i++) {
            if (Number.isNaN(u[i]) || Number.isNaN(v[i])) continue;
            speed[i] = Math.min(255, Math.round(Math.hypot(u[i], v[i]) / WIND_SPEED_UNIT));
            const angle = Math.atan2(v[i], u[i]); // 数学の角（東が0、反時計回り）
            direction[i] = Math.round(angle / (2 * Math.PI) * 256) & 255;
        }
        return { speed, direction };
    }
}

// 格子の最近傍セルの値（範囲外は null）
export function gridIndex(lat, lng) {
    const ix = Math.round((lng - GRID.lon0) / GRID.dlon);
    const iy = Math.round((lat - GRID.lat0) / GRID.dlat);
    if (ix < 0 || ix >= GRID.nx || iy < 0 || iy >= GRID.ny) return null;
    return { ix, iy, lat: GRID.lat0 + iy * GRID.dlat, lng: GRID.lon0 + ix * GRID.dlon };
}

// 等緯度経度格子をメルカトルのタイルへ最近傍で塗る Leaflet レイヤー。
// 補間やぼかしは一切しない（数値計算結果をそのまま色分けするだけ）。
export const CloudGridLayer = L.GridLayer.extend({
    options: {
        bounds: L.latLngBounds(GRID_BOUNDS)
    },

    setValues(values) {
        this._values = values;
        for (const key in this._tiles) {
            const tile = this._tiles[key];
            this._drawTile(tile.el, tile.coords);
        }
    },

    createTile(coords) {
        const tile = L.DomUtil.create('canvas', 'cloud-grid-tile');
        const size = this.getTileSize();
        const ratio = window.devicePixelRatio || 1;
        tile.width = Math.round(size.x * ratio);
        tile.height = Math.round(size.y * ratio);
        this._drawTile(tile, coords);
        return tile;
    },

    _drawTile(canvas, coords) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        if (!this._values) {
            ctx.clearRect(0, 0, w, h);
            return;
        }

        // タイル内の各列・各行が、格子のどの列・行に当たるか
        const worldPx = 256 * Math.pow(2, coords.z);
        const cols = new Int32Array(w);
        for (let px = 0; px < w; px++) {
            const lng = ((coords.x + (px + 0.5) / w) / Math.pow(2, coords.z)) * 360 - 180;
            const ix = Math.round((lng - GRID.lon0) / GRID.dlon);
            cols[px] = ix >= 0 && ix < GRID.nx ? ix : -1;
        }
        const rows = new Int32Array(h);
        for (let py = 0; py < h; py++) {
            const yWorld = (coords.y + (py + 0.5) / h) * 256;
            const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * yWorld) / worldPx))) * 180) / Math.PI;
            const iy = Math.round((lat - GRID.lat0) / GRID.dlat);
            rows[py] = iy >= 0 && iy < GRID.ny ? iy : -1;
        }

        const image = ctx.createImageData(w, h);
        const pixels = image.data;
        const values = this._values;
        for (let py = 0; py < h; py++) {
            const iy = rows[py];
            if (iy < 0) continue;
            const rowOffset = iy * GRID.nx;
            let p = py * w * 4;
            for (let px = 0; px < w; px++, p += 4) {
                const ix = cols[px];
                if (ix < 0) continue;
                const c = values[rowOffset + ix] * 4;
                pixels[p] = COLOR_LUT[c];
                pixels[p + 1] = COLOR_LUT[c + 1];
                pixels[p + 2] = COLOR_LUT[c + 2];
                pixels[p + 3] = COLOR_LUT[c + 3];
            }
        }
        ctx.putImageData(image, 0, 0);
    }
});

// 風の地図。風速を面で塗り、その上に間引いた矢印を重ねる。
// 塗りは CloudGridLayer と同じ最近傍。矢印は「実在する格子点を間引いて描く」だけで、
// 補間はしていない（流線やパーティクルは格子の間を補間するので使えない）。
export const WindGridLayer = L.GridLayer.extend({
    options: {
        bounds: L.latLngBounds(GRID_BOUNDS),
        // 画面上でこのくらいの間隔になるよう、ズームから間引きの段数を決める
        arrowSpacingPx: 46
    },

    setValues(wind) {
        this._wind = wind;
        for (const key in this._tiles) {
            const tile = this._tiles[key];
            this._drawTile(tile.el, tile.coords);
        }
    },

    createTile(coords) {
        const tile = L.DomUtil.create('canvas', 'wind-grid-tile');
        const size = this.getTileSize();
        const ratio = window.devicePixelRatio || 1;
        tile.width = Math.round(size.x * ratio);
        tile.height = Math.round(size.y * ratio);
        this._drawTile(tile, coords);
        return tile;
    },

    // 格子1マスが画面上で何ピクセルか（経度方向）
    _cellPx(z, ratio) {
        return GRID.dlon * (256 * Math.pow(2, z)) / 360 * ratio;
    },

    // 間引きの段数。ズームで変えるが、2のべき乗に丸めてズーム時に矢印が踊らないようにする
    _arrowStep(z, ratio) {
        const want = this.options.arrowSpacingPx * ratio / this._cellPx(z, ratio);
        return Math.max(1, Math.pow(2, Math.max(0, Math.round(Math.log2(want)))));
    },

    _drawTile(canvas, coords) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        if (!this._wind) return;

        const worldPx = 256 * Math.pow(2, coords.z);
        const ratio = w / this.getTileSize().x;

        // --- 風速の面（最近傍） ---
        const cols = new Int32Array(w);
        for (let px = 0; px < w; px++) {
            const lng = ((coords.x + (px + 0.5) / w) / Math.pow(2, coords.z)) * 360 - 180;
            const ix = Math.round((lng - GRID.lon0) / GRID.dlon);
            cols[px] = ix >= 0 && ix < GRID.nx ? ix : -1;
        }
        const rows = new Int32Array(h);
        for (let py = 0; py < h; py++) {
            const yWorld = (coords.y + (py + 0.5) / h) * 256;
            const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * yWorld) / worldPx))) * 180) / Math.PI;
            const iy = Math.round((lat - GRID.lat0) / GRID.dlat);
            rows[py] = iy >= 0 && iy < GRID.ny ? iy : -1;
        }

        const image = ctx.createImageData(w, h);
        const pixels = image.data;
        const speed = this._wind.speed;
        for (let py = 0; py < h; py++) {
            const iy = rows[py];
            if (iy < 0) continue;
            const rowOffset = iy * GRID.nx;
            let p = py * w * 4;
            for (let px = 0; px < w; px++, p += 4) {
                const ix = cols[px];
                if (ix < 0) continue;
                const c = speed[rowOffset + ix] * 4;
                pixels[p] = WIND_LUT[c];
                pixels[p + 1] = WIND_LUT[c + 1];
                pixels[p + 2] = WIND_LUT[c + 2];
                pixels[p + 3] = WIND_LUT[c + 3];
            }
        }
        ctx.putImageData(image, 0, 0);

        this._drawArrows(ctx, coords, w, h, ratio);
    },

    _drawArrows(ctx, coords, w, h, ratio) {
        const step = this._arrowStep(coords.z, ratio);
        const worldPx = 256 * Math.pow(2, coords.z);
        const scale = worldPx / 360;
        const { speed, direction } = this._wind;

        // このタイルが覆う緯度経度。矢印は中心がタイルの外でも半分だけ見えることがあるので、
        // 少し広げた範囲の格子点まで描く（隣のタイルも同じ点を描くので、継ぎ目で欠けない）
        const margin = 40 * ratio;
        const lngAt = (px) => ((coords.x + px / w) / Math.pow(2, coords.z)) * 360 - 180;
        const latAt = (py) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ((coords.y + py / h) * 256)) / worldPx))) * 180) / Math.PI;
        const lng0 = lngAt(-margin), lng1 = lngAt(w + margin);
        const lat1 = latAt(-margin), lat0 = latAt(h + margin);

        let ix0 = Math.ceil((lng0 - GRID.lon0) / GRID.dlon / step) * step;
        let iy0 = Math.ceil((lat0 - GRID.lat0) / GRID.dlat / step) * step;
        const ix1 = Math.floor((lng1 - GRID.lon0) / GRID.dlon);
        const iy1 = Math.floor((lat1 - GRID.lat0) / GRID.dlat);
        ix0 = Math.max(0, ix0);
        iy0 = Math.max(0, iy0);

        ctx.strokeStyle = '#ffffff';
        ctx.fillStyle = '#ffffff';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 5km格子の弱い風は向きが定まらない。これ未満は矢印を出さない
        const MIN_SPEED = 1;

        // 大きさは矢印の実間隔に対する比で決める。間引きの段数は2のべき乗に丸めるので
        // 画面上の実間隔は一定でなく、固定pxで測ると密なときに矢印どうしが重なる。
        // 線形だと弱風と強風で差がつきすぎて弱い矢印の頭が潰れるため、平方根で幅を圧縮する。
        // 頭と線幅は全長の固定比にして、どれも頭打ちにならないようにしている
        const LEN_MIN_RATIO = 0.13;  // 風速0のときの、間隔に対する全長
        const LEN_RANGE_RATIO = 0.77;
        const LEN_FULL = 50;         // この風速で間隔の9割。これを超えても伸び続ける
        const WIDTH_RATIO = 0.085;

        // 頭の比率は弱い風ほど大きくする。全長を小さくすると固定比では頭が潰れるため、
        // 弱い風はずんぐりした矢印になる。頭の絶対サイズは風速とともに増え続ける
        const HEAD_RATIO_MAX = 0.60;
        const HEAD_RATIO_RANGE = 0.20;

        // 不透明度は 0.3 から 0.9 へ。0.9 に漸近するだけで到達しないので、
        // どの風速でも頭打ちにならず、塗りつぶしにもならない
        const ALPHA_MIN = 0.3;
        const ALPHA_MAX = 0.9;
        const ALPHA_SCALE = 12;

        const spacingPx = step * this._cellPx(coords.z, ratio);

        const tileLeft = coords.x * 256 * ratio;
        const tileTop = coords.y * 256 * ratio;

        for (let iy = iy0; iy <= Math.min(iy1, GRID.ny - 1); iy += step) {
            const lat = GRID.lat0 + iy * GRID.dlat;
            const rad = lat * Math.PI / 180;
            const yWorld = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * worldPx;
            const cy = yWorld * ratio - tileTop;
            if (cy < -margin || cy > h + margin) continue;

            for (let ix = ix0; ix <= Math.min(ix1, GRID.nx - 1); ix += step) {
                const i = iy * GRID.nx + ix;
                const s = speed[i] * WIND_SPEED_UNIT;
                if (s < MIN_SPEED) continue;

                const lng = GRID.lon0 + ix * GRID.dlon;
                const cx = (lng + 180) * scale * ratio - tileLeft;
                if (cx < -margin || cx > w + margin) continue;

                // 風向は「吹いていく向き」。画面は y が下向きなので符号を反転する
                const angle = direction[i] / 256 * 2 * Math.PI;
                const dirX = Math.cos(angle);
                const dirY = -Math.sin(angle);

                const t = Math.sqrt(s / LEN_FULL);
                const len = spacingPx * (LEN_MIN_RATIO + LEN_RANGE_RATIO * t);
                const head = len * (HEAD_RATIO_MAX - HEAD_RATIO_RANGE * t);
                const hx = cx + dirX * len / 2;
                const hy = cy + dirY * len / 2;

                // 弱い風ほど薄くして、大きさの差だけに頼らず強弱が分かるようにする
                ctx.globalAlpha = ALPHA_MAX - (ALPHA_MAX - ALPHA_MIN) * Math.exp(-s / ALPHA_SCALE);

                ctx.lineWidth = len * WIDTH_RATIO;
                ctx.beginPath();
                ctx.moveTo(cx - dirX * len / 2, cy - dirY * len / 2);
                ctx.lineTo(hx - dirX * head * 0.7, hy - dirY * head * 0.7);
                ctx.stroke();

                ctx.beginPath();
                ctx.moveTo(hx, hy);
                ctx.lineTo(hx - Math.cos(angle - 0.46) * head, hy + Math.sin(angle - 0.46) * head);
                ctx.lineTo(hx - Math.cos(angle + 0.46) * head, hy + Math.sin(angle + 0.46) * head);
                ctx.closePath();
                ctx.fill();

                ctx.globalAlpha = 1;
            }
        }
    }
});
