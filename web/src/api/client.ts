import createClient, { type Middleware } from "openapi-fetch"
import md5 from "blueimp-md5"

import type { paths } from "./schema"

const TOKEN_KEY = "ckman.token"

// Every ckman response is HTTP 200 with this envelope; retCode "0000" is success.
export type Envelope<T> = {
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

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // storage unavailable: the session just won't survive a reload
  }
}

const auth: Middleware = {
  onRequest({ request }) {
    const token = getToken()
    if (token) request.headers.set("token", token)
    // ckman picks the message language from Accept-Language ("zh" → Chinese)
    request.headers.set("Accept-Language", "en")
    return request
  },
}

export const api = createClient<paths>({ baseUrl: "/" })
api.use(auth)

// Unwrap the ckman envelope; throws CkmanError on a non-"0000" retCode.
export async function unwrap<T>(
  call: Promise<{ data?: unknown; error?: unknown; response: Response }>
): Promise<T> {
  const { data, response } = await call
  if (!response.ok) {
    throw new CkmanError(String(response.status), response.statusText)
  }
  const body = data as Envelope<T>
  if (body.retCode !== "0000") {
    if (AUTH_CODES.has(body.retCode)) setToken(null)
    throw new CkmanError(body.retCode, body.retMsg)
  }
  return body.entity
}

export type LoginResult = {
  username: string
  token: string
  policy: string
  enabled: boolean
}

// ckman stores bcrypt(md5(password)), so the client sends the MD5 hex.
export async function login(username: string, password: string) {
  const res = await unwrap<LoginResult>(
    api.POST("/api/login", { body: { username, password: md5(password) } })
  )
  setToken(res.token)
  return res
}

export async function logout() {
  try {
    await unwrap(api.PUT("/api/logout"))
  } finally {
    setToken(null)
  }
}
