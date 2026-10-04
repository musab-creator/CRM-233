import nodemailer from "nodemailer";
import { BRAND, appUrl } from "./config";
import type { Message, Order } from "./types";

function smtp() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
  });
}

const from = () => `"${process.env.SMTP_FROM_NAME || BRAND.full}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`;

export function reportLink(o: Order) {
  return `${appUrl()}/api/reports/${o.id}?t=${o.token}`;
}

export function statusLink(o: Order) {
  return `${appUrl()}/order/${o.id}?t=${o.token}`;
}

/** Email the finished report. Returns "demo" when SMTP isn't configured. */
export async function deliverReport(o: Order, pdf: Uint8Array): Promise<"email" | "demo"> {
  const s = o.summary!;
  const address = o.location?.formattedAddress ?? o.address;
  const subject = `Roof report ready — ${address}`;
  const text = [
    `Hi ${o.customer.name.split(" ")[0]},`,
    "",
    `Your Xtract roof report for ${address} is attached (8 pages).`,
    "",
    `  Roof area:          ${s.totalAreaSqFt.toLocaleString()} sq ft`,
    `  Squares (${s.suggestedWastePct}% waste): ${s.squares}`,
    `  Predominant pitch:  ${s.predominantPitch}/12`,
    `  Facets:             ${s.facetCount}`,
    "",
    `Download any time: ${reportLink(o)}`,
    `3D model & details: ${statusLink(o)}`,
    "",
    `Order ${o.id}. Questions? Reply to this email or call ${BRAND.phone}.`,
    "",
    `— ${BRAND.full}`,
  ].join("\n");

  if (!process.env.SMTP_HOST) {
    console.info(`[xtract] SMTP not configured — would email ${o.customer.email}: ${subject}`);
    return "demo";
  }
  await smtp().sendMail({
    from: from(),
    to: o.customer.email,
    bcc: process.env.XTRACT_ORDERS_BCC || undefined,
    subject,
    text,
    attachments: [{ filename: `Roof Report - ${address.replace(/[^\w ,.-]/g, "")}.pdf`, content: Buffer.from(pdf), contentType: "application/pdf" }],
  });
  return "email";
}

/** Sign-in link. Returns false when email isn't configured (caller may show it in demo mode). */
export async function sendSignInLink(email: string, link: string): Promise<boolean> {
  if (!process.env.SMTP_HOST) return false;
  await smtp().sendMail({
    from: from(),
    to: email,
    subject: "Your Xtract sign-in link",
    text: `Sign in to Xtract Roof Reports:\n\n${link}\n\nThis link works once and expires in 20 minutes. If you didn't ask for it, ignore this email.`,
  });
  return true;
}

/** Tell the operator an order needs a human (bad address, no imagery…). */
export async function notifyOperator(o: Order, reason: string) {
  const to = process.env.XTRACT_OPS_EMAIL;
  if (!process.env.SMTP_HOST || !to) {
    console.warn(`[xtract] Order ${o.id} needs review: ${reason}`);
    return;
  }
  await smtp().sendMail({
    from: from(),
    to,
    subject: `[Xtract] Order ${o.id} needs review`,
    text: `${reason}\n\nAddress: ${o.address}\nCustomer: ${o.customer.name} <${o.customer.email}>\nAdmin: ${appUrl()}/admin`,
  });
}

/** Forward a support message to the operator inbox. */
export async function forwardMessage(m: Message): Promise<boolean> {
  const to = process.env.XTRACT_OPS_EMAIL;
  if (!process.env.SMTP_HOST || !to) return false;
  await smtp().sendMail({ from: from(), to, replyTo: m.email, subject: `[Xtract] Message from ${m.name}`, text: `${m.message}\n\n— ${m.name} <${m.email}>` });
  return true;
}
