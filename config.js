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
