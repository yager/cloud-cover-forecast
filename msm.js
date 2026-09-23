// 気象庁MSMの層別雲量（Open-Meteo のオープンデータ）を読み込み、Leaflet に最近傍で描画する。
//
// データ取得（MsmOmSource）と描画（CloudGridLayer）は分けてある。
// どちらも「GRID 定義 + 層ごとの Uint8Array（0〜100%、MISSING=欠測、行0が南端）」だけでやり取りするので、
// 将来 GitHub Actions で事前変換した uint8 バイナリを読むソースに差し替えても描画側はそのまま使える。
import { OmFileReader, FileBackend, OmDataType } from '@openmeteo/file-reader';

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

export const MISSING = 255;

// wxtech タイルと同じ色・同じ区切り（タイル画素と格子値の突き合わせで確認）
const COLOR_STEPS = [
    { min: 100, rgba: [105, 84, 145, 255] },
    { min: 80, rgba: [106, 126, 155, 255] },
    { min: 60, rgba: [146, 164, 173, 255] },
    { min: 40, rgba: [223, 223, 223, 255] },
    { min: 20, rgba: [239, 239, 239, 255] }
];

// 値(0〜255) → RGBA のルックアップ表。20%未満と欠測は透明
const COLOR_LUT = (() => {
    const lut = new Uint8ClampedArray(256 * 4);
    for (let v = 0; v <= 100; v++) {
        const step = COLOR_STEPS.find(s => v >= s.min);
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
            return Object.fromEntries(entries);
        } finally {
            reader.dispose();
        }
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
        bounds: L.latLngBounds(GRID_BOUNDS),
        opacity: 0.7
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
