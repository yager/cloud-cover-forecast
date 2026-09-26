// 雲量予測の画面まわり。地図の初期化・表・ナウキャストのタイムラインなど。
// データ取得そのものは msm.js / nowcast.js / weather.js / pin.js に分かれている。

import { PinController, setupSearch, formatLatLng } from './pin.js';
import { PlacesController } from './places.js';
import {
    loadPointForecast, loadJmaWeekly, trimSeriesBefore, weatherTelop,
    reverseGeocodeAddress, jstKey, formatDateLabel, formatHourLabel
} from './weather.js';
// 副作用の無い色の定数だけ。凡例は起動時に組み立てるので、描画モジュールを待たずに
// msm.js / nowcast.js と同じ色を参照できるようにしてある
import { WIND_STEPS, RAIN_COLORS, RAIN_THRESHOLDS, THUNDER_COLORS, THUNDER_LABELS } from './colors.js';

// マップオブジェクト
const maps = {
    total: null,
    lower: null,
    middle: null,
    upper: null,
    wind: null,
    rain: null,
    thunder: null
};

// 雲量の地図とは別の時間軸で動くナウキャスト（降水・雷）
let nowcastRain = null;
let nowcastThunder = null;
// 1コマの幅。15分（3コマ）おきのラベルが重ならない間隔にしてある。
// タイムラインの目盛りとピン地点の帯で共有する（片方だけ変えるとずれる）
const STEP_PX = 26;

// 地図の表示の切り替え（total: 総雲量1枚 / layers: 上中下層の3枚）
const PC_MEDIA = '(min-width: 1000px)';
let mapView = null;
let isFullscreen = false;
// 全画面スマホで「雲(上中下層)」のとき、どの1層を出すか
let cloudLayer = 'lower';
// 各地図に付けた全画面ボタン（状態をまとめて切り替える）
const fullscreenButtons = [];

// Material Icons 風の四隅枠 / 内側へ縮む矢印
const FS_ENTER_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
const FS_EXIT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path fill="currentColor" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>';

// 行きたい地点のピンと、雲量データのソース（init で作る）
let pinController = null;
let placesController = null;
let cloudSource = null;

// 雲量地図が使っている計算の基準時刻。1時間予測の表もここから始める
let resolveCloudBaseTime;
const cloudBaseTime = new Promise((resolve) => { resolveCloudBaseTime = resolve; });

// 日の出・日の入りを計算する既定の地点（ピンが無いとき）
const DEFAULT_SUN_POINT = { lat: 35.844535, lng: 139.746094 };

// パラメータなしで開いたか。自動で現在地を取るかの判定に使う。
// updateUrl が lat/lng/z を書き込むので、ここで先に確定させておく必要がある
const OPENED_WITHOUT_PARAMS = window.location.search === '';

// URLパラメータを読み取る関数
function getUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const lat = params.get('lat');
    const lng = params.get('lng');
    const z = params.get('z');

    // pin=緯度,経度（任意で pinname=表示名）
    let pin = null;
    const pinParts = (params.get('pin') || '').split(',').map(parseFloat);
    if (pinParts.length === 2 && pinParts.every(Number.isFinite)
        && Math.abs(pinParts[0]) <= 90 && Math.abs(pinParts[1]) <= 180) {
        pin = { lat: pinParts[0], lng: pinParts[1], name: params.get('pinname') };
    }

    return {
        lat: lat ? parseFloat(lat) : null,
        lng: lng ? parseFloat(lng) : null,
        z: z ? parseFloat(z) : null,
        pin
    };
}

// URLを更新する関数
function updateUrl(center, zoom) {
    const params = new URLSearchParams();
    params.set('lat', center.lat.toFixed(6));
    params.set('lng', center.lng.toFixed(6));
    params.set('z', zoom.toString());

    const pin = pinController && pinController.pin;
    if (pin) {
        params.set('pin', formatLatLng(pin.lat, pin.lng).replace(' ', ''));
        if (pin.name !== formatLatLng(pin.lat, pin.lng)) {
            params.set('pinname', pin.name);
        }
    }

    const newUrl = window.location.pathname + '?' + params.toString();
    history.replaceState(null, '', newUrl);

    // 解析側が履歴の変更を拾った場合でも座標が乗らないようにしておく
    if (window.gtag) {
        gtag('set', { page_location: location.origin + location.pathname });
    }
}

// マップを初期化する関数
function initMaps() {
    // URLパラメータから初期値を取得
    const urlParams = getUrlParams();

    // 初期表示は関東の範囲。地図の大きさ（スマホ/PC）に応じて小数ズームで合わせる。
    // スマホ（300×200）でちょうどズーム7になる範囲を、少しだけ内側に縮めてある
    const defaultBounds = L.latLngBounds([34.895, 137.840], [36.659, 141.103]);
    const mapOptions = {
        zoomSnap: 0.25
    };

    maps.rain = L.map('map-rain', mapOptions);
    maps.thunder = L.map('map-thunder', mapOptions);
    maps.wind = L.map('map-wind', mapOptions);
    maps.total = L.map('map-total', mapOptions);
    maps.lower = L.map('map-lower', mapOptions);
    maps.middle = L.map('map-middle', mapOptions);
    maps.upper = L.map('map-upper', mapOptions);

    const initialZoom = urlParams.z !== null ? urlParams.z : maps.lower.getBoundsZoom(defaultBounds);
    const initialCenter = urlParams.lat !== null && urlParams.lng !== null
        ? L.latLng(urlParams.lat, urlParams.lng)
        : defaultBounds.getCenter();

    Object.values(maps).forEach((map) => map.setView(initialCenter, initialZoom));

    // 国土地理院の陰影起伏図を暗く落とした下地に、白地図の輪郭線を重ねる。
    // 地名などの文字情報を減らし、起伏と県の輪郭だけが分かる状態にしている。
    // 無彩色にしてあるのは、下地の色が雲量の色と競合しないようにするため。
    // native ズームは地理院タイルの提供範囲（陰影起伏図 2〜16、白地図 5〜14）。
    // 範囲外のズームでは端のタイルを拡大・縮小して使う（指定しないと 404 になる）
    const BASE_TILES = [
        { url: 'https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png', minNativeZoom: 2, maxNativeZoom: 16, className: 'hillshade-dark-tile' },
        { url: 'https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png', minNativeZoom: 5, maxNativeZoom: 14, className: 'blank-line-tile' }
    ];

    for (const map of Object.values(maps)) {
        // 雲量レイヤー（既定の tilePane、z-index 200）より下に敷く
        const pane = map.createPane('baseDark');
        pane.classList.add('base-dark-pane');
        pane.style.zIndex = '199';
        for (const tile of BASE_TILES) {
            L.tileLayer(tile.url, {
                pane: 'baseDark',
                className: tile.className,
                // CORS で取ると Service Worker が中身を見られる。
                // 素の img のままだと不透明な応答になり、保存容量が実際よりはるかに大きく計上される
                crossOrigin: 'anonymous',
                maxZoom: 18,
                minNativeZoom: tile.minNativeZoom,
                maxNativeZoom: tile.maxNativeZoom
            }).addTo(map);
        }
    }

    // 各マップにラベルを追加（右上）
    const MAP_LABELS = {
        rain: '雨雲<small>気象庁ナウキャスト</small>',
        thunder: '雷<small>気象庁ナウキャスト</small>',
        wind: '風<small>地上10m付近</small>',
        total: '全雲量<small>空全体</small>',
        upper: '上層<small>5500m付近〜</small>',
        middle: '中層<small>1500〜5500m付近</small>',
        lower: '下層<small>〜1500m付近</small>'
    };
    for (const [type, html] of Object.entries(MAP_LABELS)) {
        const label = L.control({ position: 'topright' });
        label.onAdd = function() {
            const div = L.DomUtil.create('div', 'leaflet-control-map-label');
            div.innerHTML = html;
            return div;
        };
        label.addTo(maps[type]);
    }

    // 配色の凡例（左下）。連続量（風・降水）は帯、区分（雷）はマス。
    // 色の値は colors.js を参照する（msm.js / nowcast.js の実装と同じ値）

    // 連続量の帯。colors は境目の数+1、labels は境目の数ぶん（境目に目盛りを置く）
    function legendBar(colors, labels, unit) {
        const swatches = colors.map((c) => `<i style="background:${c}"></i>`).join('');
        const n = colors.length;
        const ticks = labels.map((label, i) => `<span style="left:${(i + 1) / n * 100}%">${label}</span>`).join('');
        return `<div class="legend-bar">${swatches}</div><div class="legend-ticks">${ticks}</div><div class="legend-caption">${unit}</div>`;
    }

    // WIND_STEPS は強い順（WindGridLayer の検索順）なので、凡例用に弱い順へ並べ替える。
    // 2 m/s未満は地図上では透明なので先頭に空欄を1つ足す
    const windAscending = [...WIND_STEPS].reverse();

    const LEGENDS = {
        wind: legendBar(
            ['transparent', ...windAscending.map((s) => `rgba(${s.rgba[0]},${s.rgba[1]},${s.rgba[2]},${(s.rgba[3] / 255).toFixed(2)})`)],
            windAscending.map((s) => s.min), 'm/s'
        ),
        rain: legendBar(RAIN_COLORS.map((hex) => `#${hex}`), RAIN_THRESHOLDS, 'mm/h'),
        thunder: '<div class="legend-levels">' + THUNDER_COLORS.map((hex, i) =>
            `<i style="background:#${hex}" title="${THUNDER_LABELS[i]}">${i + 1}</i>`
        ).join('') + '</div>'
    };
    for (const [type, html] of Object.entries(LEGENDS)) {
        const legend = L.control({ position: 'bottomleft' });
        legend.onAdd = function() {
            const div = L.DomUtil.create('div', 'map-legend');
            div.innerHTML = html;
            return div;
        };
        legend.addTo(maps[type]);
    }

    // マップのサイズを再計算（複数マップの場合に必要）
    setTimeout(invalidateMapsSize, 100);

    // すべての地図のズームレベルと位置を連動させる
    let syncing = false; // 同期中フラグ（無限ループを防ぐ）

    function syncMaps(sourceMap) {
        if (syncing) return; // 既に同期中なら何もしない
        syncing = true;

        const center = sourceMap.getCenter();
        const zoom = sourceMap.getZoom();

        for (const map of Object.values(maps)) {
            if (map !== sourceMap) map.setView(center, zoom);
        }

        // URLを更新
        updateUrl(center, zoom);

        setTimeout(() => {
            syncing = false;
        }, 100);
    }

    for (const map of Object.values(maps)) {
        map.on('moveend zoomend', function() {
            if (!syncing) syncMaps(map);
        });
    }
}

