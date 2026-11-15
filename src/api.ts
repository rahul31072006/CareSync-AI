function resolveApiUrl() {
  const configured = import.meta.env.VITE_API_URL?.trim()
  if (configured) {
    if (import.meta.env.PROD && /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(configured)) {
      throw new Error('Production VITE_API_URL must point to the deployed HTTPS API.')
    }
    return configured.replace(/\/$/, '')
  }
  if (import.meta.env.DEV) return 'http://localhost:8000'
  throw new Error('Set VITE_API_URL to the deployed CareSync API URL before building for production.')
}
export const API_URL = resolveApiUrl()

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

let token = localStorage.getItem('caresync.token')
export function setToken(value: string | null) {
  token = value
  if (value) localStorage.setItem('caresync.token', value)
  else localStorage.removeItem('caresync.token')
}
export function getToken() { return token }

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(`${API_URL}${path}`, { ...init, headers })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const detail = body?.detail
    if (response.status === 401) setToken(null)
    throw new ApiError(typeof detail === 'string' ? detail : `Request failed (${response.status})`, response.status)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function requestBlob(path: string): Promise<string> {
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${API_URL}${path}`, { headers })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    if (response.status === 401) setToken(null)
    throw new ApiError(typeof body?.detail === 'string' ? body.detail : `Request failed (${response.status})`, response.status)
  }
  return URL.createObjectURL(await response.blob())
}

export function jsonBody(value: unknown): string { return JSON.stringify(value) }
