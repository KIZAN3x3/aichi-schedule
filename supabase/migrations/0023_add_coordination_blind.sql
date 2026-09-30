-- 日程調整に「ブラインド（リンクを知っている人だけ）」を追加する
--   ・coordinations.is_blind: ブラインドか（既定値 false）。既存の行はすべて false（通常）になる
--   ・coordination_share_tokens: 日程調整ごとの共有トークン（推測されにくい32文字の乱数。IDとは別の値）。
--       リンクは coordination.html?t=<token>。日程調整を作ると、トリガーで自動で1つ作る。
--       既存の日程調整すべてにも作る（on conflict do nothing）。通常⇔ブラインドを切り替えてもトークンは変わらない。
--       この表は RLS 有効・ポリシーなしで、API（service_role）からだけ読める。Realtime には入れない
--   ・RLS: coordinations・候補日・回答者・回答の4つの表の読み取りポリシーを、「ブラインドの調整（とその子の行）は
--       anon・authenticated から見えない」形に作り直す。通常の調整の見え方は今と同じ（条件が常に true になる）。
--       ブラインドは API が「見てよい人」（作成者本人・その支部を管理できる管理者・回答した人（代理登録を含む））か、
--       トークンを持つ人にだけ返す。段階5で閲覧を締め出すときは、各ポリシーの条件に認証の条件を足す
--       （ブラインドの条件はそのまま残す）
--   ・update_coordination に p_is_blind を追加する（null＝今の値のまま）。
--       引数が増えるため drop → create で作り直す（0022 と同じ手順。今の引数を確認し、違えば例外で止める）。
--       既定値(null)があるため、このmigrationを先に適用しても今のAPI（p_is_blind を渡さない）の編集は動き、ブラインドは変わらない
--
-- 方針:
--   ・既存のテーブルの行は一切削除・上書きしない（列・表・関数・トリガー・ポリシーの追加と作り直し、トークンの追加だけ）
--   ・ポリシーの名前は今と同じにする（段階5でも同じ名前のまま条件を足せるように）
--
-- APIのデプロイは、このmigrationの適用後に行うこと（逆順だと、まだ無い列・表・引数を使って一覧・作成・編集が失敗する）。
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- 何度実行しても壊れないよう add column if not exists / create table if not exists / drop policy if exists / 存在確認を使っている
-- （関数の確認は「今の7引数版が1つだけ」または「適用済みの8引数版が1つだけ」のどちらかなら通る）

begin;

-- ------------------------------------------------------------
-- 1) ブラインドの列（既存の行はすべて false＝通常）
-- ------------------------------------------------------------
alter table public.coordinations
  add column if not exists is_blind boolean not null default false;

comment on column public.coordinations.is_blind is
  'ブラインド（リンクを知っている人だけ）か。true の調整は一覧に出さず、APIが見てよい人かトークンを持つ人にだけ返す。既存行はfalse';

-- ------------------------------------------------------------
-- 2) 共有トークン（日程調整ごとに1つ）
-- ------------------------------------------------------------
create table if not exists public.coordination_share_tokens (
  coordination_id uuid primary key references public.coordinations (id) on delete cascade,
  token           text not null default replace(gen_random_uuid()::text, '-', '')
                    constraint coordination_share_tokens_token_check check (token ~ '^[0-9a-f]{32}$'),
  created_at      timestamptz not null default now(),
  constraint coordination_share_tokens_token_key unique (token)
);

comment on table public.coordination_share_tokens is
  '日程調整の共有トークン（coordination.html?t=<token>）。RLS有効・ポリシーなしで、API（service_role）からだけ読む';

alter table public.coordination_share_tokens enable row level security;
-- ポリシーは作らない（anon・authenticated からは読めない）。念のため表の権限も外す
revoke all on table public.coordination_share_tokens from anon;
revoke all on table public.coordination_share_tokens from authenticated;

-- 日程調整を作ったら、トークンを自動で1つ作る
create or replace function public.coordinations_create_share_token()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.coordination_share_tokens (coordination_id)
  values (new.id)
  on conflict (coordination_id) do nothing;
  return new;
end;
$$;

revoke execute on function public.coordinations_create_share_token() from public;
revoke execute on function public.coordinations_create_share_token() from anon;
revoke execute on function public.coordinations_create_share_token() from authenticated;

drop trigger if exists trg_coordinations_create_share_token on public.coordinations;
create trigger trg_coordinations_create_share_token
  after insert on public.coordinations
  for each row
  execute function public.coordinations_create_share_token();

-- 既存の日程調整すべてにトークンを作る（すでにあれば何もしない）
insert into public.coordination_share_tokens (coordination_id)
select id from public.coordinations
on conflict (coordination_id) do nothing;

-- ------------------------------------------------------------
-- 3) RLS: ブラインドの調整（とその子の行）を anon・authenticated から見えなくする
--    名前は今と同じ。通常の調整は今と同じく誰でも読める
-- ------------------------------------------------------------
drop policy if exists "coordinations_select_anon" on public.coordinations;
create policy "coordinations_select_anon"
  on public.coordinations for select
  using (not is_blind);

drop policy if exists "coordination_candidates_select_anon" on public.coordination_candidates;
create policy "coordination_candidates_select_anon"
  on public.coordination_candidates for select
  using (exists (
    select 1 from public.coordinations c
    where c.id = coordination_candidates.coordination_id and not c.is_blind
  ));