// UTC時刻をJSTに変換して文字列として返す
function utcToJSTString(utcString) {
    const utcDate = new Date(utcString);
    return utcDate.toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).replace(/\//g, '-');
}

// UTC時刻をJSTに変換して文字列として返す（年なし、プルダウン用）
function utcToJSTStringForSelect(utcString) {
    const utcDate = new Date(utcString);
    return utcDate.toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// 日の出・日の入りの時間を計算（地図の中心座標を使用）
function getSunsetSunriseTimes(date, lat, lon) {
    const times = SunCalc.getTimes(date, lat, lon);
    return {
        sunrise: times.sunrise,
        sunset: times.sunset
    };
}

// 時刻が日の出・日の入りに該当するかチェック（±30分の範囲内）
function isSunsetSunriseTime(time, lat, lon) {
    const date = new Date(time);
    const sunTimes = getSunsetSunriseTimes(date, lat, lon);
    const tolerance = 30 * 60 * 1000; // 30分（ミリ秒）

    const timeMs = date.getTime();
    const sunriseMs = sunTimes.sunrise.getTime();
    const sunsetMs = sunTimes.sunset.getTime();

    return Math.abs(timeMs - sunriseMs) <= tolerance || Math.abs(timeMs - sunsetMs) <= tolerance;
}

// 日の出・日の入りの時間を取得（該当する場合）
function getSunsetSunriseLabel(time, lat, lon) {
    const date = new Date(time);
    const sunTimes = getSunsetSunriseTimes(date, lat, lon);
    const tolerance = 30 * 60 * 1000; // 30分（ミリ秒）

    const timeMs = date.getTime();
    const sunriseMs = sunTimes.sunrise.getTime();
    const sunsetMs = sunTimes.sunset.getTime();

    if (Math.abs(timeMs - sunriseMs) <= tolerance) {
        const sunriseTime = sunTimes.sunrise.toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo',
            hour: '2-digit',
            minute: '2-digit'
        });
        return ` /日の出 ${sunriseTime}`;
    } else if (Math.abs(timeMs - sunsetMs) <= tolerance) {
        const sunsetTime = sunTimes.sunset.toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo',
            hour: '2-digit',
            minute: '2-digit'
        });
        return ` /日の入 ${sunsetTime}`;
    }
    return '';
}

// 日時プルダウンのラベル。日の出・日の入りはピンの地点（無ければ既定の地点）で判定
function timeLabel(utcKey) {
    const point = (pinController && pinController.pin) || DEFAULT_SUN_POINT;
    let label = utcToJSTStringForSelect(utcKey);
    if (isSunsetSunriseTime(utcKey, point.lat, point.lng)) {
        label += getSunsetSunriseLabel(utcKey, point.lat, point.lng);
    }
    return label;
}

function refreshTimeLabels() {
    for (const option of document.getElementById('time-select').options) {
        if (option.value) option.textContent = timeLabel(option.value);
    }
}

// 基準時刻と対象時刻の一覧から日時プルダウンを作成
function setupTimeSelect(data) {
    const select = document.getElementById('time-select');
    select.innerHTML = ''; // 既存のオプションをクリア

    if (data.times) {
        const tileKeys = [...data.times];
        // 時刻でソート（時系列昇順）
        tileKeys.sort((a, b) => new Date(a) - new Date(b));

        tileKeys.forEach((utcKey) => {
            const option = document.createElement('option');
            option.value = utcKey;
            option.textContent = timeLabel(utcKey);
            select.appendChild(option);
        });

        // 現在時刻の次にくる時間を選択
        if (tileKeys.length > 0) {
            const now = new Date();
            // 現在時刻より後の時刻を探す
            const nextTime = tileKeys.find(utcKey => {
                const time = new Date(utcKey);
                return time > now;
            });

            // 現在時刻より後の時刻があればそれを選択、なければ最初の時刻を選択
            if (nextTime) {
                select.value = nextTime;
            } else {
                select.value = tileKeys[0];
            }
        }
    }

    // basetimeをJSTに変換して表示（年なし）
    if (data.baseTime) {
        const jstString = utcToJSTStringForSelect(data.baseTime);
        document.getElementById('update-time').innerHTML = 
            `<strong>基準時刻:</strong> ${jstString} (JST)`;
    }

    // 表のほうが先にできていることがあるので、ここでも付け直す
    markSelectableTimes();
}

