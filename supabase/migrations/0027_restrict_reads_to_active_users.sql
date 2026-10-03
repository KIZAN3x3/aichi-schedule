-- 段階5 ⑤: 閲覧の締め出し（表の読み取りを、ログインしている有効な人だけにする）
--   ・public.is_active_user() を作る：ログインしていて、app_users の状態が active か（security definer）
--   ・今「誰でも読める」13 の表の読み取りポリシーを、to authenticated using ((select public.is_active_user()) …) に作り直す
--       ポリシーの名前は今のまま（…_select_anon）。日程調整の4つの表は、今のブラインドの条件（not is_blind）を残す
--   ・anon キーだけ（ログインしていない）・承認待ち・無効・未登録の人は、どの表も 0 件になる（エラーではなく 0 件）
--   ・API（service_role）は RLS を通らないので、動きは変わらない
--   ・Realtime（postgres_changes）も同じポリシーで絞られる。有効な人の画面には今までどおり届き、anon には届かない
--
-- 方針:
--   ・表の行は一切削除・上書きしない（関数の追加と、ポリシーの作り直しだけ）
--   ・作り直しの前に、今のポリシーが想定どおり（13 の表に、読み取りのポリシーが1つずつ）であることを確かめ、
--       違えば例外で止める（ダッシュボードなどで足されたポリシーがあれば、見直してから実行する）
--   ・画面（js/auth.js の confirmReadAccess）は、直接読んだ結果が 0 件のときに is_active_user() を呼び、
--       ログインが切れていればログイン画面へ、無効にされていれば利用できない画面へ戻す（このmigrationより先に本番に出す）
--
-- 実行方法: SupabaseダッシュボードのSQL Editorで、次の順に実行する
--   (0) 実行の前に、下の「記録用の SELECT」を実行し、結果を残す
--   (1) このファイルの begin; 〜 commit; を実行する
--   (2) 最後の「確認用の SELECT」を実行する
-- 何度実行しても壊れない（create or replace function / drop policy if exists → create policy）
--
-- 実行の記録（2026-10-03、05:23〜05:36 UTC の間に実行）:
--   ・実行前: public のポリシーは 13 行（どれも {public} の SELECT）、storage は 0 行。public の表はすべて RLS 有効。
--       Realtime に入っている表は 8 つ（events・participants・equipment・equipment_history・日程調整の4つの表）
--   ・確認用の SELECT は見込みどおり（13 行すべて {authenticated} で is_active_user() を含む。関数は security definer・
--       search_path 空・anon は実行不可・authenticated は実行可）
--   ・Realtime の DELETE は RLS で絞られないため、anon にも削除された行の表の名前と主キーだけは届く（Supabase の仕組み）
-- ============================================================
-- 記録用の SELECT（変える前に実行して、結果を残す）
-- ============================================================
-- select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
--   from pg_policies
--  where schemaname in ('public', 'storage')
--  order by schemaname, tablename, policyname;
--
-- select c.relname as table_name, c.relrowsecurity as rls_enabled
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relkind = 'r'
--  order by c.relname;
--
-- select schemaname, tablename from pg_publication_tables
--  where pubname = 'supabase_realtime' order by tablename;
--
-- ============================================================
-- 元に戻すSQL（今の「誰でも読める」ポリシーに作り直す。関数は残しても害は無いが、消すなら最後に drop する）
-- ============================================================
-- begin;
-- drop policy if exists "events_select_anon"                       on public.events;
-- drop policy if exists "participants_select_anon"                 on public.participants;
-- drop policy if exists "equipment_select_anon"                    on public.equipment;
-- drop policy if exists "equipment_history_select_anon"            on public.equipment_history;
-- drop policy if exists "branch_place_options_select_anon"         on public.branch_place_options;
-- drop policy if exists "branch_category_options_select_anon"      on public.branch_category_options;
-- drop policy if exists "branch_audience_options_select_anon"      on public.branch_audience_options;
-- drop policy if exists "equipment_item_name_options_select_anon"  on public.equipment_item_name_options;
-- drop policy if exists "equipment_item_kind_options_select_anon"  on public.equipment_item_kind_options;
-- drop policy if exists "coordinations_select_anon"                on public.coordinations;
-- drop policy if exists "coordination_candidates_select_anon"      on public.coordination_candidates;
-- drop policy if exists "coordination_responses_select_anon"       on public.coordination_responses;
-- drop policy if exists "coordination_answers_select_anon"         on public.coordination_answers;
-- create policy "events_select_anon"                      on public.events                      for select using (true);
-- create policy "participants_select_anon"                on public.participants                for select using (true);
-- create policy "equipment_select_anon"                   on public.equipment                   for select using (true);
-- create policy "equipment_history_select_anon"           on public.equipment_history           for select using (true);
-- create policy "branch_place_options_select_anon"        on public.branch_place_options        for select using (true);
-- create policy "branch_category_options_select_anon"     on public.branch_category_options     for select using (true);
-- create policy "branch_audience_options_select_anon"     on public.branch_audience_options     for select using (true);
-- create policy "equipment_item_name_options_select_anon" on public.equipment_item_name_options for select using (true);
-- create policy "equipment_item_kind_options_select_anon" on public.equipment_item_kind_options for select using (true);
-- create policy "coordinations_select_anon" on public.coordinations for select using (not is_blind);
-- create policy "coordination_candidates_select_anon" on public.coordination_candidates for select
--   using (exists (select 1 from public.coordinations c
--                  where c.id = coordination_candidates.coordination_id and not c.is_blind));
-- create policy "coordination_responses_select_anon" on public.coordination_responses for select
--   using (exists (select 1 from public.coordinations c
--                  where c.id = coordination_responses.coordination_id and not c.is_blind));
-- create policy "coordination_answers_select_anon" on public.coordination_answers for select
--   using (exists (select 1 from public.coordination_responses r
--                  join public.coordinations c on c.id = r.coordination_id
--                  where r.id = coordination_answers.response_id and not c.is_blind));
-- commit;
-- -- 関数も消すときだけ（ポリシーを戻したあとに）:
-- -- drop function if exists public.is_active_user();

