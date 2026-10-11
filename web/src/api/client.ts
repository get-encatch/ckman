import md5 from "blueimp-md5"

const TOKEN_KEY = "ckman.token"
const USER_KEY = "ckman.user"

// Every ckman response is HTTP 200 with this envelope; retCode "0000" is success.
type Envelope<T> = {
  retCode: string
  retMsg: string
  entity: T
}

export class CkmanError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// Token expired / invalid / missing (model/code.go).
const AUTH_CODES = new Set(["5020", "5021", "5022"])

export type Session = {
  username: string
  policy: string
}

function storageGet(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // storage unavailable: the session just won't survive a reload
  }
}

export function getToken() {
  return storageGet(TOKEN_KEY)
}

export function getSession(): Session | null {
  const raw = storageGet(USER_KEY)
  if (!raw || !getToken()) return null
  try {
    return JSON.parse(raw) as Session
  } catch {
    return null
  }
}

function clearSession() {
  storageSet(TOKEN_KEY, null)
  storageSet(USER_KEY, null)
}

// Called when the backend rejects the token; set by the router setup.
let onUnauthorized: (() => void) | undefined
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler
}

type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  // multipart upload instead of JSON
  form?: FormData
  signal?: AbortSignal
  // keep integers beyond 2^53 (ClickHouse UInt64/Int64) as strings
  bigint?: boolean
}

// JSON.parse reviver that keeps unsafe integers as their exact source text.
// The `context.source` argument is available in current browsers; without it
// large integers fall back to (lossy) numbers.
function bigintReviver(
  _key: string,
  value: unknown,
  context?: { source?: string }
) {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value) &&
    context?.source
  ) {
    return context.source
  }
  return value
}

export async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  { query, body, form, signal, bigint }: RequestOptions = {}
): Promise<T> {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value))
    }
  }

  const headers: Record<string, string> = {
    // ckman picks the message language from Accept-Language ("zh" → Chinese)
    "Accept-Language": "en",
  }
  const token = getToken()
  if (token) headers.token = token
  if (body !== undefined) headers["Content-Type"] = "application/json"

  const response = await fetch(url, {
    method,
    headers,
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal,
  })
  if (!response.ok) {
    throw new CkmanError(String(response.status), response.statusText)
  }
  const text = await response.text()
  const envelope = (
    bigint ? JSON.parse(text, bigintReviver as never) : JSON.parse(text)
  ) as Envelope<T>
  if (envelope.retCode !== "0000") {
    if (AUTH_CODES.has(envelope.retCode)) {
      clearSession()
      onUnauthorized?.()
    }
    throw new CkmanError(envelope.retCode, envelope.retMsg)
  }
  return envelope.entity
}

export const api = {
  get: <T>(path: string, query?: RequestOptions["query"], bigint?: boolean) =>
    request<T>("GET", path, { query, bigint }),
  post: <T>(path: string, body?: unknown, query?: RequestOptions["query"]) =>
    request<T>("POST", path, { body, query }),
  put: <T>(path: string, body?: unknown, query?: RequestOptions["query"]) =>
    request<T>("PUT", path, { body, query }),
  delete: <T>(path: string, query?: RequestOptions["query"], body?: unknown) =>
    request<T>("DELETE", path, { query, body }),
}

type LoginResult = {
  username: string
  token: string
  policy: string
  enabled: boolean
}

// ckman stores bcrypt(md5(password)), so the client sends the MD5 hex.
export function hashPassword(password: string) {
  return md5(password)
}

export async function login(username: string, password: string) {
  const res = await api.post<LoginResult>("/api/login", {
    username,
    password: hashPassword(password),
  })
  storageSet(TOKEN_KEY, res.token)
  storageSet(
    USER_KEY,
    JSON.stringify({ username: res.username, policy: res.policy })
  )
  return res
}

export async function logout() {
  try {
    await api.put("/api/logout")
  } finally {
    clearSession()
  }
}

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}
