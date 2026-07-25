// Supabase Edge Function: send-email
//
// Called by the app (never directly by a browser without a valid login
// session). Verifies the caller is logged in AND listed in allowed_users,
// then relays the email through Brevo's HTTP API.
//
// The Brevo API key never reaches the browser — it's read here from an
// Edge Function secret (set with `supabase secrets set BREVO_API_KEY=...`).
//
// Deploy with:  supabase functions deploy send-email

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SENDER_EMAIL = "manish.ravikumar@gmail.com";
const SENDER_NAME = "KAN Membership";
const CC_EMAIL = "kantreasurer@gmail.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Not signed in." }, 401);
    }

    // Verify the caller with their own token (respects RLS / auth session).
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user?.email) {
      return jsonResponse({ error: "Not signed in." }, 401);
    }
    const callerEmail = userData.user.email;

    // Defense in depth: RLS already restricts DB access, but double-check
    // here too before we spend an email send on it.
    const { data: allowed, error: allowedErr } = await supabase
      .from("allowed_users")
      .select("email")
      .eq("email", callerEmail)
      .maybeSingle();

    if (allowedErr || !allowed) {
      return jsonResponse({ error: "You don't have access to send email from this app." }, 403);
    }

    const { to, subject, body } = await req.json();
    if (!to || !subject || !body) {
      return jsonResponse({ error: "Missing to, subject, or body." }, 400);
    }

    const brevoKey = Deno.env.get("BREVO_API_KEY");
    if (!brevoKey) {
      return jsonResponse({ error: "Server is missing its Brevo API key." }, 500);
    }

    const brevoResp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": brevoKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        sender: { email: SENDER_EMAIL, name: SENDER_NAME },
        to: [{ email: to }],
        cc: [{ email: CC_EMAIL }],
        subject,
        textContent: body,
        replyTo: { email: SENDER_EMAIL },
      }),
    });

    if (!brevoResp.ok) {
      const errText = await brevoResp.text();
      console.error("Brevo error:", errText);
      return jsonResponse({ error: "Brevo rejected the send.", detail: errText }, 502);
    }

    const brevoResult = await brevoResp.json();
    return jsonResponse({ ok: true, messageId: brevoResult.messageId, sentBy: callerEmail }, 200);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: "Unexpected server error.", detail: String(e) }, 500);
  }
});

function jsonResponse(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
