-- 日程調整の決定で「スケジュールに載せる／載せない」を選べるようにし、決定した人を記録する
--   ・coordinations.decided_by_user_id: 決定した人（app_users.id。null可）。載せる・載せないどちらの決定でも入れる。
--       既存の決定済みの行は null のまま（書き換えない）
--   ・decide_coordination に p_add_to_schedule を追加する（既定値 true＝今までどおり予定と参加者を作る）。
--       false のときは、予定（events）も参加者（participants）も作らず、調整だけを決定済みにする
--       （decided_event_id は空のまま。場所・内容・開始時刻の必須チェックもしない）。
--       引数が増えるため drop → create で作り直す（0019 と同じ手順。今の引数を確認し、違えば例外で止める）。
--       既定値があるため、このmigrationを先に適用しても今のAPI（p_add_to_schedule を渡さない）の決定は今までどおり動く
--   ・予定を消したときに調整中へ戻すトリガー関数（coordinations_reopen_on_event_unlink）で、決定した人も空に戻す
--   ・「載せない決定」は status = 'decided' かつ decided_event_id が空の行（予定を消したときは、上のトリガーが必ず
--       調整中に戻すため、この組み合わせは載せない決定のときだけできる）。その取り消し（調整中に戻す）は、
--       API（api/coordinations.js の action=reopen）が条件付きの1回の UPDATE で行う（DB関数は使わない）
--
-- 方針:
--   ・既存のテーブルの行は一切削除・上書きしない（列の追加と、関数の作り直しだけ）
--
-- APIのデプロイは、このmigrationの適用後に行うこと（逆順だと、まだ無い列・引数を使って決定が失敗する）。
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- 何度実行しても壊れないよう add column if not exists / create index if not exists / create or replace を使っている
-- （decide_coordination の確認は「今の11引数版が1つだけ」または「適用済みの12引数版が1つだけ」のどちらかなら通る）

begin;

-- ------------------------------------------------------------
-- 1) 決定した人（null可。既存の行は null のまま）
-- ------------------------------------------------------------
alter table public.coordinations
  add column if not exists decided_by_user_id uuid references public.app_users (id);

comment on column public.coordinations.decided_by_user_id is
  '決定した人（app_users.id）。載せる・載せないどちらの決定でも入る。調整中に戻ると空に戻る。migration 0024 より前に決定した行はnull';

create index if not exists idx_coordinations_decided_by_user_id on public.coordinations (decided_by_user_id);

-- ------------------------------------------------------------
-- 2) 予定を消したときに調整中へ戻すトリガー関数で、決定した人も空に戻す（中身は、その1行を足しただけ）
-- ------------------------------------------------------------
create or replace function public.coordinations_reopen_on_event_unlink()
returns trigger
language plpgsql
as $$
begin
  if new.decided_event_id is null
     and old.decided_event_id is not null
     and old.status = 'decided' then
    new.status := 'open';
    new.decided_candidate_id := null;
    new.decided_at := null;
    new.decided_by_user_id := null;
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------
-- 3) decide_coordination に p_add_to_schedule を追加して作り直す
-- ------------------------------------------------------------
-- 3-1) 今ある decide_coordination が、想定どおりの引数の1つだけであることを確認する
do $$
declare
  v_count int;
  v_args  text;
begin
  select count(*), max(pg_get_function_identity_arguments(p.oid))
    into v_count, v_args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'decide_coordination';

  if v_count <> 1 then
    raise exception 'decide_coordination が % 個あります（1個のはず）。中止します', v_count;
  end if;
  if v_args not in (
    'p_coordination_id uuid, p_candidate_id uuid, p_decided_by text, p_place text, p_content text, p_category text, p_time time without time zone, p_end_time time without time zone, p_register_yes boolean, p_register_maybe boolean, p_decided_by_user_id uuid',
    'p_coordination_id uuid, p_candidate_id uuid, p_decided_by text, p_place text, p_content text, p_category text, p_time time without time zone, p_end_time time without time zone, p_register_yes boolean, p_register_maybe boolean, p_decided_by_user_id uuid, p_add_to_schedule boolean'
  ) then
    raise exception 'decide_coordination の引数が想定と違います: %。中止します', v_args;
  end if;
end;
$$;

-- 3-2) 今の関数を消す（上で確認した引数のどちらか。流し直しのときは12引数版を消して作り直す）
drop function if exists public.decide_coordination(uuid, uuid, text, text, text, text, time without time zone, time without time zone, boolean, boolean, uuid);
drop function if exists public.decide_coordination(uuid, uuid, text, text, text, text, time without time zone, time without time zone, boolean, boolean, uuid, boolean);

-- 3-3) 作り直す（載せるときの中身は 0019 と同じ。決定した人の記録と、載せないときの分岐を足した）
create function public.decide_coordination(
  p_coordination_id     uuid,
  p_candidate_id        uuid,
  p_decided_by          text,
  p_place               text,
  p_content             text,
  p_category            text,
  p_time                time,
  p_end_time            time,
  p_register_yes        boolean default true,
  p_register_maybe      boolean default false,
  p_decided_by_user_id  uuid    default null,
  p_add_to_schedule     boolean default true   -- false: 予定も参加者も作らず、調整だけを決定済みにする
) returns uuid   -- 作った予定の id（載せないときは null）
language plpgsql
as $$
declare
  v_branch   text;
  v_date     date;
  v_event_id uuid;
  v_add      boolean := coalesce(p_add_to_schedule, true);
