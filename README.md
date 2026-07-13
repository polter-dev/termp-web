# termp web

The termp marketing site and contact-form backend, deployed together on Cloudflare Pages. The site is fully vendored and has no runtime package dependencies.

## Layout

- `public/` — static site, local fonts, and vendored browser runtimes
- `public/contact.html` — contact form posting to `/api/contact`
- `functions/api/contact.js` — Cloudflare Pages Function for contact submissions
- `wrangler.toml` — Cloudflare Pages configuration

## Local development

Run:

```sh
npx wrangler pages dev public
```

Pages Functions are served automatically alongside the static files.

## Deploy

```sh
npx wrangler pages deploy public --project-name=termp-web
```

## Custom domain

In the Cloudflare dashboard, open **Pages → termp-web → Custom domains** and add `termp.polter.sh`. DNS is managed automatically because `polter.sh` is already a Cloudflare zone.

## Contact form setup

Add the email-provider secret:

```sh
npx wrangler pages secret put RESEND_API_KEY
```

Then finish the documented email-delivery TODO in `functions/api/contact.js`. Until delivery is implemented, valid submissions are accepted and logged without sending email.
