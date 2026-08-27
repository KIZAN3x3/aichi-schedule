-- ============================================================
-- 愛知活動スケジュール帳 - Supabase テーブル定義
-- 対象: events / participants / equipment
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
-- 支部マスタ（16支部固定）
-- CHECK制約とプルダウン用の値を一箇所にまとめるためdomain代わりに配列で管理
-- ------------------------------------------------------------
-- 許可する支部名: '1支部' 〜 '16支部'

-- ------------------------------------------------------------
-- events: 支部ごとの活動予定
-- ------------------------------------------------------------
create table if not exists public.events (
  id           uuid primary key default gen_random_uuid(),
  branch       text not null check (
                 branch in (
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
comment on column public.events.branch is '支部名（1支部〜16支部の固定16件）';
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
  created_at        timestamptz not null default now()
);

comment on table public.participants is '予定ごとの参加者（自己申告名）';

create index if not exists idx_participants_event_id on public.participants (event_id);

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
  updated_by         text not null,
  updated_at         timestamptz not null default now()
);

comment on table public.equipment is '全体共通の備品リスト（支部を跨いで共有）';
comment on column public.equipment.image_url is 'Supabase Storageに保存した画像のURL';
comment on column public.equipment.owner_branch is '所有（支部）。西県連/東県連/1支部〜16支部/その他の19択、未定ならnull';
comment on column public.equipment.owner_person is '担当者名（任意入力、未定ならnull）';

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

create policy "events_select_anon"                  on public.events                  for select using (true);
create policy "participants_select_anon"            on public.participants            for select using (true);
create policy "equipment_select_anon"               on public.equipment               for select using (true);
create policy "equipment_history_select_anon"       on public.equipment_history       for select using (true);
create policy "branch_place_options_select_anon"    on public.branch_place_options    for select using (true);
create policy "branch_category_options_select_anon" on public.branch_category_options for select using (true);

-- ============================================================
-- Realtime: 他端末への自動反映用にpublicationへ追加
-- ============================================================
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.participants;
alter publication supabase_realtime add table public.equipment;
alter publication supabase_realtime add table public.equipment_history;
