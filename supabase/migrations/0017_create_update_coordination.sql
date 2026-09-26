-- 0017: 日程調整の編集用DB関数 update_coordination
-- 調整本体（題名・場所・内容・回答締切）と候補（追加・削除・日時の変更・補足の変更）を
-- 1つのトランザクションでまとめて更新する。
--   ・調整中(status='open')のときだけ編集できる（行ロックで決定処理と同時に走らないようにする）
--   ・渡されなかった既存の候補は削除する（その候補への回答もON DELETE CASCADEで消える）
--   ・日付か時刻が変わった候補は、削除して新しく作り直す（回答は消える）
--   ・補足・並び順だけの変更は、候補をそのまま更新する（回答は残る）
--   ・id付きで渡された候補が、この調整に無い場合は中止する（ほかの人の編集と衝突したとき）
-- 権限（作成者本人かマスター管理者か）の判定はAPI側で行う（decide_coordinationと同じ考え方）
--
-- 実行方法: SupabaseダッシュボードのSQL Editorに貼り付けて実行
-- create or replace のため、何度実行しても壊れない
-- （supabase/schema.sqlへの反映は、実行を確認してから行う）

begin;

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

commit;