drop policy if exists "coordination_responses_select_anon" on public.coordination_responses;
create policy "coordination_responses_select_anon"
  on public.coordination_responses for select
  using (exists (
    select 1 from public.coordinations c
    where c.id = coordination_responses.coordination_id and not c.is_blind
  ));

drop policy if exists "coordination_answers_select_anon" on public.coordination_answers;
create policy "coordination_answers_select_anon"
  on public.coordination_answers for select
  using (exists (
    select 1
    from public.coordination_responses r
    join public.coordinations c on c.id = r.coordination_id
    where r.id = coordination_answers.response_id and not c.is_blind
  ));

-- ------------------------------------------------------------
-- 4) update_coordination に p_is_blind を追加して作り直す
-- ------------------------------------------------------------
-- 4-1) 今ある update_coordination が、想定どおりの引数の1つだけであることを確認する
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
    'p_coordination_id uuid, p_title text, p_place text, p_content text, p_reply_deadline date, p_candidates jsonb, p_audience text',
    'p_coordination_id uuid, p_title text, p_place text, p_content text, p_reply_deadline date, p_candidates jsonb, p_audience text, p_is_blind boolean'
  ) then
    raise exception 'update_coordination の引数が想定と違います: %。中止します', v_args;
  end if;
end;
$$;

-- 4-2) 今の関数を消す（上で確認した引数のどちらか。流し直しのときは8引数版を消して作り直す）
drop function if exists public.update_coordination(uuid, text, text, text, date, jsonb, text);
drop function if exists public.update_coordination(uuid, text, text, text, date, jsonb, text, boolean);

-- 4-3) ブラインドを受け取る形で作り直す（中身は、ブラインドの更新の1点以外は 0022 と同じ）
create function public.update_coordination(
  p_coordination_id uuid,
  p_title           text,
  p_place           text,
  p_content         text,
  p_reply_deadline  date,
  p_candidates      jsonb,  -- [{ "id"?: uuid, "date": "YYYY-MM-DD", "time"?: "HH:MM", "note"?: text }, ...]（表示順）
  p_audience        text    default null,  -- 範囲（null＝範囲なし。API が今の値を残すときは今の値を渡す）
  p_is_blind        boolean default null   -- ブラインドか（null＝今の値のまま）
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
      audience       = v_audience,
      is_blind       = coalesce(p_is_blind, is_blind)
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

-- 1) 列: coordinations.is_blind(boolean, NO, default false) の1行
-- select column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'coordinations' and column_name = 'is_blind';

-- 2) 既存の日程調整はすべて通常、トークンは全件にある: total = 8, blind = 0, with_token = 8
--    （8 は 2026-09-30 時点の件数）
-- select count(*) as total,
--        count(*) filter (where is_blind) as blind,
--        count(t.coordination_id) as with_token
-- from public.coordinations c
-- left join public.coordination_share_tokens t on t.coordination_id = c.id;

-- 3) トークンの表: RLS 有効、ポリシーなし（0行）、anon・authenticated は読めない（false / false）
-- select relrowsecurity from pg_class where oid = 'public.coordination_share_tokens'::regclass;
-- select policyname from pg_policies where schemaname = 'public' and tablename = 'coordination_share_tokens';
-- select has_table_privilege('anon', 'public.coordination_share_tokens', 'select') as anon,
--        has_table_privilege('authenticated', 'public.coordination_share_tokens', 'select') as authenticated;

-- 4) 4つの表のポリシー: それぞれ *_select_anon（SELECT）が1つずつ、qual にブラインドの条件
-- select tablename, policyname, permissive, roles, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in ('coordinations', 'coordination_candidates', 'coordination_responses', 'coordination_answers')
-- order by tablename, policyname;

-- 5) トリガー: trg_coordinations_create_share_token が1つ（AFTER INSERT）
-- select tgname, pg_get_triggerdef(oid) from pg_trigger
-- where tgrelid = 'public.coordinations'::regclass and not tgisinternal order by tgname;

-- 6) update_coordination が1つだけで、最後の引数が p_is_blind boolean であること（1行だけ出る）
--    実行権限は anon=false / authenticated=false / service_role=true
-- select p.oid::regprocedure as signature,
--        has_function_privilege('anon', p.oid, 'execute') as anon,
--        has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
--        has_function_privilege('service_role', p.oid, 'execute') as service_role
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'update_coordination';

-- ============================================================
-- 元に戻すとき（何かあったときだけ。ふだんは実行しない）
-- 4つの表の読み取りポリシーを、0015 の元の形（誰でも全件読める）に戻す。
-- ※ 戻すと、ブラインドの調整も anon キーで読めるようになる（一覧の画面には、APIが返さない限り出ない）。
--   列・トークンの表・トリガー・関数はそのまま残してよい（残っていても通常の調整の動きは変わらない）
-- ============================================================
-- begin;
-- drop policy if exists "coordinations_select_anon"           on public.coordinations;
-- drop policy if exists "coordination_candidates_select_anon" on public.coordination_candidates;
-- drop policy if exists "coordination_responses_select_anon"  on public.coordination_responses;
-- drop policy if exists "coordination_answers_select_anon"    on public.coordination_answers;
-- create policy "coordinations_select_anon"           on public.coordinations           for select using (true);
-- create policy "coordination_candidates_select_anon" on public.coordination_candidates for select using (true);
-- create policy "coordination_responses_select_anon"  on public.coordination_responses  for select using (true);
-- create policy "coordination_answers_select_anon"    on public.coordination_answers    for select using (true);
-- commit;