// 気象庁MSMの数値計算結果（Open-Meteo の .om）をブラウザで描くソース
// onFrame: 表示するコマが切り替わったときに呼ぶ
async function createMsmSource(onFrame) {
    const msm = await import('./msm.js');
    const source = new msm.MsmOmSource();
    const layers = {};
    let requestedTime = null;
    let currentFrame = null;

    Object.keys(maps).forEach((type) => {
        if (type === 'rain' || type === 'thunder') return; // 降水・雷は別の時間軸なので別管理
        layers[type] = type === 'wind'
            ? new msm.WindGridLayer().addTo(maps[type])
            : new msm.CloudGridLayer().addTo(maps[type]);
    });

    return {
        loadIndex: () => source.loadIndex(),

        // 表示中のコマで、地点に最も近い格子の値。
        // 読み込み前は undefined、格子の範囲外は null、欠測の層は null
        valueAt(lat, lng) {
            if (!currentFrame) return undefined;
            const cell = msm.gridIndex(lat, lng);
            if (!cell) return null;
            const i = cell.iy * msm.GRID.nx + cell.ix;
            const value = (type) => currentFrame[type][i] === msm.MISSING ? null : currentFrame[type][i];
            const w = currentFrame.wind;
            return {
                total: value('total'), upper: value('upper'), middle: value('middle'), lower: value('lower'),
                // 格子に持っているのは「吹いていく向き」。
                // 気象でいう風向は「吹いてくる向き」なので180°反転してから表示する
                windSpeed: w ? w.speed[i] * msm.WIND_SPEED_UNIT : null,
                windFrom: w ? (270 - w.direction[i] / 256 * 360 + 720) % 360 : null
            };
        },

        async show(time) {
            requestedTime = time;
            let frame;
            try {
                frame = await source.loadFrame(time);
            } catch (error) {
                console.error(`Failed to load MSM frame ${time}:`, error);
                return;
            }
            // 読み込み中に別の時刻が選ばれていたら捨てる
            if (requestedTime !== time) return;
            currentFrame = frame;
            markDataFetched();
            Object.keys(layers).forEach((type) => layers[type].setValues(frame[type]));
            onFrame();

            // 次のコマを先読み
            const select = document.getElementById('time-select');
            const next = select.options[select.selectedIndex + 1];
            if (next) source.loadFrame(next.value).catch(() => {});
        }
    };
}

// --- 予報の表 ---

// 行＝項目、列＝時刻の表を作る。
// rows: [{ key, cells: [文字列またはHTML] }]、times: 列に対応する時刻（赤線の判定に使う）
function renderTable(table, rows, times) {
    table.innerHTML = '';
    // 列の刻み（分）。過ぎた時刻の判定に使う
    if (times && times.length > 1) {
        const first = new Date(`${times[0]}:00+09:00`).getTime();
        const second = new Date(`${times[1]}:00+09:00`).getTime();
        table.dataset.stepMinutes = String((second - first) / 60000);
    }
    for (const row of rows) {
        const tr = document.createElement('tr');
        tr.dataset.key = row.key;
        const th = document.createElement('th');
        th.textContent = row.key;
        tr.appendChild(th);
        row.cells.forEach((cell, i) => {
            const td = document.createElement('td');
            // セルは文字列か { html, colspan, time }
            if (typeof cell === 'string') {
                td.innerHTML = cell;
                if (times) td.dataset.time = times[i];
            } else {
                td.innerHTML = cell.html;
                if (cell.colspan) td.colSpan = cell.colspan;
                const time = cell.time || (times ? times[i] : null);
                if (time) td.dataset.time = time;
                if (cell.cls) td.className = cell.cls;
            }
            tr.appendChild(td);
        });
        table.appendChild(tr);
    }

    // 日付ラベルは、左端の項目名の右隣に貼り付ける
    const label = table.querySelector('th');
    if (label) table.style.setProperty('--label-width', `${label.offsetWidth}px`);
}

const num = (v, digits = 0) => v === null || v === undefined ? '−' : v.toFixed(digits);

// 1時間降水量の強さ。区切りは気象庁の「雨の強さと降り方」に合わせ、
// 30mm（激しい雨）以上は青系から離して警戒色にする
function rainCell(value) {
    const html = num(value, 1);
    if (value === null || value === undefined || value < 0.1) return html;
    const step = value >= 80 ? 8 : value >= 50 ? 7 : value >= 30 ? 6 : value >= 20 ? 5
        : value >= 10 ? 4 : value >= 5 ? 3 : value >= 1 ? 2 : 1;
    return { html, cls: `rain-${step}` };
}

// 気圧痛の目安。「6時間の急な変化」と「24時間でのじわじわした変化」の
// 強いほうを採る（前日比5hPa以上の低下で頭痛が増える、という報告に合わせている）。
// 体感に合わせて調整するときはここだけ変える。
const PRESSURE_RULES = [
    { hours: 6, levels: [2, 4, 6] },
    { hours: 24, levels: [5, 8, 12] }
];

// stepHours: その表の1コマが何時間か（1時間予測=1、2週間予測=6）
function pressureCells(values, stepHours) {
    return values.map((value, i) => {
        const html = num(value);
        if (value === null || value === undefined) return html;

        let worst = { step: 0, change: 0 };
        for (const rule of PRESSURE_RULES) {
            const back = rule.hours / stepHours;
            const previous = values[i - back];
            if (!Number.isInteger(back) || previous === null || previous === undefined) continue;
            const change = value - previous;
            const size = Math.abs(change);
            const step = size >= rule.levels[2] ? 3 : size >= rule.levels[1] ? 2 : size >= rule.levels[0] ? 1 : 0;
            if (step > worst.step || (step === worst.step && size > Math.abs(worst.change))) {
                worst = { step, change };
            }
        }
        if (worst.step === 0) return html;
        return { html, cls: `press-${worst.change < 0 ? 'fall' : 'rise'}-${worst.step}` };
    });
}

// 気温は文字色だけで表す。区切りは 0℃（凍結）と気象庁の夏日・真夏日・猛暑日
function temperatureCell(value) {
    const html = num(value, 1);
    if (value === null || value === undefined) return html;
    const cls = value >= 35 ? 'temp-hot3' : value >= 30 ? 'temp-hot2' : value >= 25 ? 'temp-hot1'
        : value < -5 ? 'temp-cold3' : value < 0 ? 'temp-cold2' : value < 5 ? 'temp-cold1' : null;
    return cls ? { html, cls } : html;
}

// 湿度は、判断に効く両端だけ色を付ける（乾燥＝砂色、多湿＝藤色）
function humidityCell(value) {
    const html = num(value);
    if (value === null || value === undefined) return html;
    if (value <= 30) return { html, cls: 'humid-dry' };
    if (value >= 100) return { html, cls: 'humid-3' };
    if (value >= 90) return { html, cls: 'humid-2' };
    if (value >= 80) return { html, cls: 'humid-1' };
    return html;
}

// 雲量の多さを背景の濃さで表す（地図の色分けと同じ 20/40/60/80/100 の区切り）
function cloudCell(value) {
    const html = num(value);
    if (value === null || value === undefined) return html;
    const step = value >= 100 ? 5 : value >= 80 ? 4 : value >= 60 ? 3 : value >= 40 ? 2 : value >= 20 ? 1 : 0;
    return step === 0 ? html : { html, cls: `cloud-${step}` };
}

// 数値計算の結果（MSM・AIFS）の表。stepHours は1コマの長さ（気圧の変化量の計算に使う）
function forecastRows(series, stepHours) {
    const v = series.values;

    // 同じ日付の列をひとつのセルにまとめる。
    // 中のラベルを固定するので、横スクロールしても日付が次の日まで残る
    const dateGroups = [];
    series.times.forEach((t) => {
        const label = formatDateLabel(t);
        const last = dateGroups[dateGroups.length - 1];
        if (last && last.html === label) last.colspan += 1;
        else dateGroups.push({ html: label, colspan: 1, time: t });
    });

    return [
        { key: '日付', cells: dateGroups.map(g => ({ ...g, cls: 'date-cell', html: `<span class="date-label">${g.html}</span>` })) },
        { key: '時刻', cells: series.times.map(formatHourLabel) },
        { key: '上層雲', cells: v.cloud_cover_high.map(cloudCell) },
        { key: '中層雲', cells: v.cloud_cover_mid.map(cloudCell) },
        { key: '下層雲', cells: v.cloud_cover_low.map(cloudCell) },
        { key: '気温', cells: v.temperature_2m.map(temperatureCell) },
        { key: '降水量', cells: v.precipitation.map(rainCell) },
        { key: '風', cells: v.wind_speed_10m.map((speed, i) => {
            const dir = v.wind_direction_10m[i];
            const arrow = dir === null ? '' : `<span class="wind-arrow" style="transform: rotate(${dir}deg)">↓</span>`;
            const html = `${arrow}${num(speed, 1)}`;
            if (speed === null || speed < 5) return html;
            // 5/10/15/20/25 m/s で色を濃くする（参考実装と同じ区切り）
            const step = speed >= 25 ? 5 : speed >= 20 ? 4 : speed >= 15 ? 3 : speed >= 10 ? 2 : 1;
            return { html, cls: `wind-${step}` };
        }) },
        { key: '湿度', cells: v.relative_humidity_2m.map(humidityCell) },
        { key: '気圧', cells: pressureCells(v.pressure_msl, stepHours) }
    ];
}

