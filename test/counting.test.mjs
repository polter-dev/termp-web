import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const source = (
  await readFile(new URL("../src/index.js", import.meta.url), "utf8")
).replace('import installScript from "./install.txt";', 'const installScript = "install";');
const worker = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;

function createCache(now = () => 0) {
  const entries = new Map();
  const cachedAt = new Map();
  return {
    entries,
    async match(key) {
      const cacheKey = String(key);
      const response = entries.get(cacheKey);
      if (!response) return undefined;

      const maxAge = Number.parseInt(
        response.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1] ?? "",
        10
      );
      if (Number.isFinite(maxAge) && now() - cachedAt.get(cacheKey) >= maxAge * 1000) {
        entries.delete(cacheKey);
        cachedAt.delete(cacheKey);
        return undefined;
      }

      return response.clone();
    },
    async put(key, response) {
      const cacheKey = String(key);
      entries.set(cacheKey, response.clone());
      cachedAt.set(cacheKey, now());
    }
  };
}

function createDatabase() {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              writes.push({ sql, values });
            }
          };
        }
      };
    }
  };
}

function createLimiter(success = true) {
  const keys = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      return { success };
    }
  };
}

function createContext() {
  const promises = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(promise);
    }
  };
}

function createEnv() {
  return {
    ENVIRONMENT: "production",
    termp_feedback: createDatabase(),
    INSTALL_COUNT_LIMITER: createLimiter(),
    DOWNLOAD_COUNT_LIMITER: createLimiter(),
    ASSETS: { fetch: async () => new Response("asset") }
  };
}

function request(path, userAgent = "curl/8.0") {
  return new Request(`https://termp.polter.sh${path}`, {
    headers: {
      "CF-Connecting-IP": "192.0.2.1",
      "User-Agent": userAgent
    }
  });
}

function release(tag, overrides = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: "2026-07-27T00:00:00Z",
    ...overrides
  };
}

async function settle(ctx) {
  await Promise.all(ctx.promises);
}

test.beforeEach(() => {
  globalThis.caches = { default: createCache() };
});

test("authenticates GitHub release lookups when the token is configured", async () => {
  const env = createEnv();
  env.GITHUB_TOKEN = "test-token";
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers });
    const tag = String(url).endsWith("/latest")
      ? "v1.0.0"
      : decodeURIComponent(String(url).split("/").at(-1));
    return Response.json(release(tag));
  };

  const installCtx = createContext();
  await worker.fetch(request("/install.sh"), env, installCtx);
  await settle(installCtx);

  const downloadCtx = createContext();
  await worker.fetch(
    request("/dl/curl/linux/amd64/v1.0.0"),
    env,
    downloadCtx
  );
  await settle(downloadCtx);

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(({ headers }) => headers.Authorization),
    ["Bearer test-token", "Bearer test-token"]
  );
});

test("keeps GitHub release lookup headers unchanged when the token is absent", async () => {
  const env = createEnv();
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers });
    const tag = String(url).endsWith("/latest")
      ? "v1.0.0"
      : decodeURIComponent(String(url).split("/").at(-1));
    return Response.json(release(tag));
  };

  const installCtx = createContext();
  await worker.fetch(request("/install.sh"), env, installCtx);
  await settle(installCtx);

  const downloadCtx = createContext();
  await worker.fetch(
    request("/dl/curl/linux/amd64/v1.0.0"),
    env,
    downloadCtx
  );
  await settle(downloadCtx);

  assert.deepEqual(
    requests.map(({ headers }) => headers),
    [
      {
        "Accept": "application/vnd.github+json",
        "User-Agent": "termp-web-install-counter"
      },
      {
        "Accept": "application/vnd.github+json",
        "User-Agent": "termp-web-download-counter"
      }
    ]
  );
});

