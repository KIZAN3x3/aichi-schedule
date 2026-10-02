import { getAuthHeaders, redirectToLogin } from './auth.js';

// api/*.js への薄いラッパー。bodyを渡さなければGETとして送る。
// 呼ぶたびに最新のアクセストークンを Authorization: Bearer で付ける。
// 401（ログインしていない・トークンが無効）なら、ログイン画面に戻す（redirectToLogin）
async function request(path, method, body) {
  const options = { method, headers: await getAuthHeaders() };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    if (res.status === 401) redirectToLogin();
    throw new Error((data && data.error) || `エラーが発生しました (${res.status})`);
  }
  return data;
}

export const api = {
  createEvent: (payload) => request('/api/events', 'POST', payload),
  updateEvent: (id, payload) => request(`/api/events/${id}`, 'PUT', payload),
  deleteEvent: (id, payload) => request(`/api/events/${id}`, 'DELETE', payload),
  joinEvent: (payload) => request('/api/participants', 'POST', payload),
  leaveEvent: (payload) => request('/api/participants', 'DELETE', payload),
  createEquipment: (payload) => request('/api/equipment', 'POST', payload),
  updateEquipment: (id, payload) => request(`/api/equipment/${id}`, 'PUT', payload),
  deleteEquipment: (id, payload) => request(`/api/equipment/${id}`, 'DELETE', payload),
  getEquipmentUploadUrl: (payload) => request('/api/equipment/upload-url', 'POST', payload),
  // 備品の画像の期限付きURL（1時間）をまとめて作る（段階5 ③）。paths: ['items/<uuid>.<拡張子>', ...]（最大100件）
  getEquipmentImageUrls: (paths) => request('/api/equipment?action=image_urls', 'POST', { paths }),
  getBranchOptions: (branch, type) =>
    request(`/api/branch-options?branch=${encodeURIComponent(branch)}&type=${encodeURIComponent(type)}`, 'GET'),
  addBranchOption: (payload) => request('/api/branch-options', 'POST', payload),
  // 備品の品名・種類の候補（全支部共通）。type: 'item_name' | 'item_kind'
  getEquipmentOptions: (type) => request(`/api/branch-options?type=${encodeURIComponent(type)}`, 'GET'),
  deleteBranchOption: (payload) => request('/api/branch-options', 'DELETE', payload),
};

// CSV出力専用。request()はJSONパース前提のため使わず、blobとしてダウンロードする。
export async function downloadCsv(params) {
  const res = await fetch('/api/export-csv', {
    method: 'POST',
    headers: { ...(await getAuthHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    if (res.status === 401) redirectToLogin();
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json().catch(() => null) : null;
    throw new Error((data && data.error) || `エラーが発生しました (${res.status})`);
  }

  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/) || disposition.match(/filename="([^"]+)"/);
  const filename = match ? decodeURIComponent(match[1]) : 'export.csv';

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // click直後の同期revokeはブラウザによってダウンロードが中断されることがあるため遅延させる
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
