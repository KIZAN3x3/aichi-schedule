import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let clientPromise = null;

// /api/config からanon keyを取得してSupabaseクライアントを作る。
// 読み取り(SELECT)とRealtime購読のみに使用し、書き込みはapi/*.js経由で行う。
export function getSupabaseClient() {
  if (!clientPromise) {
    clientPromise = fetch('/api/config')
      .then((res) => {
        if (!res.ok) throw new Error('設定の取得に失敗しました');
        return res.json();
      })
      .then(({ supabaseUrl, supabaseAnonKey }) =>
        createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false } })
      );
  }
  return clientPromise;
}