// 気象庁の週間予報の表
function weeklyRows(weekly) {
    const range = (lower, upper) => lower && upper ? `<div class="range">${lower}〜${upper}</div>` : '';
    return [
        { key: '日付', cells: weekly.days.map(d => formatDateLabel(d.time)) },
        { key: '天気', cells: weekly.days.map((d) => {
            const telop = weatherTelop(d.weatherCode);
            if (!telop) return '−';
            return `<img src="${telop.icon}" alt="${telop.text}" loading="lazy">`
                + `<div class="telop">${telop.text}</div>`;
        }) },
        { key: '降水確率', cells: weekly.days.map(d => d.pop === '' ? '−' : d.pop) },
        { key: '信頼度', cells: weekly.days.map(d => d.reliability || '−') },
        { key: '最高気温', cells: weekly.days.map(d => (d.tempMax || '−') + range(d.tempMaxLower, d.tempMaxUpper)) },
        { key: '最低気温', cells: weekly.days.map(d => (d.tempMin || '−') + range(d.tempMinLower, d.tempMinUpper)) }
    ];
}

function showForecastError(sectionId, message) {
    const section = document.getElementById(sectionId);
    section.hidden = false;
    // 前の地点の補足情報（週間予報の予報区と発表時刻）が残らないように消す
    const meta = section.querySelector('.forecast-meta');
    if (meta) meta.textContent = '';
    section.querySelector('.table-container').innerHTML = `<p class="forecast-error">${message}</p>`;
}

// ピンが変わるたびに取得し直す。古い応答は捨てる
let forecastToken = 0;
async function updateForecast(pin) {
    const token = ++forecastToken;
    const sections = ['forecast-msm', 'forecast-jma', 'forecast-aifs'];
    document.getElementById('forecast-hint').hidden = !!pin;
    if (!pin) {
        sections.forEach(id => { document.getElementById(id).hidden = true; });
        return;
    }

    Promise.all([loadPointForecast(pin.lat, pin.lng), cloudBaseTime]).then(([forecast, baseTime]) => {
        if (token !== forecastToken) return;
        markDataFetched();
        // 1時間予測は、雲量地図と同じ計算の範囲（基準時刻以降）だけを出す。
        // それより前の時刻は前の計算の値で、地図では選べないため
        const sections = [
            ['forecast-msm', trimSeriesBefore(forecast.msm, baseTime), 1],
            ['forecast-aifs', forecast.aifs, 6]
        ];
        for (const [id, series, stepHours] of sections) {
            const section = document.getElementById(id);
            section.hidden = false;
            const container = section.querySelector('.table-container');
            container.innerHTML = '<table></table>';
            renderTable(container.firstChild, forecastRows(series, stepHours), series.times);
            markPastCells();
            scrollToCurrentColumn(container);
        }
        highlightForecastTime(document.getElementById('time-select').value);
        markSelectableTimes();
    }).catch((error) => {
        if (token !== forecastToken) return;
        console.error('Failed to load point forecast:', error);
        showForecastError('forecast-msm', '予測値を取得できませんでした。');
        showForecastError('forecast-aifs', '予測値を取得できませんでした。');
    });

    loadJmaWeekly(pin.lat, pin.lng).then((weekly) => {
        if (token !== forecastToken) return;
        const section = document.getElementById('forecast-jma');
        section.hidden = false;
        section.querySelector('.table-container').innerHTML = '<table></table>';
        renderTable(section.querySelector('table'), weeklyRows(weekly), null);
        const report = utcToJSTStringForSelect(weekly.reportDatetime);
        document.getElementById('jma-meta').textContent =
            `${weekly.area.officeName} ${weekly.areaName}の予報（気温は${weekly.tempAreaName}）。${report} 発表。`;
    }).catch((error) => {
        if (token !== forecastToken) return;
        console.error('Failed to load JMA weekly forecast:', error);
        showForecastError('forecast-jma', '気象庁の週間予報を取得できませんでした。');
    });
}

