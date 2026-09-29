-- Googleログイン＋RLS移行: 備品に「登録した人」を追加する
--   ・created_by_user_id: 登録した人（app_users.id）。Googleで登録したときだけ入る
--   ・created_by        : 登録した人の名前（表示用）。新規登録のときだけ入る（共通パスワードの管理者は入力した名前）
--   ・編集では変えない。既存の行は空欄のまま（書き換えない・名前からの backfill もしない）
--   ・削除の本人判定に使う（登録した人が空欄の備品は、今までどおり管理者だけが削除できる）
--   ・外部キーの on delete は既定の no action（0018と同じ。ユーザーは削除せず disabled にする運用）
--   ・RLS のポリシーは変えない（equipment は今までどおり anon で select のみ）
--
-- APIのデプロイは、このmigrationの適用後に行うこと（逆順だと、まだ無い列に書き込んで新規登録が失敗する）。
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- 何度実行しても壊れないよう add column if not exists / create index if not exists を使っている

begin;

alter table public.equipment
  add column if not exists created_by_user_id uuid references public.app_users (id);
alter table public.equipment
  add column if not exists created_by text;

comment on column public.equipment.created_by_user_id is '登録した人（app_users.id）。Googleで登録した行だけ入る。移行前の行・共通パスワードで登録した行はnull';
comment on column public.equipment.created_by is '登録した人の名前（表示用）。新規登録のときだけ入れ、編集では変えない。移行前の行はnull';

create index if not exists idx_equipment_created_by_user_id on public.equipment (created_by_user_id);

commit;

-- ============================================================
-- 確認用 SELECT（適用後に1つずつ実行する。どれもデータは変えない）
-- ============================================================

-- 1) 列: どちらも null 可（is_nullable = YES）。型は created_by = text、created_by_user_id = uuid。column_default は null
-- select column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'equipment'
--   and column_name in ('created_by_user_id', 'created_by')
-- order by column_name;

-- 2) 外部キー: FOREIGN KEY (created_by_user_id) REFERENCES app_users(id)、confdeltype = 'a'（no action）の1行
-- select conname, pg_get_constraintdef(oid) as definition, confdeltype
-- from pg_constraint
-- where conrelid = 'public.equipment'::regclass and contype = 'f'
--   and pg_get_constraintdef(oid) like '%created_by_user_id%';

-- 3) インデックス: idx_equipment_created_by_user_id の1行
-- select indexname, indexdef
-- from pg_indexes
-- where schemaname = 'public' and tablename = 'equipment'
--   and indexname = 'idx_equipment_created_by_user_id';

-- 4) 既存の行は書き換わっていない: total = 18, with_user_id = 0, with_name = 0
-- select count(*) as total,
--        count(created_by_user_id) as with_user_id,
--        count(created_by) as with_name
-- from public.equipment;

-- 5) 説明文: 2行とも上の comment の文言
-- select a.attname, col_description(a.attrelid, a.attnum) as comment
-- from pg_attribute a
-- where a.attrelid = 'public.equipment'::regclass
--   and a.attname in ('created_by_user_id', 'created_by');

-- 6) RLS のポリシーは変わっていない: equipment_select_anon（SELECT）の1行だけ
-- select policyname, cmd from pg_policies
-- where schemaname = 'public' and tablename = 'equipment';
