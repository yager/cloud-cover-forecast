// 気象庁潮位表（同梱 data/tide/）の読み込みと、1時間予測表向けの局所正規化。
//
// 値は天文潮の推算（月・太陽の起潮力＝分潮の和）。正規化は暦日ではなく、
// 主太陰半日周潮 M2（約12h25m）の半周期に相当する前後 ±6 時間の局所窓。

const STATIONS_URL = 'data/tide/stations.json';
const TXT_URL = (year, id) => `data/tide/${year}/${id}.txt`;

// M2 半周期の近似。窓が長すぎると日潮不等の弱い頂点が潰れる
export const TIDE_HALF_WINDOW_HOURS = 6;

// |s| がこれ未満は平常（無色）。以降は5段階。頂点付近を細かく分け、
// 中央の満／干だけが最濃色になるようにする（3段階だと山が3〜4時間同じ色になりやすい）
const TIDE_LEVELS = [0.30, 0.55, 0.75, 0.88, 0.96];

let stationsPromise = null;
const yearCache = new Map(); // `${year}:${id}` -> Map(jstKey -> cm)

function pad2(n) {
    return String(n).padStart(2, '0');
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

export async function loadTideStations() {
    if (!stationsPromise) {
        stationsPromise = fetch(STATIONS_URL)
            .then((res) => {
                if (!res.ok) throw new Error(`tide stations HTTP ${res.status}`);
                return res.json();
            })
            .then((data) => data.stations || []);
    }
    return stationsPromise;
}

export async function nearestTideStation(lat, lng) {
    const stations = await loadTideStations();
    let best = null;
    let bestKm = Infinity;
    for (const st of stations) {
        const km = haversineKm(lat, lng, st.lat, st.lon);
        if (km < bestKm) {
            bestKm = km;
            best = st;
        }
    }
    if (!best) return null;
    return { ...best, distanceKm: bestKm };
}

function parseYmd(slice) {
    const parts = slice.trim().split(/\s+/);
    if (parts.length === 3) {
        return { yy: Number(parts[0]), mm: Number(parts[1]), dd: Number(parts[2]) };
    }
    return {
        yy: Number(slice.slice(0, 2)),
        mm: Number(slice.slice(2, 4)),
        dd: Number(slice.slice(4, 6))
    };
}

// 年次テキスト → JST 時刻キー（weather.js の jstKey と同じ形）の Map
export function parseTideYearText(text) {
    const byHour = new Map();
    for (const line of text.split('\n')) {
        if (line.length < 80) continue;
        const { yy, mm, dd } = parseYmd(line.slice(72, 78));
        if (!yy || !mm || !dd) continue;
        const year = 2000 + yy;
        for (let h = 0; h < 24; h++) {
            const raw = line.slice(h * 3, h * 3 + 3);
            if (raw.trim() === '') continue;
            const cm = Number(raw);
            if (!Number.isFinite(cm)) continue;
            const key = `${year}-${pad2(mm)}-${pad2(dd)}T${pad2(h)}:00`;
            byHour.set(key, cm);
        }
    }
    return byHour;
}

async function loadStationYear(stationId, year) {
    const cacheKey = `${year}:${stationId}`;
    if (yearCache.has(cacheKey)) return yearCache.get(cacheKey);
    const promise = fetch(TXT_URL(year, stationId))
        .then((res) => {
            if (!res.ok) throw new Error(`tide ${stationId} ${year} HTTP ${res.status}`);
            return res.text();
        })
        .then(parseTideYearText)
        .catch((err) => {
            yearCache.delete(cacheKey);
            throw err;
        });
    yearCache.set(cacheKey, promise);
    return promise;
}

function shiftJstHourKey(key, deltaHours) {
    // key = YYYY-MM-DDTHH:00（JST 壁時計）。UTC Date に載せてずらす
    const date = new Date(`${key}:00+09:00`);
    date.setTime(date.getTime() + deltaHours * 3600 * 1000);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day}T${hour}:00`;
}

function yearsNeeded(times) {
    const years = new Set();
    for (const t of times) {
        years.add(Number(t.slice(0, 4)));
        // 窓が年をまたぐ場合に備える
        years.add(Number(shiftJstHourKey(t, -TIDE_HALF_WINDOW_HOURS).slice(0, 4)));
        years.add(Number(shiftJstHourKey(t, TIDE_HALF_WINDOW_HOURS).slice(0, 4)));
    }
    return [...years];
}

async function loadHourMap(stationId, times) {
    const maps = await Promise.all(
        yearsNeeded(times).map((year) => loadStationYear(stationId, year).catch(() => new Map()))
    );
    const merged = new Map();
    for (const m of maps) {
        for (const [k, v] of m) merged.set(k, v);
    }
    return merged;
}

// 局所窓での符号付き相対位置。-1=干側頂点寄り、+1=満側頂点寄り、0付近=平常
export function localTideSigned(byHour, timeKey, halfHours = TIDE_HALF_WINDOW_HOURS) {
    if (!byHour.has(timeKey)) return { cm: null, s: 0 };
    let min = Infinity;
    let max = -Infinity;
    let n = 0;
    for (let d = -halfHours; d <= halfHours; d++) {
        const k = shiftJstHourKey(timeKey, d);
        if (!byHour.has(k)) continue;
        const v = byHour.get(k);
        if (v < min) min = v;
        if (v > max) max = v;
        n += 1;
    }
    const cm = byHour.get(timeKey);
    if (n < 3 || max === min) return { cm, s: 0 };
    return { cm, s: (2 * (cm - min)) / (max - min) - 1 };
}

function tideTier(absS) {
    let tier = 0;
    for (let i = 0; i < TIDE_LEVELS.length; i++) {
        if (absS >= TIDE_LEVELS[i]) tier = i + 1;
    }
    return tier;
}

export function tideCellFromSigned(cm, s) {
    if (cm === null || cm === undefined) return '−';
    const html = String(Math.round(cm));
    const tier = tideTier(Math.abs(s));
    if (tier === 0) return html;
    const side = s >= 0 ? 'high' : 'low';
    return { html, cls: `tide-${side}-${tier}` };
}

// ピン地点の最寄り検潮点と、表示時刻列に対応するセルを返す。
// 失敗時は null（表には潮位行を出さない）
export async function loadTideRow(lat, lng, times) {
    if (!times || times.length === 0) return null;
    const station = await nearestTideStation(lat, lng);
    if (!station) return null;
    const byHour = await loadHourMap(station.id, times);
    const cells = times.map((t) => {
        const { cm, s } = localTideSigned(byHour, t);
        return tideCellFromSigned(cm, s);
    });
    const km = station.distanceKm;
    const kmLabel = km < 10 ? km.toFixed(1) : String(Math.round(km));
    return {
        station,
        key: '潮位',
        label: '潮位 <span class="tide-ref">*1</span>',
        footnoteHtml: `<span class="tide-ref">*1</span> 潮位は最寄り${kmLabel}km地点（${station.name}）のデータです（単位:cm）。`,
        cells
    };
}
