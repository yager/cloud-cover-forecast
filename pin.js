// 行きたい地点を示す赤いピン（1点のみ）と、場所検索（地名・住所・緯度経度）。
// ピンは3つの地図すべてに同じ位置で立て、どれかで動かすと他も追従する。

// 国土地理院の住所検索 API（CORS 許可あり。ブラウザから直接呼ぶ）
const GSI_SEARCH_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch';

const MAX_RESULTS = 30;

// 緯度経度の小数桁数（第5位 ≒ 約1m）
const DECIMAL_PLACES = 5;

// スマホの長押し判定
const LONG_PRESS_MS = 500;
const LONG_PRESS_TOLERANCE_PX = 10;

// 住所検索の addressCode 先頭2桁 → 都道府県
const PREFECTURES = [
    '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
    '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
    '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
    '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
    '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
    '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
    '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'
];

// 緯度と経度の順序を推定するときの日本付近の範囲
const JAPAN_BOUNDS = { latMin: 24, latMax: 46, lngMin: 122, lngMax: 154 };

export function formatLatLng(lat, lng) {
    return `${lat.toFixed(DECIMAL_PLACES)}, ${lng.toFixed(DECIMAL_PLACES)}`;
}

// --- 緯度経度の読み取り（xLineMap の実装を移植） ---

function normalizeQuery(raw) {
    return String(raw || '')
        .trim()
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/　/g, ' ')
        .replace(/[−－]/g, '-')
        .replace(/[，、]/g, ',')
        .replace(/[．]/g, '.')
        .replace(/′/g, "'")
        .replace(/″/g, '"');
}

// 「カンマ区切りで2つ」または「空白区切りでちょうど2つ」
function splitPair(normalized) {
    const commaParts = normalized.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
    if (commaParts.length === 2) return commaParts;
    const spaceParts = normalized.split(/\s+/).filter((p) => p.length > 0);
    if (spaceParts.length === 2) return spaceParts;
    return null;
}

// 度分秒（36°04'52.0"N など）→ 十進度。° が無ければ NaN
function parseDms(token) {
    let t = token.trim();
    if (!t.includes('°')) return NaN;

    let hemi = '';
    const hm = t.match(/([NnSsEeWw])\s*$/);
    if (hm) {
        hemi = hm[1].toUpperCase();
        t = t.slice(0, hm.index).trim();
    }

    const [degPart, rest = ''] = t.split('°');
    const deg = parseFloat(degPart);
    if (!Number.isFinite(deg)) return NaN;

    let min = 0;
    let sec = 0;
    if (rest.trim() !== '') {
        const [minPart, ...secParts] = rest.split("'");
        min = parseFloat(minPart);
        if (!Number.isFinite(min)) return NaN;
        const secText = secParts.join("'").replace(/["“”]/g, '').trim();
        if (secText !== '') {
            sec = parseFloat(secText);
            if (!Number.isFinite(sec)) return NaN;
        }
    }

    const value = Math.abs(deg) + min / 60 + sec / 3600;
    if (hemi === 'S' || hemi === 'W') return -value;
    if (hemi === 'N' || hemi === 'E') return value;
    return deg < 0 ? -value : value;
}

// 十進度・度分秒・末尾に N/S/E/W の付いた十進度
function parseCoordinate(token) {
    const dms = parseDms(token);
    if (Number.isFinite(dms)) return dms;

    // 「3丁目」のような数字始まりの地名を座標と誤認しないよう、数値だけの形に限る
    const m = token.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+))\s*([NnSsEeWw])?$/);
    if (!m) return NaN;
    const v = parseFloat(m[1]);
    const hemi = m[2] ? m[2].toUpperCase() : '';
    if (hemi === 'S' || hemi === 'W') return -Math.abs(v);
    if (hemi === 'N' || hemi === 'E') return Math.abs(v);
    return v;
}

function isValidLatLng(p) {
    return Number.isFinite(p.lat) && Number.isFinite(p.lng)
        && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
}

function isInJapan(p) {
    return p.lat >= JAPAN_BOUNDS.latMin && p.lat <= JAPAN_BOUNDS.latMax
        && p.lng >= JAPAN_BOUNDS.lngMin && p.lng <= JAPAN_BOUNDS.lngMax;
}

