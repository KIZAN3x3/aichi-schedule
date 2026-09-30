-- 日程調整に「参加できる人の範囲」（任意）を追加する
--   ・coordinations.audience: 範囲（任意・1〜50文字）。既存の行は null（範囲なし）のまま
--   ・branch_audience_options: 支部ごとの範囲の候補（場所の候補 branch_place_options と同じ形）。
--       初期候補「県連役員」「支部長」「支部役員のみ」「支部全員」を18支部すべてに入れる
--       （on conflict do nothing。すでにある候補はそのまま）。日程調整の作成・編集で新しく入れた範囲は API が自動で覚える。
--       候補の削除は、候補管理の画面から（その支部を管理できる管理者）
--   ・update_coordination に範囲の引数 p_audience を追加する
--       引数が増えるため create or replace ではなく drop → create で作り直す（0019 の decide_coordination と同じ手順）。
--       drop の前に、今ある関数の引数が想定どおりか確認し、違えば例外で止める（このトランザクション全体が取り消される）。
--       p_audience には既定値(null)があるため、このmigrationを先に適用しても今のAPI（p_audience を渡さない）の編集は動く
--       （そのときは範囲が null になるが、今のAPIのときは範囲を入れる手段がまだ無いため、消える範囲も無い）
--
-- 方針:
--   ・既存のテーブルの行は一切削除・上書きしない（列・表・関数・ポリシーの追加と、関数の作り直しだけ）
--   ・値は API で前後の空白を除いてから保存する。DB では前後に空白が無いことと 1〜50 文字であることだけを確かめる
--   ・候補の読み取りは anon にも許可（場所の候補と同じ）。書き込みは API（service_role）だけ
--
-- APIのデプロイは、このmigrationの適用後に行うこと（逆順だと、まだ無い列・引数を使って作成・編集が失敗する）。
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- 何度実行しても壊れないよう add column if not exists / create table if not exists / 制約・ポリシーの存在確認を使っている
-- （関数の確認は「今の6引数版が1つだけ」または「適用済みの7引数版が1つだけ」のどちらかなら通る）
-- ※ btrim の文字集合 E' \t\r\n　' の末尾は全角スペース(U+3000)の実文字（0013・0018・0021 と同じ）

begin;

-- ------------------------------------------------------------
-- 1) 日程調整の範囲（任意）
-- ------------------------------------------------------------
alter table public.coordinations
  add column if not exists audience text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.coordinations'::regclass and conname = 'coordinations_audience_check'
  ) then
    alter table public.coordinations
      add constraint coordinations_audience_check check (
        audience is null or (audience = btrim(audience, E' \t\r\n　') and char_length(audience) between 1 and 50)
      );
  end if;
end $$;

comment on column public.coordinations.audience is '参加できる人の範囲（任意。例：支部役員のみ）。既存行はnull（範囲なし）';

-- ------------------------------------------------------------
-- 2) 範囲の候補（支部ごと。branch_place_options と同じ形）
-- ------------------------------------------------------------
create table if not exists public.branch_audience_options (
  id         uuid primary key default gen_random_uuid(),
  branch     text not null
               constraint branch_audience_options_branch_check check (
                 branch in (
                   '西県連','東県連',
                   '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
                   '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部'
                 )
               ),
  value      text not null
               constraint branch_audience_options_value_check check (
                 value = btrim(value, E' \t\r\n　') and char_length(value) between 1 and 50
               ),
  created_at timestamptz not null default now(),
  constraint branch_audience_options_branch_value_key unique (branch, value)
);

comment on table public.branch_audience_options is '支部ごとの日程調整の「参加できる人の範囲」の候補（プルダウン用）。作成・編集で入れた範囲を自動で覚える';

alter table public.branch_audience_options enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'branch_audience_options'
      and policyname = 'branch_audience_options_select_anon'
  ) then
    create policy "branch_audience_options_select_anon"
      on public.branch_audience_options for select using (true);
  end if;
end $$;

-- 初期候補（4つ×18支部）。すでにある候補はそのまま（削除した候補も、このmigrationを流し直すと戻る点に注意）
insert into public.branch_audience_options (branch, value)
select b.branch, v.value
from (values
  ('西県連'), ('東県連'),
  ('1支部'), ('2支部'), ('3支部'), ('4支部'), ('5支部'), ('6支部'), ('7支部'), ('8支部'),
  ('9支部'), ('10支部'), ('11支部'), ('12支部'), ('13支部'), ('14支部'), ('15支部'), ('16支部')
) as b(branch)
cross join (values ('県連役員'), ('支部長'), ('支部役員のみ'), ('支部全員')) as v(value)
on conflict (branch, value) do nothing;

