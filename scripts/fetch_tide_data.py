#!/usr/bin/env python3
"""気象庁の潮位表掲載地点と年次テキストを data/tide/ に同梱する。

使い方:
  python3 scripts/fetch_tide_data.py
  python3 scripts/fetch_tide_data.py --years 2026,2027
  python3 scripts/fetch_tide_data.py --out data/tide

出典:
  地点一覧 https://www.data.jma.go.jp/kaiyou/db/tide/suisan/station.php
  年次テキスト https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/{year}/{id}.txt
  フォーマット https://www.data.jma.go.jp/kaiyou/db/tide/suisan/readme.html
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

STATION_URL = "https://www.data.jma.go.jp/kaiyou/db/tide/suisan/station.php"
STATION_YEAR_URL = (
    "https://www.data.jma.go.jp/kaiyou/db/tide/suisan/station{year}.php"
)
TXT_URL = (
    "https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/{year}/{station_id}.txt"
)
USER_AGENT = "cloud-cover-forecast-tide-fetch/1.0 (+https://github.com/yager/cloud-cover-forecast)"
DM_RE = re.compile(r"(\d+)\s*[゜°]\s*(\d+)\s*'?")
# データ行: <td>番号</td><td>記号</td><td><a...>地名</a></td><td>緯度</td><td>経度</td>
ROW_RE = re.compile(
    r"<td>(\d+)</td>\s*"
    r"<td>([A-Z0-9]{2})</td>\s*"
    r"<td><a[^>]*>([^<]+)</a></td>\s*"
    r"<td>([^<]+)</td>\s*"
    r"<td>([^<]+)</td>",
    re.IGNORECASE,
)


def fetch_bytes(url: str, *, retries: int = 3, pause: float = 0.4) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as err:
            last_err = err
            if isinstance(err, urllib.error.HTTPError) and err.code == 404:
                raise
            time.sleep(pause * (attempt + 1))
    assert last_err is not None
    raise last_err


def url_exists(url: str) -> bool:
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return 200 <= res.status < 300
    except urllib.error.HTTPError as err:
        if err.code in (403, 405):
            # 一部環境は HEAD 拒否 → GET で先頭だけ見る
            try:
                fetch_bytes(url, retries=1)
                return True
            except Exception:
                return False
        return False
    except Exception:
        return False


def parse_dm(text: str) -> float:
    cleaned = text.replace("&nbsp;", " ").strip()
    m = DM_RE.search(cleaned)
    if not m:
        raise ValueError(f"緯度経度を解釈できない: {text!r}")
    deg = int(m.group(1))
    minutes = int(m.group(2))
    return deg + minutes / 60.0


def parse_stations_html(html: str, *, list_year: int) -> list[dict]:
    stations: list[dict] = []
    seen: set[str] = set()
    for m in ROW_RE.finditer(html):
        index = int(m.group(1))
        station_id = m.group(2)
        name = m.group(3).strip()
        lat = round(parse_dm(m.group(4)), 6)
        lon = round(parse_dm(m.group(5)), 6)
        if station_id in seen:
            continue
        seen.add(station_id)
        stations.append(
            {
                "id": station_id,
                "name": name,
                "lat": lat,
                "lon": lon,
                "index": index,
                "list_year": list_year,
            }
        )
    if len(stations) < 100:
        raise RuntimeError(f"地点が少なすぎる ({len(stations)})。HTML構造が変わった可能性")
    return stations


def load_station_list(year: int) -> tuple[list[dict], str]:
    """その年の一覧を取る。無ければ現行 station.php にフォールバック。"""
    candidates = [
        (STATION_YEAR_URL.format(year=year), year),
        (STATION_URL, year),
    ]
    last_err: Exception | None = None
    for url, list_year in candidates:
        try:
            html = fetch_bytes(url).decode("utf-8", errors="replace")
            # station.php は「現在の掲載年」なので、タイトル年と要求年が違う場合がある
            title_m = re.search(r"潮位表掲載地点一覧表（(\d{4})年）", html)
            if title_m:
                list_year = int(title_m.group(1))
            stations = parse_stations_html(html, list_year=list_year)
            return stations, url
        except Exception as err:
            last_err = err
            continue
    raise RuntimeError(f"{year} の地点一覧を取得できない: {last_err}")


def default_years(today: dt.date | None = None) -> list[int]:
    today = today or dt.date.today()
    years = [today.year]
    # 翌年テキストが出ていれば同梱（年末〜年始の切れ目用）
    probe = TXT_URL.format(year=today.year + 1, station_id="TK")
    if url_exists(probe):
        years.append(today.year + 1)
    return years


def download_year(
    year: int,
    stations: list[dict],
    year_dir: Path,
    *,
    workers: int,
) -> dict:
    year_dir.mkdir(parents=True, exist_ok=True)
    ok: list[str] = []
    missing: list[str] = []
    errors: list[dict] = []
    total_bytes = 0

    def one(station_id: str) -> tuple[str, str, int, str | None]:
        url = TXT_URL.format(year=year, station_id=station_id)
        path = year_dir / f"{station_id}.txt"
        try:
            body = fetch_bytes(url)
            if len(body) < 100:
                return station_id, "missing", 0, f"too short ({len(body)} bytes)"
            path.write_bytes(body)
            return station_id, "ok", len(body), None
        except urllib.error.HTTPError as err:
            if err.code == 404:
                if path.exists():
                    path.unlink()
                return station_id, "missing", 0, "404"
            return station_id, "error", 0, f"HTTP {err.code}"
        except Exception as err:
            return station_id, "error", 0, str(err)

    ids = [s["id"] for s in stations]
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(one, sid) for sid in ids]
        for fut in concurrent.futures.as_completed(futures):
            station_id, status, nbytes, detail = fut.result()
            if status == "ok":
                ok.append(station_id)
                total_bytes += nbytes
            elif status == "missing":
                missing.append(station_id)
            else:
                errors.append({"id": station_id, "error": detail})

    # 孤立した古いファイルを消す（地点が減った年）
    keep = set(ok)
    for path in year_dir.glob("*.txt"):
        if path.stem not in keep:
            path.unlink()

    return {
        "year": year,
        "files_ok": sorted(ok),
        "files_ok_count": len(ok),
        "files_missing": sorted(missing),
        "files_missing_count": len(missing),
        "errors": errors,
        "total_bytes": total_bytes,
        "txt_url_template": TXT_URL.format(year=year, station_id="{id}"),
    }


def merge_stations(by_year: dict[int, list[dict]]) -> list[dict]:
    """新しい年のメタを優先して id 単位でマージ。"""
    merged: dict[str, dict] = {}
    for year in sorted(by_year):
        for st in by_year[year]:
            merged[st["id"]] = {
                "id": st["id"],
                "name": st["name"],
                "lat": st["lat"],
                "lon": st["lon"],
                "index": st["index"],
            }
    return sorted(merged.values(), key=lambda s: (s["lat"] * -1, s["lon"], s["id"]))


def write_json(path: Path, payload: object) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--years",
        help="カンマ区切りの西暦。省略時は今年（と翌年テキストがあれば翌年）",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/tide"),
        help="出力ディレクトリ（既定: data/tide）",
    )
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args(argv)

    if args.years:
        years = sorted({int(y.strip()) for y in args.years.split(",") if y.strip()})
    else:
        years = default_years()

    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    print(f"years: {years}")
    print(f"out: {out}")

    stations_by_year: dict[int, list[dict]] = {}
    station_sources: dict[str, str] = {}
    year_reports: list[dict] = []

    for year in years:
        stations, source_url = load_station_list(year)
        stations_by_year[year] = stations
        station_sources[str(year)] = source_url
        print(f"[{year}] stations: {len(stations)} from {source_url}")

        report = download_year(
            year,
            stations,
            out / str(year),
            workers=args.workers,
        )
        year_reports.append(report)
        print(
            f"[{year}] ok={report['files_ok_count']} "
            f"missing={report['files_missing_count']} "
            f"errors={len(report['errors'])} "
            f"bytes={report['total_bytes']}"
        )
        if report["errors"]:
            for err in report["errors"][:10]:
                print(f"  error {err['id']}: {err['error']}", file=sys.stderr)

    stations = merge_stations(stations_by_year)
    fetched_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()

    stations_payload = {
        "source": "Japan Meteorological Agency tide table station list",
        "source_urls": station_sources,
        "fetched_at": fetched_at,
        "years": years,
        "count": len(stations),
        "stations": stations,
    }
    write_json(out / "stations.json", stations_payload)

    # 年次レポートは files_ok の全列挙が長いので件数中心の manifest にする
    manifest = {
        "fetched_at": fetched_at,
        "years": years,
        "station_count": len(stations),
        "station_sources": station_sources,
        "readme": {
            "stations": "stations.json",
            "yearly_text": "{year}/{id}.txt",
            "format": "https://www.data.jma.go.jp/kaiyou/db/tide/suisan/readme.html",
            "note": "航海用ではない参考値。気象の影響で実測とずれることがある。",
        },
        "by_year": [
            {
                "year": r["year"],
                "files_ok_count": r["files_ok_count"],
                "files_missing_count": r["files_missing_count"],
                "files_missing": r["files_missing"],
                "errors": r["errors"],
                "total_bytes": r["total_bytes"],
                "txt_url_template": r["txt_url_template"],
            }
            for r in year_reports
        ],
    }
    write_json(out / "manifest.json", manifest)

    hard_fail = any(r["errors"] for r in year_reports)
    soft_empty = any(r["files_ok_count"] == 0 for r in year_reports)
    if soft_empty:
        print("ERROR: 取得できた年次テキストが無い年がある", file=sys.stderr)
        return 1
    if hard_fail:
        print("ERROR: 一部地点の取得に失敗した", file=sys.stderr)
        return 1

    print(f"wrote {out / 'stations.json'} ({len(stations)} stations)")
    print(f"wrote {out / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
