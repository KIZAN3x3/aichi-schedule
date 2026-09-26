-- ============================================================
-- 愛知活動スケジュール＆備品管理 - Supabase テーブル定義
-- 対象: events / participants / equipment / coordinations（日程調整）
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
--
-- 権限モデルについて:
--   このアプリはSupabase Authを使わず、パスワード1つで
--   一般ユーザー/マスター管理者を判定する簡易認証（123 / 123123）。
--   そのため「自分の投稿だけ編集可」等の権限チェックは
--   Vercel Serverless Functions（api/*.js）側でservice role keyを使って
--   サーバーサイドで行う想定。
--   ブラウザから直接Supabaseを叩くのはRealtime購読の読み取り(SELECT)のみとし、
--   書き込み(INSERT/UPDATE/DELETE)はanonロールには許可しない。
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 支部マスタ（西県連・東県連 + 1支部〜16支部の18件固定）
-- CHECK制約とプルダウン用の値を一箇所にまとめるためdomain代わりに配列で管理
-- （js/branches.js, api/_lib/branches.js と一致させること）
-- ------------------------------------------------------------
-- 許可する支部名: '西県連','東県連','1支部' 〜 '16支部'

-- ------------------------------------------------------------
-- events: 支部ごとの活動予定
-- ------------------------------------------------------------
create table if not exists public.events (
  id           uuid primary key default gen_random_uuid(),
  branch       text not null check (
                 branch in (
                   '西県連','東県連',
                   '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
                   '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部'
                 )
               ),
  date         date not null,
  time         time not null,
  end_time     time,
  place        text not null,
  content      text not null,
  poster_name  text not null,
  category     text,
  finished_at  timestamptz,
  created_at   timestamptz not null default now()
);

comment on table public.events is '支部ごとの活動スケジュール';
comment on column public.events.branch is '支部名（西県連・東県連 + 1支部〜16支部の固定18件）';
comment on column public.events.end_time is '終了時間（任意）。未入力ならタイムライン表示は固定の短いブロックとして描画';
comment on column public.events.finished_at is '「終了」ボタンが押された日時（未終了ならnull）。予定終了時刻(end_time)とは別物';
comment on column public.events.poster_name is '投稿者名（自己申告・Supabase Authは使わない）';
comment on column public.events.category is 'カテゴリ（固定16種、または「その他」選択時の自由入力テキスト。未選択(null)も許容）';

-- 支部×日付での一覧表示が主用途なので複合インデックスを用意
create index if not exists idx_events_branch_date on public.events (branch, date);
create index if not exists idx_events_date on public.events (date);

-- ------------------------------------------------------------
-- participants: 各予定への参加者
-- ------------------------------------------------------------
create table if not exists public.participants (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.events (id) on delete cascade,
  participant_name  text not null,
  created_at        timestamptz not null default now(),
  status            text not null default 'going'
                      constraint participants_status_check check (status in ('going', 'not_going')),
  comment           text
                      constraint participants_comment_length_check check (comment is null or char_length(comment) <= 200),
  -- ※ btrim の文字集合 E' \t\r\n　' の末尾は全角スペース(U+3000)の実文字（0013 と同一）
  registered_by     text
                      constraint participants_registered_by_check check (
                        registered_by is null
                        or (
                          registered_by = btrim(registered_by, E' \t\r\n　')
                          and char_length(registered_by) between 1 and 50
                        )
                      ),
  constraint participants_event_id_participant_name_key unique (event_id, participant_name)
);

comment on table public.participants is '予定ごとの参加者（自己申告名）';
comment on column public.participants.status is '参加区分: going=参加 / not_going=不参加';
comment on column public.participants.comment is '参加者ごとの個別コメント（任意・200文字以内）';
comment on column public.participants.registered_by is 'この参加登録を最初に行った人の名前（代理登録対応）。NULL=従来データ（本人登録として扱う）';

create index if not exists idx_participants_event_id on public.participants (event_id);

-- Realtime の UPDATE/DELETE イベントの payload.old に全カラムを載せる（既定では主キーのみ）
alter table public.participants replica identity full;

-- ------------------------------------------------------------
-- equipment: 全体共通の備品管理（支部の区別なし）
-- ------------------------------------------------------------
create table if not exists public.equipment (
  id                 uuid primary key default gen_random_uuid(),
  item_name          text not null,
  management_number  text,
  location           text not null,
  image_url          text,
  memo               text,
  owner_branch       text check (
                       owner_branch is null or owner_branch in (
                         '西県連','東県連',
                         '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
                         '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部',
                         'その他'
                       )
                     ),
  owner_person       text,
  is_shared          boolean not null default false,
  quantity           integer not null default 1 check (quantity >= 0),
  is_countable       boolean not null default false,
  updated_by         text not null,
  updated_at         timestamptz not null default now()
);

comment on table public.equipment is '全体共通の備品リスト（支部を跨いで共有）';
comment on column public.equipment.image_url is 'Supabase Storageに保存した画像のURL';
comment on column public.equipment.owner_branch is '所有（支部）。西県連/東県連/1支部〜16支部/その他の19択、未定ならnull';
comment on column public.equipment.owner_person is '担当者名（任意入力、未定ならnull）';
comment on column public.equipment.is_shared is '「全体で使用」フラグ。owner_branchが西県連/東県連の場合はAPI側で常にtrueを強制する';
comment on column public.equipment.quantity is '数量（固定数・残数どちらも保持できる、0以上）';
comment on column public.equipment.is_countable is '「日常的に増減するか」の区分。true=チラシ等の消耗品、false=幟・テント等の固定数';

create index if not exists idx_equipment_item_name on public.equipment (item_name);

-- ------------------------------------------------------------
-- equipment_history: 備品の保管場所移動履歴（初回登録時の記録を含む）
-- ------------------------------------------------------------
create table if not exists public.equipment_history (
  id            uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references public.equipment (id) on delete cascade,
  location      text not null,
  moved_by      text not null,
  moved_at      timestamptz not null default now()
);

comment on table public.equipment_history is '備品の保管場所移動履歴（登録時の初回記録を含む、新しい順で表示）';

create index if not exists idx_equipment_history_equipment_id on public.equipment_history (equipment_id, moved_at desc);

-- ------------------------------------------------------------
-- branch_place_options / branch_category_options:
-- 支部ごとに過去入力された「場所」「自由入力カテゴリ」の候補
-- （イベント登録時にapi/events.js側で自動追加。次回以降の入力補完・プルダウン候補に使う）
-- ------------------------------------------------------------
create table if not exists public.branch_place_options (
  id         uuid primary key default gen_random_uuid(),
  branch     text not null check (
               branch in (
                 '西県連','東県連',
                 '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
                 '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部'
               )
             ),
  value      text not null,
  created_at timestamptz not null default now(),
  unique (branch, value)
);

create table if not exists public.branch_category_options (
  id         uuid primary key default gen_random_uuid(),
  branch     text not null check (
               branch in (
                 '西県連','東県連',
                 '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
                 '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部'
               )
             ),
  value      text not null,
  created_at timestamptz not null default now(),
  unique (branch, value)
);

comment on table public.branch_place_options is '支部ごとに過去入力された「場所」の候補（datalist用）';
comment on table public.branch_category_options is '支部ごとに過去入力された自由入力「カテゴリ」の候補（プルダウン用）';

-- ------------------------------------------------------------
-- coordinations / coordination_candidates / coordination_responses / coordination_answers:
-- 日程調整（支部ごと）。候補日時に〇△✕で回答を集め、作成者本人またはマスター管理者が
-- 決定すると、候補日を予定としてeventsへ1件登録する。
--
-- coordinationsとcoordination_candidatesは相互参照になるため、
-- 1) coordinationsをdecided_candidate_id抜きで作成
-- 2) coordination_candidatesを作成
-- 3) coordinationsにdecided_candidate_idを後から追加
-- という順で作る。
-- ------------------------------------------------------------
create table if not exists public.coordinations (
  id                   uuid primary key default gen_random_uuid(),
  branch               text not null check (
                         branch in (
                           '西県連','東県連',
                           '1支部','2支部','3支部','4支部','5支部','6支部','7支部','8支部',
                           '9支部','10支部','11支部','12支部','13支部','14支部','15支部','16支部'
                         )
                       ),
  title                text not null,
  place                text not null,
  content              text not null,
  created_by           text not null,
  reply_deadline       date,
  status               text not null default 'open'
                         check (status in ('open', 'decided')),
  decided_event_id     uuid references public.events (id) on delete set null,
  decided_at           timestamptz,
  created_at           timestamptz not null default now()
);

comment on table public.coordinations is '日程調整（支部ごと）';
comment on column public.coordinations.created_by is '作成者名（events.poster_nameと同じ自己申告）';
comment on column public.coordinations.status is '調整状況: open=調整中 / decided=決定済み';
comment on column public.coordinations.decided_event_id is
  '決定して作られたeventsの行。events側が削除されるとON DELETE SET NULLでnullに戻り、
   下のトリガーでstatusもopenに戻る（再決定できるようにするため）';

create table if not exists public.coordination_candidates (
  id               uuid primary key default gen_random_uuid(),
  coordination_id  uuid not null references public.coordinations (id) on delete cascade,
  date             date not null,
  time             time,
  note             text
                     constraint coordination_candidates_note_length_check check (note is null or char_length(note) <= 50),
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  unique (coordination_id, date, time)
);

comment on table public.coordination_candidates is '日程調整の候補日時';
comment on column public.coordination_candidates.time is 'null許容＝終日候補。決定時に必須入力させる';
comment on column public.coordination_candidates.note is '候補日時の補足（例：午前／午後／撮影日）。任意・50文字以内';

alter table public.coordinations
  add column if not exists decided_candidate_id uuid references public.coordination_candidates (id) on delete set null;

create table if not exists public.coordination_responses (
  id               uuid primary key default gen_random_uuid(),
  coordination_id  uuid not null references public.coordinations (id) on delete cascade,
  participant_name text not null,
  registered_by    text,
  comment          text check (comment is null or char_length(comment) <= 200),
  created_at       timestamptz not null default now(),
  unique (coordination_id, participant_name)
);

comment on table public.coordination_responses is '日程調整への回答者（自己申告名・代理登録対応）';
comment on column public.coordination_responses.registered_by is 'この回答を最初に行った人の名前（代理登録対応）。participants.registered_byと同じ考え方';

create table if not exists public.coordination_answers (
  id            uuid primary key default gen_random_uuid(),
  response_id   uuid not null references public.coordination_responses (id) on delete cascade,
  candidate_id  uuid not null references public.coordination_candidates (id) on delete cascade,
  mark          text not null check (mark in ('yes', 'maybe', 'no')),
  unique (response_id, candidate_id)
);

comment on table public.coordination_answers is '候補日ごとの回答（yes=〇 / maybe=△ / no=✕）';

create index if not exists idx_coordinations_branch_status on public.coordinations (branch, status);
create index if not exists idx_coordination_candidates_coordination_id on public.coordination_candidates (coordination_id);
create index if not exists idx_coordination_responses_coordination_id on public.coordination_responses (coordination_id);
create index if not exists idx_coordination_answers_response_id on public.coordination_answers (response_id);
create index if not exists idx_coordination_answers_candidate_id on public.coordination_answers (candidate_id);

-- Realtime の UPDATE/DELETE イベントの payload.old に全カラムを載せる（participantsと同じ理由。
-- branch列を持たないcoordination_responses/coordination_answersの購読で必要）
alter table public.coordination_responses replica identity full;
alter table public.coordination_answers   replica identity full;

-- トリガー: 決定済みのeventsが削除されたら、調整を自動的にopenへ戻す。
-- decided_event_idへのON DELETE SET NULLで列自体はnullになるが、
-- status/decided_candidate_id/decided_atは自動では戻らないため、
-- BEFORE UPDATEトリガーでNEWを書き換える。
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

-- 決定処理を一括で行うDB関数。events作成・participants一括登録・coordinations更新を
-- 1トランザクションで行う。FOR UPDATEでの行ロック＋status='open'の再確認により、
-- 二重クリックでも2件目はopen条件に合わず例外で弾かれる（events重複作成を防ぐ）。
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

-- anon/authenticatedからの直接rpc呼び出しを封じる（作成者/管理者チェックはAPIレイヤーの責務）。
-- Supabaseの既定でanon/authenticatedにPUBLIC経由のEXECUTE権限が付与されている場合があるため、
-- public・anon・authenticatedの3つすべてから明示的にrevokeし、service_roleにのみ許可する
revoke execute on function public.decide_coordination from public;
revoke execute on function public.decide_coordination from anon;
revoke execute on function public.decide_coordination from authenticated;
grant execute on function public.decide_coordination to service_role;

-- 日程調整の編集を一括で行うDB関数（migration 0017）。調整本体と候補の追加・削除・日時の変更・補足の変更を
-- 1トランザクションで行う。調整中(status='open')のときだけ編集でき、行ロックで決定処理と同時には走らない。
-- 日付か時刻が変わった候補は削除して作り直す（回答は消える）。補足・並び順だけの変更なら回答は残る。
-- id付きで渡された候補がこの調整に無い場合は、ほかの人の編集と衝突したとしてP0004で中止する。
-- 権限（作成者本人かマスター管理者か）の判定はAPIレイヤーの責務（decide_coordinationと同じ）
create or replace function public.update_coordination(
  p_coordination_id uuid,
  p_title           text,
  p_place           text,
  p_content         text,
  p_reply_deadline  date,
  p_candidates      jsonb   -- [{ "id"?: uuid, "date": "YYYY-MM-DD", "time"?: "HH:MM", "note"?: text }, ...]（表示順）
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
begin
  if p_title is null or btrim(p_title) = ''
     or p_place is null or btrim(p_place) = ''
     or p_content is null or btrim(p_content) = '' then
    raise exception '必須項目が不足しています' using errcode = 'P0003';
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
      reply_deadline = p_reply_deadline
  where id = p_coordination_id;
end;
$$;

-- anon/authenticatedからの直接rpc呼び出しを封じ、service_role（API）からだけ呼べるようにする
-- （decide_coordinationと同じく、PUBLIC・anon・authenticatedの3つすべてからrevokeする）
revoke execute on function public.update_coordination from public;
revoke execute on function public.update_coordination from anon;
revoke execute on function public.update_coordination from authenticated;
grant execute on function public.update_coordination to service_role;

-- ============================================================
-- Row Level Security
-- 読み取り(SELECT)はanonにも許可（Realtimeでの自動反映に必要）。
-- 書き込みはanonには許可せず、api/*.js からservice role keyで実行する
-- （service roleはRLSをバイパスするため専用ポリシーは不要）。
-- branch_place_options / branch_category_optionsも読み取りはanonに許可する
-- （書き込み=INSERTはapi/branch-options.js経由のみとし、anonには開放しない）。
-- ============================================================

alter table public.events                  enable row level security;
alter table public.participants            enable row level security;
alter table public.equipment               enable row level security;
alter table public.equipment_history       enable row level security;
alter table public.branch_place_options    enable row level security;
alter table public.branch_category_options enable row level security;
alter table public.coordinations           enable row level security;
alter table public.coordination_candidates enable row level security;
alter table public.coordination_responses  enable row level security;
alter table public.coordination_answers    enable row level security;

create policy "events_select_anon"                  on public.events                  for select using (true);
create policy "participants_select_anon"            on public.participants            for select using (true);
create policy "equipment_select_anon"               on public.equipment               for select using (true);
create policy "equipment_history_select_anon"       on public.equipment_history       for select using (true);
create policy "branch_place_options_select_anon"    on public.branch_place_options    for select using (true);
create policy "branch_category_options_select_anon" on public.branch_category_options for select using (true);
create policy "coordinations_select_anon"           on public.coordinations           for select using (true);
create policy "coordination_candidates_select_anon" on public.coordination_candidates for select using (true);
create policy "coordination_responses_select_anon"  on public.coordination_responses  for select using (true);
create policy "coordination_answers_select_anon"    on public.coordination_answers    for select using (true);

-- ============================================================
-- Realtime: 他端末への自動反映用にpublicationへ追加
-- ============================================================
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.participants;
alter publication supabase_realtime add table public.equipment;
alter publication supabase_realtime add table public.equipment_history;
alter publication supabase_realtime add table public.coordinations;
alter publication supabase_realtime add table public.coordination_candidates;
alter publication supabase_realtime add table public.coordination_responses;
alter publication supabase_realtime add table public.coordination_answers;
