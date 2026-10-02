-- 段階5 ①: 参加・回答の重複チェックをユーザーIDに移す
--   ・参加（participants）に「予定＋本人のユーザーID」、回答（coordination_responses）に「日程調整＋本人のユーザーID」の
--       一意の条件を足す（本人のIDがある行だけ。部分一意インデックス）。表示名を変えた人が、同じ予定（日程調整）に
--       2行持てないようにする（APIは本人登録のとき、まず自分のIDで既存の行を探す）
--   ・今の「予定＋名前」「日程調整＋名前」の一意の条件は消さずに残す（取消のAPIは今までどおり名前で行を探すため。
--       移行前の行・代理登録の行は、今までどおり名前で1行）
--   ・decide_coordination の参加者の登録を「on conflict (event_id, participant_name) do nothing」から
--       「on conflict do nothing」に変える（名前・本人のID、どちらの一意の条件に重なっても飛ばす）。
--       引数は変えないので create or replace で作り直す（中身はこの2か所以外 0024 と同じ）
--
-- 方針:
--   ・既存のテーブルの行は一切削除・上書きしない（一意の条件の追加と、関数の作り直しだけ）
--   ・追加の前に、同じ予定（日程調整）に同じ本人IDの行が2つ以上ないことを確かめ、あれば例外で止める
--     （2026-10-02 時点で 0 組。本人IDのある参加は2行、回答は6行）
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- 何度実行しても壊れないよう create unique index if not exists / create or replace を使っている
-- APIのデプロイは、このmigrationの適用後に行うこと（順番が逆でも動くが、適用前は本人IDの重複を防げない）

begin;

-- ------------------------------------------------------------
-- 1) 同じ予定（日程調整）に、同じ本人IDの行が2つ以上ないことを確かめる
-- ------------------------------------------------------------
do $$
declare
  v_participants int;
  v_responses    int;
begin
  select count(*) into v_participants from (
    select event_id, participant_user_id from public.participants
    where participant_user_id is not null
    group by event_id, participant_user_id having count(*) > 1
  ) d;
  select count(*) into v_responses from (
    select coordination_id, participant_user_id from public.coordination_responses
    where participant_user_id is not null
    group by coordination_id, participant_user_id having count(*) > 1
  ) d;
  if v_participants > 0 or v_responses > 0 then
    raise exception '同じ本人IDの行が重なっています（参加 % 組・回答 % 組）。中止します', v_participants, v_responses;
  end if;
end;
$$;

-- 2) 一意の条件（本人のIDがある行だけ）
create unique index if not exists participants_event_id_participant_user_id_key
  on public.participants (event_id, participant_user_id)
  where participant_user_id is not null;

create unique index if not exists coordination_responses_coordination_id_participant_user_id_key
  on public.coordination_responses (coordination_id, participant_user_id)
  where participant_user_id is not null;

comment on index public.participants_event_id_participant_user_id_key is
  '同じ予定に、同じ本人（participant_user_id）の参加は1行だけ（本人のIDがある行のみ。名前の一意の条件とは別に持つ）';
comment on index public.coordination_responses_coordination_id_participant_user_id_key is
  '同じ日程調整に、同じ本人（participant_user_id）の回答は1行だけ（本人のIDがある行のみ。名前の一意の条件とは別に持つ）';

-- ------------------------------------------------------------
-- 3) decide_coordination の参加者の登録で、どちらの一意の条件に重なっても飛ばす
--    今ある関数が12引数版1つだけであることを確かめてから作り直す
-- ------------------------------------------------------------
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
  if v_args <> 'p_coordination_id uuid, p_candidate_id uuid, p_decided_by text, p_place text, p_content text, p_category text, p_time time without time zone, p_end_time time without time zone, p_register_yes boolean, p_register_maybe boolean, p_decided_by_user_id uuid, p_add_to_schedule boolean' then
    raise exception 'decide_coordination の引数が想定と違います: %。中止します', v_args;
  end if;
end;
$$;

create or replace function public.decide_coordination(
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
      on conflict do nothing;   -- 名前・本人のユーザーID、どちらの一意の条件に重なっても飛ばす（0025）
    end if;

    if p_register_maybe then
      insert into public.participants (event_id, participant_name, participant_user_id, registered_by, registered_by_user_id, status)
      select v_event_id, r.participant_name, r.participant_user_id, p_decided_by, p_decided_by_user_id, 'going'
      from public.coordination_responses r
      join public.coordination_answers a on a.response_id = r.id
      where r.coordination_id = p_coordination_id
        and a.candidate_id = p_candidate_id
        and a.mark = 'maybe'
      on conflict do nothing;   -- 名前・本人のユーザーID、どちらの一意の条件に重なっても飛ばす（0025）
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

-- anon/authenticatedからの直接rpc呼び出しを封じる（今までと同じ）
revoke execute on function public.decide_coordination from public;
revoke execute on function public.decide_coordination from anon;
revoke execute on function public.decide_coordination from authenticated;
grant execute on function public.decide_coordination to service_role;

commit;

-- ============================================================
-- 確認用 SELECT（適用後に1つずつ実行する。どれもデータは変えない）
-- ============================================================

-- 1) 一意の条件: 新しい2つ（部分一意インデックス）と、今までの名前の2つ（どちらも残っている）の計4行
-- select tablename, indexname, indexdef from pg_indexes
-- where schemaname = 'public'
--   and indexname in (
--     'participants_event_id_participant_user_id_key',
--     'coordination_responses_coordination_id_participant_user_id_key',
--     'participants_event_id_participant_name_key',
--     'coordination_responses_coordination_id_participant_name_key'
--   )
-- order by indexname;

-- 2) decide_coordination が1つだけで、参加者の登録が「on conflict do nothing」になっていること
--    （signature が1行、uses_any_conflict = true、uses_name_conflict = false）。実行権限は false / false / true
-- select p.oid::regprocedure as signature,
--        position('on conflict do nothing' in pg_get_functiondef(p.oid)) > 0 as uses_any_conflict,
--        position('on conflict (event_id, participant_name)' in pg_get_functiondef(p.oid)) > 0 as uses_name_conflict,
--        has_function_privilege('anon', p.oid, 'execute') as anon,
--        has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
--        has_function_privilege('service_role', p.oid, 'execute') as service_role
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'decide_coordination';

-- 3) 既存の行は書き換わっていない（件数が適用前と同じ。2026-10-02 時点で 参加 42 / 回答 13）
-- select (select count(*) from public.participants) as participants,
--        (select count(*) from public.coordination_responses) as responses;

-- ============================================================
-- 元に戻すとき（何かあったときだけ。ふだんは実行しない）
--   ・一意の条件: 足した2つを消す（名前の一意の条件は残っているので、今までの動きに戻る）
--   ・decide_coordination: 0024 の関数の定義（create function 〜 $$;）を、create or replace にして流し直す
-- ============================================================
-- begin;
-- drop index if exists public.participants_event_id_participant_user_id_key;
-- drop index if exists public.coordination_responses_coordination_id_participant_user_id_key;
-- commit;
