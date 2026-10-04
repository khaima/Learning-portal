# Sign-in, invitations and passwords — production setup

How people sign in to the HPF Digital Learning Portal, how staff are
invited, what an administrator can do when someone is locked out, and the
one-time setup (mail sender, branded emails, closed sign-ups) that makes it
production-ready. Supabase project: `fwpqytrdlmxymvegvgji`.

## How sign-in works

| Who | How | Accounts come from |
|---|---|---|
| Staff (all seven staff roles) | Email + password (Supabase Auth). Google only if it's switched on. | The `api` Edge Function: `POST /auth/register` (already confirmed), then an invitation or an administrator's approval decides the role. |
| Learners | Username + 4-digit PIN, checked by the `api` Edge Function | Their teacher |

- **Public sign-ups are off** in Supabase Auth. Nobody can create an
  account by calling Supabase Auth directly with the public key; accounts
  are only created by the `api` Edge Function, which uses the service-role
  key on the server. (The service-role key never reaches a browser.)
- **"Continue with Google"** is hidden unless Supabase Auth's public
  settings (`/auth/v1/settings`) say `external.google = true`. If those
  settings can't be read, it stays hidden — it's never shown and then
  fails. While sign-ups are off it's offered for signing in only, not on
  "Create an account".
- **Password boxes** show a hint ("Your password", "At least 8
  characters"), not dots that look like a password is already filled in.

## Inviting staff

Users & roles → **+ Invite staff**: email, role, and the school or county.
Every invitation is a one-time link — it creates their account with
exactly that role and placement, for that email address only, and expires
in 14 days. Two ways to get it to them:

- **Send invitation email** — the portal emails the link from your sender
  address, in an HPF-branded email ("You're invited…", the role and
  school, an **Accept the invitation** button and the plain link). Replies
  go to the administrator who sent it. The link is also shown once, so you
  can send it another way too.
- **Copy link instead** — copy it and send it yourself (WhatsApp, SMS,
  your own email).

If the email can't be sent (mail not set up yet, or the provider refuses),
the invitation is still made and its link is shown to copy, with the
reason. Until the mail secrets are set (step 4 below), only **Create link
to copy** is offered.

Only a hash of each link is kept, so a link can't be shown again later.
For an open invitation, **Email again** or **New link** makes a fresh link
(the earlier one stops working at once) and restarts the 14 days.
**Revoke** stops it.

Invitation emails go through the mail provider's HTTPS API from the `api`
Edge Function ([`mail.ts`](../supabase/functions/api/mail.ts)) — they carry
the portal's own link, so they aren't a Supabase Auth email. That's why
the setup script also gives the function its own mail secrets. Resend uses
the same API key as for SMTP; Brevo needs an **API key** (not the SMTP
key); a custom SMTP server can't send invitations — copy the links.

## When someone can't sign in

Users & roles → a person's row → **Reset password**. It needs the
`users.password.reset` permission (Super Admin and Admin) and authority
over that account (not your own, not someone at or above your level, inside
your data scope), and the account must be active.

1. **Send reset link** (the default). Supabase Auth emails a link to the
   person's own address; they choose a new password themselves, and nobody
   else ever knows it. The link works once and lasts an hour. It always
   leads back to the portal (`index.html?flow=recovery` on the Vercel or
   GitHub Pages site) — the server picks the address from its own list, not
   from the browser.
2. **Temporary password** — for someone who can't get email. The server
   makes a random one (16 characters, easy to read aloud: no 0/O or 1/l/I),
   shows it to the administrator **once**, and sets
   `must_change_password` on their profile. Then:
   - Signing in with it leads straight to **Choose your own password**.
     The API refuses every other request from that account until they do
     (`403 {mustChangePassword: true}`), so nothing else is reachable —
     not even work queued offline, which waits and is sent afterwards.
   - Only a session signed in **after** the temporary password was made can
     replace it — a session left open from before is told to sign in again.
   - They can't keep the temporary password as their "new" one.
   - The temporary password itself is never stored (only a salted scrypt
     hash, to refuse it as the new one, cleared once it's changed), never
     written to the audit log, and never kept for an offline-retry replay.
     The reply carries `Cache-Control: no-store`.

The old "Set new password" (an administrator typing a password into a
browser prompt) is gone, and so is its route, `POST /users/:id/reset-password`.

Anyone can still use **Forgot password?** on the sign-in page — the same
email as "Send reset link".

## Audit log

Every administrator action on someone's sign-in is recorded (Super Admin:
Audit log and Security events; Admins: the account's View panel). Never a
password.

| Action | When | Details |
|---|---|---|
| `password.reset_link_sent` | An administrator sent a reset link | the email address, where the link leads |
| `password.temporary_set` | An administrator made a temporary password | — |
| `password.changed` | Someone chose their own password (reset link, temporary password, or My profile) | whether it replaced a temporary password |
| `password.reset` | (history only) the old "Set new password" | — |

Invitations too:

| Action | When | Details |
|---|---|---|
| `invitation.created` | An invitation was made | email, role, school or county, expiry |
| `invitation.emailed` | The portal emailed it | email, role (never the link) |
| `invitation.renewed` | **Email again** / **New link** made a fresh link | email, role, new and previous expiry |
| `invitation.revoked` / `invitation.accepted` | Revoked, or used | email, role |

Account approval, role and status changes are audited as before
(`docs/RBAC.md`).

## One-time setup: mail sender, branded email, closed sign-ups

Supabase's built-in mailer only sends to the project's own team and a
couple of emails an hour — reset links to real staff need the portal's own
mail sender (custom SMTP). [`scripts/configure-auth.mjs`](../scripts/configure-auth.mjs)
sets all of it through the Supabase Management API. Run it yourself, with
your own keys — they stay on your computer.

### 1. A mail provider, with your domain verified

Either works; both have a free tier that's plenty for password resets
and invitations.

- **Resend** (resend.com): Domains → Add domain → `humanpractice.org` (or
  a subdomain such as `mail.humanpractice.org`) → add the DNS records it
  shows (SPF, DKIM) at your DNS host → wait for **Verified**. Then API
  Keys → Create (permission: *Sending access*, that domain only).
- **Brevo** (brevo.com): Senders, Domains & Dedicated IPs → Domains → add
  and authenticate the domain (DKIM, DMARC). Then SMTP & API → SMTP →
  note the **SMTP login** and create an **SMTP key**; and SMTP & API →
  API keys → create an **API key** (for invitation emails).

The sender address (e.g. `no-reply@humanpractice.org`) must be on the
verified domain, or mail is refused or lands in spam.

### 2. A Supabase access token

supabase.com/dashboard/account/tokens → **Generate new token**. It can
change any project you can, so keep it private and revoke it when you're
done (step 5).

### 3. A `.env` file (git ignores it)

In the repository folder, copy [`.env.example`](../.env.example) to `.env`
and fill it in:

| Variable | Needed | What |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | always | the token from step 2 |
| `SUPABASE_PROJECT_REF` | no | defaults to `fwpqytrdlmxymvegvgji` |
| `SMTP_PROVIDER` | for mail | `resend`, `brevo` or `custom` |
| `RESEND_API_KEY` | Resend | the API key (host `smtp.resend.com`, port 465, user `resend` are filled in for you) |
| `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY` | Brevo | the SMTP login and key (host `smtp-relay.brevo.com`, port 587) |
| `BREVO_API_KEY` | Brevo, for invitation emails | an API key (`xkeysib-…`) — not the SMTP key |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | custom | any other SMTP server |
| `SMTP_SENDER_EMAIL` | for mail | the From address, on the verified domain |
| `SMTP_SENDER_NAME` | no | defaults to "HPF Digital Learning Portal" |
| `SMTP_RATE_LIMIT_PER_HOUR` | no | emails per hour for the whole project, default 30 |
| `PORTAL_URLS` | no | the portal's addresses for the redirect allow-list; defaults to the Vercel and GitHub Pages sites |

The `api` Edge Function also reads an optional `PORTAL_URLS` secret
(same format) for where reset and invitation links may lead; the default
is the two live sites. Set it only if the portal moves:
`npx supabase secrets set PORTAL_URLS=https://…/,https://…/ --project-ref fwpqytrdlmxymvegvgji`.

### 4. Run it

```bash
node --env-file=.env scripts/configure-auth.mjs
```

A dry run: it lists every setting it would change (secrets show only as
"set") and stops. When it looks right:

```bash
node --env-file=.env scripts/configure-auth.mjs --apply
```

It sets:

- the mail sender (`smtp_*`), at most one email per address per minute,
  and the hourly limit;
- the **Reset password** email: subject "Reset your HPF Digital Learning
  Portal password" and [`supabase/templates/recovery.html`](../supabase/templates/recovery.html)
  — HPF colours, no images (quick on a slow connection), a plain link as
  well as the button;
- link lifetime one hour;
- **public sign-ups off** (`disable_signup`);
- the portal's addresses added to the redirect allow-list (nothing is
  removed from it);
- the `api` Edge Function's mail secrets for invitation emails:
  `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM` (your sender address),
  `MAIL_FROM_NAME`. They take effect at once — no redeploy.

To close sign-ups before mail is ready:
`node --env-file=.env scripts/configure-auth.mjs --signups-only --apply`.

Without a token, `node scripts/configure-auth.mjs --check` shows what the
sign-in page sees (sign-ups, email, Google).

### 5. Check it works, then tidy up

1. `node scripts/configure-auth.mjs --check` → "sign-ups disabled: yes".
2. In the portal, as an administrator: Users & roles → your own test
   account (or a colleague's, with their agreement) → Reset password →
   **Send reset link**. It should arrive within a minute from your sender
   address, with the HPF email; the link opens "Set a new password" on the
   portal.
3. Users & roles → **+ Invite staff** → an address of yours → **Send
   invitation email**. It should arrive with the HPF invitation; you can
   revoke it afterwards.
4. Audit log → Security events shows `sent a password reset link` and
   `emailed an invitation`.
5. Revoke the access token (supabase.com/dashboard/account/tokens) and
   delete `.env` if you no longer need it. The mail key stays only in
   Supabase.

## Troubleshooting

| You see | Why | Fix |
|---|---|---|
| "The email couldn't be sent … Check the portal's mail settings" | No custom SMTP yet (the built-in mailer refuses), or the provider rejected it | Steps 1–4; check the sender is on the verified domain. Meanwhile use **Temporary password**. |
| "The invitation … is ready, but not emailed" | Mail secrets not set, the sender isn't on a verified domain, or the API key is wrong | Re-run the script (step 4); meanwhile copy the link |
| "Too many emails have gone out just now" | The hourly limit, or the one-per-minute limit per address | Wait, or raise `SMTP_RATE_LIMIT_PER_HOUR` and re-run |
| The link opens the portal's front page instead of "Set a new password" | The portal address isn't on the redirect allow-list | Re-run the script (it adds them), or Authentication → URL Configuration |
| "This link is invalid, already used, or has expired" | Used already, older than an hour, or opened by an email scanner first | Send a new one |
| Someone is stuck on "Choose your own password" | Working as intended after a temporary password | They choose one; or send a reset link instead |

## Where it lives in the code

- Server: [`supabase/functions/api/index.ts`](../supabase/functions/api/index.ts)
  — `POST /users/:id/reset-link`, `POST /users/:id/temporary-password`,
  `POST /me/password`, and the `must_change_password` check in
  `resolveActor`. Tests: "5b. passwords" in
  [`authz_test.ts`](../supabase/functions/api/authz_test.ts).
- Database: [`20261004150000_password_policy.sql`](../supabase/migrations/20261004150000_password_policy.sql)
  (`profiles.must_change_password`, `temporary_password_at`,
  `temporary_password_hash`, `password_changed_at`).
- Sign-in page: `index.js` (Google button, "Choose your own password"),
  `auth.js` (`authSettings`, `changeMyPassword`, `requireRole`).
- Console: `console.js` (Reset password dialog, the one-time password;
  Invite staff — email or copy, Email again / New link / Revoke).
- Invitations: `POST /users/invitations` (`send`), `POST
  /users/invitations/:id/renew`, [`mail.ts`](../supabase/functions/api/mail.ts)
  (Resend / Brevo, the invitation email). Tests:
  [`mail_test.ts`](../supabase/functions/api/mail_test.ts) and the
  "invitation email" / "renewing an invitation" tests in `authz_test.ts`.
