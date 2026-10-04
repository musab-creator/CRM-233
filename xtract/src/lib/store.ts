import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Message, Order, OrderEvent, OrderStatus, User } from "./types";

// File-backed store. Good for a single server (Replit, a VPS, `next start`).
// On Vercel only /tmp is writable and it is wiped between instances, so data
// there is demo-grade; for production point XTRACT_DATA_DIR at a mounted
// volume or swap this module for a database.
export const DATA_DIR =
  process.env.XTRACT_DATA_DIR || (process.env.VERCEL ? "/tmp/xtract" : path.join(process.cwd(), ".data"));
const DB_FILE = path.join(DATA_DIR, "db.json");
const LEGACY_ORDERS = path.join(DATA_DIR, "orders.json");
export const REPORTS_DIR = path.join(DATA_DIR, "reports");

interface Db {
  orders: Record<string, Order>;
  users: Record<string, User>;
  loginTokens: Record<string, { email: string; expires: number }>;
  messages: Message[];
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function readDb(): Promise<Db> {
  try {
    return { orders: {}, users: {}, loginTokens: {}, messages: [], ...JSON.parse(await fs.readFile(DB_FILE, "utf8")) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let orders: Record<string, Order> = {};
  try {
    orders = JSON.parse(await fs.readFile(LEGACY_ORDERS, "utf8"));
  } catch {
    /* fresh install */
  }
  return { orders, users: {}, loginTokens: {}, messages: [] };
}

async function writeDb(db: Db) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, DB_FILE);
}

function mutate<T>(fn: (db: Db) => T): Promise<T> {
  return serial(async () => {
    const db = await readDb();
    const out = fn(db);
    await writeDb(db);
    return out;
  });
}

export function newOrderId(): string {
  const d = new Date();
  const ymd = `${d.getFullYear() % 100}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `XR-${ymd}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

export function newToken(bytes = 18): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// --- Orders ---------------------------------------------------------------------

export async function createOrder(order: Order): Promise<Order> {
  return mutate((db) => {
    db.orders[order.id] = order;
    return order;
  });
}

export async function getOrder(id: string): Promise<Order | null> {
  return (await readDb()).orders[id] ?? null;
}

export async function listOrders(filter?: (o: Order) => boolean): Promise<Order[]> {
  const all = Object.values((await readDb()).orders);
  return (filter ? all.filter(filter) : all).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Paid/queued reports this calendar month for an email (drives volume pricing). */
export async function monthlyCount(email: string, now = new Date()): Promise<number> {
  const month = now.toISOString().slice(0, 7);
  const e = email.toLowerCase();
  return (await listOrders((o) => o.kind === "auto" && o.customer.email === e && o.status !== "awaiting_payment" && o.createdAt.startsWith(month))).length;
}

/** Read-modify-write under the store lock. Return null from fn to abort. */
export async function updateOrder(id: string, fn: (o: Order) => Order | null): Promise<Order | null> {
  return serial(async () => {
    const db = await readDb();
    const current = db.orders[id];
    if (!current) return null;
    const next = fn(structuredClone(current));
    if (!next) return null;
    next.updatedAt = new Date().toISOString();
    db.orders[id] = next;
    await writeDb(db);
    return next;
  });
}

export async function deleteOrder(id: string): Promise<Order | null> {
  const removed = await mutate((db) => {
    const o = db.orders[id] ?? null;
    delete db.orders[id];
    return o;
  });
  if (removed?.files) {
    for (const f of Object.values(removed.files)) {
      if (typeof f === "string" && f.includes(".")) await fs.rm(path.join(REPORTS_DIR, path.basename(f)), { force: true });
    }
  }
  return removed;
}

export function withEvent(o: Order, status: OrderStatus, message: string): Order {
  const ev: OrderEvent = { at: new Date().toISOString(), status, message };
  o.status = status;
  o.events.push(ev);
  return o;
}

// --- Report files ---------------------------------------------------------------

export async function saveFile(name: string, bytes: Uint8Array | string): Promise<string> {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const file = path.basename(name);
  await fs.writeFile(path.join(REPORTS_DIR, file), bytes);
  return file;
}

export async function readFile(file: string): Promise<Buffer> {
  return fs.readFile(path.join(REPORTS_DIR, path.basename(file)));
}

// --- Users & sign-in --------------------------------------------------------------

export async function userByEmail(email: string): Promise<User | null> {
  const e = email.toLowerCase();
  return Object.values((await readDb()).users).find((u) => u.email === e) ?? null;
}

export async function getUser(id: string): Promise<User | null> {
  return (await readDb()).users[id] ?? null;
}

export async function upsertUser(email: string, patch: Partial<Pick<User, "company" | "phone">> = {}): Promise<User> {
  const e = email.toLowerCase();
  return mutate((db) => {
    let u = Object.values(db.users).find((x) => x.email === e);
    if (!u) {
      u = { id: crypto.randomUUID(), email: e, createdAt: new Date().toISOString() };
      db.users[u.id] = u;
    }
    Object.assign(u, patch);
    return u;
  });
}

/** One-time sign-in token; only its hash is stored. Valid 20 minutes. */
export async function createLoginToken(email: string): Promise<string> {
  const token = newToken(24);
  await mutate((db) => {
    const now = Date.now();
    for (const [k, v] of Object.entries(db.loginTokens)) if (v.expires < now) delete db.loginTokens[k];
    db.loginTokens[sha256(token)] = { email: email.toLowerCase(), expires: now + 20 * 60_000 };
  });
  return token;
}

export async function consumeLoginToken(token: string): Promise<string | null> {
  return mutate((db) => {
    const key = sha256(token);
    const rec = db.loginTokens[key];
    delete db.loginTokens[key];
    return rec && rec.expires > Date.now() ? rec.email : null;
  });
}

// --- Messages ---------------------------------------------------------------------

export async function addMessage(m: Message) {
  await mutate((db) => {
    db.messages.unshift(m);
    db.messages = db.messages.slice(0, 2000);
  });
}

export async function listMessages(userId?: string): Promise<Message[]> {
  const all = (await readDb()).messages;
  return userId ? all.filter((m) => m.userId === userId) : all;
}
