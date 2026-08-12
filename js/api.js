// api/*.js（書き込み専用エンドポイント）への薄いラッパー
async function request(path, method, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

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
};
