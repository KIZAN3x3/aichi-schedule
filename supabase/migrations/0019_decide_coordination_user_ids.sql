-- Googleログイン＋RLS移行 段階3-2: decide_coordination に「決定した人のユーザーID」を追加する
--   ・作る予定（events）の poster_user_id に、決定した人のユーザーIDを入れる
--   ・〇（と任意で△）の回答者を参加者（participants）に登録するとき、
--       participant_user_id   = 回答者のユーザーID（coordination_responses.participant_user_id。本人登録の回答のみ入っている）
--       registered_by_user_id = 決定した人のユーザーID
--     を入れる
--   ・共通パスワードでの決定は p_decided_by_user_id が null（今までどおりIDは空欄）
--   ・あわせて app_users.is_admin の説明文を「システム管理者」に変える（説明文だけで、データは変えない）
--
-- 引数が増えるため create or replace ではなく drop → create で作り直す。
-- drop の前に、今ある関数の引数が想定どおりか確認し、違えば例外で止める（このトランザクション全体が取り消される）。
-- 新しい引数には既定値(null)があるため、このmigrationを先に適用しても、今のAPI（引数なしで呼ぶ）の決定はそのまま動く。
-- APIのデプロイは、このmigrationの適用後に行うこと（逆順だと、まだ無い引数を渡して決定が失敗する）。
--
-- 既存のテーブルの行は一切書き換えない（関数の作り直しと、列の説明文の変更のみ）。
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行

begin;

-- 1) 今ある decide_coordination が、想定どおりの引数の1つだけであることを確認する
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
  if v_args <> 'p_coordination_id uuid, p_candidate_id uuid, p_decided_by text, p_place text, p_content text, p_category text, p_time time without time zone, p_end_time time without time zone, p_register_yes boolean, p_register_maybe boolean' then
    raise exception 'decide_coordination の引数が想定と違います: %。中止します', v_args;
  end if;
end;
$$;

-- 2) 今の関数を消す（上で確認した引数と完全に一致させる）
drop function public.decide_coordination(uuid, uuid, text, text, text, text, time without time zone, time without time zone, boolean, boolean);

-- 3) 決定した人のユーザーIDを受け取る形で作り直す（中身は、IDを入れる2点以外は今までと同じ）
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
  p_decided_by_user_id  uuid    default null
) returns uuid
language plpgsql
as $$
declare
  v_branch   text;
  v_date     date;
  v_event_id uuid;
begin
  if p_place is null or btrim(p_place) = '' then
    raise exception '場所を入力してください' using errcode = 'P0003';
  end if;
  if p_content is null or btrim(p_content) = '' then
    raise exception '活動内容を入力してください' using errcode = 'P0003';
  end if;
  if p_time is null then
    raise exception '開始時刻を入力してください' using errcode = 'P0003';
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

  update public.coordinations
  set status = 'decided',
      decided_candidate_id = p_candidate_id,
      decided_event_id = v_event_id,
      decided_at = now()
  where id = p_coordination_id;

  return v_event_id;
end;
$$;

-- anon/authenticatedからの直接rpc呼び出しを封じる（今までと同じ。作成者/管理者チェックはAPIレイヤーの責務）
revoke execute on function public.decide_coordination from public;
revoke execute on function public.decide_coordination from anon;
revoke execute on function public.decide_coordination from authenticated;
grant execute on function public.decide_coordination to service_role;

-- 4) 名称の変更（説明文だけ）
comment on column public.app_users.is_admin is 'true=システム管理者（全支部で全権限）';

commit;

-- ============================================================
-- 適用後の確認（読むだけ）。別に実行して、結果を確認する
-- ============================================================
-- (a) decide_coordination が1つだけで、最後の引数が p_decided_by_user_id uuid であること（1行だけ出る）
-- select p.oid::regprocedure as signature, pg_get_function_identity_arguments(p.oid) as args
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'decide_coordination';
--
-- (b) anon・authenticated から実行できず、service_role からは実行できること（false / false / true）
-- select has_function_privilege('anon', p.oid, 'execute') as anon,
--        has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
--        has_function_privilege('service_role', p.oid, 'execute') as service_role
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'decide_coordination';
--
-- (c) is_admin の説明文
-- select col_description('public.app_users'::regclass,
--        (select attnum from pg_attribute where attrelid = 'public.app_users'::regclass and attname = 'is_admin'));
