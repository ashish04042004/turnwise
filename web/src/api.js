export class ApiError extends Error {
  constructor(status, error) {
    super(error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = error?.code;
    this.details = error?.details;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'x-actor': 'reception' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error);
  return data;
}

export const post = (path, body = {}) => api(path, { method: 'POST', body });