test("attributes install lookup failures to the last-known-good release", async () => {
  let now = 0;
  globalThis.caches = { default: createCache(() => now) };
  const env = createEnv();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return fetches === 1
      ? Response.json(release("v1.2.3"))
      : new Response("rate limited", { status: 403 });
  };

  const firstCtx = createContext();
  await worker.fetch(request("/install.sh"), env, firstCtx);
  await settle(firstCtx);

  now += 11 * 60 * 1000;
  const secondCtx = createContext();
  await worker.fetch(request("/install.sh"), env, secondCtx);
  await settle(secondCtx);

  assert.equal(fetches, 2);
  assert.deepEqual(
    env.termp_feedback.writes.map(({ values }) => values[1]),
    ["v1.2.3", "v1.2.3"]
  );
});

test("keeps the unreleased install fallback without a last-known-good release", async () => {
  const env = createEnv();
  globalThis.fetch = async () =>
    new Response("rate limited", { status: 403 });

  const ctx = createContext();
  await worker.fetch(request("/install.sh"), env, ctx);
  await settle(ctx);

  assert.equal(env.termp_feedback.writes.length, 1);
  assert.equal(env.termp_feedback.writes[0].values[1], "unreleased");
});

test("records unreleased on a genuine 404 even with a last-known-good release", async () => {
  let now = 0;
  globalThis.caches = { default: createCache(() => now) };
  const env = createEnv();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return fetches === 1
      ? Response.json(release("v1.2.3"))
      : new Response("missing", { status: 404 });
  };

  const firstCtx = createContext();
  await worker.fetch(request("/install.sh"), env, firstCtx);
  await settle(firstCtx);

  now += 11 * 60 * 1000;
  const secondCtx = createContext();
  await worker.fetch(request("/install.sh"), env, secondCtx);
  await settle(secondCtx);

  assert.deepEqual(
    env.termp_feedback.writes.map(({ values }) => values[1]),
    ["v1.2.3", "unreleased"]
  );
});

test("counts a published explicit version even when it is not latest", async () => {
  const env = createEnv();
  const ctx = createContext();
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return Response.json(release("v1.0.0"));
  };

  const response = await worker.fetch(
    request("/dl/curl/linux/amd64/v1.0.0"),
    env,
    ctx
  );

  assert.equal(response.status, 302);
  await settle(ctx);
  assert.match(requestedUrl, /releases\/tags\/v1.0.0$/);
  assert.equal(env.termp_feedback.writes.length, 1);
  assert.deepEqual(env.termp_feedback.writes[0].values.slice(1), [
    "v1.0.0",
    "curl",
    "linux",
    "amd64"
  ]);
});

test("does not delay an explicit-version redirect while GitHub verification is pending", async () => {
  const env = createEnv();
  const ctx = createContext();
  let resolveLookup;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      resolveLookup = resolve;
    });

  const response = await worker.fetch(
    request("/dl/curl/linux/amd64/v1.0.0"),
    env,
    ctx
  );

  assert.equal(response.status, 302);
  assert.equal(env.termp_feedback.writes.length, 0);
  await Promise.resolve();
  resolveLookup(Response.json(release("v1.0.0")));
  await settle(ctx);
  assert.equal(env.termp_feedback.writes.length, 1);
});

test("does not count prerelease, draft, missing, or unverifiable tags", async () => {
  for (const githubResponse of [
    Response.json(release("v2.0.0-rc.1", { prerelease: true })),
    Response.json(release("v2.0.0", { draft: true })),
    new Response("missing", { status: 404 }),
    new Response("unavailable", { status: 503 })
  ]) {
    globalThis.caches = { default: createCache() };
    const env = createEnv();
    const ctx = createContext();
    globalThis.fetch = async () => githubResponse.clone();

    await worker.fetch(
      request("/dl/curl/linux/amd64/v2.0.0-rc.1"),
      env,
      ctx
    );
    await settle(ctx);

    assert.equal(env.termp_feedback.writes.length, 0);
  }
});

test("does not redirect or count a prerelease returned by the latest endpoint", async () => {
  const env = createEnv();
  const ctx = createContext();
  globalThis.fetch = async () =>
    Response.json(release("v2.0.0-rc.1", { prerelease: true }));

  const response = await worker.fetch(
    request("/dl/curl/linux/amd64"),
    env,
    ctx
  );

  assert.equal(response.status, 503);
  await settle(ctx);
  assert.equal(env.termp_feedback.writes.length, 0);
});

