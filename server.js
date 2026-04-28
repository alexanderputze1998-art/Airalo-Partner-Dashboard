// ============================================================
//  Airalo × Shopify – Automatischer eSIM Server
//  Autor: Dein Shop-Backend
//  Deploy auf: Railway.app (kostenlos)
// ============================================================

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// ── Raw Body für Shopify Webhook-Signatur ─────────────────
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ============================================================
//  AIRALO API CLIENT
// ============================================================

let cachedToken = null;
let tokenExpiry = 0;

async function getAiraloToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch("https://partners-api.airalo.com/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.AIRALO_CLIENT_ID,
      client_secret: process.env.AIRALO_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Airalo Auth Error: ${JSON.stringify(data)}`);

  cachedToken = data.data.access_token;
  // Token 1 Minute vor Ablauf erneuern
  tokenExpiry = Date.now() + (data.data.expires_in - 60) * 1000;
  console.log("✅ Airalo Token erneuert");
  return cachedToken;
}

async function airaloRequest(method, path, body = null) {
  const token = await getAiraloToken();
  const res = await fetch(`https://partners-api.airalo.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Airalo API Error: ${JSON.stringify(data)}`);
  return data;
}

// ── eSIM bestellen ────────────────────────────────────────
async function orderEsim(packageId, quantity, description) {
  console.log(`📦 Bestelle eSIM: ${packageId} × ${quantity}`);
  const result = await airaloRequest("POST", "/v2/orders", {
    package_id: packageId,
    quantity: quantity,
    type: "sim",
    description: description,
  });
  return result.data;
}

// ============================================================
//  E-MAIL VERSAND
// ============================================================

function createMailTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendEsimEmail(customerEmail, customerName, orderNumber, esims) {
  const transporter = createMailTransport();

  // HTML für jede eSIM
  const esimHtml = esims
    .map(
      (esim, i) => `
    <div style="background:#f8f9fa;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #e9ecef;">
      <h3 style="margin:0 0 12px 0;color:#1a1a2e;">eSIM ${i + 1} ${esims.length > 1 ? `von ${esims.length}` : ""}</h3>
      
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:6px 0;color:#666;font-size:13px;">ICCID:</td>
          <td style="padding:6px 0;font-weight:600;font-size:13px;font-family:monospace;">${esim.iccid}</td>
        </tr>
        ${esim.lpa ? `
        <tr>
          <td style="padding:6px 0;color:#666;font-size:13px;">SM-DP+ Adresse:</td>
          <td style="padding:6px 0;font-weight:600;font-size:13px;font-family:monospace;">${esim.lpa}</td>
        </tr>` : ""}
        ${esim.matching_id ? `
        <tr>
          <td style="padding:6px 0;color:#666;font-size:13px;">Aktivierungscode:</td>
          <td style="padding:6px 0;font-weight:600;font-size:13px;font-family:monospace;">${esim.matching_id}</td>
        </tr>` : ""}
      </table>

      ${esim.qrcode_url ? `
      <div style="margin-top:16px;text-align:center;">
        <p style="color:#666;font-size:13px;margin-bottom:8px;">QR-Code zum Scannen:</p>
        <img src="${esim.qrcode_url}" alt="eSIM QR Code" style="width:180px;height:180px;"/>
      </div>` : ""}

      ${esim.sharing?.link ? `
      <div style="margin-top:16px;text-align:center;">
        <a href="${esim.sharing.link}" 
           style="display:inline-block;background:linear-gradient(135deg,#00d4aa,#0099ff);color:#000;font-weight:700;
                  padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;">
          📱 eSIM installieren
        </a>
        ${esim.sharing.access_code ? `
        <p style="margin-top:8px;color:#666;font-size:12px;">
          Zugangscode: <strong style="font-family:monospace;">${esim.sharing.access_code}</strong>
        </p>` : ""}
      </div>` : ""}
    </div>
  `
    )
    .join("");

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a2e;">
      
      <div style="text-align:center;margin-bottom:32px;">
        <div style="display:inline-block;background:linear-gradient(135deg,#00d4aa,#0099ff);
                    border-radius:16px;padding:16px 24px;color:#000;font-size:22px;font-weight:900;">
          eSIM bereit! 🎉
        </div>
      </div>

      <p style="font-size:16px;">Hallo ${customerName || ""},</p>
      <p style="color:#444;line-height:1.6;">
        Deine Bestellung <strong>#${orderNumber}</strong> wurde erfolgreich verarbeitet. 
        Deine eSIM${esims.length > 1 ? "s sind" : " ist"} jetzt einsatzbereit.
      </p>

      ${esimHtml}

      <div style="background:#fff3cd;border-radius:8px;padding:16px;margin-top:24px;border-left:4px solid #ffc107;">
        <strong>⚠️ Wichtig:</strong>
        <ul style="margin:8px 0 0 0;padding-left:20px;color:#555;font-size:13px;line-height:1.8;">
          <li>Die eSIM kann nur <strong>einmal installiert</strong> werden</li>
          <li>Stelle sicher, dass dein Gerät eSIM-kompatibel ist</li>
          <li>Aktiviere die eSIM erst kurz vor der Reise</li>
          <li>Datenroaming im Gerät aktivieren nicht vergessen</li>
        </ul>
      </div>

      <hr style="border:none;border-top:1px solid #eee;margin:32px 0;">
      <p style="color:#999;font-size:12px;text-align:center;">
        ${process.env.SHOP_NAME || "Dein Shop"} · Bei Fragen: ${process.env.SUPPORT_EMAIL || process.env.SMTP_USER}
      </p>
    </body>
    </html>
  `;

  await transporter.sendMail({
    from: `"${process.env.SHOP_NAME || "eSIM Shop"}" <${process.env.SMTP_USER}>`,
    to: customerEmail,
    subject: `✅ Deine eSIM zur Bestellung #${orderNumber}`,
    html,
  });

  console.log(`📧 E-Mail gesendet an: ${customerEmail}`);
}

