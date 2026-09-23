// ピンの地点の天気データを取得する。
//
// - 1時間予報・2週間予報: Open-Meteo の API（気象庁MSM / ECMWF AIFS の数値計算結果）
// - 週間予報: 気象庁の予報（公式の予報なので、そのまま表示する）
//
// 数値計算の結果と気象庁の予報は性質が違うので、表示側でも別の節に分けている。

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

// 国土地理院の逆ジオコーダ（緯度経度 → 市区町村コード）
const GSI_REVERSE_URL = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';

// 気象庁の地域一覧と府県天気予報
const JMA_AREA_URL = 'https://www.jma.go.jp/bosai/common/const/area.json';
const JMA_FORECAST_URL = 'https://www.jma.go.jp/bosai/forecast/data/forecast';
export const JMA_ICON_URL = 'https://www.jma.go.jp/bosai/forecast/img';

const MODELS = { msm: 'jma_msm', aifs: 'ecmwf_aifs025_single' };

const HOURLY_VARIABLES = [
    'temperature_2m',
    'relative_humidity_2m',
    'precipitation',
    'cloud_cover_low',
    'cloud_cover_mid',
    'cloud_cover_high',
    'wind_speed_10m',
    'wind_direction_10m',
    'pressure_msl'
];

// AIFS は6時間ごとの計算結果。API が1時間ごとに補間した値ではなく、
// 元の時刻（世界時の 00/06/12/18＝日本時間の 09/15/21/03）だけを表示する
const AIFS_JST_HOURS = [3, 9, 15, 21];

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// 日本時間の「YYYY-MM-DDTHH:00」。Open-Meteo に timezone=Asia/Tokyo で返させた時刻と同じ形式
export function jstKey(date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour === '24' ? '00' : parts.hour}:00`;
}

// 「9/23」と「(水)」を2段にして、列の幅を狭くする
export function formatDateLabel(isoLocal) {
    const [date] = isoLocal.split('T');
    const [, month, day] = date.split('-');
    const weekday = WEEKDAYS[new Date(`${date}T00:00:00+09:00`).getDay()];
    return `${Number(month)}/${Number(day)}<br>(${weekday})`;
}

export function formatHourLabel(isoLocal) {
    return `${Number(isoLocal.slice(11, 13))}時`;
}

// Open-Meteo から MSM と AIFS の地点予測を取得する。
// 気温は実際の標高に合わせた値（API の既定の扱い）を使う
export async function loadPointForecast(lat, lng) {
    const params = new URLSearchParams({
        latitude: lat.toFixed(5),
        longitude: lng.toFixed(5),
        models: `${MODELS.msm},${MODELS.aifs}`,
        hourly: HOURLY_VARIABLES.join(','),
        timezone: 'Asia/Tokyo',
        wind_speed_unit: 'ms',
        forecast_days: '16'
    });
    const res = await fetch(`${OPEN_METEO_URL}?${params}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.reason || `HTTP ${res.status}`);

    return {
        elevation: data.elevation,
        msm: extractSeries(data.hourly, MODELS.msm, () => true),
        aifs: extractSeries(data.hourly, MODELS.aifs, (t) => AIFS_JST_HOURS.includes(Number(t.slice(11, 13))))
    };
}

// モデルごとの列（変数名_モデル名）を取り出し、値のある時刻だけに絞る
function extractSeries(hourly, model, timeFilter) {
    const times = [];
    const values = Object.fromEntries(HOURLY_VARIABLES.map(v => [v, []]));
    hourly.time.forEach((time, i) => {
        const temperature = hourly[`temperature_2m_${model}`][i];
        if (temperature === null || !timeFilter(time)) return;
        times.push(time);
        for (const v of HOURLY_VARIABLES) values[v].push(hourly[`${v}_${model}`][i]);
    });
    return { times, values };
}

// 指定時刻より前の列を落とす（雲量地図と同じ計算の範囲だけを残すのに使う）
export function trimSeriesBefore(series, isoTime) {
    if (!isoTime) return series;
    const from = new Date(isoTime).getTime();
    const keep = series.times.map(t => new Date(`${t}:00+09:00`).getTime() >= from);
    return {
        times: series.times.filter((t, i) => keep[i]),
        values: Object.fromEntries(
            Object.entries(series.values).map(([k, arr]) => [k, arr.filter((v, i) => keep[i])])
        )
    };
}

