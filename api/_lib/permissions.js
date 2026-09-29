const { loadRegionOf } = require('./user-auth');

// データ（予定・参加・日程調整・回答・備品・入力候補）の権限判定。方針は CLAUDE.md の「権限の方針」。
//   ・データを管理できる管理者: システム管理者（全支部）、県連管理者（自分の県連内の支部だけ）、
//     共通パスワードの管理者（並行期間中は今までどおり全支部）。支部管理者は、データについては一般と同じ
//   ・本人判定:
//       ユーザーIDが入っている行 … そのユーザー本人、またはその支部を管理できる管理者だけ
//       ユーザーIDが空欄の行（移行前・共通パスワードで作られた行）… その支部を管理できる管理者、
//         または共通パスワードの一般の人で名前が一致する場合（並行期間中だけ）。Googleの一般の人は不可

// 全支部のデータを管理できるか（共通パスワードの管理者・システム管理者）
function isGlobalManager(actor) {
  return actor.role === 'admin';
}

// 県連管理者のときだけ、支部→県連の対応表（branch_regions）を読む。それ以外は読まずに null を返す
async function regionResolverFor(actor) {
  if (actor.via === 'google' && actor.kind === 'region') return loadRegionOf();
  return null;
}

// その支部のデータを管理できる管理者か
function canManageBranch(actor, branch, regionOf) {
  if (isGlobalManager(actor)) return true;
  if (actor.via === 'google' && actor.kind === 'region' && regionOf && branch) {
    const myRegion = regionOf(actor.user.branch);
    return Boolean(myRegion) && regionOf(branch) === myRegion;
  }
  return false;
}

// 行に対して本人（または管理者）として操作できるか
//   row.branch  : その行の支部（参加・回答は親の予定・日程調整の支部、備品は所有支部）
//   row.userIds : その行の本人のユーザーID（例: 予定は poster_user_id、参加は participant_user_id と registered_by_user_id）
//   row.names   : その行の本人の名前（ユーザーIDが空欄の行を、共通パスワードの一般の人が操作するときだけ使う）
//   requestName : 共通パスワードの人がリクエストで名乗った名前
function canActOnRow(actor, row, regionOf, requestName) {
  if (canManageBranch(actor, row.branch, regionOf)) return true;
  const ids = (row.userIds || []).filter(Boolean);
  if (ids.length > 0) {
    return actor.via === 'google' && ids.includes(actor.user.id);
  }
  if (actor.via === 'password') {
    const name = typeof requestName === 'string' ? requestName.trim() : '';
    return Boolean(name) && (row.names || []).filter(Boolean).includes(name);
  }
  return false;
}

// 書き込む名前: Googleの人は、送られた値ではなく app_users.display_name を使う（共通パスワードの人は今までどおり送られた値）
function writerName(actor, requestedName) {
  return actor.via === 'google' ? actor.user.display_name : requestedName;
}

// 書き込むユーザーID: Googleの人は自分のID、共通パスワードの人は空欄
function writerId(actor) {
  return actor.via === 'google' ? actor.user.id : null;
}

// 権限が無いときの文言。Googleの人には理由が分かる文言、共通パスワードの人には今までどおりの文言
function forbiddenMessage(actor, legacyMessage, googleMessage) {
  return actor.via === 'google' ? googleMessage : legacyMessage;
}

module.exports = {
  isGlobalManager,
  regionResolverFor,
  canManageBranch,
  canActOnRow,
  writerName,
  writerId,
  forbiddenMessage,
};
