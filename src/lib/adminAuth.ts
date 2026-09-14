import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

/** Temporary hardcoded admin (replace with real auth later). */
export const ADMIN_USERNAME = "admin";
/** Share this with the operator — do not commit to public docs. */
export const ADMIN_PASSWORD = "AwShelf#K7mN2pQx9";

const COOKIE = "aw_admin_session";
const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function signingSecret(): string {
  return (
    process.env.ADMIN_SESSION_SECRET ||
    process.env.CRON_SECRET ||
    `aw-admin:${ADMIN_PASSWORD}`
  );
}

function sign(payload: string): string {
  return createHmac("sha256", signingSecret()).update(payload).digest("hex");
}

export function mintAdminSession(): string {
  const exp = Date.now() + TTL_MS;
  const body = `${ADMIN_USERNAME}:${exp}`;
  return `${body}.${sign(body)}`;
}

export function verifyAdminSession(token: string | undefined | null): boolean {
  if (!token || !token.includes(".")) return false;
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  const expected = sign(body);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }
  const [user, expStr] = body.split(":");
  if (user !== ADMIN_USERNAME) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  return true;
}

export function checkAdminCredentials(
  username: string,
  password: string,
): boolean {
  const uOk = username === ADMIN_USERNAME;
  const pOk = password === ADMIN_PASSWORD;
  return uOk && pOk;
}

export async function requireAdminSession(): Promise<boolean> {
  const jar = await cookies();
  return verifyAdminSession(jar.get(COOKIE)?.value);
}

export { COOKIE as ADMIN_COOKIE_NAME, TTL_MS as ADMIN_COOKIE_TTL_MS };