test("does not redirect unreleased downloads to Worker assets", async () => {
  const env = createEnv();
  env.ENVIRONMENT = "development";
  const ctx = createContext();
  globalThis.fetch = async () => new Response("missing", { status: 404 });

  const response = await worker.fetch(
    request("/dl/curl/linux/amd64"),
    env,
    ctx
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Location"), null);
  assert.equal(await response.text(), "No release available.");
  await settle(ctx);
  assert.equal(env.termp_feedback.writes.length, 0);
});

test("does not redirect latest downloads to a stale last-known-good release", async () => {
  let now = 0;
  globalThis.caches = { default: createCache(() => now) };
  const env = createEnv();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return fetches === 1
      ? Response.json(release("v1.2.3"))
      : new Response("rate limited", { status: 403 });
  };

  const installCtx = createContext();
  await worker.fetch(request("/install.sh"), env, installCtx);
  await settle(installCtx);

  now += 11 * 60 * 1000;
  const downloadCtx = createContext();
  const response = await worker.fetch(
    request("/dl/curl/linux/amd64"),
    env,
    downloadCtx
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Location"), null);
  await settle(downloadCtx);
  assert.equal(fetches, 2);
  assert.equal(env.termp_feedback.writes.length, 1);
});

test("briefly caches unreleased before picking up a newly published release", async () => {
  let now = 0;
  const cache = createCache(() => now);
  globalThis.caches = { default: cache };
  const env = createEnv();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return fetches === 1
      ? new Response("missing", { status: 404 })
      : Response.json(release("v1.0.0"));
  };

  const unreleasedResponse = await worker.fetch(
    request("/dl/curl/linux/amd64"),
    env,
    createContext()
  );

  assert.equal(unreleasedResponse.status, 503);
  assert.equal(fetches, 1);
  const negativeEntry = [...cache.entries.values()][0];
  const negativeTtl = Number.parseInt(
    negativeEntry.headers.get("Cache-Control").match(/max-age=(\d+)/)[1],
    10
  );

  now += (negativeTtl + 1) * 1000;
  const publishedResponse = await worker.fetch(
    request("/dl/curl/linux/amd64"),
    env,
    createContext()
  );

  assert.equal(publishedResponse.status, 302);
  assert.match(publishedResponse.headers.get("Location"), /\/v1\.0\.0\//);
  assert.equal(fetches, 2);
  const positiveEntry = [...cache.entries.values()][0];
  const positiveTtl = Number.parseInt(
    positiveEntry.headers.get("Cache-Control").match(/max-age=(\d+)/)[1],
    10
  );
  assert.ok(
    negativeTtl <= positiveTtl / 10,
    `expected negative TTL ${negativeTtl}s to be materially shorter than positive TTL ${positiveTtl}s`
  );
});

test("excludes archive fixtures from the public asset directory", async () => {
  const publicDirectory = new URL("../public/", import.meta.url);
  const assetIgnore = await readFile(
    new URL(".assetsignore", publicDirectory),
    "utf8"
  );
  const publicEntries = await readdir(publicDirectory, {
    recursive: true,
    withFileTypes: true
  });

  assert.match(assetIgnore, /^\*\*\/\*\.tar\.gz$/m);
  assert.equal(
    publicEntries.some(
      (entry) => entry.isFile() && entry.name.endsWith(".tar.gz")
    ),
    false
  );
});

test("reuses a cached positive tag verification", async () => {
  const env = createEnv();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return Response.json(release("v1.2.3"));
  };

  for (let index = 0; index < 2; index += 1) {
    const ctx = createContext();
    await worker.fetch(
      request("/dl/update/linux/amd64/v1.2.3", "wget/1.21"),
      env,
      ctx
    );
    await settle(ctx);
  }

  assert.equal(fetches, 1);
  assert.equal(env.termp_feedback.writes.length, 2);
  const cached = [...globalThis.caches.default.entries.values()][0];
  assert.equal(await cached.text(), "ok");
  assert.equal(cached.headers.get("Cache-Control"), "public, max-age=21600");
});

