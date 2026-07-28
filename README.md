# termp web

The termp marketing site and contact-form backend, deployed together as a Cloudflare Worker with static assets. The site is fully vendored and has no runtime package dependencies.

## Layout

- `public/` — static site, local fonts, and vendored browser runtimes
- `public/logos/` — self-hosted flagship tool logos for Discord Terminal Presence
- `public/contact.html` — contact form posting to `/api/contact`
- `src/index.js` — Cloudflare Worker for contact, feedback, and install-script requests plus asset fallback
- `src/install.txt` — vendored install script bundled as a private Worker text module
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

## Install script counter

`GET /install.sh` serves the vendored shell script directly from the Worker; `HEAD`
returns the same response headers without a body. The source file lives outside
`public/`, so there is no static-asset URL that bypasses the canonical route.

Eligible GETs from script clients such as curl, wget, and fetch increment the D1
`installs` table by UTC day and version. The Worker resolves the current GitHub
latest-release tag server-side and caches it for about 10 minutes; if no release
exists, it records `unreleased`. If GitHub cannot be reached, it uses a cached
last-known-good release tag when one is available and otherwise records
`unreleased`. HEAD requests, browsers, and obvious crawlers are not counted.

This is intentionally aggregate-only measurement. The table stores only
`day`, `version`, and `count`; it does not store IP addresses, User-Agent strings,
identifiers, or client telemetry, and the release binary never passes through the
Worker.

## Download request counter

`GET /dl/...` redirects eligible artifact requests to GitHub Releases. The D1
`downloads` series counts these redirect requests, not completed artifact
deliveries, so it is directional supporting detail. GitHub release asset
`download_count` (reliable) is the authoritative, externally verifiable download
figure.

Script-oriented channels (`curl`, `brew`, and `update`) are counted only for
script clients such as curl, wget, and fetch. The `direct` channel also serves
browser downloads, so browsers remain eligible there while obvious bots are
excluded. Explicit versions are counted only after GitHub confirms that the tag
belongs to a published, non-prerelease release. Install-script requests and
download requests use separate per-IP rate-limit budgets, and the aggregate
tables never store those IP addresses.

## GitHub API authentication

The Worker uses a GitHub token for its release API requests when the optional
`GITHUB_TOKEN` secret is configured:

```sh
npx wrangler secret put GITHUB_TOKEN
```

Without the secret, the same requests are sent without an `Authorization`
header, preserving the unauthenticated fallback behavior.