begin;

-- ------------------------------------------------------------
-- 1) 今のポリシーが想定どおりかを確かめる（違えば何も変えずに止める）
--    13 の表それぞれに、読み取り（SELECT）のポリシーが今の名前で1つだけあること
-- ------------------------------------------------------------
do $$
declare
  v_expected text[] := array[
    'events.events_select_anon',
    'participants.participants_select_anon',
    'equipment.equipment_select_anon',
    'equipment_history.equipment_history_select_anon',
    'branch_place_options.branch_place_options_select_anon',
    'branch_category_options.branch_category_options_select_anon',
    'branch_audience_options.branch_audience_options_select_anon',
    'equipment_item_name_options.equipment_item_name_options_select_anon',
    'equipment_item_kind_options.equipment_item_kind_options_select_anon',
    'coordinations.coordinations_select_anon',
    'coordination_candidates.coordination_candidates_select_anon',
    'coordination_responses.coordination_responses_select_anon',
    'coordination_answers.coordination_answers_select_anon'
  ];
  v_actual text[];
begin
  select coalesce(array_agg(tablename || '.' || policyname order by tablename, policyname), '{}')
    into v_actual
    from pg_policies
   where schemaname = 'public'
     and tablename in (
       'events', 'participants', 'equipment', 'equipment_history',
       'branch_place_options', 'branch_category_options', 'branch_audience_options',
       'equipment_item_name_options', 'equipment_item_kind_options',
       'coordinations', 'coordination_candidates', 'coordination_responses', 'coordination_answers'
     );
  if not (v_actual @> v_expected and v_expected @> v_actual and cardinality(v_actual) = cardinality(v_expected)) then
    raise exception '今のポリシーが想定と違います。何も変えずに止めました。実際: %', v_actual;
  end if;
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and (tablename || '.' || policyname) = any (v_expected) and cmd <> 'SELECT'
  ) then
    raise exception '読み取り以外のポリシーがあります。何も変えずに止めました';
  end if;
end
$$;

-- ------------------------------------------------------------
-- 2) is_active_user(): ログインしていて、app_users の状態が active か
--    security definer: app_users は RLS 有効・ポリシーなしで、authenticated からは読めないため、
--    関数の持ち主の権限で読む。返すのは自分が有効かどうかだけ（ほかの人の情報は返さない）
--    search_path を空にして、関数の中の名前はすべてスキーマ付きで書く
-- ------------------------------------------------------------
create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_users u
    where u.id = (select auth.uid())
      and u.status = 'active'
  );
$$;

