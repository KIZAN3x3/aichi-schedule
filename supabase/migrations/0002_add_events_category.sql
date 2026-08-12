-- events.category を追加
-- 固定8カテゴリ、または「その他」選択時に入力される自由記述テキストを保存する。
-- 未選択(null)も許容するためCHECK制約は設けない。
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは新規構築用に既にcategoryカラムを反映済み。
--   既存プロジェクトにはこのマイグレーションを適用すること）

alter table public.events
  add column if not exists category text;

comment on column public.events.category is 'カテゴリ（固定8種、または「その他」選択時の自由入力テキスト。未選択(null)も許容）';
