import { currentUser } from "./auth";
import { getOrder, safeEqual } from "./store";
import type { Order, User } from "./types";

/** An order is visible with its secret link token, or to the signed-in owner. */
export async function accessOrder(id: string, token: string | null): Promise<{ order: Order; user: User | null; owner: boolean } | null> {
  const order = await getOrder(id);
  if (!order) return null;
  const user = await currentUser();
  const owner = Boolean(user && user.email === order.customer.email);
  if (owner || safeEqual(token, order.token)) return { order, user, owner };
  return null;
}

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
