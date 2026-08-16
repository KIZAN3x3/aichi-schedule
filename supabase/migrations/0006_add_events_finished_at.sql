-- events.finished_at を追加（任意）
-- 「終了」ボタンが実際に押された日時を記録する専用カラム。
-- 従来はend_time（予定終了時刻）を終了済み判定に流用していたが、
-- 予定終了時刻を入力しただけで「終了済み」表示になる不具合があったため分離した。
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは新規構築用に既にfinished_atカラムを反映済み。
--   既存プロジェクトにはこのマイグレーションを適用すること）

alter table public.events
  add column if not exists finished_at timestamptz;

comment on column public.events.finished_at is '「終了」ボタンが押された日時（未終了ならnull）。予定終了時刻(end_time)とは別物';
