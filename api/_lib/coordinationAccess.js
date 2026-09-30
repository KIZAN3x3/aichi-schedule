const { canManageBranch } = require('./permissions');

// 日程調整の「見てよい人」とブラインド（リンクを知っている人だけ）の判定。migration 0023。
// ブラインドの調整は RLS で anon・authenticated から見えないため、API（service_role）がここで判定してから返す。
//   見てよい人:
//     ・作成者本人（created_by_user_id が自分）
//     ・その支部を管理できる管理者（システム管理者・自県連の県連管理者。支部管理者は含まない）
//     ・その調整に回答した人（coordination_responses の participant_user_id か registered_by_user_id が自分。代理登録した人も含む）
//   トークン（coordination_share_tokens.token）を知っている人は、見てよい人でなくても見られ、回答できる。
// 通常の調整（is_blind = false）は誰でも見てよい。
// 一覧（api/coordinations.js の GET）・回答の受付（api/coordination-responses.js）で使う。
// 「あなたの参加予定」（自分が回答した調整を全支部分出す欄）でも respondedCoordinationIds を使い回す想定

const SHARE_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

// 画面（js/coordination.js の COORDINATION_SELECT）と同じ形で日程調整を読む。
// coordinationsとcoordination_candidatesの間には外部キーが2本あるため、どちらを辿るかを明示する
const COORDINATION_SELECT =
  '*, coordination_candidates!coordination_candidates_coordination_id_fkey(*), coordination_responses(*, coordination_answers(*)), ' +
  'decided_event:events!coordinations_decided_event_id_fkey(date, time, end_time)';

// 自分が回答した（本人として、または代理登録で）日程調整の id の Set。
// coordinationIds を渡すと、その中だけを調べる（省略すると全支部の自分の回答すべて）
async function respondedCoordinationIds(supabase, userId, coordinationIds = null) {
  if (!userId) return new Set();
  if (Array.isArray(coordinationIds) && coordinationIds.length === 0) return new Set();
  let query = supabase
    .from('coordination_responses')
    .select('coordination_id')
    .or(`participant_user_id.eq.${userId},registered_by_user_id.eq.${userId}`);
  if (coordinationIds) query = query.in('coordination_id', coordinationIds);
  const { data, error } = await query;
  if (error) throw error;
  return new Set((data || []).map((row) => row.coordination_id));
}

// その日程調整を見てよい人か（通常の調整は誰でも true）。
//   coordination: { id, branch, is_blind, created_by_user_id }
//   regionOf    : regionResolverFor(actor) の結果
//   respondedIds: respondedCoordinationIds の結果（回答したかの判定に使う）
function canViewCoordination(actor, coordination, regionOf, respondedIds) {
  if (!coordination.is_blind) return true;
  if (coordination.created_by_user_id && coordination.created_by_user_id === actor.user.id) return true;
  if (canManageBranch(actor, coordination.branch, regionOf)) return true;
  return Boolean(respondedIds && respondedIds.has(coordination.id));
}

// トークンから日程調整の id を探す。形が正しくない・見つからないときは null
async function coordinationIdByToken(supabase, token) {
  if (typeof token !== 'string' || !SHARE_TOKEN_PATTERN.test(token)) return null;
  const { data, error } = await supabase
    .from('coordination_share_tokens')
    .select('coordination_id')
    .eq('token', token)
    .maybeSingle();
  if (error) throw error;
  return data ? data.coordination_id : null;
}

// 日程調整の id → トークン の Map（ブラインドの調整を返すとき、リンク用に付ける）
async function shareTokensFor(supabase, coordinationIds) {
  if (coordinationIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('coordination_share_tokens')
    .select('coordination_id, token')
    .in('coordination_id', coordinationIds);
  if (error) throw error;
  return new Map((data || []).map((row) => [row.coordination_id, row.token]));
}

module.exports = {
  SHARE_TOKEN_PATTERN,
  COORDINATION_SELECT,
  respondedCoordinationIds,
  canViewCoordination,
  coordinationIdByToken,
  shareTokensFor,
};
