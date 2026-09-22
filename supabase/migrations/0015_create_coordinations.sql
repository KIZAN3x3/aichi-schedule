-- ============================================================
-- 日程調整機能: coordinations / coordination_candidates /
--               coordination_responses / coordination_answers
-- ============================================================
-- 新規テーブル4つ・トリガー1つ・DB関数1つを追加するだけで、
-- 既存テーブル（events / participants / equipment 等）の行は
-- 一切変更・削除しない（既存テーブルへの参照は外部キーのみ）。
--
-- coordinations と coordination_candidates は相互参照になるため、
-- 1) coordinations を decided_candidate_id 抜きで作成
-- 2) coordination_candidates を作成
-- 3) coordinations に decided_candidate_id を後から追加
-- という順で行う。
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- （supabase/schema.sqlは今回は未反映。動作確認後にまとめて反映する）

begin;

-- ------------------------------------------------------------
-- 1. coordinations（decided_candidate_id を除く）
-- ------------------------------------------------------------
create table public.coordinations (
  id                   uuid primary key default gen_random_uuid(),
  branch               text not null check (
                         branch in (
                           '西県連','東県連',
                           '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
                           '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部'
                         )
                       ), -- events.branch（0014適用後）と完全一致
  title                text not null,
  place                text not null,   -- events.placeがNOT NULLのため、作成時必須
  content              text not null,   -- 同上（events.content）
  created_by           text not null,   -- 作成者名（events.poster_nameと同じ自己申告）
  reply_deadline       date,
  status               text not null default 'open'
                         check (status in ('open', 'decided')),
  decided_event_id     uuid references public.events (id) on delete set null,
  decided_at           timestamptz,
  created_at           timestamptz not null default now()
);

comment on table public.coordinations is '日程調整（支部ごと）';
comment on column public.coordinations.decided_event_id is
  '決定して作られたeventsの行。events側が削除されるとON DELETE SET NULLでnullに戻り、
   下のトリガーでstatusもopenに戻る（再決定できるようにするため）';

-- ------------------------------------------------------------
-- 2. coordination_candidates（候補日時）
-- ------------------------------------------------------------
create table public.coordination_candidates (
  id               uuid primary key default gen_random_uuid(),
  coordination_id  uuid not null references public.coordinations (id) on delete cascade,
  date             date not null,
  time             time,              -- null許容＝終日候補。決定時に必須入力させる
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  unique (coordination_id, date, time)
);

comment on table public.coordination_candidates is '日程調整の候補日時';

-- ------------------------------------------------------------
-- 3. coordinations に decided_candidate_id を後から追加
--    （coordination_candidates 作成後でないと参照できないため）
-- ------------------------------------------------------------
alter table public.coordinations
  add column decided_candidate_id uuid references public.coordination_candidates (id) on delete set null;

-- ------------------------------------------------------------
-- 4. coordination_responses（回答者、1人1行）
-- ------------------------------------------------------------
create table public.coordination_responses (
  id               uuid primary key default gen_random_uuid(),
  coordination_id  uuid not null references public.coordinations (id) on delete cascade,
  participant_name text not null,
  registered_by    text,              -- participants.registered_by と同じ「代理登録」の考え方
  comment          text check (comment is null or char_length(comment) <= 200),
  created_at       timestamptz not null default now(),
  unique (coordination_id, participant_name)
);

comment on table public.coordination_responses is '日程調整への回答者（自己申告名・代理登録対応）';

-- ------------------------------------------------------------
-- 5. coordination_answers（候補ごとの〇△✕）
-- ------------------------------------------------------------
create table public.coordination_answers (
  id            uuid primary key default gen_random_uuid(),
  response_id   uuid not null references public.coordination_responses (id) on delete cascade,
  candidate_id  uuid not null references public.coordination_candidates (id) on delete cascade,
  mark          text not null check (mark in ('yes', 'maybe', 'no')),
  unique (response_id, candidate_id)
);

comment on table public.coordination_answers is '候補日ごとの回答（yes=〇 / maybe=△ / no=✕）';

-- ------------------------------------------------------------
-- インデックス
-- ------------------------------------------------------------
create index idx_coordinations_branch_status on public.coordinations (branch, status);
create index idx_coordination_candidates_coordination_id on public.coordination_candidates (coordination_id);
create index idx_coordination_responses_coordination_id on public.coordination_responses (coordination_id);
create index idx_coordination_answers_response_id on public.coordination_answers (response_id);
create index idx_coordination_answers_candidate_id on public.coordination_answers (candidate_id);

