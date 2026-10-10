export class ApiError extends Error {
  constructor(status, error) {
    super(error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = error?.code;
    this.details = error?.details;
  }
}

/** Fired when the session has expired or been revoked, so the app can show sign-in again. */
export const SIGNED_OUT = 'turnwise:signed-out';

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event(SIGNED_OUT));
    throw new ApiError(res.status, data?.error);
  }
  return data;
}

export const post = (path, body = {}) => api(path, { method: 'POST', body });
