const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_CHARS = 5000;
const MAX_EMAIL_CHARS = 320;
const MAX_CATEGORY_CHARS = 100;
const MAX_TURNSTILE_TOKEN_CHARS = 2048;
const FEEDBACK_FIELDS = new Set([
  "message",
  "category",
  "email",
  "company",
  "cf-turnstile-response",
  "turnstileToken"
]);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });

async function readBoundedJson(request) {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return { error: json({ ok: false, error: "Content-Type must be application/json." }, 415) };
  }

  const contentLength = request.headers.get("Content-Length");

  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      return { error: json({ ok: false, error: "Invalid Content-Length header." }, 400) };
    }

    if (Number(contentLength) > MAX_JSON_BODY_BYTES) {
      return { error: json({ ok: false, error: "Request body is too large." }, 413) };
    }
  }

  if (!request.body) {
    return { error: json({ ok: false, error: "Request body must be valid JSON." }, 400) };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The 413 response is still authoritative if stream cancellation fails.
        }
        return { error: json({ ok: false, error: "Request body is too large." }, 413) };
      }

      chunks.push(value);
    }
  } catch {
    return { error: json({ ok: false, error: "Request body could not be read." }, 400) };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { error: json({ ok: false, error: "Request body must be valid JSON." }, 400) };
  }
}

function feedbackDevBypassEnabled(env) {
  return env.ENVIRONMENT === "development" && env.FEEDBACK_DEV_BYPASS === "true";
}

function feedbackConfigurationAvailable(env, allowDevBypass) {
  if (!env.termp_feedback || typeof env.termp_feedback.prepare !== "function") return false;
  if (allowDevBypass) return true;

  return Boolean(
    env.TURNSTILE_SECRET_KEY &&
      env.TURNSTILE_EXPECTED_ACTION &&
      env.TURNSTILE_EXPECTED_HOSTNAME &&
      env.FEEDBACK_PRE_LIMITER &&
      typeof env.FEEDBACK_PRE_LIMITER.limit === "function" &&
      env.FEEDBACK_LIMITER &&
      typeof env.FEEDBACK_LIMITER.limit === "function"
  );
}

async function handleContactPost(request, env) {
  const limiter = env.CONTACT_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") {
    return json({ ok: false, error: "Contact form is currently unavailable; your message was not received." }, 503);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await limiter.limit({ key: ip });

  if (!success) {
    return json({ ok: false, error: "Too many contact requests. Please try again later." }, 429);
  }

  // Delivery is intentionally disabled until a provider is implemented and verified.
  return json({ ok: false, error: "Contact form is currently unavailable; your message was not received." }, 503);
}

async function verifyTurnstile(token, secret, remoteIp, expectedAction, expectedHostname) {
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: remoteIp
      })
    });

    if (!response.ok) {
      console.error(`Turnstile verification returned HTTP ${response.status}.`);
      return false;
    }

    const result = await response.json();
    return (
      result.success === true &&
      result.action === expectedAction &&
      result.hostname === expectedHostname
    );
  } catch (error) {
    console.error("Turnstile verification failed.", error);
    return false;
  }
}

function discordFeedbackContent(message, email) {
  const emailLine = email ? `\nemail: ${email}` : "";
  const messageLimit = Math.max(0, 2000 - emailLine.length);

  return message.slice(0, messageLimit) + emailLine;
}

async function postFeedbackToDiscord(webhookUrl, message, email) {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: discordFeedbackContent(message, email),
        allowed_mentions: { parse: [] }
      })
    });

    if (!response.ok) {
      console.error(`Discord feedback webhook returned HTTP ${response.status}.`);
    }
  } catch {
    console.error("Discord feedback webhook request failed.");
  }
}

