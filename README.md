# termp web

The termp marketing site and contact-form backend, deployed together as a Cloudflare Worker with static assets. The site is fully vendored and has no runtime package dependencies.

## Layout

- `public/` — static site, local fonts, and vendored browser runtimes
- `public/logos/` — self-hosted flagship tool logos for Discord Terminal Presence
- `public/contact.html` — contact form posting to `/api/contact`
- `src/index.js` — Cloudflare Worker for contact and feedback submissions plus asset fallback
- `migrations/` — versioned D1 schema migrations
- `wrangler.toml` — Cloudflare Workers configuration

## Local development

Run:

```sh
npx wrangler dev
```

## Deploy

```sh
npx wrangler deploy
```

For Git-connected deployment, connect the repository through the Cloudflare dashboard's Workers build and use `npx wrangler deploy` as the deploy command. Every push to `main` then deploys automatically.

## Custom domain

In the Cloudflare dashboard, open the Worker's **Settings → Domains & Routes → Custom Domains** and add `termp.polter.sh`.

## Contact form setup

Add the email-provider secret:

```sh
npx wrangler secret put RESEND_API_KEY
```

Then finish the documented email-delivery TODO in `src/index.js`. Until delivery is implemented, valid submissions are accepted and logged without sending email.

## Feedback storage

Apply the D1 migrations after authenticating Wrangler with the owning Cloudflare account:

```sh
npx wrangler d1 migrations apply termp-feedback --remote
```

Do not commit the Turnstile secret. Configure it as a Worker secret:

```sh
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Until that secret is configured, the feedback endpoint logs a warning and skips Turnstile verification. The feedback form is not part of this repository change; when it is added, its public site key should start with an explicit placeholder rather than an invented key:

```js
// The owner fills in the public Turnstile site key when the feedback form is added.
const TURNSTILE_SITE_KEY = "OWNER_TO_FILL_IN";
```

Read the 20 most recent submissions with:

```sh
npx wrangler d1 execute termp-feedback --remote \
  --command "SELECT created_at, category, message FROM feedback ORDER BY created_at DESC LIMIT 20"
```
