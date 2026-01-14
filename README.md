# 雲量予想 / Cloud Cover Forecast

雲量予想 https://weathernews.jp/mountain/cloud/ を参考に、
下層・中層・上層の雲量を同時に表示して判断を早められるようにしています。
初期表示は、作者の意向で関東地方を表示するようにしています。

## システム詳細

### 地図表示

- **地図ライブラリ**: Leaflet.js
  - Googleマップのように拡大縮小や移動がスムーズに実現できます。
- **地図タイル**: 国土地理院の写真地図（seamlessphoto）
  - `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg`
- **オーバーレイ**: 白地図（blank）を階調逆転して重ねる
  - `https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png`
  - CSS filter: `invert(1)` と `mix-blend-mode: lighten` を適用

### 雲量レイヤー

- 株式会社ウェザーニューズの雲量予想を参照しています。
- プルダウンで選択された日時の雲量レイヤーを表示します。

### 日の出・日の入り計算

- **ライブラリ**: SunCalc (https://github.com/mourner/suncalc)
- **計算対象**: 地図の中心座標（緯度35.844535、経度139.746094）における日の出・日の入り時刻
  - 日の出・日の入時刻に近い日時のプルダウンに表示します。

### 地図連動機能

3つの地図のズームレベルと位置を連動させ、1つの地図を操作すると他の2つの地図も同期します。
