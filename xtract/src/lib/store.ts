import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Order, OrderEvent, OrderStatus } from "./types";

// File-backed order store. Good for a single server (Replit, a VPS, `next
// start`). On serverless hosts with an ephemeral disk, point XTRACT_DATA_DIR
// at a mounted volume or swap this module for a database.
const DATA_DIR = process.env.XTRACT_DATA_DIR || path.join(process.cwd(), ".data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
export const REPORTS_DIR = path.join(DATA_DIR, "reports");

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function readAll(): Promise<Record<string, Order>> {
  try {
    return JSON.parse(await fs.readFile(ORDERS_FILE, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

async function writeAll(orders: Record<string, Order>) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${ORDERS_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(orders, null, 2));
  await fs.rename(tmp, ORDERS_FILE);
}

export function newOrderId(): string {
  const d = new Date();
  const ymd = `${d.getFullYear() % 100}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `XR-${ymd}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

export function newToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export function safeEqual(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function createOrder(order: Order): Promise<Order> {
  return serial(async () => {
    const all = await readAll();
    all[order.id] = order;
    await writeAll(all);
    return order;
  });
}

export async function getOrder(id: string): Promise<Order | null> {
  const all = await readAll();
  return all[id] ?? null;
}

export async function listOrders(): Promise<Order[]> {
  const all = await readAll();
  return Object.values(all).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Read-modify-write under the store lock. Return null from fn to abort. */
export async function updateOrder(id: string, fn: (o: Order) => Order | null): Promise<Order | null> {
  return serial(async () => {
    const all = await readAll();
    const current = all[id];
    if (!current) return null;
    const next = fn(structuredClone(current));
    if (!next) return null;
    next.updatedAt = new Date().toISOString();
    all[id] = next;
    await writeAll(all);
    return next;
  });
}

export function withEvent(o: Order, status: OrderStatus, message: string): Order {
  const ev: OrderEvent = { at: new Date().toISOString(), status, message };
  o.status = status;
  o.events.push(ev);
  return o;
}

export async function saveReport(id: string, bytes: Uint8Array): Promise<string> {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const file = `${id}.pdf`;
  await fs.writeFile(path.join(REPORTS_DIR, file), bytes);
  return file;
}

export async function readReport(file: string): Promise<Buffer> {
  return fs.readFile(path.join(REPORTS_DIR, path.basename(file)));
}
