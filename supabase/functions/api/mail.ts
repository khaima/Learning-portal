/* ============================================================
   Email the portal sends itself — today, staff invitations.

   Password reset emails are sent by Supabase Auth (its own mail settings,
   docs/AUTH.md). An invitation isn't a Supabase Auth email — it carries
   the portal's own one-time invitation link — so this sends it through the
   same mail provider's HTTPS API (Edge Functions can't use the usual SMTP
   ports, and an HTTPS API is the more reliable path anyway).

   Edge Function secrets (set by scripts/configure-auth.mjs):
     MAIL_PROVIDER   resend | brevo
     MAIL_API_KEY    the provider's API key (Resend: the same key as its SMTP
                     password; Brevo: an API key, not the SMTP key)
     MAIL_FROM       sender address on the provider's verified domain
     MAIL_FROM_NAME  optional, default "HPF Digital Learning Portal"

   Nothing secret is ever returned or logged — only the provider's reason
   when it refuses.
   ============================================================ */

export type MailMessage = { to: string; subject: string; html: string; text: string; replyTo?: string | null };
export type MailResult = { ok: true; id: string | null } | { ok: false; error: string };
type Settings = { provider: "resend" | "brevo"; key: string; from: string; fromName: string };

const get = (k: string) => (Deno.env.get(k) ?? "").trim();

/** The configured provider, or null when invitation email isn't set up. */
export function mailSettings(): Settings | null {
  const provider = get("MAIL_PROVIDER").toLowerCase();
  const key = get("MAIL_API_KEY");
  const from = get("MAIL_FROM");
  if ((provider !== "resend" && provider !== "brevo") || !key || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) return null;
  return { provider, key, from, fromName: get("MAIL_FROM_NAME") || "HPF Digital Learning Portal" };
}
export const mailReady = () => mailSettings() !== null;

/** What the provider said, short and safe to show an administrator. */
function reason(status: number, body: unknown): string {
  const b = body as Record<string, unknown> | null;
  const msg = String(b?.message ?? b?.error ?? b?.code ?? "").slice(0, 200);
  if (status === 401 || status === 403) return `the mail provider refused the API key${msg ? ` (${msg})` : ""}`;
  if (status === 429) return "the mail provider's sending limit was reached — try again in a minute";
  return msg || `the mail provider answered ${status}`;
}

export async function sendMail(msg: MailMessage, fetchImpl: typeof fetch = fetch): Promise<MailResult> {
  const s = mailSettings();
  if (!s) return { ok: false, error: "Email sending isn't set up for the portal yet" };
  let res: Response;
  try {
    if (s.provider === "resend") {
      res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${s.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${s.fromName} <${s.from}>`, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text,
          ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } else {
      res = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": s.key, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          sender: { name: s.fromName, email: s.from }, to: [{ email: msg.to }], subject: msg.subject,
          htmlContent: msg.html, textContent: msg.text,
          ...(msg.replyTo ? { replyTo: { email: msg.replyTo } } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    }
  } catch (err) {
    return { ok: false, error: `couldn't reach the mail provider (${(err as Error)?.name === "TimeoutError" ? "timed out" : "network error"})` };
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) return { ok: false, error: reason(res.status, body) };
  const b = body as Record<string, unknown> | null;
  return { ok: true, id: (b?.id ?? b?.messageId ?? null) as string | null };
}

/* ---- the invitation email ---- */

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function invitationEmail(o: {
  link: string; roleLabel: string; place: string | null; inviterName: string | null; expiresAt: string;
}): { subject: string; html: string; text: string } {
  const until = new Date(o.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Nairobi" });
  const who = o.inviterName ? `${o.inviterName} has` : "You've been";
  const what = `${o.roleLabel}${o.place ? ` — ${o.place}` : ""}`;
  const subject = "You're invited to the HPF Digital Learning Portal";
  const text = [
    `${who} invited you to join the HPF Digital Learning Portal as ${what}.`,
    "",
    "Accept the invitation and create your password here:",
    o.link,
    "",
    `The link works once and expires on ${until}. Use this email address when you sign up.`,
    "",
    "Didn't expect this? You can ignore it — nothing happens unless the link is used.",
    "",
    "Human Practice Foundation · HPF Digital Learning Portal",
  ].join("\n");
  // Inline styles and tables only, no images: reads the same in Gmail,
  // Outlook and phone mail apps, and arrives quickly on a slow connection.
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#FAF6EF;font-family:Arial,Helvetica,sans-serif;color:#14213D;">
  <div style="display:none;max-height:0;overflow:hidden;">${esc(who)} invited you to join as ${esc(o.roleLabel)}. The link works once.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF6EF;"><tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E4DACB;border-radius:14px;">
      <tr><td style="background:#1E4C8A;border-radius:14px 14px 0 0;padding:18px 24px;">
        <div style="font-size:18px;font-weight:bold;color:#FFFFFF;">HPF Digital Learning Portal</div>
        <div style="font-size:13px;color:#DCE6F3;margin-top:2px;">Human Practice Foundation</div>
      </td></tr>
      <tr><td style="padding:24px;">
        <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#14213D;">You're invited</h1>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#3D4C6B;">${esc(who)} invited you to join the HPF Digital Learning Portal as <strong style="color:#14213D;">${esc(what)}</strong>.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td style="background:#1E4C8A;border-radius:10px;">
          <a href="${esc(o.link)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:bold;color:#FFFFFF;text-decoration:none;">Accept the invitation</a>
        </td></tr></table>
        <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#3D4C6B;">You'll create your password when you accept. The link works once and expires on <strong>${esc(until)}</strong>. Sign up with this email address. If the button doesn't open, copy this address into your browser:</p>
        <p style="margin:0 0 20px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${esc(o.link)}" style="color:#1E4C8A;">${esc(o.link)}</a></p>
        <p style="margin:0;padding:12px 14px;background:#FBE7D4;border-radius:10px;font-size:13px;line-height:1.5;color:#7A4317;">Didn't expect this? You can ignore it — nothing happens unless the link is used.</p>
      </td></tr>
      <tr><td style="padding:14px 24px 20px;border-top:1px solid #E4DACB;font-size:12px;line-height:1.5;color:#6B7590;">Sent by the HPF Digital Learning Portal on behalf of a portal administrator.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { subject, html, text };
}