test("reuses a cached rejection without counting the tag", async () => {
  const env = createEnv();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response("missing", { status: 404 });
  };

  for (let index = 0; index < 2; index += 1) {
    const ctx = createContext();
    await worker.fetch(
      request("/dl/curl/linux/amd64/v9.9.9"),
      env,
      ctx
    );
    await settle(ctx);
  }

  assert.equal(fetches, 1);
  assert.equal(env.termp_feedback.writes.length, 0);
  const cached = [...globalThis.caches.default.entries.values()][0];
  assert.equal(await cached.text(), "not-ok");
  assert.equal(cached.headers.get("Cache-Control"), "public, max-age=60");
});

test("caches a transient GitHub failure for five minutes", async () => {
  const env = createEnv();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response("rate limited", { status: 403 });
  };

  for (let index = 0; index < 2; index += 1) {
    const ctx = createContext();
    await worker.fetch(
      request("/dl/curl/linux/amd64/v1.2.4"),
      env,
      ctx
    );
    await settle(ctx);
  }

  assert.equal(fetches, 1);
  assert.equal(env.termp_feedback.writes.length, 0);
  const cached = [...globalThis.caches.default.entries.values()][0];
  assert.equal(await cached.text(), "transient-error");
  assert.equal(cached.headers.get("Cache-Control"), "public, max-age=300");
});

test("still refuses published prereleases and drafts", async () => {
  for (const overrides of [{ prerelease: true }, { draft: true }]) {
    globalThis.caches = { default: createCache() };
    const env = createEnv();
    const ctx = createContext();
    globalThis.fetch = async () =>
      Response.json(release("v2.0.0", overrides));

    await worker.fetch(
      request("/dl/curl/linux/amd64/v2.0.0"),
      env,
      ctx
    );
    await settle(ctx);

    assert.equal(env.termp_feedback.writes.length, 0);
    const cached = [...globalThis.caches.default.entries.values()][0];
    assert.equal(await cached.text(), "not-ok");
  }
});

test("coalesces concurrent verification lookups for the same tag", async () => {
  const env = createEnv();
  const firstCtx = createContext();
  const secondCtx = createContext();
  let fetches = 0;
  let resolveLookup;
  globalThis.fetch = () => {
    fetches += 1;
    return new Promise((resolve) => {
      resolveLookup = resolve;
    });
  };

  const responses = await Promise.all([
    worker.fetch(
      request("/dl/curl/linux/amd64/v3.0.0"),
      env,
      firstCtx
    ),
    worker.fetch(
      request("/dl/update/linux/amd64/v3.0.0", "wget/1.21"),
      env,
      secondCtx
    )
  ]);

  assert.deepEqual(responses.map(({ status }) => status), [302, 302]);
  await Promise.resolve();
  assert.equal(fetches, 1);

  resolveLookup(Response.json(release("v3.0.0")));
  await Promise.all([settle(firstCtx), settle(secondCtx)]);
  assert.equal(env.termp_feedback.writes.length, 2);
});

test("uses script filtering except for legitimate direct browser requests", async () => {
  const env = createEnv();
  globalThis.fetch = async (url) => {
    const tag = decodeURIComponent(String(url).split("/").at(-1));
    return Response.json(release(tag));
  };

  const cases = [
    ["/dl/curl/linux/amd64/v1.0.0", "Mozilla/5.0", 0],
    ["/dl/curl/linux/amd64/v1.0.0", "curl/8.0", 1],
    ["/dl/direct/linux/amd64/v1.0.0", "Mozilla/5.0", 1],
    ["/dl/direct/linux/amd64/v1.0.0", "ExampleBot/1.0", 0]
  ];

  for (const [path, userAgent, expectedNewWrites] of cases) {
    const before = env.termp_feedback.writes.length;
    const ctx = createContext();
    await worker.fetch(request(path, userAgent), env, ctx);
    await settle(ctx);
    assert.equal(
      env.termp_feedback.writes.length - before,
      expectedNewWrites,
      `${path} with ${userAgent}`
    );
  }
});

function asset(name, downloadCount) {
  return { name, download_count: downloadCount };
}

