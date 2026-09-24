// 雲量予測の Service Worker。
//
// 目的は2つだけ。
//   1. PWA としてインストールできるようにする（fetch ハンドラがあることが条件）
//   2. 内容が変わらないファイル（外部ライブラリ・地図タイル）の読み込みを速くする
//
// 予測データ（.om / Open-Meteo API / 気象庁 / 国土地理院の API）はキャッシュしない。
// 古い計算結果を新しいものと誤認させないため。オフライン時は画面側が取得時刻を明示する。
//
// アプリ本体は「ネットワーク優先・失敗したらキャッシュ」にしてある。
// キャッシュ優先にすると古い版に固定されて更新が届かなくなるため、速度より確実さを取っている。

const VERSION = 'v1';

const SHELL = `ccf-shell-${VERSION}`; // 同オリジンのアプリ本体。オフライン時の控え
const LIB = 'ccf-lib-v1';             // 版を固定してある外部ライブラリ
const TILES = 'ccf-tiles-v1';         // 地理院タイル（内容が変わらない）

// タイルの保持枚数。陰影起伏図が平均30KB、白地図が平均2KBなので、おおよそ20〜40MBに収まる
const TILE_LIMIT = 1200;

const TILE_HOST = 'cyberjapandata.gsi.go.jp';
const LIB_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
    // 本体は毎回取り直すので、ここではオフライン時の控えを用意するだけ
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL);
        await cache.addAll(['./', './msm.js', './pin.js', './weather.js']);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keep = [SHELL, LIB, TILES];
        for (const name of await caches.keys()) {
            if (!keep.includes(name)) await caches.delete(name);
        }
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin === self.location.origin) {
        event.respondWith(networkFirst(request));
    } else if (url.hostname === TILE_HOST) {
        event.respondWith(cacheFirstTile(request));
    } else if (LIB_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(request, LIB));
    }
    // それ以外（予測データの取得先）は素通し。キャッシュしない
});

// アプリ本体。取れたら必ず最新を返し、取れなければ前回の内容を返す
async function networkFirst(request) {
    // 画面のURLは lat/pin などが付くので、控えは常にディレクトリのURLひとつにまとめる
    const key = request.mode === 'navigate'
        ? new Request(new URL('./', self.location).href)
        : request;
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(SHELL);
            await cache.put(key, response.clone());
        }
        return response;
    } catch (error) {
        const cached = await caches.match(key);
        if (cached) return cached;
        throw error;
    }
}

async function cacheFirst(request, cacheName) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
        const cache = await caches.open(cacheName);
        await cache.put(request, response.clone());
    }
    return response;
}

async function cacheFirstTile(request) {
    const cache = await caches.open(TILES);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
        await cache.put(request, response.clone());
        trimTiles(cache); // 終わるのを待たない
    }
    return response;
}

// Cache API には古いものから消す仕組みが無いので、入れた順に上限まで削る
let trimming = false;
async function trimTiles(cache) {
    if (trimming) return;
    trimming = true;
    try {
        const keys = await cache.keys();
        const excess = keys.length - TILE_LIMIT;
        for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
    } finally {
        trimming = false;
    }
}