// 降水・雷ナウキャスト共通のタイムラインエンジン。雲量とは時間軸が違うので、
// コマ送りも表示も独立して持つ。frames の取得方法とコマごとの描画（タイル差し替え・
// マーカー更新など）だけ呼び出し側で差し替える。スクロール・スナップ・再生・
// レイアウトの計算はここに1箇所だけ持つ
async function createTimeline({ loadFrames, renderFrame }) {
    const viewport = document.getElementById('nowcast-viewport');
    const strip = document.getElementById('nowcast-strip');
    const ticks = document.getElementById('nowcast-ticks');
    const axis = document.getElementById('nowcast-axis');
    const head = document.getElementById('nowcast-head');
    const playButton = document.getElementById('nowcast-play');
    const resetButton = document.getElementById('nowcast-reset');

    const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
    const hhmm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

    let frames = [];
    let index = 0;
    let timer = null;
    let scrolling = false; // 自分でスクロールさせている間は反応しない

    function render() {
        const frame = frames[index];
        if (!frame) return;
        renderFrame(frame);
        const d = frame.time;
        head.innerHTML = `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]}) <b>${hhmm(d)}</b>`
            + `<span class="kind" data-forecast="${frame.isForecast}">${frame.isForecast ? '予測' : '実況'}</span>`;
        viewport.setAttribute('aria-valuetext', `${hhmm(d)} ${frame.isForecast ? '予測' : '実況'}`);
    }

    // コマを中央へ持ってくる。共有DOM（見出し・地図）は常にこのタブのコマで描き直す。
    // index が変わらないときも render する（タブ切替で戻ってきたときに、
    // もう片方のタブが書き換えた #nowcast-head をこのタブの内容に戻すため）
    function show(i, smooth) {
        if (!frames.length) return;
        index = Math.max(0, Math.min(frames.length - 1, i));
        render();
        scrolling = true;
        viewport.scrollTo({ left: index * STEP_PX, behavior: smooth ? 'smooth' : 'auto' });
        setTimeout(() => { scrolling = false; }, smooth ? 400 : 80);
    }

    // 中央に来ているコマを読み取る。
    // メモリの間隔はデータの間隔（5分）そのものなので、途中で止まると
    // どの時刻を指しているのか分からなくなる。スクロールが止まったら
    // 最寄りのコマへ smooth スナップする（フリースクロール自体は妨げない）。
    //
    // 再生中（timer が動いている間）はここで何もしない。play() 自身が
    // index とスクロール位置を完全に管理しているので、ここで反応する理由が無い。
    // 本来は scrolling フラグ（80ms）で自分のスクロールを無視しているが、
    // ピンのサンプリングなどでメインスレッドが混むとこのタイマーが間に合わず、
    // 自分自身のスクロールをユーザー操作と誤認識してスナップと再生が競合し、
    // タイムラインが行ったり来たりする不具合があった。timer 中は完全に無視することで、
    // タイミングに依存せず解消する
    let snapTimer = null;
    function onScroll() {
        if (timer || scrolling || !frames.length) return;
        const i = Math.max(0, Math.min(frames.length - 1, Math.round(viewport.scrollLeft / STEP_PX)));
        if (i !== index) {
            index = i;
            render();
        }
        clearTimeout(snapTimer);
        snapTimer = setTimeout(() => show(index, true), 120);
    }

    const nowIndex = () => {
        const last = frames.map((f) => f.isForecast).lastIndexOf(false);
        return last < 0 ? 0 : last;
    };

    function stop() {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
        playButton.textContent = '▶';
        playButton.setAttribute('aria-label', '再生');
    }

    function play() {
        if (timer) return stop();
        clearTimeout(snapTimer); // 保留中のスナップがあれば、再生開始と競合する前に捨てる
        if (index >= frames.length - 1) show(0);
        playButton.textContent = '■';
        playButton.setAttribute('aria-label', '停止');
        timer = setInterval(() => show(index >= frames.length - 1 ? 0 : index + 1), 1000);
    }

    // カーソルは viewport の中央に固定してあるので、
    // 最初と最後のコマもそこまで来られるよう前後に画面半分ぶんの余白をとる。
    // 余白は目盛り層を右へずらすことで作る（padding では目盛りが動かない）
    function layout() {
        const pad = viewport.clientWidth / 2;
        if (!pad) return; // 隠れている間は幅を測れない。表示されたときに測り直す
        ticks.style.left = `${pad}px`;
        strip.style.width = `${(frames.length - 1) * STEP_PX + pad * 2}px`;
        show(index);
    }

    function buildStrip() {
        const boundary = nowIndex();
        const x = (i) => i * STEP_PX;
        let html = `<div class="nowcast-rail" style="width:${x(frames.length - 1)}px"></div>`;

        frames.forEach((frame, i) => {
            const major = frame.time.getMinutes() % 15 === 0;
            const isNow = i === boundary;
            html += `<div class="nowcast-tick${isNow ? ' now' : major ? ' major' : ''}" style="left:${x(i)}px"></div>`;
            if (isNow) {
                html += `<div class="nowcast-label now" style="left:${x(i)}px">現在</div>`;
            } else if (major) {
                html += `<div class="nowcast-label" style="left:${x(i)}px">${hhmm(frame.time)}</div>`;
            }
        });
        axis.innerHTML = html;
    }

    // PCはホイールでもドラッグでも動かせるように
    let dragFrom = null;
    function onPointerDown(e) {
        if (e.pointerType === 'touch') return; // タッチは既定のスクロールに任せる
        dragFrom = { x: e.clientX, left: viewport.scrollLeft };
        viewport.setPointerCapture(e.pointerId);
        stop();
    }
    function onPointerMove(e) {
        if (!dragFrom) return;
        viewport.scrollLeft = dragFrom.left - (e.clientX - dragFrom.x);
    }
    function endDrag() { if (dragFrom) { dragFrom = null; show(index, true); } }
    function onKeyDown(e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        stop();
        show(index + (e.key === 'ArrowRight' ? 1 : -1), true);
    }
    function onResize() { if (frames.length) layout(); }
    function onReset() { stop(); show(nowIndex(), true); }

    // 降水・雷はこのDOM（タイムラインの操作UI）を共有している。両方が createTimeline を
    // 呼ぶので、リスナーを付けっぱなしにすると片方の再生ボタンでもう片方まで一緒に
    // 動いてしまう（実機で発覚：雷タブで再生→降水タブに切り替えても裏で雷の再生が
    // 残っていて、共有DOM（#nowcast-head 等）を奪い合っていた）。
    // アクティブなタブの間だけリスナーを付ける
    let active = false;

    return {
        stop,
        get frames() { return frames; },
        // このタブが表示されている間だけ呼ぶ
        activate() {
            if (active) return;
            active = true;
            viewport.addEventListener('scroll', onScroll, { passive: true });
            viewport.addEventListener('pointerdown', onPointerDown);
            viewport.addEventListener('pointermove', onPointerMove);
            viewport.addEventListener('pointerup', endDrag);
            viewport.addEventListener('pointercancel', endDrag);
            viewport.addEventListener('keydown', onKeyDown);
            window.addEventListener('resize', onResize);
            playButton.addEventListener('click', play);
            resetButton.addEventListener('click', onReset);
            // 目盛り・見出し・スクロール位置は降水と雷で別物。共有DOMに
            // 前回タブの内容が残っているので、このタブのコマ列で描き直す
            if (frames.length) {
                buildStrip();
                layout();
            }
        },
        // タブを離れるときに呼ぶ。再生中なら止め、リスナーも外す
        deactivate() {
            if (!active) return;
            active = false;
            stop();
            viewport.removeEventListener('scroll', onScroll);
            viewport.removeEventListener('pointerdown', onPointerDown);
            viewport.removeEventListener('pointermove', onPointerMove);
            viewport.removeEventListener('pointerup', endDrag);
            viewport.removeEventListener('pointercancel', endDrag);
            viewport.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', onResize);
            playButton.removeEventListener('click', play);
            resetButton.removeEventListener('click', onReset);
        },
        // タブに切り替わるたびに呼ばれる。取得は最初の1回だけだが、
        // 隠れている間のリサイズでは幅を測れないので、配置は毎回やり直す
        async load() {
            if (!frames.length) {
                frames = await loadFrames();
                buildStrip();
                index = nowIndex();
                render();
                markDataFetched();
            }
            layout();
        }
    };
}

// ピンの地点の値を、時間軸に重ねた帯で示す。降水・雷で共通のロジック
// （1コマぶんの幅をそのまま使うので、続く時間は切れ目のない帯になる。
// 強さは色だけで表し、太さや長さは変えない＝コントロールを小さく保つ）。
// sample(frame, lat, lng) は階級（0は「無し」）を返す非同期関数、color(rank) はその表示色。
// hasData(frame) を渡すと、false のコマは直前の値を引き継いで表示する
// （面レイヤーもデータの無いコマは直前のコマを表示し続けているので、それに揃えるだけ。
// 新しい値を作っているわけではない）。省略時は毎コマの値をそのまま使う（降水はこちら）
function createPinBar(el, sample, color, hasData) {
    let frames = [];
    let pinPoint = null;
    let token = 0;

    async function draw() {
        const my = ++token;
        if (!pinPoint || !frames.length) {
            el.innerHTML = '';
            return;
        }
        const values = await Promise.all(frames.map((frame) => sample(frame, pinPoint.lat, pinPoint.lng)));
        if (my !== token) return; // 読んでいる間にピンが動いた/コマが変わった

        let shown = values;
        if (hasData) {
            let carry = 0;
            shown = values.map((v, i) => {
                if (hasData(frames[i])) carry = v;
                return carry;
            });
        }

        el.innerHTML = frames.map((frame, i) => {
            if (!shown[i]) return '';
            return `<div class="nowcast-pinbar-seg" style="left:${i * STEP_PX - STEP_PX / 2}px;`
                + `width:${STEP_PX}px;background:${color(shown[i])}"></div>`;
        }).join('');
    }

    return {
        setFrames(newFrames) {
            frames = newFrames;
            draw();
        },
        setPin(pin) {
            pinPoint = pin ? { lat: pin.lat, lng: pin.lng } : null;
            draw();
        }
    };
}

// 降水・雷のタブ切替口。タイムラインとピン帯はタブごとに別だが、
// 共有DOMへの接続の仕方は同じなのでここにまとめてある。
//
// load() の途中（フレーム取得中）にタブを離れることがある。その場合、
// 取得が終わった時点でもう自分は表示されていないので activate() してはいけない
// （片方のタブのリスナーがもう片方に残る、という同種の不具合の再発になる）。
// stop() は再生停止に加え、共有DOMのイベントリスナーも外す
// （外さないと非表示のタブ側の再生ボタンなどが一緒に反応してしまう）。
// load() はタブに切り替わるたびに呼ばれる。#nowcast-pinbar は降水・雷で共有しているので、
// フレーム取得が済んでいても帯は毎回描き直す
function bindNowcastControls(timeline, pinBar) {
    let loadToken = 0;
    return {
        stop() {
            loadToken++;
            timeline.deactivate();
        },
        async load() {
            const my = ++loadToken;
            await timeline.load();
            if (my !== loadToken) return; // 待っている間にタブが変わった
            timeline.activate();
            pinBar.setFrames(timeline.frames);
        },
        setPin: pinBar.setPin
    };
}

// 降水ナウキャスト
async function createNowcastRain() {
    const nc = await import('./nowcast.js');
    const layer = nc.createRainLayer().addTo(maps.rain);
    const pinBar = createPinBar(document.getElementById('nowcast-pinbar'), nc.sampleAt, nc.intensityColor);

    const timeline = await createTimeline({
        loadFrames: () => nc.loadFrames(),
        renderFrame: (frame) => layer.setUrl(nc.tileUrl(frame))
    });

    return bindNowcastControls(timeline, pinBar);
}

