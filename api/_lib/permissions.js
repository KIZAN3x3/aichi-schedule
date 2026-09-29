const { loadRegionOf } = require('./user-auth');

// データ（予定・参加・日程調整・回答・備品・入力候補）の権限判定。方針は CLAUDE.md の「権限の方針」。
// リクエストした人（actor）は、Googleログインの有効な利用者だけ（api/_lib/auth.js の resolveActor）。
//   ・データを管理できる管理者: システム管理者（全支部）、県連管理者（自分の県連内の支部だけ）。
//     支部管理者は、データについては一般と同じ
//   ・本人判定:
//       ユーザーIDが入っている行 … そのユーザー本人、またはその支部を管理できる管理者だけ
//       ユーザーIDが空欄の行（移行前の行）… その支部を管理できる管理者だけ（名前の一致では判定しない）

// 全支部のデータを管理できるか（システム管理者）
function isGlobalManager(actor) {
  return actor.role === 'admin';
}

// 県連管理者のときだけ、支部→県連の対応表（branch_regions）を読む。それ以外は読まずに null を返す
async function regionResolverFor(actor) {
  if (actor.kind === 'region') return loadRegionOf();
  return null;
}

// その支部のデータを管理できる管理者か
function canManageBranch(actor, branch, regionOf) {
  if (isGlobalManager(actor)) return true;
  if (actor.kind === 'region' && regionOf && branch) {
    const myRegion = regionOf(actor.user.branch);
    return Boolean(myRegion) && regionOf(branch) === myRegion;
  }
  return false;
}

// 行に対して本人（または管理者）として操作できるか
//   row.branch  : その行の支部（参加・回答は親の予定・日程調整の支部、備品は所有支部）
//   row.userIds : その行の本人のユーザーID（例: 予定は poster_user_id、参加は participant_user_id と registered_by_user_id）
// ユーザーIDが空欄の行は、その支部を管理できる管理者だけ
function canActOnRow(actor, row, regionOf) {
  if (canManageBranch(actor, row.branch, regionOf)) return true;
  const ids = (row.userIds || []).filter(Boolean);
  return ids.length > 0 && ids.includes(actor.user.id);
}

// 全支部共通の入力候補（備品の品名・種類）を管理できるか。
// 「⚙ 候補管理」を使える人と同じ（システム管理者・県連管理者（東西どちらも））
function canManageSharedOptions(actor) {
  return isGlobalManager(actor) || actor.kind === 'region';
}

// 書き込む名前: 送られた値ではなく app_users.display_name を使う
function writerName(actor) {
  return actor.user.display_name;
}

// 書き込むユーザーID: 自分のID
function writerId(actor) {
  return actor.user.id;
}

module.exports = {
  isGlobalManager,
  regionResolverFor,
  canManageBranch,
  canActOnRow,
  canManageSharedOptions,
  writerName,
  writerId,
};
