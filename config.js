/*
  Supabase設定ファイル

  ここにSupabaseの
  ・Project URL
  ・anon / publishable key
  を入力します。

  ※ service_role key は絶対に入れないでください。
*/

window.ONSEN_SUPABASE_CONFIG = {
  url: "https://kquwafghdaopeeqsalxm.supabase.co",
  anonKey: "sb_publishable_6jb3CQIiwJf7dR1eEGMStQ_MLcoJVeM"
};

/*
  Mapbox設定（任意）

  ここにMapboxの「Default public token」を入力すると、
  地図がMapboxの地図に切り替わります。
  空欄のままなら、これまで通り国土地理院地図が使われます。
*/

window.ONSEN_MAPBOX_CONFIG = {
  accessToken: ""
};

/*
  Protomaps設定（任意）

  ここにProtomapsの無料APIキーを入力すると、
  地図の切り替えボタンで「ダークマップ」を選べるようになります。

  APIキーの取得方法：
  1. https://protomaps.com/api にアクセスし、「Sign up」からアカウント登録（無料）
  2. ログイン後、アカウントページ（https://protomaps.com/account）でAPIキーを発行
  3. 発行されたキーを下のapiKeyに貼り付ける

  空欄のままなら、ダークマップへの切り替えは表示されません（航空写真⇔通常マップの2種類のまま）。
*/

window.ONSEN_PROTOMAPS_CONFIG = {
  apiKey: "56e4bdf3492ca846"
};

/*
  道路・鉄道の色設定

  下記に色コード（例: "#ff0000"）を入力すると、その色に変更されます。
  null にすると、その項目だけデフォルトの色（白／グレー）に戻せます。
  ※ 県道は地図データ上「路線番号がJP:prefecturalで始まる道路」として判定しています。
  ※ 鉄道の種別（JR線／新幹線／私鉄／地下鉄／路面電車／その他）は、
    OpenStreetMap上の operator（運行会社）タグ等から自動判定しているため、
    タグの登録状況によっては判定が完全でない場合があります。
*/
window.ONSEN_ROAD_COLOR_CONFIG = {
  national: "#e53935",     // 国道 → 赤
  prefectural: "#fbc02d",  // 県道 → 黄色
  expressway: "#43a047",   // 高速・有料道路 → 緑
  majorOther: "#fb8c00",   // 主要幹線道路（国道・県道以外） → オレンジ
  // その他の道路は白のまま（変更なし）

  railJr: "#283593",         // JR線 → 藍色
  railShinkansen: "#1e88e5", // 新幹線 → 青色
  railPrivate: "#7e57c2",    // 私鉄 → 紫色
  railSubway: "#795548",     // 地下鉄 → 茶色
  railTram: "#9ccc65",       // 路面電車 → 黄緑色
  railOther: null            // 第三セクター・モノレール・ケーブルカー・新交通システム・その他 → 色分けなし（地図の標準色のまま）
};

/*
  手動追加の主要施設ラベル

  OpenStreetMap（地図の元データ）側にタグが無い・不足しているせいで
  地図上に表示されない店舗等を、ここに直接追加すると表示できます。
  （OSM側の修正を待たずに、このアプリ上でだけ先に表示させる機能です）

  書き方：
  { name: "表示したい名称", lat: 緯度, lon: 経度, category: "shopping" },

  category は以下のいずれか：
    "shopping" → 黄色（大型スーパー・モール・百貨店など）
    "hospital" → ピンク色（病院）
    "school"   → オレンジ色（学校）
    "other"    → 色分けなし（その他）

  緯度・経度（lat / lon）の調べ方：
  1. Googleマップで該当の場所を長押しする
  2. 画面下に出てくる座標（例：35.4317623, 133.3329508）をコピーする
  3. 1つ目の数字がlat、2つ目の数字がlonです
*/
window.ONSEN_MANUAL_FACILITIES = [
  { name: "高島屋 米子店", lat: 35.4317623, lon: 133.3329508, category: "shopping" }
  // ここに追加していけます（末尾のカンマを忘れずに）
];