// Real artifact names from `goreleaser release --snapshot` (2026-07-27), plus
// the release-only extras. This fixture is the drift lock shared with the
// dashboard's fetch-stats.sh asset pattern: both must count exactly the
// tar.gz/zip archives and the nfpm deb/rpm packages, and nothing else.
const COUNTED_ASSETS = [
  asset("termp_1.0.0_darwin_amd64.tar.gz", 1),
  asset("termp_1.0.0_darwin_arm64.tar.gz", 2),
  asset("termp_1.0.0_linux_amd64.tar.gz", 4),
  asset("termp_1.0.0_linux_arm64.tar.gz", 8),
  asset("termp_1.0.0_windows_amd64.zip", 16),
  asset("termp_1.0.0_windows_arm64.zip", 32),
  asset("termp_1.0.0_linux_amd64.deb", 64),
  asset("termp_1.0.0_linux_arm64.deb", 128),
  asset("termp_1.0.0_linux_amd64.rpm", 256),
  asset("termp_1.0.0_linux_arm64.rpm", 512)
];
const COUNTED_TOTAL = 1023;
const IGNORED_ASSETS = [
  asset("checksums.txt", 9001),
  asset("termp.rb", 9001),
  asset("termp-1.0.0.tar.gz", 9001),
  asset("Source code (zip)", 9001)
];

function snapshotDay() {
  return new Date().toISOString().slice(0, 10);
}

async function runScheduled(env) {
  const ctx = createContext();
  await worker.scheduled({ cron: "50 23 * * *" }, env, ctx);
  await settle(ctx);
}

test("scheduled snapshot records the full stable-release download total", async () => {
  const env = createEnv();
  env.GITHUB_TOKEN = "test-token";
  const requested = [];
  globalThis.fetch = async (url, init) => {
    requested.push(String(url));
    assert.equal(init.headers.Authorization, "Bearer test-token");
    return Response.json([
      release("v1.0.0", { assets: [...COUNTED_ASSETS, ...IGNORED_ASSETS] }),
      release("v2.0.0-rc.1", {
        prerelease: true,
        assets: [asset("termp_2.0.0-rc.1_linux_amd64.tar.gz", 9001)]
      }),
      release("v3.0.0", {
        draft: true,
        assets: [asset("termp_3.0.0_linux_amd64.tar.gz", 9001)]
      })
    ]);
  };

  await runScheduled(env);

  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/releases\?per_page=100&page=1$/);
  assert.equal(env.termp_feedback.writes.length, 1);
  const write = env.termp_feedback.writes[0];
  assert.match(write.sql, /INSERT INTO github_download_snapshots/);
  assert.match(write.sql, /ON CONFLICT\(day\) DO UPDATE/);
  assert.deepEqual(write.values, [snapshotDay(), COUNTED_TOTAL, "v1.0.0"]);
});

test("scheduled snapshot re-run upserts the same day instead of duplicating it", async () => {
  const env = createEnv();
  const table = new Map();
  env.termp_feedback = {
    prepare(sql) {
      return {
        bind(day, total, latestTag) {
          return {
            async run() {
              assert.match(sql, /ON CONFLICT\(day\) DO UPDATE/);
              table.set(day, { total, latestTag });
            }
          };
        }
      };
    }
  };
  let downloads = 5;
  globalThis.fetch = async () =>
    Response.json([
      release("v1.0.0", { assets: [asset("termp_1.0.0_linux_amd64.deb", downloads)] })
    ]);

  await runScheduled(env);
  downloads = 7;
  await runScheduled(env);

  assert.equal(table.size, 1);
  assert.deepEqual(table.get(snapshotDay()), { total: 7, latestTag: "v1.0.0" });
});