// 雷ナウキャスト。面（thns）と落雷地点（liden）を重ねる。
// 偶数ズームへの丸めは降水と共通だが、上限ズームは違う（nowcast.js 参照）
async function createNowcastThunder() {
    const nc = await import('./nowcast.js');
    const areaLayer = nc.createThunderAreaLayer().addTo(maps.thunder);
    const markers = L.layerGroup().addTo(maps.thunder);
    // #nowcast-pinbar は降水タブと共有しているDOM。役割は同じ（ピン地点の帯）なので
    // そのまま流用する。色は気象庁の活動度1〜4の定義色（nc.thunderActivityColor）。
    // thns が無いコマ（liden だけの5分刻み）は直前の値を引き継ぐ
    const pinBar = createPinBar(
        document.getElementById('nowcast-pinbar'), nc.sampleThunderAt, nc.thunderActivityColor,
        (frame) => frame.hasArea
    );
    let strikeToken = 0;

    // 落雷地点のマーカー。ピン（pin.js の PIN_ICON）と同じ作法で、白フチ付きの自前SVGにする。
    // 円だと目立たなかったので、意味も伝わる稲妻の形にした
    const STRIKE_ICON = L.divIcon({
        className: 'strike-marker',
        html: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="22" viewBox="0 0 24 24">'
            + '<path d="M7 2v11h3v9l7-12h-4l4-8z" fill="#ffe066" stroke="#241b00" stroke-width="1.4" stroke-linejoin="round"/></svg>',
        iconSize: [16, 22],
        iconAnchor: [8, 11]
    });

    async function renderFrame(frame) {
        // frame.areaFrame は「このコマの時点で分かる一番新しい面」を指す
        // （nowcast.js の loadThunderFrames で事前に解決済み）。逐次再生だけでなく、
        // リセットやドラッグでいきなり位置が飛んでも正しい面にたどり着ける
        if (frame.areaFrame) areaLayer.setUrl(nc.thunderTileUrl(frame.areaFrame));

        const token = ++strikeToken;
        const features = await nc.loadStrikes(frame);
        if (token !== strikeToken) return; // 読んでいる間にコマが進んだ
        markers.clearLayers();
        for (const feature of features) {
            const [lng, lat] = feature.geometry.coordinates;
            L.marker([lat, lng], { icon: STRIKE_ICON })
                .bindTooltip(feature.properties.obstimeJST || '').addTo(markers);
        }
    }

    const timeline = await createTimeline({ loadFrames: () => nc.loadThunderFrames(), renderFrame });

    return bindNowcastControls(timeline, pinBar);
}

// 雲量地図で選んでいる時刻の列を赤線で囲み、その列まで横スクロールする。
// 同じMSMの同じ時刻である1時間予測だけが対象（2週間予測は別のモデル）
function highlightForecastTime(utcTime) {
    // プルダウンがまだ「データ取得中...」のときは時刻として解釈できない
    const date = utcTime ? new Date(utcTime) : null;
    const key = date && !Number.isNaN(date.getTime()) ? jstKey(date) : null;
    const container = document.querySelector('#forecast-msm .table-container');
    if (!container) return;

    container.querySelectorAll('td').forEach((td) => {
        td.classList.toggle('pin-time', !!key && td.dataset.time === key);
    });

    // 赤線の列が画面の外にあるときだけ、その列が見えるところまで横に動かす
    const cell = container.querySelector('td.pin-time');
    if (!cell) return;
    const labelWidth = container.querySelector('th')?.offsetWidth || 0;
    const left = cell.offsetLeft - labelWidth;
    const right = left + cell.offsetWidth;
    const visibleWidth = container.clientWidth - labelWidth;
    if (left < container.scrollLeft || right > container.scrollLeft + visibleWidth) {
        container.scrollLeft = Math.max(0, cell.offsetLeft - labelWidth - 40);
    }
}

// 1時間予測の「時刻」を押したら、その時刻の雲量地図に切り替える。
// 地図のコマは表より短いことがある（MSMの計算が39時間先までか78時間先までかで変わる）ので、
// 対応するコマがある列にだけ下線とクリックを付ける
function markSelectableTimes() {
    const row = document.querySelector('#forecast-msm tr[data-key="時刻"]');
    if (!row) return;

    const keys = new Set();
    for (const option of document.getElementById('time-select').options) {
        const date = new Date(option.value);
        if (!Number.isNaN(date.getTime())) keys.add(jstKey(date));
    }

    for (const td of row.querySelectorAll('td')) {
        const selectable = keys.has(td.dataset.time);
        td.classList.toggle('time-link', selectable);
        if (selectable) {
            td.tabIndex = 0;
        } else {
            td.removeAttribute('tabindex');
        }
    }
}

function showTimeOfCell(td) {
    if (!td.classList.contains('time-link')) return;
    const select = document.getElementById('time-select');
    const index = [...select.options].findIndex((option) => {
        const date = new Date(option.value);
        return !Number.isNaN(date.getTime()) && jstKey(date) === td.dataset.time;
    });
    if (index < 0) return;
    select.selectedIndex = index;
    // プルダウンを操作したときと同じ経路を通す（地図の切り替えと赤枠の移動はそちらが行う）
    select.dispatchEvent(new Event('change'));
}

// 表は作り直されるので、節に委譲して一度だけ登録する
function initTimeCellLinks() {
    const section = document.getElementById('forecast-msm');
    const cellOf = (target) => target.closest && target.closest('tr[data-key="時刻"] td');

    section.addEventListener('click', (event) => {
        const td = cellOf(event.target);
        if (td) showTimeOfCell(td);
    });

    section.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const td = cellOf(event.target);
        if (!td || !td.classList.contains('time-link')) return;
        event.preventDefault();
        showTimeOfCell(td);
    });
}

// 現在の列の1つ前が左端に来るところまで横スクロールする（表を作り直したときだけ）
function scrollToCurrentColumn(container) {
    const cells = [...container.querySelectorAll('tr[data-key="時刻"] td[data-time]')];
    if (cells.length === 0) return;
    const liveIndex = cells.findIndex(td => !td.classList.contains('past'));
    const target = cells[liveIndex < 0 ? cells.length - 1 : Math.max(0, liveIndex - 1)];
    const labelWidth = container.querySelector('th')?.offsetWidth || 0;
    container.scrollLeft = Math.max(0, target.offsetLeft - labelWidth);
}

// 過ぎた時刻のセルに .past を付ける。
// セルは「その時刻から次の列の時刻まで」を表すので、9:55 なら 9時のセルはまだ過ぎていない
function markPastCells() {
    const now = Date.now();
    document.querySelectorAll('.table-container table[data-step-minutes]').forEach((table) => {
        const stepMs = Number(table.dataset.stepMinutes) * 60000;
        table.querySelectorAll('td[data-time]').forEach((td) => {
            const end = new Date(`${td.dataset.time}:00+09:00`).getTime() + stepMs;
            td.classList.toggle('past', end <= now);
        });
    });
}

// 「i」の説明を、押したボタンの真下に吹き出しとして出す
function initInfoPopovers() {
    const supported = 'popover' in HTMLElement.prototype;
    document.querySelectorAll('[popovertarget]').forEach((button) => {
        const popover = document.getElementById(button.getAttribute('popovertarget'));
        if (!supported) {
            // 対応していないブラウザでは見出しの下に開く
            button.addEventListener('click', () => popover.classList.toggle('open'));
            return;
        }

        const place = () => {
            const rect = button.getBoundingClientRect();
            const width = popover.offsetWidth;
            const left = Math.min(Math.max(10, rect.left - 20), window.innerWidth - width - 10);
            popover.style.left = `${left}px`;
            popover.style.top = `${rect.bottom + 8}px`;
            popover.style.setProperty('--arrow-x', `${rect.left + rect.width / 2 - left - 7}px`);
        };
        popover.addEventListener('toggle', (e) => {
            if (e.newState === 'open') place();
        });
        const reposition = () => {
            if (popover.matches(':popover-open')) place();
        };
        window.addEventListener('scroll', reposition, { passive: true });
        window.addEventListener('resize', reposition);
    });
}