// 検索語が緯度経度2つなら { lat, lng }、そうでなければ null。
// 順序は「緯度, 経度」を基本とし、逆順でしか日本付近にならない場合は入れ替える
export function parseLatLngQuery(raw) {
    const tokens = splitPair(normalizeQuery(raw));
    if (!tokens) return null;
    const a = parseCoordinate(tokens[0]);
    const b = parseCoordinate(tokens[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

    const asIs = { lat: a, lng: b };
    const swapped = { lat: b, lng: a };
    const okAsIs = isValidLatLng(asIs);
    const okSwapped = isValidLatLng(swapped);
    if (okAsIs && okSwapped) {
        return !isInJapan(asIs) && isInJapan(swapped) ? swapped : asIs;
    }
    if (okAsIs) return asIs;
    if (okSwapped) return swapped;
    return null;
}

// --- 地名・住所の検索 ---

function distanceKm(a, b) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function prefectureOf(addressCode) {
    const code = parseInt(String(addressCode || '').padStart(5, '0').slice(0, 2), 10);
    return PREFECTURES[code - 1] || '';
}

// 「雲取山（東京都）」。住所のように都道府県名から始まる場合は付けない
function placeName(title, pref) {
    if (!pref || title.startsWith(pref)) return title;
    return `${title}（${pref}）`;
}

// 地名・住所で検索し、center から近い順に返す
export async function searchPlaces(query, center, signal) {
    const res = await fetch(`${GSI_SEARCH_URL}?q=${encodeURIComponent(query)}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const features = await res.json();
    const results = [];
    for (const f of Array.isArray(features) ? features : []) {
        const coords = f?.geometry?.coordinates;
        const title = String(f?.properties?.title || '').trim();
        if (!Array.isArray(coords) || coords.length < 2 || title === '') continue;
        const p = { lat: Number(coords[1]), lng: Number(coords[0]) };
        if (!isValidLatLng(p)) continue;
        results.push({
            name: placeName(title, prefectureOf(f.properties.addressCode)),
            lat: p.lat,
            lng: p.lng,
            distanceKm: distanceKm(center, p)
        });
    }
    results.sort((a, b) => a.distanceKm - b.distanceKm);
    return results.slice(0, MAX_RESULTS);
}

// --- ピン ---

const PIN_ICON = L.divIcon({
    className: 'pin-marker',
    html: '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="38" viewBox="0 0 26 38">'
        + '<path d="M13 1C6.4 1 1 6.3 1 12.9 1 21.8 13 37 13 37s12-15.2 12-24.1C25 6.3 19.6 1 13 1z" '
        + 'fill="#e53935" stroke="#fff" stroke-width="2"/>'
        + '<circle cx="13" cy="13" r="4.5" fill="#fff"/></svg>',
    iconSize: [26, 38],
    iconAnchor: [13, 37]
});

// スマホ（タッチ）の長押しを検出する。指が動いたり2本指になったら取り消す
function onLongPress(map, handler) {
    const el = map.getContainer();
    let timer = null;
    let start = null;
    let lastPointerType = 'mouse';

    const cancel = () => {
        clearTimeout(timer);
        timer = null;
    };

    el.addEventListener('pointerdown', (e) => {
        lastPointerType = e.pointerType;
        if (e.pointerType !== 'touch') return;
        if (!e.isPrimary) {
            cancel();
            return;
        }
        start = { x: e.clientX, y: e.clientY };
        cancel();
        timer = setTimeout(() => {
            timer = null;
            handler(map.mouseEventToLatLng(e));
        }, LONG_PRESS_MS);
    });
    el.addEventListener('pointermove', (e) => {
        if (!timer || !e.isPrimary) return;
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_TOLERANCE_PX) cancel();
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    // Android の長押しメニューを出さない
    el.addEventListener('contextmenu', (e) => {
        if (lastPointerType === 'touch') e.preventDefault();
    });
}

export class PinController {
    // maps: { key: L.Map }、onChange(pin | null): ピンが置かれた・動いた・消えたとき
    constructor(maps, onChange) {
        this.maps = Object.values(maps);
        this.onChange = onChange;
        this.pin = null; // { lat, lng, name }
        this.markers = [];

        for (const map of this.maps) {
            let lastPointerType = 'mouse';
            map.getContainer().addEventListener('pointerdown', (e) => {
                lastPointerType = e.pointerType;
            }, true);

            // PC はクリック、スマホは長押しで置く
            map.on('click', (e) => {
                if (lastPointerType === 'touch') return;
                this.set(e.latlng.lat, e.latlng.lng);
            });
            onLongPress(map, (latlng) => this.set(latlng.lat, latlng.lng));
        }
    }

    // name が無いとき（クリック・ドラッグ・緯度経度入力）は座標を表示名にする
    set(lat, lng, name = null) {
        this.pin = { lat, lng, name: name || formatLatLng(lat, lng) };
        this._render();
        this.onChange(this.pin);
    }

    clear() {
        this.pin = null;
        this._render();
        this.onChange(null);
    }

    _render() {
        if (!this.pin) {
            this.markers.forEach((m) => m.remove());
            this.markers = [];
            return;
        }
        if (this.markers.length === 0) {
            this.markers = this.maps.map((map) => {
                const marker = L.marker([this.pin.lat, this.pin.lng], {
                    icon: PIN_ICON,
                    draggable: true,
                    autoPan: true,
                    keyboard: false
                }).addTo(map);
                // ドラッグ中は他の地図のピンも追従させる
                marker.on('drag', (e) => {
                    const latlng = e.target.getLatLng();
                    this.markers.forEach((m) => {
                        if (m !== marker) m.setLatLng(latlng);
                    });
                });
                marker.on('dragend', (e) => {
                    const latlng = e.target.getLatLng();
                    this.set(latlng.lat, latlng.lng);
                });
                return marker;
            });
        } else {
            this.markers.forEach((m) => m.setLatLng([this.pin.lat, this.pin.lng]));
        }
    }
}

// --- 検索欄 ---

// elements: { form, input, list, status }
// getCenter(): 並べ替えの基準（地図の中心）、onPick(lat, lng, name | null): 場所が決まったとき
export function setupSearch(elements, getCenter, onPick) {
    const { form, input, list, status } = elements;
    let abort = null;

    const setStatus = (text) => {
        status.textContent = text;
        status.hidden = text === '';
    };
    const close = () => {
        list.innerHTML = '';
        list.hidden = true;
        setStatus('');
    };

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const q = input.value.trim();
        if (abort) abort.abort();
        close();
        if (q === '') return;

        const ll = parseLatLngQuery(q);
        if (ll) {
            input.blur();
            onPick(ll.lat, ll.lng, null);
            return;
        }

        abort = new AbortController();
        const signal = abort.signal;
        setStatus('検索中…');
        let results;
        try {
            results = await searchPlaces(q, getCenter(), signal);
        } catch (error) {
            if (signal.aborted) return;
            console.error('Place search failed:', error);
            setStatus('検索できませんでした。時間をおいて試してください。');
            return;
        }
        if (signal.aborted) return;
        if (results.length === 0) {
            setStatus('見つかりませんでした。');
            return;
        }

        setStatus('');
        list.hidden = false;
        for (const r of results) {
            const li = document.createElement('li');
            const button = document.createElement('button');
            button.type = 'button';
            const name = document.createElement('span');
            name.textContent = r.name;
            const dist = document.createElement('small');
            dist.textContent = r.distanceKm < 10 ? `${r.distanceKm.toFixed(1)}km` : `${Math.round(r.distanceKm)}km`;
            button.append(name, dist);
            button.addEventListener('click', () => {
                close();
                input.blur();
                onPick(r.lat, r.lng, r.name);
            });
            li.appendChild(button);
            list.appendChild(li);
        }
    });

    // 検索欄の外を触ったら候補を閉じる
    document.addEventListener('pointerdown', (e) => {
        if (!form.contains(e.target)) close();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
        // Enter で検索。日本語入力の変換確定の Enter（Safari は keyCode 229）では検索しない
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            form.requestSubmit();
        }
    });
}
