const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });

export async function onRequestPost({ request, env }) {
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

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Allow": "POST, OPTIONS"
    }
  });
}

export function onRequest() {
  return json({ ok: false, error: "Method not allowed." }, 405);
}
