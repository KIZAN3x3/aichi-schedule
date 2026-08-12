// banner-maker-v2と同じパスワード体系: 123=一般ユーザー, 123123=マスター管理者
const PASSWORD_ROLES = {
  '123': 'user',
  '123123': 'admin',
};

function resolveRole(password) {
  return PASSWORD_ROLES[password] || null;
}

module.exports = { resolveRole };
