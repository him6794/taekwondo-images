export const COOKIE = "tt_admin";
export const SESSION_HOURS = 8;
const MIN_PASSWORD_LENGTH = 12;
const MIN_SECRET_LENGTH = 32;

const enc = new TextEncoder();

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(s) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function configError(env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return "尚未設定 ADMIN_PASSWORD 與 SESSION_SECRET，請見 README 的設定步驟";
  }
  if (env.ADMIN_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    return `ADMIN_PASSWORD 至少需要 ${MIN_PASSWORD_LENGTH} 個字元`;
  }
  if (env.SESSION_SECRET.length < MIN_SECRET_LENGTH) {
    return `SESSION_SECRET 至少需要 ${MIN_SECRET_LENGTH} 個字元`;
  }
  return null;
}

export async function checkPassword(env, input) {
  return safeEqual(await sha256Hex(String(input ?? "")), await sha256Hex(env.ADMIN_PASSWORD));
}

export async function makeSession(env, now = Date.now()) {
  const exp = now + SESSION_HOURS * 3600 * 1000;
  return `${exp}.${await hmacHex(env.SESSION_SECRET, `admin:${exp}`)}`;
}

const TOKEN_PATTERN = /^([1-9][0-9]{12})\.([0-9a-f]{64})$/;

export function parseSession(token) {
  const m = TOKEN_PATTERN.exec(String(token ?? ""));
  return m ? { exp: Number(m[1]), sig: m[2] } : null;
}

export async function verifySession(env, token, now = Date.now()) {
  if (!env.SESSION_SECRET) return null;
  const session = parseSession(token);
  if (!session || session.exp <= now) return null;
  const expected = await hmacHex(env.SESSION_SECRET, `admin:${session.exp}`);
  return safeEqual(expected, session.sig) ? session : null;
}

export function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/admin; Max-Age=${SESSION_HOURS * 3600}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearedCookie() {
  return `${COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