begin
  -- 場所・内容・開始時刻は、予定を作るときだけ必須
  if v_add then
    if p_place is null or btrim(p_place) = '' then
      raise exception '場所を入力してください' using errcode = 'P0003';
    end if;
    if p_content is null or btrim(p_content) = '' then
      raise exception '活動内容を入力してください' using errcode = 'P0003';
    end if;
    if p_time is null then
      raise exception '開始時刻を入力してください' using errcode = 'P0003';
    end if;
  end if;

  -- 対象の調整をロックしつつ、まだopenであることを確認（二重決定防止の要）
  select branch into v_branch
  from public.coordinations
  where id = p_coordination_id and status = 'open'
  for update;

  if not found then
    raise exception '既に決定済み、または調整が見つかりません' using errcode = 'P0001';
  end if;

  -- 候補（この調整に属するものであること）を確認
  select date into v_date
  from public.coordination_candidates
  where id = p_candidate_id and coordination_id = p_coordination_id;

  if not found then
    raise exception '候補が見つかりません' using errcode = 'P0002';
  end if;

  if v_add then
    insert into public.events (branch, date, time, end_time, place, content, poster_name, poster_user_id, category)
    values (v_branch, v_date, p_time, p_end_time, p_place, p_content, p_decided_by, p_decided_by_user_id,
            nullif(btrim(coalesce(p_category, '')), ''))
    returning id into v_event_id;

    if p_register_yes then
      insert into public.participants (event_id, participant_name, participant_user_id, registered_by, registered_by_user_id, status)
      select v_event_id, r.participant_name, r.participant_user_id, p_decided_by, p_decided_by_user_id, 'going'
      from public.coordination_responses r
      join public.coordination_answers a on a.response_id = r.id
      where r.coordination_id = p_coordination_id
        and a.candidate_id = p_candidate_id
        and a.mark = 'yes'
      on conflict (event_id, participant_name) do nothing;
    end if;

    if p_register_maybe then
      insert into public.participants (event_id, participant_name, participant_user_id, registered_by, registered_by_user_id, status)
      select v_event_id, r.participant_name, r.participant_user_id, p_decided_by, p_decided_by_user_id, 'going'
      from public.coordination_responses r
      join public.coordination_answers a on a.response_id = r.id
      where r.coordination_id = p_coordination_id
        and a.candidate_id = p_candidate_id
        and a.mark = 'maybe'
      on conflict (event_id, participant_name) do nothing;
    end if;
  end if;

  update public.coordinations
  set status = 'decided',
      decided_candidate_id = p_candidate_id,
      decided_event_id = v_event_id,   -- 載せないときは null のまま
      decided_at = now(),
      decided_by_user_id = p_decided_by_user_id
  where id = p_coordination_id;

  return v_event_id;
end;
$$;

-- anon/authenticatedからの直接rpc呼び出しを封じる（今までと同じ。作成者/管理者チェックはAPIレイヤーの責務）
revoke execute on function public.decide_coordination from public;
revoke execute on function public.decide_coordination from anon;
revoke execute on function public.decide_coordination from authenticated;
grant execute on function public.decide_coordination to service_role;

commit;

-- ============================================================
-- 確認用 SELECT（適用後に1つずつ実行する。どれもデータは変えない）
-- ============================================================

-- 1) 列: coordinations.decided_by_user_id(uuid, YES) の1行と、外部キー（app_users を参照）・インデックス
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'coordinations' and column_name = 'decided_by_user_id';
-- select conname, pg_get_constraintdef(oid) from pg_constraint
-- where conrelid = 'public.coordinations'::regclass and pg_get_constraintdef(oid) like '%decided_by_user_id%';
-- select indexname from pg_indexes where schemaname = 'public' and indexname = 'idx_coordinations_decided_by_user_id';

-- 2) 既存の行は書き換わっていない: decided_by_user_id が入った行は0件、決定済みは予定ありの1件だけ
--    （2026-09-30 時点。decided_with_event = 1, decided_without_event = 0, with_decided_by = 0）
-- select count(*) filter (where status = 'decided' and decided_event_id is not null) as decided_with_event,
--        count(*) filter (where status = 'decided' and decided_event_id is null)     as decided_without_event,
--        count(decided_by_user_id)                                                   as with_decided_by
-- from public.coordinations;

-- 3) decide_coordination が1つだけで、最後の引数が p_add_to_schedule boolean であること（1行だけ出る）
--    実行権限は anon=false / authenticated=false / service_role=true
-- select p.oid::regprocedure as signature,
--        has_function_privilege('anon', p.oid, 'execute') as anon,
--        has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
--        has_function_privilege('service_role', p.oid, 'execute') as service_role
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'decide_coordination';

-- 4) トリガー関数に「決定した人も空に戻す」が入っていること（true）と、トリガーが今までどおり有効なこと
-- select position('decided_by_user_id := null' in pg_get_functiondef('public.coordinations_reopen_on_event_unlink'::regproc)) > 0 as clears_decided_by;
-- select tgname, tgenabled from pg_trigger
-- where tgrelid = 'public.coordinations'::regclass and not tgisinternal order by tgname;
