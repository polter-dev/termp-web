import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (
  await readFile(new URL("../src/index.js", import.meta.url), "utf8")
).replace('import installScript from "./install.txt";', 'const installScript = "install";');
const worker = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;

function createCache() {
  const entries = new Map();
  return {
    entries,
    async match(key) {
      return entries.get(String(key))?.clone();
    },
    async put(key, response) {
      entries.set(String(key), response.clone());
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

test("briefly caches a transient GitHub failure", async () => {
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
  assert.equal(cached.headers.get("Cache-Control"), "public, max-age=15");
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
