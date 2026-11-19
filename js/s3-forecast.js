// 1時間予測・2週間予測の予備の取得先。Open-Meteo の API を通さず、
// S3 のオープンデータ（API が読んでいるのと同じファイル）から1地点ぶんを直接読む。
//
//   data/<モデル>/<変数>/chunk_<n>.om   （寸法 [緯度行, 経度列, 時間]）
//
// API が応答しないときだけ使う（js/forecast-source.js）。API と違い、標高の補正はしない。
// 地点に最も近い格子点の値を、そのまま返す。
// 返す形は js/weather.js の loadPointForecast と同じ（msm / aifs の { times, values }）。

import { OmFileReader, OmDataType } from '@openmeteo/file-reader';

const S3_BASE = 'https://openmeteo.s3.amazonaws.com';
const TIMEOUT_MS = 10000;

// 格子は各モデルの meta.json と、ファイルの寸法から確認した値（寸法は読むたびに照合する）
const MODELS = {
    msm: {
        id: 'jma_msm',
        grid: { nx: 481, ny: 505, lat0: 22.4, lon0: 120, dlat: 0.05, dlon: 0.0625, wrapLon: false },
        // 先頭は雲量地図の計算（3時間ごと）の基準時刻を覆えばよいので、少し前から
        pastHours: 12
    },
    aifs: {
        id: 'ecmwf_aifs025_single',
        grid: { nx: 1440, ny: 721, lat0: -90, lon0: -180, dlat: 0.25, dlon: 0.25, wrapLon: true },
        // API の表と同じく、今日（日本時間）の0時から
        fromJstMidnight: true
    }
};

// 終わりは API（forecast_days=16）と同じ、今日（日本時間）から16日目の終わりまで。
// 範囲を狭めればファイルの数が減って約0.7秒短くなる（ブラウザで 3.0〜3.9秒 → 2.3〜2.7秒）が、効果が小さいので揃えている。
// モデルのデータがそこまで無い分は、meta.json の data_end_time で打ち切る
const FORECAST_DAYS = 16;

// S3 に保存されている変数。風は東向き・北向きの成分で入っていて、風速と風向は自分で求める
const STORED_VARIABLES = [
    'temperature_2m', 'relative_humidity_2m', 'precipitation',
    'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
    'pressure_msl', 'wind_u_component_10m', 'wind_v_component_10m'
];

// 2週間予測は6時間ごとの値だけを表に出す（js/weather.js と同じ）。世界時の 00/06/12/18＝日本時間の 3/9/15/21
const AIFS_JST_HOURS = [3, 9, 15, 21];

// 最近傍の格子点。範囲の外なら null
export function nearestCell(grid, lat, lng) {
    const iy = Math.round((lat - grid.lat0) / grid.dlat);
    const lon = grid.wrapLon ? ((lng + 180) % 360 + 360) % 360 - 180 : lng;
    let ix = Math.round((lon - grid.lon0) / grid.dlon);
    if (grid.wrapLon) ix = ((ix % grid.nx) + grid.nx) % grid.nx;
    if (iy < 0 || iy >= grid.ny || ix < 0 || ix >= grid.nx) return null;
    return { iy, ix, lat: grid.lat0 + iy * grid.dlat, lng: grid.lon0 + ix * grid.dlon };
}

// 風の東向き成分 u・北向き成分 v → 風速と、風が吹いてくる方位（度）。Open-Meteo の API と同じ定義
export function windFromComponents(u, v) {
    if (u === null || v === null) return { speed: null, direction: null };
    return {
        speed: Math.hypot(u, v),
        direction: ((Math.atan2(u, v) * 180 / Math.PI + 180) % 360 + 360) % 360
    };
}

// 「YYYY-MM-DDTHH:00」（日本時間）。js/weather.js の jstKey と同じ形
function jstHourKey(unixSec) {
    return `${new Date((unixSec + 9 * 3600) * 1000).toISOString().slice(0, 13)}:00`;
}

