-- equipment.quantity / equipment.is_countable を追加
-- quantity: 数量（幟・テント等の固定数、チラシ等の残数どちらも保持できる）
-- is_countable: 「日常的に増減するか」の区分。true=チラシ等の消耗品、false=幟・テント等の固定数
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは新規構築用に既にquantity/is_countableカラムを反映済み。
--   既存プロジェクトにはこのマイグレーションを適用すること）
-- 既存データのbackfillは行わない（全件 quantity=1, is_countable=false のまま）

alter table public.equipment add column if not exists quantity integer not null default 1
  check (quantity >= 0);

alter table public.equipment add column if not exists is_countable boolean not null default false;