-- ------------------------------------------------------------
-- 3) update_coordination に p_audience を追加して作り直す
-- ------------------------------------------------------------
-- 3-1) 今ある update_coordination が、想定どおりの引数の1つだけであることを確認する
do $$
declare
  v_count int;
  v_args  text;
begin
  select count(*), max(pg_get_function_identity_arguments(p.oid))
    into v_count, v_args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'update_coordination';

  if v_count <> 1 then
    raise exception 'update_coordination が % 個あります（1個のはず）。中止します', v_count;
  end if;
  if v_args not in (
    'p_coordination_id uuid, p_title text, p_place text, p_content text, p_reply_deadline date, p_candidates jsonb',
    'p_coordination_id uuid, p_title text, p_place text, p_content text, p_reply_deadline date, p_candidates jsonb, p_audience text'
  ) then
    raise exception 'update_coordination の引数が想定と違います: %。中止します', v_args;
  end if;
end;
$$;

-- 3-2) 今の関数を消す（上で確認した引数のどちらか。流し直しのときは7引数版を消して作り直す）
drop function if exists public.update_coordination(uuid, text, text, text, date, jsonb);
drop function if exists public.update_coordination(uuid, text, text, text, date, jsonb, text);

-- 3-3) 範囲を受け取る形で作り直す（中身は、範囲の確認と更新の2点以外は 0017 と同じ）
create function public.update_coordination(
  p_coordination_id uuid,
  p_title           text,
  p_place           text,
  p_content         text,
  p_reply_deadline  date,
  p_candidates      jsonb,  -- [{ "id"?: uuid, "date": "YYYY-MM-DD", "time"?: "HH:MM", "note"?: text }, ...]（表示順）
  p_audience        text default null   -- 範囲（null＝範囲なし。API が今の値を残すときは今の値を渡す）
) returns void
language plpgsql
as $$
declare
  r          record;
  v_id       uuid;
  v_date     date;
  v_time     time;
  v_note     text;
  v_key      text;
  v_keys     text[] := '{}';
  v_kept_ids uuid[] := '{}';
  v_existing record;
  v_audience text := nullif(btrim(coalesce(p_audience, ''), E' \t\r\n　'), '');
