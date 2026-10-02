import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let clientPromise = null;

// /api/config からanon keyを取得してSupabaseクライアントを作る。
// 読み取り(SELECT)とRealtime購読、Googleログイン（Supabase Auth）に使用し、書き込みはapi/*.js経由で行う。
// Googleログイン:
//   ・flowType 'pkce': Googleから戻るURLには使い捨ての ?code= だけが付き、トークンはURLに載らない
//   ・detectSessionInUrl: クライアント作成時に ?code= を読み取ってセッションに交換する
//   ・persistSession: セッションをlocalStorageに保存し、ページを移動してもログインを保つ
// Googleでログイン中は、SELECTとRealtimeも authenticated ロールで動く。
// 読み取りポリシーは「ログインしている有効な人だけ」（段階5 ⑤、migration 0027）。ログインしていない（anon）・承認待ち・無効の人は0件になる。
// 0件のときに本当に読める状態かは、js/auth.js の confirmReadAccess で確かめる
export function getSupabaseClient() {
  if (!clientPromise) {
    clientPromise = fetch('/api/config')
      .then((res) => {
        if (!res.ok) throw new Error('設定の取得に失敗しました');
        return res.json();
      })
      .then(({ supabaseUrl, supabaseAnonKey }) =>
        createClient(supabaseUrl, supabaseAnonKey, {
          auth: { persistSession: true, flowType: 'pkce', detectSessionInUrl: true },
        })
      );
  }
  return clientPromise;
}