comment on function public.is_active_user() is
  'ログインしていて app_users.status = active か（段階5 ⑤。読み取りポリシーと、画面の確認（confirmReadAccess）で使う）';

revoke execute on function public.is_active_user() from public;
revoke execute on function public.is_active_user() from anon;
grant execute on function public.is_active_user() to authenticated;
grant execute on function public.is_active_user() to service_role;

-- ------------------------------------------------------------
-- 3) 読み取りポリシーを作り直す（名前は今のまま。to authenticated + is_active_user()）
--    (select public.is_active_user()) と select で包むと、1回の問い合わせで1回だけ評価される
-- ------------------------------------------------------------
drop policy if exists "events_select_anon" on public.events;
create policy "events_select_anon" on public.events
  for select to authenticated
  using ((select public.is_active_user()));

drop policy if exists "participants_select_anon" on public.participants;
create policy "participants_select_anon" on public.participants
  for select to authenticated
  using ((select public.is_active_user()));

drop policy if exists "equipment_select_anon" on public.equipment;
create policy "equipment_select_anon" on public.equipment
  for select to authenticated
  using ((select public.is_active_user()));

drop policy if exists "equipment_history_select_anon" on public.equipment_history;
create policy "equipment_history_select_anon" on public.equipment_history
  for select to authenticated
  using ((select public.is_active_user()));

drop policy if exists "branch_place_options_select_anon" on public.branch_place_options;
create policy "branch_place_options_select_anon" on public.branch_place_options
  for select to authenticated
  using ((select public.is_active_user()));

drop policy if exists "branch_category_options_select_anon" on public.branch_category_options;
create policy "branch_category_options_select_anon" on public.branch_category_options
  for select to authenticated
  using ((select public.is_active_user()));

drop policy if exists "branch_audience_options_select_anon" on public.branch_audience_options;
create policy "branch_audience_options_select_anon" on public.branch_audience_options
  for select to authenticated
  using ((select public.is_active_user()));

drop policy if exists "equipment_item_name_options_select_anon" on public.equipment_item_name_options;
create policy "equipment_item_name_options_select_anon" on public.equipment_item_name_options
  for select to authenticated
  using ((select public.is_active_user()));

drop policy if exists "equipment_item_kind_options_select_anon" on public.equipment_item_kind_options;
create policy "equipment_item_kind_options_select_anon" on public.equipment_item_kind_options
  for select to authenticated
  using ((select public.is_active_user()));

-- 日程調整の4つの表: 今のブラインドの条件（0023）はそのまま残し、有効な人の条件を足す
drop policy if exists "coordinations_select_anon" on public.coordinations;
create policy "coordinations_select_anon" on public.coordinations
  for select to authenticated
  using ((select public.is_active_user()) and not is_blind);

drop policy if exists "coordination_candidates_select_anon" on public.coordination_candidates;
create policy "coordination_candidates_select_anon" on public.coordination_candidates
  for select to authenticated
  using ((select public.is_active_user()) and exists (
    select 1 from public.coordinations c
    where c.id = coordination_candidates.coordination_id and not c.is_blind
  ));

drop policy if exists "coordination_responses_select_anon" on public.coordination_responses;
create policy "coordination_responses_select_anon" on public.coordination_responses
  for select to authenticated
  using ((select public.is_active_user()) and exists (
    select 1 from public.coordinations c
    where c.id = coordination_responses.coordination_id and not c.is_blind
  ));

drop policy if exists "coordination_answers_select_anon" on public.coordination_answers;
create policy "coordination_answers_select_anon" on public.coordination_answers
  for select to authenticated
  using ((select public.is_active_user()) and exists (
    select 1
    from public.coordination_responses r
    join public.coordinations c on c.id = r.coordination_id
    where r.id = coordination_answers.response_id and not c.is_blind
  ));

commit;

-- ============================================================
-- 確認用の SELECT（実行のあと）
-- ============================================================
-- select tablename, policyname, roles, cmd, qual
--   from pg_policies
--  where schemaname = 'public'
--  order by tablename, policyname;
--   → 13 行。roles はどれも {authenticated}、qual はどれも is_active_user() を含む
--     （日程調整の4つは not is_blind / not c.is_blind も含む）
--
-- select p.proname, p.prosecdef as security_definer, p.proconfig,
--        has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
--        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'is_active_user';
--   → security_definer = true、proconfig = {search_path=""}、anon_can_execute = false、authenticated_can_execute = true
