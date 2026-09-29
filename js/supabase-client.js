import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let clientPromise = null;

// /api/config からanon keyを取得してSupabaseクライアントを作る。
// 読み取り(SELECT)とRealtime購読、Googleログイン（Supabase Auth）に使用し、書き込みはapi/*.js経由で行う。
// Googleログイン:
//   ・flowType 'pkce': Googleから戻るURLには使い捨ての ?code= だけが付き、トークンはURLに載らない
//   ・detectSessionInUrl: クライアント作成時に ?code= を読み取ってセッションに交換する
//   ・persistSession: セッションをlocalStorageに保存し、ページを移動してもログインを保つ
// Googleでログイン中は、SELECTとRealtimeも authenticated ロールで動く（既存のSELECTポリシーはロールを問わないため、見える範囲は変わらない）
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