// 検索欄の開閉（畳むと虫眼鏡ボタンだけになる）
function setSearchCollapsed(collapsed) {
    const panel = document.querySelector('.point-panel');
    panel.classList.toggle('search-collapsed', collapsed);
    document.getElementById('search-toggle-btn').setAttribute('aria-expanded', String(!collapsed));
}

// 風向の表示に使う16方位（風が吹いてくる向き）
const COMPASS_16 = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
                    '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];

// 操作パネルの「📍地点名 上12 / 中40 / 下80%」
function updatePinInfo() {
    const info = document.getElementById('pin-info');
    const pin = pinController && pinController.pin;
    info.hidden = !pin;
    if (!pin) return;

    const nameEl = document.getElementById('pin-name');
    nameEl.textContent = `📍${pin.name}`;
    nameEl.title = pin.name;
    if (placesController) {
        placesController.updatePinActionButton(document.getElementById('pin-place-btn'));
    }
    const values = cloudSource ? cloudSource.valueAt(pin.lat, pin.lng) : undefined;
    let html = '';
    if (values === null) {
        html = '<span class="layer">範囲外</span>';
    } else if (values) {
        const fmt = (v) => v === null ? '−' : String(v);
        const cell = (label, v) => `<span class="layer">${label}</span><b>${fmt(v)}</b>`;
        if (mapView === 'rain' || mapView === 'thunder') {
            // 降水はタイムラインの棒グラフで時間ごとに見せている。雷は時刻ごとの値を持たない
            html = '';
        } else if (mapView === 'wind') {
            html = values.windSpeed === null
                ? '<span class="layer">−</span>'
                : `<span class="layer">${COMPASS_16[Math.round(values.windFrom / 22.5) % 16]}の風</span>`
                  + `<b>${values.windSpeed.toFixed(1)}</b><span class="unit">m/s</span>`;
        } else {
            html = mapView === 'total'
                ? cell('全雲量', values.total)
                : [cell('上', values.upper), cell('中', values.middle), cell('下', values.lower)].join(' ');
            html += '<span class="unit">%</span>';
        }
    }
    document.getElementById('pin-values').innerHTML = html;
}

// 隠れていた地図は大きさを持っていないので測り直す（タブ切替・全画面の出入りで共有）
function invalidateMapsSize() {
    Object.values(maps).forEach((map) => {
        if (map) map.invalidateSize();
    });
}

function updateFullscreenButtons() {
    for (const btn of fullscreenButtons) {
        const exiting = isFullscreen;
        btn.innerHTML = exiting ? FS_EXIT_SVG : FS_ENTER_SVG;
        btn.setAttribute('aria-label', exiting ? '全画面を閉じる' : '地図を全画面表示');
        btn.title = exiting ? '全画面を閉じる' : '全画面';
        btn.classList.toggle('is-exit', exiting);
    }
}

// 全画面スマホの上中下層フロート。PCと通常表示では出さない
function updateCloudLayerFloat() {
    const el = document.getElementById('cloud-layer-float');
    if (!el) return;
    const show = isFullscreen && mapView === 'layers' && !window.matchMedia(PC_MEDIA).matches;
    el.hidden = !show;
    el.querySelectorAll('.cloud-layer-tab').forEach((tab) => {
        tab.setAttribute('aria-selected', String(tab.dataset.layer === cloudLayer));
    });
}

function setCloudLayer(layer) {
    cloudLayer = layer;
    document.getElementById('maps-container').dataset.layer = layer;
    updateCloudLayerFloat();
    invalidateMapsSize();
}

function setFullscreen(on) {
    isFullscreen = !!on;
    const panel = document.getElementById('maps-panel');
    const pointPanel = document.querySelector('.point-panel');
    panel.classList.toggle('is-fullscreen', isFullscreen);
    document.body.classList.toggle('is-map-fullscreen', isFullscreen);
    updateFullscreenButtons();
    // 通常時は予測表の上（幅いっぱい）。全画面ではパネル内の最下段に移す
    if (isFullscreen) {
        panel.appendChild(pointPanel);
    } else {
        document.getElementById('forecast-msm').before(pointPanel);
    }
    updateCloudLayerFloat();
    requestAnimationFrame(() => {
        invalidateMapsSize();
        if (mapView === 'rain' && nowcastRain) nowcastRain.load().catch(() => {});
        if (mapView === 'thunder' && nowcastThunder) nowcastThunder.load().catch(() => {});
    });
}

function initFullscreen() {
    // 各地図の右下（Leaflet コントロール）に YouTube 風の全画面ボタンを置く
    const FullscreenControl = L.Control.extend({
        options: { position: 'bottomright' },
        onAdd() {
            const btn = L.DomUtil.create('button', 'leaflet-control leaflet-control-fullscreen');
            btn.type = 'button';
            btn.innerHTML = FS_ENTER_SVG;
            btn.setAttribute('aria-label', '地図を全画面表示');
            btn.title = '全画面';
            L.DomEvent.disableClickPropagation(btn);
            L.DomEvent.disableScrollPropagation(btn);
            L.DomEvent.on(btn, 'click', (e) => {
                L.DomEvent.stop(e);
                setFullscreen(!isFullscreen);
            });
            fullscreenButtons.push(btn);
            return btn;
        }
    });
    for (const map of Object.values(maps)) {
        new FullscreenControl().addTo(map);
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isFullscreen) setFullscreen(false);
    });
    document.querySelectorAll('.cloud-layer-tab').forEach((tab) => {
        tab.addEventListener('click', () => setCloudLayer(tab.dataset.layer));
    });
    window.matchMedia(PC_MEDIA).addEventListener('change', () => {
        updateCloudLayerFloat();
        if (isFullscreen) invalidateMapsSize();
    });
}

// 雲量の地図の表示を切り替える（total: 総雲量1枚 / layers: 上中下層の3枚）
function setMapView(view) {
    mapView = view;
    document.getElementById('maps-container').dataset.view = view;
    document.querySelectorAll('.layer-tab').forEach((tab) => {
        tab.setAttribute('aria-selected', String(tab.dataset.view === view));
    });

    // 時間軸が違うので、コントロールごと入れ替える。
    // 同時に2つ見えると、どちらが効いているのか分からなくなる
    const isNowcast = view === 'rain' || view === 'thunder';
    document.querySelector('.time-select-container').hidden = isNowcast;
    document.getElementById('nowcast-timeline').hidden = !isNowcast;
    // 降水・雷は同時に1つだけ動かす（共有DOMを奪い合わないように）
    const nowcasts = { rain: nowcastRain, thunder: nowcastThunder };
    const nowcastLabels = { rain: '降水', thunder: '雷' };
    for (const key of Object.keys(nowcasts)) {
        const ctrl = nowcasts[key];
        if (!ctrl) continue;
        if (view === key) {
            ctrl.load().catch((e) => console.error(`${nowcastLabels[key]}ナウキャストを取得できませんでした`, e));
        } else {
            ctrl.stop();
        }
    }
    updateCloudLayerFloat();
    invalidateMapsSize();
    updatePinInfo();
}

function initMapViewTabs() {
    const pcMedia = window.matchMedia(PC_MEDIA);
    let chosenByUser = false;

    // 既定はPCが上中下層、スマホが全体。ユーザーが選ぶまでは画面幅に追従する
    setMapView(pcMedia.matches ? 'layers' : 'total');
    pcMedia.addEventListener('change', (e) => {
        if (!chosenByUser) setMapView(e.matches ? 'layers' : 'total');
    });

    document.querySelectorAll('.layer-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            chosenByUser = true;
            setMapView(tab.dataset.view);
        });
    });
}

// 現在地の取得に失敗したときの文言
const GEOLOCATION_ERRORS = {
    1: '位置情報の利用が許可されていません。ブラウザの設定から許可してください。',
    2: '現在地を取得できませんでした。',
    3: '現在地の取得に時間がかかっています。もう一度お試しください。'
};