// ============================================================
//  SHOPIFY WEBHOOK VALIDIERUNG
// ============================================================

function verifyShopifyWebhook(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac) return false;

  const hash = crypto
    .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac));
}

// ============================================================
//  ROUTES
// ============================================================

// Health Check
app.get("/", (req, res) => {
  res.json({
    status: "✅ Server läuft",
    shop: process.env.SHOP_NAME || "eSIM Shop",
    version: "1.0.0",
  });
});

// ── Shopify Webhook: Order Paid ───────────────────────────
app.post("/webhook/order-paid", async (req, res) => {
  // 1. Webhook-Signatur prüfen
  if (!verifyShopifyWebhook(req)) {
    console.warn("❌ Ungültige Webhook-Signatur!");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Shopify erwartet sofortige 200-Antwort
  res.status(200).json({ received: true });

  const order = req.body;
  console.log(`\n🛍 Neue Bestellung #${order.order_number} von ${order.email}`);

  try {
    const allEsims = [];

    // 2. Alle Artikel der Bestellung verarbeiten
    for (const item of order.line_items || []) {
      const packageId = item.sku;

      if (!packageId) {
        console.log(`⚠️  Artikel "${item.title}" hat keine SKU – übersprungen`);
        continue;
      }

      console.log(`   → ${item.title} (SKU: ${packageId}) × ${item.quantity}`);

      try {
        const orderResult = await orderEsim(
          packageId,
          item.quantity,
          `Shopify #${order.order_number} – ${item.title}`
        );

        // eSIMs aus der Antwort extrahieren
        const esims = orderResult.sims || orderResult.esims || [];
        allEsims.push(...esims);

        console.log(`   ✅ ${esims.length} eSIM(s) bestellt`);
      } catch (err) {
        console.error(`   ❌ Fehler bei Artikel "${item.title}":`, err.message);
      }
    }

    // 3. E-Mail mit allen eSIMs senden
    if (allEsims.length > 0 && order.email) {
      const customerName =
        order.billing_address?.first_name ||
        order.customer?.first_name ||
        "";

      await sendEsimEmail(
        order.email,
        customerName,
        order.order_number,
        allEsims
      );
    } else if (allEsims.length === 0) {
      console.warn("⚠️  Keine eSIMs bestellt – keine E-Mail versendet");
    }
  } catch (err) {
    console.error("❌ Fehler bei Webhook-Verarbeitung:", err);
  }
});

// ── Manuelle eSIM-Bestellung (Dashboard) ─────────────────
app.post("/api/order", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { package_id, quantity = 1, description, email } = req.body;
  if (!package_id) return res.status(400).json({ error: "package_id fehlt" });

  try {
    const result = await orderEsim(package_id, quantity, description || "Manuelle Bestellung");

    if (email) {
      const esims = result.sims || result.esims || [];
      if (esims.length > 0) {
        await sendEsimEmail(email, "", "MANUELL", esims);
      }
    }

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pakete abrufen ────────────────────────────────────────
app.get("/api/packages", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { country, limit = 50 } = req.query;
    let path = `/v2/packages?limit=${limit}`;
    if (country) path += `&filter[country]=${country}`;
    const data = await airaloRequest("GET", path);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── eSIM Status abfragen ──────────────────────────────────
app.get("/api/esim/:iccid", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const data = await airaloRequest(
      "GET",
      `/v2/sims/${req.params.iccid}?include=order,order.status,share`
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── eSIM Liste abrufen ───────────────────────────────────
app.get("/api/esims", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const data = await airaloRequest("GET", "/v2/sims?limit=50");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bestellungen abrufen ──────────────────────────────────
app.get("/api/orders", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const data = await airaloRequest("GET", "/v2/orders?limit=50");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  SERVER STARTEN
// ============================================================

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   Airalo × Shopify Server           ║
║   Port: ${PORT}                         ║
║   Status: ✅ Bereit                  ║
╚══════════════════════════════════════╝

Endpoints:
  GET  /                    → Health Check
  POST /webhook/order-paid  → Shopify Webhook
  GET  /api/packages        → Pakete abrufen
  POST /api/order           → Manuelle Bestellung
  GET  /api/esim/:iccid     → eSIM Status
  GET  /api/orders          → Bestellungen
  `);
});
