# Request counting

The Worker maintains aggregate-only D1 counters for install-script requests and
download requests. Neither counter stores IP addresses, User-Agent strings,
identifiers, or per-request rows.

`GET /install.sh` is eligible only for script clients. `GET /dl/...` applies the
same filter to the script-oriented `curl`, `brew`, and `update` channels. The
`direct` channel also serves legitimate browsers, so it accepts browsers while
still excluding obvious bots.

An explicit `/dl/.../<tag>` request is recorded only when GitHub's release-by-tag
API verifies an exact matching release that is published, non-draft, and not a
prerelease. Verified and rejected tags are cached per colo; rejected tags have a
short TTL so a tag requested just before publication is rechecked quickly.
Transient GitHub failures use a distinct, shorter cache entry, and concurrent
verification requests for the same tag share one in-flight lookup per isolate.
Verification runs in `waitUntil`, so failures neither delay nor block redirects.

Install-script and download-request counting use separate 100-per-minute,
per-IP Cloudflare rate-limit namespaces. Limiter errors and missing bindings
remain fail-closed. IPs are used only as ephemeral limiter keys and are not
written to D1.

The `downloads` table name is retained for schema compatibility. Its values are
directional download-request data; GitHub release asset `download_count`
(reliable) is the authoritative, externally verifiable download figure.
