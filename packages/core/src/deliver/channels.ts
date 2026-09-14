// packages/core/src/deliver/channels.ts
// Digest delivery channels — email and Slack.
//
// A channel adapter CARRIES NO BUSINESS LOGIC. What the digest says is decided
// by `compose.ts`; the code here only changes the shape. The test: adding Teams
// or Telegram must require NO business logic to be copied.
//
// No dependencies: Slack is an HTTP POST, and email is either the provider's
// HTTP API (Resend/Postmark) or raw SMTP. Pulling in something like Nodemailer
// would break `gate:no-deps` and weaken the one-command-install promise.

import type { Digest, DigestLine } from "../insight/compose.ts";

export interface DeliveryTarget {
  kind: "slack" | "email" | "webhook";
  /** Slack: webhook URL · email: recipient address · webhook: URL */
  to: string;
}

export interface DeliveryResult {
  ok: boolean;
  /** Why it failed — NOT written to the ledger, so it will be retried. */
  error?: string;
  /** Size of the body that was sent (for debugging; the content is not stored). */
  bytes?: number;
}

/** Line kind → the heading shown in Slack/email. */
const KIND_LABEL: Record<DigestLine["kind"], string> = {
  headline: "Summary",
  change: "Change",
  peak: "Peak",
  ai: "AI traffic",
  funnel: "Funnel",
  quality: "Quality",
  action: "What to do",
};

/** The link that takes evidence ids to the dashboard. */
function evidenceUrl(baseUrl: string, siteId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/app?site=${encodeURIComponent(siteId)}`;
}

// ——————————————————————————————————————————— Slack

export function slackBlocks(digest: Digest, baseUrl: string): unknown {
  const url = evidenceUrl(baseUrl, digest.siteId);
  const grouped = new Map<DigestLine["kind"], DigestLine[]>();
  for (const line of digest.lines) {
    const list = grouped.get(line.kind) ?? [];
    list.push(line);
    grouped.set(line.kind, list);
  }

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Vitrus — ${digest.window.label}`, emoji: false },
    },
  ];

  for (const [kind, lines] of grouped) {
    if (kind === "headline") continue;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${KIND_LABEL[kind]}*\n${lines.map((l) => `• ${l.text}`).join("\n")}`,
      },
    });
  }

  const headline = digest.lines.find((l) => l.kind === "headline");
  if (headline) {
    blocks.splice(1, 0, { type: "section", text: { type: "mrkdwn", text: headline.text } });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: digest.degraded
          ? `⚠ Some sentences were removed because they could not be verified against the evidence. <${url}|See the evidence>`
          : `To see the query behind every number: <${url}|open the dashboard>`,
      },
    ],
  });

  return { blocks };
}

export async function sendSlack(
  webhookUrl: string,
  digest: Digest,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<DeliveryResult> {
  const body = JSON.stringify(slackBlocks(digest, baseUrl));
  try {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) return { ok: false, error: `slack_${res.status}` };
    return { ok: true, bytes: body.length };
  } catch (e) {
    return { ok: false, error: `slack_network: ${(e as Error).message}` };
  }
}

// ——————————————————————————————————————————— Email

export function emailSubject(digest: Digest): string {
  const headline = digest.lines.find((l) => l.kind === "headline");
  // The subject line carries a CLAIM, so it too is text that came from the evidence set.
  const first = headline?.text.split(".")[0] ?? digest.window.label;
  return `Vitrus · ${first}`.slice(0, 140);
}

export function emailHtml(digest: Digest, baseUrl: string): string {
  const url = evidenceUrl(baseUrl, digest.siteId);
  const rows = digest.lines
    .map(
      (l) =>
        `<tr><td style="padding:9px 0;border-bottom:1px solid #e6e9ec;vertical-align:top">
           <div style="font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:#8d99a7;margin-bottom:3px">${esc(
             KIND_LABEL[l.kind]
           )}</div>
           <div style="font-size:14.5px;color:#1b2026;line-height:1.55">${esc(l.text)}</div>
         </td></tr>`
    )
    .join("");

  return `<!doctype html>
<html><body style="margin:0;background:#f7f8fa;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8fa;padding:28px 12px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #e2e6ea;border-radius:14px;padding:26px">
      <tr><td style="font-size:17px;font-weight:650;color:#1b2026;padding-bottom:3px">vitrus<span style="color:#3aa88f">.</span></td></tr>
      <tr><td style="font-size:13px;color:#5d6b7a;padding-bottom:18px">${esc(digest.window.label)}</td></tr>
      <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
      <tr><td style="padding-top:22px">
        <a href="${esc(url)}" style="display:inline-block;background:#3aa88f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:9px;font-size:14px;font-weight:550">See the evidence</a>
      </td></tr>
      <tr><td style="padding-top:18px;font-size:12px;color:#8d99a7;line-height:1.6">
        ${
          digest.degraded
            ? "Some sentences were removed because they could not be verified against the evidence.<br>"
            : "Every number here is backed by a query you can click in the dashboard.<br>"
        }
        If you no longer want this summary, you can turn it off in the dashboard.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export interface EmailSender {
  readonly name: string;
  send(to: string, subject: string, html: string, text: string): Promise<DeliveryResult>;
}

/**
 * An HTTP-based provider such as Resend or Postmark.
 * HTTP rather than SMTP: writing an SMTP client would mean either a dependency
 * or 300 lines of protocol code, and most hosted installs already use an HTTP API.
 */
export class HttpEmailSender implements EmailSender {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly endpoint = "https://api.resend.com/emails",
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.name = `http-email:${new URL(endpoint).hostname}`;
  }

  async send(to: string, subject: string, html: string, text: string): Promise<DeliveryResult> {
    try {
      const body = JSON.stringify({ from: this.from, to: [to], subject, html, text });
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body,
      });
      if (!res.ok) return { ok: false, error: `email_${res.status}` };
      return { ok: true, bytes: body.length };
    } catch (e) {
      return { ok: false, error: `email_network: ${(e as Error).message}` };
    }
  }
}

/** When no provider is configured: nothing is sent, and that is said EXPLICITLY. */
export class NullEmailSender implements EmailSender {
  readonly name = "none";
  async send(): Promise<DeliveryResult> {
    return { ok: false, error: "email_not_configured" };
  }
}
