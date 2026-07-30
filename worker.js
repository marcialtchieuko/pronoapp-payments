const PLANS = {
  afrique: {
    weekly: { amount: 7000, currency: "XAF", days: 7 },
    monthly: { amount: 25000, currency: "XAF", days: 30 },
  },
  afrique_ouest: {
    weekly: { amount: 7000, currency: "XOF", days: 7 },
    monthly: { amount: 25000, currency: "XOF", days: 30 },
  },
  europe: {
    weekly: { amount: 11, currency: "EUR", days: 7 },
    monthly: { amount: 38, currency: "EUR", days: 30 },
  },
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

    if (url.pathname === "/confirm-payment" && request.method === "POST") {
      return handleConfirmPayment(request, env);
    }

    if (url.pathname === "/confirm-payment" && request.method === "GET") {
      const reference = url.searchParams.get("reference");
      return handleConfirmPayment(request, env, reference);
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};

async function handleCreatePayment(request, env) {
  try {
    const body = await request.json();
    const { plan, region, userId, email } = body || {};
    console.log("create-payment body reçu:", JSON.stringify(body));
    const regionKey = PLANS[region] ? region : "afrique";
    const planInfo = PLANS[regionKey][plan];
    console.log("regionKey retenue:", regionKey, "planInfo:", JSON.stringify(planInfo));

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
        currency: planInfo.currency,
        reference,
        description: `Abonnement VIP PronoApp - ${plan === "weekly" ? "Hebdomadaire" : "Mensuel"}`,
        callback: env.APP_URL,
        metadata: { user_id: userId, days: planInfo.days, plan, region: regionKey },
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
    console.log("webhook: signature invalide");
    return new Response("Invalid signature", { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  console.log("webhook reçu:", JSON.stringify(event));

  const data = event?.data || {};
  const reference = data.reference;
  const meta = data.metadata || {};
  const userId = meta.user_id;
  const days = Number(meta.days) || 0;
  const plan = meta.plan || null;

  if (!reference || !userId || !days) {
    console.log("webhook: donnees manquantes", { reference, userId, days });
    return new Response("OK", { status: 200 });
  }

  // Ne jamais faire confiance au seul contenu du webhook : on revérifie le
  // vrai statut directement aupres de NotchPay avant de débloquer quoi que ce soit.
  let realStatus = data.status;
  try {
    const verifyRes = await fetch(`https://api.notchpay.co/payments/${reference}`, {
      headers: {
        Authorization: env.NOTCHPAY_PUBLIC_KEY,
        Accept: "application/json",
      },
    });
    const verifyData = await verifyRes.json();
    console.log("verify status http:", verifyRes.status, "body:", JSON.stringify(verifyData));
    realStatus =
      verifyData?.transaction?.status || verifyData?.data?.status || verifyData?.status || realStatus;
  } catch (e) {
    console.log("verify a échoué:", e.message);
  }

  console.log("statut final retenu:", realStatus);

  if (SUCCESS_STATUSES.includes(realStatus)) {
    await unlockVip(env, userId, plan, days);
  }

  return new Response("OK", { status: 200 });
}

const SUCCESS_STATUSES = ["complete", "completed", "success", "successful"];

async function unlockVip(env, userId, plan, days) {
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const patchRes = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ vip_active: true, vip_plan: plan, vip_expires_at: expiresAt }),
  });
  console.log("maj supabase statut:", patchRes.status, await patchRes.text());
  return patchRes.ok;
}

async function handleConfirmPayment(request, env, refFromQuery) {
  try {
    let reference = refFromQuery;
    if (!reference) {
      const body = await request.json();
      reference = body?.reference;
    }
    if (!reference) {
      return json({ success: false, error: "reference manquante" }, 400);
    }

    const verifyRes = await fetch(`https://api.notchpay.co/payments/${reference}`, {
      headers: {
        Authorization: env.NOTCHPAY_PUBLIC_KEY,
        Accept: "application/json",
      },
    });
    const verifyData = await verifyRes.json();
    console.log("confirm-payment verify body:", JSON.stringify(verifyData));

    const tx = verifyData?.transaction || verifyData?.data || {};
    const status = tx.status;
    const meta = tx.metadata || {};
    const userId = meta.user_id;
    const days = Number(meta.days) || 0;
    const plan = meta.plan || null;

    if (SUCCESS_STATUSES.includes(status) && userId && days > 0) {
      const ok = await unlockVip(env, userId, plan, days);
      return json({ success: ok, status });
    }

    return json({ success: false, status: status || "unknown" });
  } catch (e) {
    return json({ success: false, error: "Erreur serveur" }, 500);
  }
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