// 天気コード → [アイコンのファイル名（昼）, 文言]。
// アイコン名はコード番号と一致しないものが多い（例: 211「曇後晴」は 210.svg）。
// 気象庁の天気予報ページが持つ対応表（TELOPS）から書き起こしたもの。
const WEATHER_TELOPS = {
    100: ["100", "晴"],
    101: ["101", "晴時々曇"],
    102: ["102", "晴一時雨"],
    103: ["102", "晴時々雨"],
    104: ["104", "晴一時雪"],
    105: ["104", "晴時々雪"],
    106: ["102", "晴一時雨か雪"],
    107: ["102", "晴時々雨か雪"],
    108: ["102", "晴一時雨か雷雨"],
    110: ["110", "晴後時々曇"],
    111: ["110", "晴後曇"],
    112: ["112", "晴後一時雨"],
    113: ["112", "晴後時々雨"],
    114: ["112", "晴後雨"],
    115: ["115", "晴後一時雪"],
    116: ["115", "晴後時々雪"],
    117: ["115", "晴後雪"],
    118: ["112", "晴後雨か雪"],
    119: ["112", "晴後雨か雷雨"],
    120: ["102", "晴朝夕一時雨"],
    121: ["102", "晴朝の内一時雨"],
    122: ["112", "晴夕方一時雨"],
    123: ["100", "晴山沿い雷雨"],
    124: ["100", "晴山沿い雪"],
    125: ["112", "晴午後は雷雨"],
    126: ["112", "晴昼頃から雨"],
    127: ["112", "晴夕方から雨"],
    128: ["112", "晴夜は雨"],
    130: ["100", "朝の内霧後晴"],
    131: ["100", "晴明け方霧"],
    132: ["101", "晴朝夕曇"],
    140: ["102", "晴時々雨で雷を伴う"],
    160: ["104", "晴一時雪か雨"],
    170: ["104", "晴時々雪か雨"],
    181: ["115", "晴後雪か雨"],
    200: ["200", "曇"],
    201: ["201", "曇時々晴"],
    202: ["202", "曇一時雨"],
    203: ["202", "曇時々雨"],
    204: ["204", "曇一時雪"],
    205: ["204", "曇時々雪"],
    206: ["202", "曇一時雨か雪"],
    207: ["202", "曇時々雨か雪"],
    208: ["202", "曇一時雨か雷雨"],
    209: ["200", "霧"],
    210: ["210", "曇後時々晴"],
    211: ["210", "曇後晴"],
    212: ["212", "曇後一時雨"],
    213: ["212", "曇後時々雨"],
    214: ["212", "曇後雨"],
    215: ["215", "曇後一時雪"],
    216: ["215", "曇後時々雪"],
    217: ["215", "曇後雪"],
    218: ["212", "曇後雨か雪"],
    219: ["212", "曇後雨か雷雨"],
    220: ["202", "曇朝夕一時雨"],
    221: ["202", "曇朝の内一時雨"],
    222: ["212", "曇夕方一時雨"],
    223: ["201", "曇日中時々晴"],
    224: ["212", "曇昼頃から雨"],
    225: ["212", "曇夕方から雨"],
    226: ["212", "曇夜は雨"],
    228: ["215", "曇昼頃から雪"],
    229: ["215", "曇夕方から雪"],
    230: ["215", "曇夜は雪"],
    231: ["200", "曇海上海岸は霧か霧雨"],
    240: ["202", "曇時々雨で雷を伴う"],
    250: ["204", "曇時々雪で雷を伴う"],
    260: ["204", "曇一時雪か雨"],
    270: ["204", "曇時々雪か雨"],
    281: ["215", "曇後雪か雨"],
    300: ["300", "雨"],
    301: ["301", "雨時々晴"],
    302: ["302", "雨時々止む"],
    303: ["303", "雨時々雪"],
    304: ["300", "雨か雪"],
    306: ["300", "大雨"],
    308: ["308", "雨で暴風を伴う"],
    309: ["303", "雨一時雪"],
    311: ["311", "雨後晴"],
    313: ["313", "雨後曇"],
    314: ["314", "雨後時々雪"],
    315: ["314", "雨後雪"],
    316: ["311", "雨か雪後晴"],
    317: ["313", "雨か雪後曇"],
    320: ["311", "朝の内雨後晴"],
    321: ["313", "朝の内雨後曇"],
    322: ["303", "雨朝晩一時雪"],
    323: ["311", "雨昼頃から晴"],
    324: ["311", "雨夕方から晴"],
    325: ["311", "雨夜は晴"],
    326: ["314", "雨夕方から雪"],
    327: ["314", "雨夜は雪"],
    328: ["300", "雨一時強く降る"],
    329: ["300", "雨一時みぞれ"],
    340: ["400", "雪か雨"],
    350: ["300", "雨で雷を伴う"],
    361: ["411", "雪か雨後晴"],
    371: ["413", "雪か雨後曇"],
    400: ["400", "雪"],
    401: ["401", "雪時々晴"],
    402: ["402", "雪時々止む"],
    403: ["403", "雪時々雨"],
    405: ["400", "大雪"],
    406: ["406", "風雪強い"],
    407: ["406", "暴風雪"],
    409: ["403", "雪一時雨"],
    411: ["411", "雪後晴"],
    413: ["413", "雪後曇"],
    414: ["414", "雪後雨"],
    420: ["411", "朝の内雪後晴"],
    421: ["413", "朝の内雪後曇"],
    422: ["414", "雪昼頃から雨"],
    423: ["414", "雪夕方から雨"],
    425: ["400", "雪一時強く降る"],
    426: ["400", "雪後みぞれ"],
    427: ["400", "雪一時みぞれ"],
    450: ["400", "雪で雷を伴う"]
};