// ファイルの末尾をまとめて1回で読むバックエンド。
//
// 標準の OmHttpBackend は、ファイルの中身の場所をたどるのに
//   HEAD（サイズ）→ 末尾24B → 変数の情報 → 索引 → データ本体
// と、前の結果を待って5回順番に出す。このうち前の4つは全部ファイルの末尾に固まっているので、
// 「末尾 N バイト」を1回で取って、以降はメモリから返す。データ本体だけ別に取る（5回 → 2回）。
// 末尾指定の Range（bytes=-N）は、ファイルのサイズを先に知らなくても使える。
// 取得結果はブラウザにも残さない（cache: 'no-store'）。
export class TailBackend {
    constructor({ url, tailBytes = 16384, timeoutMs = TIMEOUT_MS }) {
        this.url = url;
        this.tailBytes = tailBytes;
        this.timeoutMs = timeoutMs;
        this.tailPromise = null;
    }

    _tail() {
        if (!this.tailPromise) {
            this.tailPromise = (async () => {
                const res = await fetch(this.url, {
                    headers: { Range: `bytes=-${this.tailBytes}` },
                    cache: 'no-store',
                    signal: AbortSignal.timeout(this.timeoutMs)
                });
                if (res.status !== 206) throw new Error(`末尾の取得: HTTP ${res.status}`);
                const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
                if (!match) throw new Error('末尾の取得: Content-Range を読めません');
                const data = new Uint8Array(await res.arrayBuffer());
                const start = Number(match[1]);
                const size = Number(match[3]);
                if (start + data.length !== size) throw new Error('末尾の取得: 長さが合いません');
                return { start, size, data };
            })();
        }
        return this.tailPromise;
    }

    async count() {
        return (await this._tail()).size;
    }

    async getBytes(offset, size, signal) {
        const tail = await this._tail();
        if (offset >= tail.start && offset + size <= tail.size) {
            return tail.data.slice(offset - tail.start, offset - tail.start + size);
        }
        // 末尾に入っていない部分（データ本体など）は、通常の Range で取る
        const res = await fetch(this.url, {
            headers: { Range: `bytes=${offset}-${offset + size - 1}` },
            cache: 'no-store',
            signal: signal ?? AbortSignal.timeout(this.timeoutMs)
        });
        if (res.status !== 206) throw new Error(`Range の取得: HTTP ${res.status}`);
        const data = new Uint8Array(await res.arrayBuffer());
        if (data.length !== size) throw new Error(`Range の取得: ${data.length} バイト（期待 ${size}）`);
        return data;
    }

    async close() {}
}

async function fetchMeta(modelId) {
    const res = await fetch(`${S3_BASE}/data/${modelId}/static/meta.json`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`meta.json: HTTP ${res.status}`);
    return res.json();
}

// 1変数・1チャンクぶんの、指定セルの時系列
async function readChunk(model, variable, chunkNumber, cell) {
    const { grid } = model;
    const url = `${S3_BASE}/data/${model.id}/${variable}/chunk_${chunkNumber}.om`;
    const reader = await OmFileReader.create(new TailBackend({ url }));
    try {
        const dims = reader.getDimensions();
        if (dims.length !== 3 || dims[0] !== grid.ny || dims[1] !== grid.nx) {
            throw new Error(`${variable}: 想定外の寸法 ${dims.join('x')}`);
        }
        return await reader.read({
            type: OmDataType.FloatArray,
            ranges: [
                { start: cell.iy, end: cell.iy + 1 },
                { start: cell.ix, end: cell.ix + 1 },
                { start: 0, end: dims[2] }
            ]
        });
    } finally {
        reader.dispose?.();
    }
}

