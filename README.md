# termp web

The termp marketing site and contact-form backend, deployed together as a Cloudflare Worker with static assets. The site is fully vendored and has no runtime package dependencies.

## Layout

- `public/` — static site, local fonts, and vendored browser runtimes
- `public/contact.html` — contact form posting to `/api/contact`
- `src/index.js` — Cloudflare Worker for contact submissions and asset fallback
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
