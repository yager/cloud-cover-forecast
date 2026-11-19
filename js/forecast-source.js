// 1時間予測・2週間予測の取得先の切り替え。
//
// Open-Meteo の API を主とし、3秒たっても返らない、または失敗したときだけ、
// 別系統（S3 のオープンデータの直読み。js/s3-forecast.js）でも取り始める。
//
// - 同じサーバーへの再送（リトライ）ではない。API へのリクエストは出したまま待ち続ける
// - API が後から返ってきたら、API の値で置き換える（API が常に優先。予備は捨てる）
// - API が先に返ったら、予備は始めない（始めていても、結果は使わない）
// - 取得結果はどちらもキャッシュしない
//
// 画面には依存しない（取得の関数は呼び出し側から渡す）。

export const FALLBACK_AFTER_MS = 3000;

// onResult(forecast, source) は、source が 'fallback'（予備）で先に、
// API が後から返れば 'primary'（API）でもう一度呼ばれる。
// 'fallback' は、API が返った後には呼ばれない。
// 戻り値は、これ以上 onResult が呼ばれないと決まった時点で解決する。
// 値が1つも得られなかった（API も予備も失敗した）ときは、API のエラーで失敗する。
export function loadForecastWithFallback({
    loadPrimary,
    loadFallback,
    onResult,
    isCurrent = () => true,
    delayMs = FALLBACK_AFTER_MS
}) {
    return new Promise((resolve, reject) => {
        let primaryDone = false;
        let primaryOk = false;
        let primaryError = null;
        let fallbackStarted = false;
        let fallbackDone = false;
        let fallbackOk = false;
        let settled = false;
        let timer = null;

        // 画面側の失敗で、取得の流れ（どちらが先か・置き換え）を止めない
        const deliver = (forecast, source) => {
            try {
                onResult(forecast, source);
            } catch (error) {
                console.error('Failed to show forecast:', error);
            }
        };

        const settle = () => {
            if (settled) return;
            if (primaryOk) {
                settled = true;
                resolve();
            } else if (primaryDone && (!fallbackStarted || fallbackDone)) {
                settled = true;
                if (fallbackOk) resolve();
                else reject(primaryError);
            }
        };

        const startFallback = () => {
            if (fallbackStarted || primaryOk || !isCurrent()) return;
            fallbackStarted = true;
            loadFallback().then(
                (forecast) => {
                    fallbackOk = true;
                    if (!primaryOk && isCurrent()) deliver(forecast, 'fallback');
                },
                () => { /* 予備が失敗しても、API を待つだけ。両方だめなら settle が API のエラーで失敗にする */ }
            ).finally(() => {
                fallbackDone = true;
                settle();
            });
        };

        timer = setTimeout(startFallback, delayMs);

        loadPrimary().then(
            (forecast) => {
                primaryOk = true;
                clearTimeout(timer);
                if (isCurrent()) deliver(forecast, 'primary');
            },
            (error) => {
                primaryError = error;
                clearTimeout(timer);
                startFallback(); // 失敗したことが分かったので、3秒を待たずに始める
            }
        ).finally(() => {
            primaryDone = true;
            settle();
        });
    });
}