// 天気コードからアイコンのURLと文言を得る（未知のコードは null）
export function weatherTelop(code) {
    const telop = WEATHER_TELOPS[String(code)];
    if (!telop) return null;
    return { icon: `${JMA_ICON_URL}/${telop[0]}.svg`, text: telop[1] };
}

// 緯度経度 → 気象庁の府県予報区と一次細分区域
async function resolveJmaArea(lat, lng) {
    const revRes = await fetch(`${GSI_REVERSE_URL}?lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`);
    const rev = await revRes.json();
    const muniCode = String(rev?.results?.muniCd || '');
    if (!muniCode) throw new Error('市区町村を特定できませんでした');

    const area = await (await fetch(JMA_AREA_URL)).json();
    const class20 = area.class20s[muniCode.padStart(5, '0') + '00'];
    const class15 = class20 && area.class15s[class20.parent];
    const class10 = class15 && area.class10s[class15.parent];
    const office = class10 && area.offices[class10.parent];
    if (!office) throw new Error('予報区を特定できませんでした');

    return {
        officeCode: class10.parent,
        officeName: office.name,
        class10Code: class15.parent,
        class10Name: class10.name,
        muniName: class20.name
    };
}

// 気象庁の週間予報（7日分）
export async function loadJmaWeekly(lat, lng) {
    const area = await resolveJmaArea(lat, lng);
    const res = await fetch(`${JMA_FORECAST_URL}/${area.officeCode}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const forecast = await res.json();

    const weekly = forecast[1];
    // 天気は一次細分区域、気温は府県内の代表地点。見つからなければ先頭を使う
    const weatherSeries = weekly.timeSeries[0];
    const weatherArea = weatherSeries.areas.find(a => a.area.code === area.class10Code) || weatherSeries.areas[0];
    const tempSeries = weekly.timeSeries[1];
    const tempArea = tempSeries.areas[0];

    const days = weatherSeries.timeDefines.map((time, i) => {
        const t = tempSeries.timeDefines.indexOf(time);
        const pick = (key) => (t >= 0 && tempArea[key] ? tempArea[key][t] : '') || '';
        return {
            time,
            weatherCode: weatherArea.weatherCodes[i] || '',
            pop: weatherArea.pops[i] || '',
            reliability: weatherArea.reliabilities ? (weatherArea.reliabilities[i] || '') : '',
            tempMax: pick('tempsMax'),
            tempMaxUpper: pick('tempsMaxUpper'),
            tempMaxLower: pick('tempsMaxLower'),
            tempMin: pick('tempsMin'),
            tempMinUpper: pick('tempsMinUpper'),
            tempMinLower: pick('tempsMinLower')
        };
    });

    return {
        area,
        areaName: weatherArea.area.name,
        tempAreaName: tempArea.area.name,
        reportDatetime: forecast[0].reportDatetime,
        days
    };
}
