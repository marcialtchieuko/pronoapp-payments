const PLANS = {
  weekly: { amount: 7000, days: 7 },
  monthly: { amount: 25000, days: 30 },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/create-payment" && request.method === "POST") {
      return handleCreatePayment(request, env);
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};

async function handleCreatePayment(request, env) {
  try {
    const body = await request.json();
    const { plan, userId, email } = body || {};
    const planInfo = PLANS[plan];

    if (!planInfo || !userId || !email) {
      return json({ error: "Requête invalide" }, 400);
    }

    const reference = `pronoapp_${userId}_${Date.now()}`;

    const res = await fetch("https://api.notchpay.co/payments/initialize", {
      method: "POST",
      headers: {
        Authorization: env.NOTCHPAY_PUBLIC_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        email,
        amount: planInfo.amount,
        currency: "XAF",
        reference,
        description: `Abonnement VIP PronoApp - ${plan === "weekly" ? "Hebdomadaire" : "Mensuel"}`,
        callback: env.APP_URL,
        metadata: { user_id: userId, days: planInfo.days, plan },
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.authorization_url) {
      return json({ error: "Impossible d'initialiser le paiement", details: data }, 502);
    }

    return json({ authorization_url: data.authorization_url });
  } catch (err) {
    return json({ error: "Erreur serveur" }, 500);
  }
}

async function handleWebhook(request, env) {
  const payload = await request.text();
  const signature = request.headers.get("x-notch-signature") || "";

  const valid = await verifySignature(payload, signature, env.NOTCHPAY_WEBHOOK_HASH);
  if (!valid) {
    return new Response("Invalid signature", { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  const status = event?.data?.status;
  if (event?.event === "payment.complete" && status === "complete") {
    const meta = event.data.metadata || {};
    const userId = meta.user_id;
    const days = Number(meta.days) || 0;
    const plan = meta.plan || null;

    if (userId && days > 0) {
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ vip_active: true, vip_plan: plan, vip_expires_at: expiresAt }),
      });
    }
  }

  return new Response("OK", { status: 200 });
}

async function verifySignature(payload, signature, secret) {
  if (!secret || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === signature;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
