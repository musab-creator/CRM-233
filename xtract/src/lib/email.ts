import nodemailer from "nodemailer";
import { BRAND, PRODUCTS, appUrl } from "./config";
import type { Order } from "./types";

function smtp() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
  });
}

export function reportLink(o: Order) {
  return `${appUrl()}/api/reports/${o.id}?t=${o.token}`;
}

export function statusLink(o: Order) {
  return `${appUrl()}/order/${o.id}?t=${o.token}`;
}

/** Email the finished report. Returns "demo" when SMTP isn't configured. */
export async function deliverReport(o: Order, pdf: Uint8Array): Promise<"email" | "demo"> {
  const product = PRODUCTS[o.tier];
  const s = o.summary!;
  const subject = `Your ${product.name} is ready — ${o.location?.formattedAddress ?? o.address}`;
  const text = [
    `Hi ${o.customer.name.split(" ")[0]},`,
    "",
    `Your ${BRAND.full} ${product.name} for ${o.location?.formattedAddress ?? o.address} is attached.`,
    "",
    `  Roof area:          ${s.totalAreaSqFt.toLocaleString()} sq ft (${s.squares} SQ)`,
    `  Predominant pitch:  ${s.predominantPitch}/12`,
    `  Facets:             ${s.facetCount}`,
    `  Suggested waste:    ${s.suggestedWastePct}%`,
    "",
    `Download any time: ${reportLink(o)}`,
    `Order status:      ${statusLink(o)}`,
    "",
    `Order ${o.id}. Questions? Reply to this email or call ${BRAND.phone}.`,
    "",
    `— ${BRAND.full}`,
  ].join("\n");

  if (!process.env.SMTP_HOST) {
    console.info(`[xtract] SMTP not configured — would email ${o.customer.email}:\n${subject}\n${text}`);
    return "demo";
  }

  const transport = smtp();
  await transport.sendMail({
    from: `"${process.env.SMTP_FROM_NAME || BRAND.full}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
    to: o.customer.email,
    bcc: process.env.XTRACT_ORDERS_BCC || undefined,
    subject,
    text,
    attachments: [{ filename: `Xtract-${o.id}.pdf`, content: Buffer.from(pdf), contentType: "application/pdf" }],
  });
  return "email";
}

/** Tell the operator an order needs a human (bad address, no imagery…). */
export async function notifyOperator(o: Order, reason: string) {
  const to = process.env.XTRACT_OPS_EMAIL;
  if (!process.env.SMTP_HOST || !to) {
    console.warn(`[xtract] Order ${o.id} needs review: ${reason}`);
    return;
  }
  const transport = smtp();
  await transport.sendMail({
    from: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER,
    to,
    subject: `[Xtract] Order ${o.id} needs review`,
    text: `${reason}\n\nAddress: ${o.address}\nCustomer: ${o.customer.name} <${o.customer.email}>\nAdmin: ${appUrl()}/admin`,
  });
}
