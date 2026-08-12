-- events.end_time を追加（任意）
-- タイムライン表示でブロックの長さを決めるための終了時間。
-- 未入力(null)の場合、フロント側で固定の短いブロック幅として表示する。
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは新規構築用に既にend_timeカラムを反映済み。
--   既存プロジェクトにはこのマイグレーションを適用すること）

alter table public.events
  add column if not exists end_time time;

comment on column public.events.end_time is '終了時間（任意）。未入力ならタイムライン表示は固定の短いブロックとして描画';
