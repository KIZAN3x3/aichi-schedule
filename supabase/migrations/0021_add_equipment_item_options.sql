-- 備品の品名を選択式にし、「種類」を追加する
--   ・equipment_item_name_options: 品名の候補（全支部共通）。備品の登録・編集で品名を入れると API が自動で覚える
--   ・equipment_item_kind_options: 種類の候補（品名ごと・全支部共通）。品名は文字列で持つ
--       （品名の候補表への外部キーにはしない。候補に無い既存の品名の備品に種類を付けた場合も、その品名の種類として覚えるため）
--   ・equipment.item_kind: 種類（任意）。既存の行は null のまま
--
-- 方針:
--   ・既存データは一切書き換えない（既存18件の品名も候補には取り込まない。候補は空から始める）
--   ・候補の値は API で表記をそろえてから保存する（前後の空白除去・途中の空白の連続は半角スペース1つ・
--     全角英数字→半角・半角カタカナ→全角）。DB では前後に空白が無いことと 1〜50 文字であることだけを確かめる
--   ・読み取りは anon にも許可（場所の候補 branch_place_options と同じ）。書き込みは API（service_role）だけ
--   ・equipment.item_name には制約を足さない（既存の行に影響させないため）
--
-- APIのデプロイは、このmigrationの適用後に行うこと（逆順だと、まだ無い列・テーブルに書き込んで備品の登録が失敗する）。
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- 何度実行しても壊れないよう create table if not exists / add column if not exists / 制約・ポリシーの存在確認を使っている
-- ※ btrim の文字集合 E' \t\r\n　' の末尾は全角スペース(U+3000)の実文字（0013・0018 と同じ）

begin;

-- ------------------------------------------------------------
-- 品名の候補（全支部共通）
-- ------------------------------------------------------------
create table if not exists public.equipment_item_name_options (
  id          uuid primary key default gen_random_uuid(),
  value       text not null
                constraint equipment_item_name_options_value_check check (
                  value = btrim(value, E' \t\r\n　') and char_length(value) between 1 and 50
                ),
  created_at  timestamptz not null default now(),
  constraint equipment_item_name_options_value_key unique (value)
);

-- ------------------------------------------------------------
-- 種類の候補（品名ごと・全支部共通）
-- ------------------------------------------------------------
create table if not exists public.equipment_item_kind_options (
  id          uuid primary key default gen_random_uuid(),
  item_name   text not null,
  value       text not null
                constraint equipment_item_kind_options_value_check check (
                  value = btrim(value, E' \t\r\n　') and char_length(value) between 1 and 50
                ),
  created_at  timestamptz not null default now(),
  constraint equipment_item_kind_options_item_name_value_key unique (item_name, value)
);

-- ------------------------------------------------------------
-- 備品の種類（任意）
-- ------------------------------------------------------------
alter table public.equipment
  add column if not exists item_kind text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.equipment'::regclass and conname = 'equipment_item_kind_check'
  ) then
    alter table public.equipment
      add constraint equipment_item_kind_check check (
        item_kind is null or (item_kind = btrim(item_kind, E' \t\r\n　') and char_length(item_kind) between 1 and 50)
      );
  end if;
end $$;

comment on table public.equipment_item_name_options is '備品の品名の候補（全支部共通）。備品の登録・編集で品名を入れると自動で覚える';
comment on table public.equipment_item_kind_options is '備品の種類の候補（品名ごと・全支部共通）。備品の登録・編集で種類を入れると自動で覚える';
comment on column public.equipment_item_kind_options.item_name is 'この種類の候補が属する品名（文字列。品名の候補表への外部キーにはしない）';
comment on column public.equipment.item_kind is '種類（任意。例：品名「ポスター」→「〇〇候補 2026」）。既存行はnull';

-- ------------------------------------------------------------
-- RLS: 読み取りは anon にも許可、書き込みは service_role（API）だけ
-- ------------------------------------------------------------
alter table public.equipment_item_name_options enable row level security;
alter table public.equipment_item_kind_options enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'equipment_item_name_options'
      and policyname = 'equipment_item_name_options_select_anon'
  ) then
    create policy "equipment_item_name_options_select_anon"
      on public.equipment_item_name_options for select using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'equipment_item_kind_options'
      and policyname = 'equipment_item_kind_options_select_anon'
  ) then
    create policy "equipment_item_kind_options_select_anon"
      on public.equipment_item_kind_options for select using (true);
  end if;
end $$;

commit;

-- ============================================================
-- 確認用 SELECT（適用後に1つずつ実行する。どれもデータは変えない）
-- ============================================================

-- 1) テーブルと列: 次の8行（equipment 1＋種類の候補 4＋品名の候補 3。is_nullable は item_kind だけ YES、ほかは NO）
--    equipment.item_kind(text, YES)
--    equipment_item_kind_options: id(uuid) / item_name(text) / value(text) / created_at(timestamp with time zone)
--    equipment_item_name_options: id(uuid) / value(text) / created_at(timestamp with time zone)
-- select table_name, column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and (table_name in ('equipment_item_name_options', 'equipment_item_kind_options')
--        or (table_name = 'equipment' and column_name = 'item_kind'))
-- order by table_name, ordinal_position;

-- 2) 制約: 次の5行（CHECK 3つ・UNIQUE 2つ）
--    equipment_item_kind_check / equipment_item_name_options_value_check / equipment_item_name_options_value_key /
--    equipment_item_kind_options_value_check / equipment_item_kind_options_item_name_value_key
-- select conrelid::regclass as table_name, conname, contype, pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conname in (
--   'equipment_item_kind_check',
--   'equipment_item_name_options_value_check', 'equipment_item_name_options_value_key',
--   'equipment_item_kind_options_value_check', 'equipment_item_kind_options_item_name_value_key'
-- )
-- order by conname;

-- 3) RLS: 2テーブルとも relrowsecurity = true
-- select relname, relrowsecurity
-- from pg_class
-- where oid in ('public.equipment_item_name_options'::regclass, 'public.equipment_item_kind_options'::regclass);

-- 4) ポリシー: 2テーブルに select_anon（SELECT）が1つずつ。equipment は今までどおり equipment_select_anon の1つだけ
-- select tablename, policyname, cmd
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in ('equipment', 'equipment_item_name_options', 'equipment_item_kind_options')
-- order by tablename, policyname;

-- 5) 既存の行は書き換わっていない・候補は空: total = 18, with_kind = 0, name_options = 0, kind_options = 0
-- select
--   (select count(*) from public.equipment) as total,
--   (select count(item_kind) from public.equipment) as with_kind,
--   (select count(*) from public.equipment_item_name_options) as name_options,
--   (select count(*) from public.equipment_item_kind_options) as kind_options;