test("scheduled snapshot sums releases across pagination", async () => {
  const env = createEnv();
  const pages = [];
  globalThis.fetch = async (url) => {
    pages.push(String(url));
    if (pages.length === 1) {
      return Response.json(
        Array.from({ length: 100 }, (_, index) =>
          release(`v1.0.${index}`, {
            published_at: `2026-07-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
            assets: [asset(`termp_1.0.${index}_linux_amd64.rpm`, 1)]
          })
        )
      );
    }
    return Response.json([
      release("v2.0.0", {
        published_at: "2026-07-27T00:00:00Z",
        assets: [asset("termp_2.0.0_linux_amd64.deb", 10)]
      })
    ]);
  };

  await runScheduled(env);

  assert.equal(pages.length, 2);
  assert.match(pages[1], /page=2$/);
  assert.equal(env.termp_feedback.writes.length, 1);
  assert.deepEqual(env.termp_feedback.writes[0].values, [snapshotDay(), 110, "v2.0.0"]);
});

test("scheduled snapshot writes a genuine zero total from a verified empty history", async () => {
  const env = createEnv();
  globalThis.fetch = async () => Response.json([]);

  await runScheduled(env);

  assert.equal(env.termp_feedback.writes.length, 1);
  assert.deepEqual(env.termp_feedback.writes[0].values, [snapshotDay(), 0, null]);
});

test("scheduled snapshot writes nothing when the GitHub fetch fails", async () => {
  for (const failure of [
    async () => new Response("rate limited", { status: 403 }),
    async () => new Response("down", { status: 503 }),
    async () => Response.json({ message: "not an array" }),
    async () => new Response("not json", { status: 200 }),
    async () => {
      throw new Error("network unreachable");
    },
    async () =>
      Response.json([
        release("v1.0.0", {
          assets: [asset("termp_1.0.0_linux_amd64.deb", "corrupt")]
        })
      ])
  ]) {
    const env = createEnv();
    globalThis.fetch = failure;

    await runScheduled(env);

    assert.equal(
      env.termp_feedback.writes.length,
      0,
      "a failed fetch must write nothing — never a zero or partial total"
    );
  }
});

test("scheduled snapshot writes nothing when a later pagination page fails", async () => {
  const env = createEnv();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    if (fetches === 1) {
      return Response.json(
        Array.from({ length: 100 }, (_, index) =>
          release(`v1.0.${index}`, {
            assets: [asset(`termp_1.0.${index}_linux_amd64.tar.gz`, 1)]
          })
        )
      );
    }
    return new Response("rate limited", { status: 403 });
  };

  await runScheduled(env);

  assert.equal(fetches, 2);
  assert.equal(
    env.termp_feedback.writes.length,
    0,
    "a partial pagination result must never be recorded"
  );
});

test("scheduled snapshot degrades safely when the table is missing", async () => {
  const env = createEnv();
  env.termp_feedback = {
    prepare() {
      return {
        bind() {
          return {
            async run() {
              throw new Error("D1_ERROR: no such table: github_download_snapshots");
            }
          };
        }
      };
    }
  };
  globalThis.fetch = async () => Response.json([release("v1.0.0", { assets: COUNTED_ASSETS })]);

  await runScheduled(env);
});

test("uses separate fail-closed limiter bindings", async () => {
  const env = createEnv();
  globalThis.fetch = async (url) => {
    const value = String(url);
    const tag = value.endsWith("/latest")
      ? "v1.0.0"
      : decodeURIComponent(value.split("/").at(-1));
    return Response.json(release(tag));
  };

  const installCtx = createContext();
  await worker.fetch(request("/install.sh"), env, installCtx);
  await settle(installCtx);
  assert.equal(env.INSTALL_COUNT_LIMITER.keys.length, 1);
  assert.equal(env.DOWNLOAD_COUNT_LIMITER.keys.length, 0);

  const downloadCtx = createContext();
  await worker.fetch(
    request("/dl/curl/linux/amd64/v1.0.0"),
    env,
    downloadCtx
  );
  await settle(downloadCtx);
  assert.equal(env.INSTALL_COUNT_LIMITER.keys.length, 1);
  assert.equal(env.DOWNLOAD_COUNT_LIMITER.keys.length, 1);

  const writesBefore = env.termp_feedback.writes.length;
  env.DOWNLOAD_COUNT_LIMITER = undefined;
  const failedClosedCtx = createContext();
  await worker.fetch(
    request("/dl/curl/linux/amd64/v1.0.0"),
    env,
    failedClosedCtx
  );
  await settle(failedClosedCtx);
  assert.equal(env.termp_feedback.writes.length, writesBefore);
});