async function handleFeedbackPost(request, env, ctx) {
  const allowDevBypass = feedbackDevBypassEnabled(env);

  if (!feedbackConfigurationAvailable(env, allowDevBypass)) {
    console.error("Feedback processing is unavailable because required bindings or configuration are missing.");
    return json({ ok: false, error: "Feedback is temporarily unavailable. Please try again later." }, 503);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const preLimiter = env.FEEDBACK_PRE_LIMITER;

  if (preLimiter && typeof preLimiter.limit === "function") {
    const { success } = await preLimiter.limit({ key: ip || "unknown" });
    if (!success) {
      return json({ ok: false, error: "Too many feedback requests. Please try again later." }, 429);
    }
  }

  const parsed = await readBoundedJson(request);
  if (parsed.error) return parsed.error;

  const body = parsed.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, error: "Request body must be a JSON object." }, 400);
  }

  const unknownFields = Object.keys(body).filter((field) => !FEEDBACK_FIELDS.has(field));
  if (unknownFields.length > 0) {
    return json({ ok: false, error: "Request body contains unknown fields." }, 400);
  }

  const { message, category, email, company } = body;

  // Silently accept and discard submissions that fill the honeypot.
  if (typeof company === "string" ? company.trim() : Boolean(company)) {
    return json({ ok: true });
  }

  if (typeof message !== "string" || !message.trim()) {
    return json({ ok: false, error: "Message is required." }, 400);
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return json({ ok: false, error: `Message must be ${MAX_MESSAGE_CHARS} characters or fewer.` }, 400);
  }
  if (category !== undefined && category !== null && typeof category !== "string") {
    return json({ ok: false, error: "Category must be a string." }, 400);
  }
  if (typeof category === "string" && category.length > MAX_CATEGORY_CHARS) {
    return json({ ok: false, error: `Category must be ${MAX_CATEGORY_CHARS} characters or fewer.` }, 400);
  }
  if (email !== undefined && email !== null && typeof email !== "string") {
    return json({ ok: false, error: "Email must be a string." }, 400);
  }
  if (typeof email === "string" && email.length > MAX_EMAIL_CHARS) {
    return json({ ok: false, error: `Email must be ${MAX_EMAIL_CHARS} characters or fewer.` }, 400);
  }

  const rawToken = body["cf-turnstile-response"] ?? body.turnstileToken;
  if (rawToken !== undefined && (typeof rawToken !== "string" || rawToken.length > MAX_TURNSTILE_TOKEN_CHARS)) {
    return json({ ok: false, error: "Turnstile verification failed." }, 403);
  }

  const cleanMessage = message.trim();
  const cleanCategory = typeof category === "string" ? category.trim() || null : null;
  const cleanEmail = typeof email === "string" ? email.trim() || null : null;

  if (!allowDevBypass) {
    if (
      !ip ||
      typeof rawToken !== "string" ||
      !rawToken.trim() ||
      !(await verifyTurnstile(
        rawToken.trim(),
        env.TURNSTILE_SECRET_KEY,
        ip,
        env.TURNSTILE_EXPECTED_ACTION,
        env.TURNSTILE_EXPECTED_HOSTNAME
      ))
    ) {
      return json({ ok: false, error: "Turnstile verification failed." }, 403);
    }
  }

  const submissionLimiter = env.FEEDBACK_LIMITER;
  if (submissionLimiter && typeof submissionLimiter.limit === "function") {
    const { success } = await submissionLimiter.limit({ key: ip || "unknown" });
    if (!success) {
      return json({ ok: false, error: "Too many feedback submissions. Please try again later." }, 429);
    }
  }

  try {
    await env.termp_feedback
      .prepare("INSERT INTO feedback (category, message, email) VALUES (?, ?, ?)")
      .bind(cleanCategory, cleanMessage, cleanEmail)
      .run();
  } catch (error) {
    console.error("Failed to store feedback in D1.", error);
    return json({ ok: false, error: "Feedback could not be saved. Please try again." }, 502);
  }

  const discordWebhookUrl = env.DISCORD_WEBHOOK_URL;

  if (discordWebhookUrl) {
    ctx.waitUntil(postFeedbackToDiscord(discordWebhookUrl, cleanMessage, cleanEmail));
  } else {
    console.warn("Discord webhook skipped; DISCORD_WEBHOOK_URL is not configured.");
  }

  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/contact") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Allow": "POST, OPTIONS"
          }
        });
      }

      if (request.method === "POST") {
        return handleContactPost(request, env);
      }

      return json({ ok: false, error: "Method not allowed." }, 405);
    }

    if (url.pathname === "/api/feedback") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Allow": "POST, OPTIONS"
          }
        });
      }

      if (request.method === "POST") {
        return handleFeedbackPost(request, env, ctx);
      }

      return json({ ok: false, error: "Method not allowed." }, 405);
    }

    return env.ASSETS.fetch(request);
  }
};