// GPS で現在地を取り、そこにピンを立てる。
// auto = ページを開いたときの自動取得。断られても黙って何もしない（ボタン操作のときだけ理由を出す）
function locateAndSetPin({ auto = false } = {}) {
    const button = document.getElementById('gps-btn');
    const status = document.getElementById('search-status');
    const showStatus = (text) => {
        status.textContent = text;
        status.hidden = !text;
    };

    button.disabled = true;
    showStatus('現在地を取得しています…');

    navigator.geolocation.getCurrentPosition(
        (position) => {
            button.disabled = false;
            showStatus('');
            const { latitude, longitude } = position.coords;
            // まず座標のまま置き、住所が分かったら表示名だけ差し替える
            pinController.set(latitude, longitude, `現在地（${formatLatLng(latitude, longitude)}）`);
            maps.lower.setView([latitude, longitude], maps.lower.getZoom());
            nameCurrentLocation(latitude, longitude);
        },
        (error) => {
            button.disabled = false;
            showStatus(auto ? '' : (GEOLOCATION_ERRORS[error.code] || '現在地を取得できませんでした。'));
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60 * 1000 }
    );
}

// 現在地のピンの表示名を「現在地（都道府県市区町村）」にする。
// 逆ジオコーディングの待ち時間ぶん遅れて届くので、その間にピンが動いていたら何もしない
async function nameCurrentLocation(lat, lng) {
    let address = null;
    try {
        address = await reverseGeocodeAddress(lat, lng);
    } catch (error) {
        console.warn('逆ジオコーディングに失敗しました', error);
    }

    const pin = pinController && pinController.pin;
    if (!address || !pin || pin.lat !== lat || pin.lng !== lng) return;

    pinController.rename(`現在地（${address}）`);
    updatePinInfo();
    updateUrl(maps.lower.getCenter(), maps.lower.getZoom());
}

// データを最後に取得できた時刻。オフラインになったときに「いつの値か」を出すために持つ。
// 予測データはキャッシュしていないので、これはこのセッションで読み込んだ分を指す
let lastDataFetchedAt = null;

function markDataFetched() {
    lastDataFetchedAt = new Date();
    updateOfflineBanner();
}

function updateOfflineBanner() {
    const banner = document.getElementById('offline-banner');
    if (navigator.onLine) {
        banner.hidden = true;
        return;
    }
    const d = lastDataFetchedAt;
    banner.textContent = d
        ? `オフラインです。表示中のデータは ${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')} に取得したものです。`
        : 'オフラインです。データを取得できません。';
    banner.hidden = false;
}

// ピン（クリック/長押しで置く・ドラッグで動かす・検索で置く・現在地で置く）
function initPin() {
    pinController = new PinController(maps, (pin) => {
        setSearchCollapsed(!!pin);
        if (nowcastRain) nowcastRain.setPin(pin);
        if (nowcastThunder) nowcastThunder.setPin(pin);
        updatePinInfo();
        refreshTimeLabels();
        updateForecast(pin);
        updateUrl(maps.lower.getCenter(), maps.lower.getZoom());
        if (placesController) placesController.onPinChange();
    }, {
        onMarkerClick: (pin, map) => {
            if (placesController) placesController.onPinMarkerClick(pin, map);
        }
    });

    placesController = new PlacesController({
        maps,
        pinController,
        reverseGeocode: reverseGeocodeAddress
    });

    const urlPin = getUrlParams().pin;
    if (urlPin) {
        pinController.set(urlPin.lat, urlPin.lng, urlPin.name);
    }

    document.getElementById('pin-clear-btn').addEventListener('click', () => pinController.clear());
    document.getElementById('pin-place-btn').addEventListener('click', () => {
        if (placesController) placesController.openPinAction();
    });

    // 現在地ボタン。geolocation は https か localhost でしか使えないので、無ければボタンごと隠す
    const gpsButton = document.getElementById('gps-btn');
    if (navigator.geolocation) {
        gpsButton.addEventListener('click', () => locateAndSetPin());
    } else {
        gpsButton.hidden = true;
    }

    // ピンが決まっている間、検索欄は虫眼鏡ボタンに畳んでおく
    const searchInput = document.getElementById('search-input');
    document.getElementById('search-toggle-btn').addEventListener('click', () => {
        setSearchCollapsed(false);
        searchInput.focus();
    });

    // 場所検索（地図の下。雲量地図の表示には要らないので上部には置かない）
    setupSearch(
        {
            form: document.getElementById('search-form'),
            input: document.getElementById('search-input'),
            list: document.getElementById('search-results'),
            status: document.getElementById('search-status')
        },
        () => maps.lower.getCenter(),
        (lat, lng, name) => {
            pinController.set(lat, lng, name);
            maps.lower.setView([lat, lng], maps.lower.getZoom());
        }
    );
}

// 初期化
async function init() {
    // title-linkのURLをクエリストリングなしのURLに設定
    const baseUrl = window.location.origin + window.location.pathname;
    const titleLink = document.getElementById('title-link');
    if (titleLink) {
        titleLink.href = baseUrl;
    }

    // まずマップを初期化。
    // タブの初期化は地図の大きさを測り直して moveend を起こすので、
    // URL のピンを読み終えてから行う（先にやると URL が書き換わって pin が消える）
    initMaps();
    initPin();
    initMapViewTabs();
    initFullscreen();

    // パラメータなしで開いたときは、現在地を自動で取ってピンを立てる。
    // 共有された URL（ピンや地図の位置つき）で開いた場合は、その指定を優先して何もしない
    if (OPENED_WITHOUT_PARAMS && navigator.geolocation) {
        locateAndSetPin({ auto: true });
    }

    initInfoPopovers();
    initTimeCellLinks();

    window.addEventListener('online', updateOfflineBanner);
    window.addEventListener('offline', updateOfflineBanner);
    updateOfflineBanner();

    // PWA としてインストールできるようにする。失敗してもページの動作には影響しない
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch((error) => {
            console.warn('Service Worker の登録に失敗しました', error);
        });
    }

    // 時間の経過で「過ぎた時刻」が増えるので、定期的に付け直す
    setInterval(markPastCells, 60 * 1000);

    // URL で指定されたピンは、ここに来る前に置かれていることがある
    const pin = pinController && pinController.pin;
    for (const [key, factory] of [['rain', createNowcastRain], ['thunder', createNowcastThunder]]) {
        const ctrl = await factory();
        if (key === 'rain') nowcastRain = ctrl;
        else nowcastThunder = ctrl;
        ctrl.setPin(pin);
        if (mapView === key) ctrl.load().catch(() => {});
    }

    cloudSource = await createMsmSource(updatePinInfo);

    let index = null;
    try {
        index = await cloudSource.loadIndex();
    } catch (error) {
        console.error('Failed to load cloud data index:', error);
    }

    resolveCloudBaseTime(index ? index.baseTime : null);

    if (index) {
        setupTimeSelect(index);

        // 日時プルダウンの変更イベント
        const timeSelect = document.getElementById('time-select');
        const prevBtn = document.getElementById('time-prev-btn');
        const nextBtn = document.getElementById('time-next-btn');

        timeSelect.addEventListener('change', function() {
            cloudSource.show(this.value);
            highlightForecastTime(this.value);
        });

        // 前の時刻に移動
        prevBtn.addEventListener('click', function() {
            const currentIndex = timeSelect.selectedIndex;
            if (currentIndex > 0) {
                timeSelect.selectedIndex = currentIndex - 1;
                timeSelect.dispatchEvent(new Event('change'));
            }
        });

        // 次の時刻に移動
        nextBtn.addEventListener('click', function() {
            const currentIndex = timeSelect.selectedIndex;
            if (currentIndex < timeSelect.options.length - 1) {
                timeSelect.selectedIndex = currentIndex + 1;
                timeSelect.dispatchEvent(new Event('change'));
            }
        });

        // 初期表示（少し遅延させてマップが完全に初期化されるのを待つ）
        setTimeout(() => {
            if (timeSelect.value) {
                cloudSource.show(timeSelect.value);
                highlightForecastTime(timeSelect.value);
            }
        }, 200);
    }
}

// ページ読み込み時に初期化
window.addEventListener('DOMContentLoaded', init);