// 範囲 [fromSec, toSec]（UNIX秒）を、チャンクをまたいでつなぐ。時刻 → 値の Map
async function readVariable(model, variable, cell, meta, fromSec, toSec) {
    const step = meta.temporal_resolution_seconds;
    const chunkSec = meta.chunk_time_length * step;
    const first = Math.floor(fromSec / chunkSec);
    const last = Math.floor(Math.min(toSec, meta.data_end_time) / chunkSec);
    const numbers = [];
    for (let n = first; n <= last; n++) numbers.push(n);
    const chunks = await Promise.all(numbers.map((n) => readChunk(model, variable, n, cell)));

    const out = new Map();
    chunks.forEach((values, k) => {
        const startSec = numbers[k] * chunkSec;
        for (let i = 0; i < values.length; i++) {
            const t = startSec + i * step;
            if (t >= fromSec && t <= toSec) out.set(t, Number.isNaN(values[i]) ? null : values[i]);
        }
    });
    return out;
}

// 1モデルぶん。js/weather.js の extractSeries と同じ { times, values }
async function loadModelSeries(modelKey, lat, lng, nowSec, timeFilter) {
    const model = MODELS[modelKey];
    const cell = nearestCell(model.grid, lat, lng);
    if (!cell) return emptySeries(); // 範囲外（API も値なしを返す）

    const meta = await fetchMeta(model.id);
    const step = meta.temporal_resolution_seconds;
    const midnightJst = Math.floor((nowSec + 9 * 3600) / 86400) * 86400 - 9 * 3600;
    // 時刻の刻みに丸めない（丸めると、2週間予測の先頭が今日の0時より前の6時間前の値になる）
    const fromSec = model.fromJstMidnight ? midnightJst : nowSec - model.pastHours * 3600;
    const toSec = midnightJst + FORECAST_DAYS * 86400;

    const entries = await Promise.all(STORED_VARIABLES.map(async (variable) =>
        [variable, await readVariable(model, variable, cell, meta, fromSec, toSec)]));
    const byVariable = Object.fromEntries(entries);

    // 気温のある時刻だけ残す（API の extractSeries と同じ）
    const unix = [...byVariable.temperature_2m.keys()].sort((a, b) => a - b)
        .filter((t) => byVariable.temperature_2m.get(t) !== null && timeFilter(jstHourKey(t)));
    const get = (variable) => unix.map((t) => byVariable[variable].get(t) ?? null);
    const winds = unix.map((t) => windFromComponents(
        byVariable.wind_u_component_10m.get(t) ?? null, byVariable.wind_v_component_10m.get(t) ?? null));
    // AIFS の降水は1ステップ（6時間）ぶんの合計で入っている。API は1時間あたりに直した値を返すので揃える
    const hoursPerStep = step / 3600;

    return {
        times: unix.map(jstHourKey),
        values: {
            temperature_2m: get('temperature_2m'),
            relative_humidity_2m: get('relative_humidity_2m'),
            precipitation: get('precipitation').map((v) => (v === null ? null : v / hoursPerStep)),
            cloud_cover_low: get('cloud_cover_low'),
            cloud_cover_mid: get('cloud_cover_mid'),
            cloud_cover_high: get('cloud_cover_high'),
            wind_speed_10m: winds.map((w) => w.speed),
            wind_direction_10m: winds.map((w) => w.direction),
            pressure_msl: get('pressure_msl')
        }
    };
}

function emptySeries() {
    return {
        times: [],
        values: Object.fromEntries([
            'temperature_2m', 'relative_humidity_2m', 'precipitation',
            'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
            'wind_speed_10m', 'wind_direction_10m', 'pressure_msl'
        ].map((v) => [v, []]))
    };
}

// 1時間予測（MSM）と2週間予測（AIFS）を、どちらも S3 から読む。
// 片方だけ失敗したときは全体を失敗にする（API の応答と同じく、両方そろって返す）。
export async function loadPointForecastFromS3(lat, lng, nowSec = Math.floor(Date.now() / 1000)) {
    const [msm, aifs] = await Promise.all([
        loadModelSeries('msm', lat, lng, nowSec, () => true),
        loadModelSeries('aifs', lat, lng, nowSec, (key) => AIFS_JST_HOURS.includes(Number(key.slice(11, 13))))
    ]);
    return { elevation: null, msm, aifs };
}
