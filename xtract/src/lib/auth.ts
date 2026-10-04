import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { cookies } from "next/headers";
import { DATA_DIR, getUser } from "./store";
import type { User } from "./types";

// Passwordless accounts: a one-time link is emailed, and clicking it sets a
// signed, httpOnly session cookie (user id + expiry + HMAC).

export const SESSION_COOKIE = "xtract_session";
const SESSION_DAYS = 30;

let cachedSecret: string | null = null;

async function secret(): Promise<string> {
  if (process.env.XTRACT_SECRET) return process.env.XTRACT_SECRET;
  if (cachedSecret) return cachedSecret;
  // Dev fallback: a random secret persisted next to the data.
  const file = path.join(DATA_DIR, "session-secret");
  try {
    cachedSecret = (await fs.readFile(file, "utf8")).trim();
  } catch {
    cachedSecret = crypto.randomBytes(32).toString("hex");
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(file, cachedSecret, { mode: 0o600 });
  }
  return cachedSecret;
}

const hmac = (key: string, data: string) => crypto.createHmac("sha256", key).update(data).digest("base64url");

export async function signSession(userId: string): Promise<{ value: string; maxAge: number }> {
  const maxAge = SESSION_DAYS * 86400;
  const body = `${userId}.${Math.floor(Date.now() / 1000) + maxAge}`;
  return { value: `${body}.${hmac(await secret(), body)}`, maxAge };
}

export async function verifySession(value: string | undefined): Promise<string | null> {
  if (!value) return null;
  const i = value.lastIndexOf(".");
  if (i < 0) return null;
  const body = value.slice(0, i);
  const sig = value.slice(i + 1);
  const expected = hmac(await secret(), body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [userId, exp] = body.split(".");
  return Number(exp) > Date.now() / 1000 ? userId : null;
}

export async function currentUser(): Promise<User | null> {
  const id = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  return id ? getUser(id) : null;
}

export const sessionCookieOptions = (maxAge: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge,
});

/** Reject cross-site writes (CSRF) — browsers always send Origin on POST. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host);
  } catch {
    return false;
  }
}
