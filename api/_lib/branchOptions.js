const TABLES = {
  place: 'branch_place_options',
  category: 'branch_category_options',
};

// 支部ごとの入力候補を追加する。既に同じ(branch, value)があれば何もしない（エラーにしない）。
async function addBranchOption(supabase, { branch, type, value }) {
  const table = TABLES[type];
  if (!table || !value) return;

  const { error } = await supabase
    .from(table)
    .upsert({ branch, value }, { onConflict: 'branch,value', ignoreDuplicates: true });
  if (error) {
    console.error(`${table} upsert failed:`, error.message);
  }
}

module.exports = { TABLES, addBranchOption };