-- ------------------------------------------------------------
-- トリガー: 決定済みのeventsが削除されたら、調整を自動的にopenへ戻す
-- decided_event_idへのON DELETE SET NULLで列自体はnullになるが、
-- status/decided_candidate_id/decided_atは自動では戻らないため、
-- BEFORE UPDATEトリガーでNEWを書き換える。
-- coordinations自身への更新のみを扱うトリガーであり、events/participantsの
-- 行を変更・削除する処理ではない。
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
  end if;
  return new;
end;
$$;

create trigger trg_coordinations_reopen_on_event_unlink
  before update on public.coordinations
  for each row
  execute function public.coordinations_reopen_on_event_unlink();

-- ------------------------------------------------------------
-- 決定処理を一括で行うDB関数。
-- 関数「定義」にinsert/updateの文を含むが、これはCREATE FUNCTION実行時には
-- 一切実行されない（関数本体としてDBに登録されるだけ）。実際にevents/participants
-- へ書き込まれるのは、後日この関数をrpc経由で呼び出した時点のみ。
--
-- 1回の関数呼び出し＝1トランザクション。FOR UPDATEでの行ロック＋status='open'の
-- 再確認により、二重クリックでも2件目はopen条件に合わず例外で弾かれる（events重複作成を防ぐ）。
-- ------------------------------------------------------------
create or replace function public.decide_coordination(
  p_coordination_id uuid,
  p_candidate_id    uuid,
  p_decided_by      text,
  p_place           text,
  p_content         text,
  p_category        text,
  p_time            time,
  p_end_time        time,
  p_register_yes    boolean default true,
  p_register_maybe  boolean default false
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

  insert into public.events (branch, date, time, end_time, place, content, poster_name, category)
  values (v_branch, v_date, p_time, p_end_time, p_place, p_content, p_decided_by, nullif(btrim(coalesce(p_category, '')), ''))
  returning id into v_event_id;

  if p_register_yes then
    insert into public.participants (event_id, participant_name, registered_by, status)
    select v_event_id, r.participant_name, p_decided_by, 'going'
    from public.coordination_responses r
    join public.coordination_answers a on a.response_id = r.id
    where r.coordination_id = p_coordination_id
      and a.candidate_id = p_candidate_id
      and a.mark = 'yes'
    on conflict (event_id, participant_name) do nothing;
  end if;

  if p_register_maybe then
    insert into public.participants (event_id, participant_name, registered_by, status)
    select v_event_id, r.participant_name, p_decided_by, 'going'
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

-- 重要: anon/authenticatedからの直接rpc呼び出しを封じる（作成者/管理者チェックはAPIレイヤーの責務）。
-- Supabaseの既定でanon/authenticatedにPUBLIC経由のEXECUTE権限が付与されている場合があるため、
-- public・anon・authenticatedの3つすべてから明示的にrevokeし、service_roleにのみ許可する
revoke execute on function public.decide_coordination from public;
revoke execute on function public.decide_coordination from anon;
revoke execute on function public.decide_coordination from authenticated;
grant execute on function public.decide_coordination to service_role;

-- ------------------------------------------------------------
-- RLS: 既存4テーブル（events等）と同じ方針。SELECTのみanon許可、
-- 書き込みはservice role経由のみ（anon向けの書き込みポリシーは作らない）
-- ------------------------------------------------------------
alter table public.coordinations            enable row level security;
alter table public.coordination_candidates  enable row level security;
alter table public.coordination_responses   enable row level security;
alter table public.coordination_answers     enable row level security;

create policy "coordinations_select_anon"           on public.coordinations           for select using (true);
create policy "coordination_candidates_select_anon" on public.coordination_candidates for select using (true);
create policy "coordination_responses_select_anon"  on public.coordination_responses  for select using (true);
create policy "coordination_answers_select_anon"    on public.coordination_answers    for select using (true);

-- ------------------------------------------------------------
-- Realtime: 他端末への自動反映用にpublicationへ追加
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.coordinations;
alter publication supabase_realtime add table public.coordination_candidates;
alter publication supabase_realtime add table public.coordination_responses;
alter publication supabase_realtime add table public.coordination_answers;

-- DELETE時のpayload.oldに全カラムを載せる（participantsと同じ理由。branch列を持たない
-- coordination_responses/coordination_answersの購読で必要）
alter table public.coordination_responses replica identity full;
alter table public.coordination_answers   replica identity full;

commit;
