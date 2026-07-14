const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });

async function handleContactPost(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Request body must be valid JSON." }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, error: "Request body must be a JSON object." }, 400);
  }

  const { name, email, message, company } = body;

  // Silently accept and discard submissions that fill the honeypot.
  if (typeof company === "string" ? company.trim() : Boolean(company)) {
    return json({ ok: true });
  }

  const cleanName = typeof name === "string" ? name.trim() : "";
  const cleanEmail = typeof email === "string" ? email.trim() : "";
  const cleanMessage = typeof message === "string" ? message.trim() : "";
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!cleanName) {
    return json({ ok: false, error: "Name is required." }, 400);
  }

  if (!emailPattern.test(cleanEmail)) {
    return json({ ok: false, error: "A valid email address is required." }, 400);
  }

  if (!cleanMessage) {
    return json({ ok: false, error: "Message is required." }, 400);
  }

  if (typeof message === "string" && message.length > 5000) {
    return json({ ok: false, error: "Message must be 5000 characters or fewer." }, 400);
  }

  const apiKey = env.RESEND_API_KEY;

  if (!apiKey) {
    // Local/dev deployments can exercise the complete form without an email account.
    console.log("Contact accepted; RESEND_API_KEY is not configured, so no email was sent.");
    return json({ ok: true });
  }

  /*
   * TODO: Connect the preferred email provider. A Resend implementation would
   * look roughly like this (keep addresses/configuration in environment vars):
   *
   * const response = await fetch("https://api.resend.com/emails", {
   *   method: "POST",
   *   headers: {
   *     Authorization: `Bearer ${apiKey}`,
   *     "Content-Type": "application/json"
   *   },
   *   body: JSON.stringify({
   *     from: env.CONTACT_FROM_EMAIL,
   *     to: [env.CONTACT_TO_EMAIL],
   *     reply_to: cleanEmail,
   *     subject: `termp contact from ${cleanName}`,
   *     text: cleanMessage
   *   })
   * });
   *
   * Check response.ok and return a 502 response if delivery fails.
   */
  console.log("Contact accepted; email delivery TODO is not implemented yet.");
  return json({ ok: true });
}

async function verifyTurnstile(token, secret) {
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: token })
    });

    if (!response.ok) {
      console.error(`Turnstile verification returned HTTP ${response.status}.`);
      return false;
    }

    const result = await response.json();
    return result.success === true;
  } catch (error) {
    console.error("Turnstile verification failed.", error);
    return false;
  }
}

async function handleFeedbackPost(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Request body must be valid JSON." }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, error: "Request body must be a JSON object." }, 400);
  }

  const { message, category, email, company } = body;

  // Silently accept and discard submissions that fill the honeypot.
  if (typeof company === "string" ? company.trim() : Boolean(company)) {
    return json({ ok: true });
  }

  const cleanMessage = typeof message === "string" ? message.trim() : "";
  const cleanCategory = typeof category === "string" ? category.trim() || null : null;
  const cleanEmail = typeof email === "string" ? email.trim() || null : null;

  if (!cleanMessage) {
    return json({ ok: false, error: "Message is required." }, 400);
  }

  if (typeof message === "string" && message.length > 5000) {
    return json({ ok: false, error: "Message must be 5000 characters or fewer." }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  // Windows are only 10 or 60 seconds; counters are per Cloudflare location,
  // eventually consistent, and intentionally not an accurate accounting system.
  const { success } = await env.FEEDBACK_LIMITER.limit({ key: ip });

  if (!success) {
    return json({ ok: false, error: "Too many feedback submissions. Please try again later." }, 429);
  }

  const turnstileSecret = env.TURNSTILE_SECRET_KEY;

  if (turnstileSecret) {
    const rawToken = body["cf-turnstile-response"] ?? body.turnstileToken;
    const token = typeof rawToken === "string" ? rawToken.trim() : "";

    if (!token || !(await verifyTurnstile(token, turnstileSecret))) {
      return json({ ok: false, error: "Turnstile verification failed." }, 403);
    }
  } else {
    console.warn("Turnstile verification skipped; TURNSTILE_SECRET_KEY is not configured.");
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
        return handleFeedbackPost(request, env);
      }

      return json({ ok: false, error: "Method not allowed." }, 405);
    }

    return env.ASSETS.fetch(request);
  }
};
