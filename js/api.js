// api/*.js への薄いラッパー。bodyを渡さなければGETとして送る。
async function request(path, method, body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
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
  getBranchOptions: (branch, type) =>
    request(`/api/branch-options?branch=${encodeURIComponent(branch)}&type=${encodeURIComponent(type)}`, 'GET'),
  addBranchOption: (payload) => request('/api/branch-options', 'POST', payload),
  deleteBranchOption: (payload) => request('/api/branch-options', 'DELETE', payload),
};

// CSV出力専用。request()はJSONパース前提のため使わず、blobとしてダウンロードする。
export async function downloadCsv(params) {
  const res = await fetch('/api/export-csv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
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