begin
  if p_title is null or btrim(p_title) = ''
     or p_place is null or btrim(p_place) = ''
     or p_content is null or btrim(p_content) = '' then
    raise exception '必須項目が不足しています' using errcode = 'P0003';
  end if;
  if v_audience is not null and char_length(v_audience) > 50 then
    raise exception '範囲は50文字以内で入力してください' using errcode = 'P0003';
  end if;

  -- 対象の調整をロックしつつ、調整中であることを確認（決定処理と同時に走らないようにする）
  perform 1
  from public.coordinations
  where id = p_coordination_id and status = 'open'
  for update;

  if not found then
    raise exception '決定済み、または日程調整が見つからないため編集できません' using errcode = 'P0001';
  end if;

  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' then
    raise exception '候補日時の形式が正しくありません' using errcode = 'P0003';
  end if;
  if jsonb_array_length(p_candidates) > 30 then
    raise exception '候補日時は30件以内にしてください' using errcode = 'P0003';
  end if;

  -- 1周目: 入力チェック（書き込みはまだしない）
  for r in
    select e.value as item
    from jsonb_array_elements(p_candidates) as e(value)
  loop
    v_date := nullif(btrim(coalesce(r.item->>'date', '')), '')::date;
    if v_date is null then
      raise exception '候補日を入力してください' using errcode = 'P0003';
    end if;
    v_time := nullif(btrim(coalesce(r.item->>'time', '')), '')::time;

    v_key := v_date::text || '|' || coalesce(to_char(v_time, 'HH24:MI:SS'), '');
    if v_key = any(v_keys) then
      raise exception '同じ日時の候補が重複しています' using errcode = 'P0003';
    end if;
    v_keys := array_append(v_keys, v_key);

    v_note := nullif(btrim(coalesce(r.item->>'note', '')), '');
    if v_note is not null and char_length(v_note) > 50 then
      raise exception '候補の補足は50文字以内で入力してください' using errcode = 'P0003';
    end if;

    if nullif(r.item->>'id', '') is not null then
      v_id := (r.item->>'id')::uuid;
      if not exists (
        select 1 from public.coordination_candidates
        where id = v_id and coordination_id = p_coordination_id
      ) then
        raise exception 'ほかの人が編集したため反映できませんでした。画面を読み直してから編集してください'
          using errcode = 'P0004';
      end if;
      if v_id = any(v_kept_ids) then
        raise exception '候補の指定が正しくありません' using errcode = 'P0003';
      end if;
      v_kept_ids := array_append(v_kept_ids, v_id);
    end if;
  end loop;

  if coalesce(array_length(v_keys, 1), 0) < 2 then
    raise exception '日程調整は候補日を2つ以上入れてください。日にちが決まっている場合は、スケジュール画面から予定として登録してください。'
      using errcode = 'P0003';
  end if;

  -- 2) 渡されなかった既存の候補を削除（回答もCASCADEで消える）
  delete from public.coordination_candidates
  where coordination_id = p_coordination_id
    and not (id = any(v_kept_ids));

  -- 3) 残す候補: 日付か時刻が変わったものは削除（4で作り直す）、補足・並び順だけならそのまま更新
  for r in
    select e.value as item, (e.ordinality - 1)::integer as idx
    from jsonb_array_elements(p_candidates) with ordinality as e(value, ordinality)
  loop
    if nullif(r.item->>'id', '') is null then
      continue;
    end if;
    v_id   := (r.item->>'id')::uuid;
    v_date := (r.item->>'date')::date;
    v_time := nullif(btrim(coalesce(r.item->>'time', '')), '')::time;
    v_note := nullif(btrim(coalesce(r.item->>'note', '')), '');

    select date, time into v_existing
    from public.coordination_candidates
    where id = v_id;

    if v_existing.date is distinct from v_date or v_existing.time is distinct from v_time then
      delete from public.coordination_candidates where id = v_id;   -- 回答もCASCADEで消える
    else
      update public.coordination_candidates
      set note = v_note, sort_order = r.idx
      where id = v_id;
    end if;
  end loop;

  -- 4) 新しい候補と、3で作り直す候補を追加（削除を先に済ませているので、日時の入れ替えでも重複エラーにならない）
  for r in
    select e.value as item, (e.ordinality - 1)::integer as idx
    from jsonb_array_elements(p_candidates) with ordinality as e(value, ordinality)
  loop
    if nullif(r.item->>'id', '') is not null
       and exists (select 1 from public.coordination_candidates where id = (r.item->>'id')::uuid) then
      continue;   -- 3で更新済み（日時が変わっていない候補）
    end if;
    insert into public.coordination_candidates (coordination_id, date, time, note, sort_order)
    values (
      p_coordination_id,
      (r.item->>'date')::date,
      nullif(btrim(coalesce(r.item->>'time', '')), '')::time,
      nullif(btrim(coalesce(r.item->>'note', '')), ''),
      r.idx
    );
  end loop;

  -- 5) 調整本体を更新（内容が同じでも必ずUPDATEし、Realtimeで他の画面に確実に届くようにする）
  update public.coordinations
  set title          = btrim(p_title),
      place          = btrim(p_place),
      content        = btrim(p_content),
      reply_deadline = p_reply_deadline,
      audience       = v_audience
  where id = p_coordination_id;
end;
$$;

-- anon/authenticatedからの直接rpc呼び出しを封じ、service_role（API）からだけ呼べるようにする（0017と同じ）
revoke execute on function public.update_coordination from public;
revoke execute on function public.update_coordination from anon;
revoke execute on function public.update_coordination from authenticated;
grant execute on function public.update_coordination to service_role;

commit;

-- ============================================================
-- 確認用 SELECT（適用後に1つずつ実行する。どれもデータは変えない）
-- ============================================================

-- 1) 列: coordinations.audience(text, YES) の1行
-- select table_name, column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'coordinations' and column_name = 'audience';

-- 2) 制約: 次の4行
--    coordinations_audience_check / branch_audience_options_branch_check /
--    branch_audience_options_value_check / branch_audience_options_branch_value_key
-- select conrelid::regclass as table_name, conname, contype, pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conname in (
--   'coordinations_audience_check',
--   'branch_audience_options_branch_check', 'branch_audience_options_value_check', 'branch_audience_options_branch_value_key'
-- )
-- order by conname;

-- 3) RLSとポリシー: relrowsecurity = true、ポリシーは branch_audience_options_select_anon（SELECT）の1つだけ
-- select relname, relrowsecurity from pg_class where oid = 'public.branch_audience_options'::regclass;
-- select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'branch_audience_options';

-- 4) 初期候補: 18支部 × 4つ = 72行（支部ごとに4行）
-- select branch, count(*) from public.branch_audience_options group by branch order by branch;

-- 5) update_coordination が1つだけで、最後の引数が p_audience text であること（1行だけ出る）
--    実行権限は anon=false / authenticated=false / service_role=true
-- select p.oid::regprocedure as signature,
--        has_function_privilege('anon', p.oid, 'execute') as anon,
--        has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
--        has_function_privilege('service_role', p.oid, 'execute') as service_role
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'update_coordination';

-- 6) 既存の行は書き換わっていない: total は適用前と同じ（2026-09-30時点で8）、with_audience = 0
-- select count(*) as total, count(audience) as with_audience from public.coordinations;
