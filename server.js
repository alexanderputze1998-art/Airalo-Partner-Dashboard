// ============================================================
//  Airalo × Shopify – Automatischer eSIM Server
//  Autor: Dein Shop-Backend
//  Deploy auf: Railway.app (kostenlos)
// ============================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
app.use(cors());
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

// ── E-Mail senden via Resend ──────────────────────────────
async function sendViaResend(to, subject, html, text) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY nicht gesetzt");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${process.env.SHOP_NAME || "For You eSIM"} <${process.env.FROM_EMAIL || process.env.SMTP_USER}>`,
      to: [to],
      subject,
      html: html || `<p>${text}</p>`,
      text: text || "",
      reply_to: process.env.SMTP_USER,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Resend Error: ${JSON.stringify(data)}`);
  console.log(`📧 E-Mail via Resend gesendet an: ${to} (ID: ${data.id})`);
  return data;
}


async function sendEsimEmail(customerEmail, customerName, orderNumber, esims) {

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

  await sendViaResend(
    customerEmail,
    `✅ Deine eSIM zur Bestellung #${orderNumber}`,
    html
  );

  console.log(`📧 E-Mail gesendet an: ${customerEmail}`);
}

// ============================================================
//  HUBSPOT API CLIENT
// ============================================================

async function hubspotRequest(method, path, body = null) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) { console.warn("⚠ HUBSPOT_TOKEN nicht gesetzt"); return null; }

  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return { success: true };
  const data = await res.json();
  if (!res.ok) throw new Error(`HubSpot Error: ${JSON.stringify(data)}`);
  return data;
}

// Kontakt anlegen oder aktualisieren
async function hubspotUpsertContact(email, firstName, lastName, phone) {
  if (!email) return null;
  try {
    const properties = {
      email,
      firstname: firstName || "",
      lastname: lastName || "",
      phone: phone || "",
      company: "For You eSIM Kunde",
    };

    // Erst suchen ob Kontakt existiert
    const search = await hubspotRequest("POST", "/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
    });

    if (search?.results?.length > 0) {
      const contactId = search.results[0].id;
      await hubspotRequest("PATCH", `/crm/v3/objects/contacts/${contactId}`, { properties });
      console.log(`👤 HubSpot Kontakt aktualisiert: ${email}`);
      return contactId;
    } else {
      const created = await hubspotRequest("POST", "/crm/v3/objects/contacts", { properties });
      console.log(`👤 HubSpot Kontakt angelegt: ${email}`);
      return created?.id;
    }
  } catch (err) {
    console.error("❌ HubSpot Kontakt Fehler:", err.message);
    return null;
  }
}

// Deal anlegen
async function hubspotCreateDeal(contactId, orderNumber, amount, items, status = "Bestellung eingegangen") {
  try {
    const deal = await hubspotRequest("POST", "/crm/v3/objects/deals", {
      properties: {
        dealname: `eSIM Bestellung #${orderNumber}`,
        amount: amount,
        dealstage: "appointmentscheduled",
        pipeline: "default",
        closedate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        description: items.map(i => `${i.title} (SKU: ${i.sku}) × ${i.quantity}`).join("\n"),
      },
    });

    // Deal mit Kontakt verknüpfen
    if (contactId && deal?.id) {
      await hubspotRequest("PUT", `/crm/v3/objects/deals/${deal.id}/associations/contacts/${contactId}/deal_to_contact`);
    }

    console.log(`💼 HubSpot Deal angelegt: #${orderNumber}`);
    return deal?.id;
  } catch (err) {
    console.error("❌ HubSpot Deal Fehler:", err.message);
    return null;
  }
}

// Notiz/Aktivität hinzufügen
async function hubspotAddNote(contactId, dealId, text) {
  try {
    const note = await hubspotRequest("POST", "/crm/v3/objects/notes", {
      properties: {
        hs_note_body: text,
        hs_timestamp: new Date().toISOString(),
      },
    });

    if (note?.id) {
      if (contactId) {
        await hubspotRequest("PUT", `/crm/v3/objects/notes/${note.id}/associations/contacts/${contactId}/note_to_contact`).catch(() => {});
      }
      if (dealId) {
        await hubspotRequest("PUT", `/crm/v3/objects/notes/${note.id}/associations/deals/${dealId}/note_to_deal`).catch(() => {});
      }
    }
    console.log("📝 HubSpot Notiz hinzugefügt");
    return note?.id;
  } catch (err) {
    console.error("❌ HubSpot Notiz Fehler:", err.message);
    return null;
  }
}

// Kompletter HubSpot Sync nach Bestellung
async function hubspotSyncOrder(order, esims) {
  if (!process.env.HUBSPOT_TOKEN) return;
  try {
    console.log("🔄 HubSpot Sync gestartet...");

    const firstName = order.billing_address?.first_name || order.customer?.first_name || "";
    const lastName = order.billing_address?.last_name || order.customer?.last_name || "";
    const phone = order.billing_address?.phone || order.customer?.phone || "";
    const amount = order.total_price || "0";

    // 1. Kontakt anlegen/aktualisieren
    const contactId = await hubspotUpsertContact(order.email, firstName, lastName, phone);

    // 2. Deal anlegen
    const dealId = await hubspotCreateDeal(
      contactId,
      order.order_number,
      amount,
      order.line_items || []
    );

    // 3. Notiz mit eSIM-Details
    const esimDetails = esims.map(e => `ICCID: ${e.iccid}`).join("\n");
    await hubspotAddNote(
      contactId,
      dealId,
      `✅ eSIM Bestellung erfolgreich\nShopify Order: #${order.order_number}\n${esimDetails}\nE-Mail gesendet an: ${order.email}`
    );

    console.log("✅ HubSpot Sync abgeschlossen");
  } catch (err) {
    console.error("❌ HubSpot Sync Fehler:", err.message);
  }
}



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

      // 4. HubSpot Sync (im Hintergrund)
      hubspotSyncOrder(order, allEsims).catch(err =>
        console.error("HubSpot Sync Fehler:", err.message)
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

// ── Einzelne Bestellung abrufen ───────────────────────────
app.get("/api/orders/:id", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const data = await airaloRequest("GET", `/v2/orders/${req.params.id}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Refund beantragen ─────────────────────────────────────
app.post("/api/refund", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { order_id, iccid, reason, comment, customer_email, shopify_order } = req.body;
  if (!iccid && !order_id) return res.status(400).json({ error: "iccid oder order_id fehlt" });

  // Korrekte Airalo Refund-Gründe laut API Dokumentation
  const reasonMap = {
    "Kundenwunsch": "TRIP_CANCELLATION",
    "Customer request": "TRIP_CANCELLATION",
    "Technisches Problem": "INSTALLATION_FAILURE",
    "Technical issue": "INSTALLATION_FAILURE",
    "Falsches Produkt bestellt": "WRONG_PURCHASE",
    "Wrong product": "WRONG_PURCHASE",
    "Doppelte Bestellung": "WRONG_PURCHASE",
    "Duplicate order": "WRONG_PURCHASE",
    "Keine Netzabdeckung": "NO_COVERAGE",
    "Gerät nicht kompatibel": "INCOMPATIBLE_DEVICE",
    "Sonstiges": "OTHERS",
    "Other": "OTHERS",
  };
  const airaloReason = reasonMap[reason] || "OTHERS";

  try {
    console.log(`↩ Refund beantragt für ICCID ${iccid}: ${airaloReason}`);

    // ICCID holen falls nur Order ID angegeben
    let iccidToRefund = iccid;
    if (!iccidToRefund && order_id) {
      const orderData = await airaloRequest("GET", `/v2/orders/${order_id}`);
      const sims = orderData?.data?.sims || [];
      if (sims.length > 0) iccidToRefund = sims[0].iccid;
    }

    if (!iccidToRefund) {
      return res.status(400).json({ error: "Keine ICCID für diese Bestellung gefunden" });
    }

    const data = await airaloRequest("POST", "/v2/refund", {
      iccids: [iccidToRefund],
      reason: airaloReason,
      notes: comment || (airaloReason === "OTHERS" ? "Customer refund request" : undefined),
    });

    // HubSpot Notiz über Refund
    if (customer_email) {
      const search = await hubspotRequest("POST", "/crm/v3/objects/contacts/search", {
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: customer_email }] }],
      }).catch(() => null);
      const contactId = search?.results?.[0]?.id;
      await hubspotAddNote(
        contactId, null,
        `↩ REFUND beantragt\nICCID: ${iccidToRefund}\nAiralo Order: #${order_id}\nShopify Order: ${shopify_order || "–"}\nGrund: ${reason}\nKommentar: ${comment || "–"}\n⚠ Manuelle Rückerstattung in Shopify erforderlich!`
      ).catch(() => {});
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HubSpot Kontakte abrufen ──────────────────────────────
app.get("/api/hubspot/contacts", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  try {
    const data = await hubspotRequest("GET", "/crm/v3/objects/contacts?limit=20&properties=email,firstname,lastname,phone");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HubSpot Kontakt suchen ────────────────────────────────
app.post("/api/hubspot/search-contact", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  const { email } = req.body;
  try {
    const data = await hubspotRequest("POST", "/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", "firstname", "lastname", "phone", "createdate"],
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HubSpot Deals abrufen ─────────────────────────────────
app.get("/api/hubspot/deals", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  try {
    const data = await hubspotRequest("GET", "/crm/v3/objects/deals?limit=20&properties=dealname,amount,dealstage,closedate,description");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HubSpot Manueller Sync ────────────────────────────────
app.post("/api/hubspot/sync", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  const { email, firstName, lastName, phone, orderNumber, amount, note } = req.body;
  try {
    const contactId = await hubspotUpsertContact(email, firstName, lastName, phone);
    if (note && contactId) {
      await hubspotAddNote(contactId, null, note);
    }
    res.json({ success: true, contactId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── eSIM E-Mail nach manueller Dashboard-Bestellung ───────
app.post("/api/email/send-esim", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: "Unauthorized" });

  const { to, name, esims, orderDesc, packageTitle } = req.body;
  if (!to || !esims?.length) return res.status(400).json({ error: "to und esims fehlen" });

  try {
    const esimHtml = esims.map((esim, i) => `
      <div style="background:#f8f9fa;border-radius:10px;padding:16px;margin-bottom:12px;border:1px solid #e9ecef">
        <div style="font-weight:700;color:#1a1a2e;margin-bottom:10px">
          eSIM ${esims.length > 1 ? `${i + 1} von ${esims.length}` : ''}
        </div>
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:5px 0;color:#666;font-size:13px;width:140px">ICCID:</td>
            <td style="padding:5px 0;font-weight:700;font-size:13px;font-family:monospace;color:#1a1a2e">${esim.iccid || '–'}</td>
          </tr>
          ${esim.lpa ? `<tr>
            <td style="padding:5px 0;color:#666;font-size:13px">SM-DP+ Adresse:</td>
            <td style="padding:5px 0;font-weight:700;font-size:12px;font-family:monospace;color:#1a1a2e">${esim.lpa}</td>
          </tr>` : ''}
          ${esim.matching_id ? `<tr>
            <td style="padding:5px 0;color:#666;font-size:13px">Aktivierungscode:</td>
            <td style="padding:5px 0;font-weight:700;font-family:monospace;color:#1a1a2e">${esim.matching_id}</td>
          </tr>` : ''}
        </table>
        ${esim.qrcode_url ? `
          <div style="text-align:center;margin-top:14px">
            <p style="color:#666;font-size:12px;margin-bottom:8px">QR-Code scannen zur Installation:</p>
            <img src="${esim.qrcode_url}" alt="eSIM QR Code" style="width:160px;height:160px">
          </div>` : ''}
        ${esim.sharing?.link ? `
          <div style="text-align:center;margin-top:14px">
            <a href="${esim.sharing.link}" style="display:inline-block;background:linear-gradient(135deg,#00d4aa,#0099ff);color:#000;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px">
              📱 eSIM installieren
            </a>
          </div>` : ''}
      </div>`).join('');

    const html = `
      <!DOCTYPE html><html><head><meta charset="utf-8"></head>
      <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a2e">
        <div style="text-align:center;margin-bottom:28px">
          <div style="display:inline-block;background:linear-gradient(135deg,#00d4aa,#0099ff);border-radius:12px;padding:14px 24px;color:#000;font-size:20px;font-weight:900">
            eSIM bereit! 🎉
          </div>
        </div>
        <p style="font-size:16px">Hallo ${name || ''},</p>
        <p style="color:#444;line-height:1.6">deine <strong>${packageTitle || 'eSIM'}</strong> ist jetzt einsatzbereit.</p>
        ${esimHtml}
        <div style="background:#fff3cd;border-radius:8px;padding:14px;margin-top:20px;border-left:4px solid #ffc107">
          <strong>⚠️ Wichtig:</strong>
          <ul style="margin:8px 0 0;padding-left:20px;color:#555;font-size:13px;line-height:1.8">
            <li>Die eSIM kann nur <strong>einmal</strong> installiert werden</li>
            <li>Aktiviere die eSIM erst kurz vor der Reise</li>
            <li>Datenroaming im Gerät aktivieren</li>
          </ul>
        </div>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#999;font-size:12px;text-align:center">
          ${process.env.SHOP_NAME || "For You eSIM"} · ${process.env.SUPPORT_EMAIL || process.env.SMTP_USER}
        </p>
      </body></html>`;

    await sendViaResend(to, `✅ Deine eSIM – ${packageTitle || orderDesc || 'Bestellung'}`, html);
    console.log(`📧 eSIM E-Mail via Dashboard gesendet an: ${to}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Rechnung versenden ────────────────────────────────────
app.post("/api/email/send-invoice", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: "Unauthorized" });

  const { to, name, invoiceNo, items, orderRef } = req.body;
  if (!to || !items?.length) return res.status(400).json({ error: "to und items fehlen" });

  try {
    const subtotal = items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    const tax = subtotal * 0.19;
    const total = subtotal + tax;
    const today = new Date().toLocaleDateString('de', { day:'2-digit', month:'2-digit', year:'numeric' });

    const itemsHtml = items.map(item => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px">${item.description}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:center">${item.quantity}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right">€${parseFloat(item.price).toFixed(2)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;font-weight:700">€${(item.price * item.quantity).toFixed(2)}</td>
      </tr>`).join('');

    const html = `
      <!DOCTYPE html><html><head><meta charset="utf-8"></head>
      <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:650px;margin:0 auto;padding:20px;color:#1a1a2e">

        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;flex-wrap:wrap;gap:16px">
          <div>
            <div style="font-size:24px;font-weight:900;color:#1a1a2e">${process.env.SHOP_NAME || "For You eSIM"}</div>
            <div style="color:#666;font-size:13px;margin-top:4px">${process.env.SUPPORT_EMAIL || ''}</div>
            <div style="color:#666;font-size:13px">fouryouesim.de</div>
          </div>
          <div style="text-align:right">
            <div style="background:linear-gradient(135deg,#00d4aa,#0099ff);color:#000;font-weight:900;font-size:18px;padding:8px 16px;border-radius:8px;display:inline-block">
              RECHNUNG
            </div>
            <div style="margin-top:8px;font-size:13px;color:#666">Nr. ${invoiceNo}</div>
            <div style="font-size:13px;color:#666">Datum: ${today}</div>
          </div>
        </div>

        <!-- Kunde -->
        <div style="background:#f8f9fa;border-radius:10px;padding:16px;margin-bottom:24px">
          <div style="font-size:11px;color:#999;margin-bottom:6px;letter-spacing:1px">RECHNUNGSEMPFÄNGER</div>
          <div style="font-weight:700;font-size:15px">${name || to}</div>
          <div style="color:#666;font-size:13px">${to}</div>
          ${orderRef ? `<div style="color:#666;font-size:13px;margin-top:4px">Referenz: ${orderRef}</div>` : ''}
        </div>

        <!-- Positionen -->
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
          <thead>
            <tr style="background:#1a1a2e;color:#fff">
              <th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:700;border-radius:8px 0 0 0">BESCHREIBUNG</th>
              <th style="padding:10px 12px;text-align:center;font-size:12px;font-weight:700">MENGE</th>
              <th style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700">EINZELPREIS</th>
              <th style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700;border-radius:0 8px 0 0">GESAMT</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>

        <!-- Summen -->
        <div style="display:flex;justify-content:flex-end">
          <div style="width:260px">
            <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#666">
              <span>Nettobetrag:</span><span>€${subtotal.toFixed(2)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#666">
              <span>MwSt. 19%:</span><span>€${tax.toFixed(2)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:10px 12px;background:linear-gradient(135deg,#00d4aa,#0099ff);border-radius:8px;margin-top:6px">
              <span style="font-weight:900;color:#000;font-size:15px">GESAMT:</span>
              <span style="font-weight:900;color:#000;font-size:15px">€${total.toFixed(2)}</span>
            </div>
          </div>
        </div>

        <!-- Zahlungsinfo -->
        <div style="background:#f0fff4;border-radius:8px;padding:14px;margin-top:24px;border-left:4px solid #00d4aa">
          <div style="font-weight:700;font-size:13px;margin-bottom:6px">Zahlungsinformation</div>
          <div style="font-size:12px;color:#555;line-height:1.7">
            Vielen Dank für Ihren Kauf bei ${process.env.SHOP_NAME || "For You eSIM"}.<br>
            Zahlung wurde bereits bei Bestellung verarbeitet.
          </div>
        </div>

        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#999;font-size:11px;text-align:center">
          ${process.env.SHOP_NAME || "For You eSIM"} · fouryouesim.de · ${process.env.SUPPORT_EMAIL || ''}
        </p>
      </body></html>`;

    await sendViaResend(to, `🧾 Rechnung ${invoiceNo} – ${process.env.SHOP_NAME || "For You eSIM"}`, html);
    console.log(`🧾 Rechnung ${invoiceNo} gesendet an: ${to}`);
    res.json({ success: true, invoiceNo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── E-Mail senden (Dashboard) via Resend ─────────────────
app.post("/api/email/send", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: "Unauthorized" });

  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: "to, subject, body fehlen" });

  try {
    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;line-height:1.6">
        ${body.replace(/\n/g, '<br>').replace(/•/g, '&bull;')}
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#999;font-size:12px">
          ${process.env.SHOP_NAME || "For You eSIM"} · 
          <a href="mailto:${process.env.SMTP_USER}" style="color:#00d4aa">${process.env.SMTP_USER}</a>
        </p>
      </div>`;
    await sendViaResend(to, subject, html, body);
    console.log(`📧 Dashboard E-Mail via Resend gesendet an: ${to}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── E-Mail Posteingang (IMAP) ─────────────────────────────
app.get("/api/email/inbox", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: "Unauthorized" });

  try {
    const Imap = require("imap");
    const { simpleParser } = require("mailparser");

    const imap = new Imap({
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASS,
      host: process.env.IMAP_HOST || "imap.ionos.de",
      port: parseInt(process.env.IMAP_PORT || "993"),
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    const emails = await new Promise((resolve, reject) => {
      const results = [];
      const promises = [];

      imap.once("ready", () => {
        imap.openBox("INBOX", false, (err, box) => {
          if (err) { imap.end(); return reject(err); }
          const total = box.messages.total;
          if (total === 0) { imap.end(); return resolve([]); }
          const start = Math.max(1, total - 19);

          const fetch = imap.seq.fetch(`${start}:${total}`, {
            bodies: "",  // ganze E-Mail holen
            struct: true,
          });

          fetch.on("message", (msg) => {
            const p = new Promise((res2) => {
              let buffer = "";
              msg.on("body", (stream) => {
                stream.on("data", (chunk) => buffer += chunk.toString("utf8"));
              });
              msg.once("end", async () => {
                try {
                  const parsed = await simpleParser(buffer);
                  // Vorschau aus Text extrahieren
                  const preview = (parsed.text || "")
                    .replace(/\r?\n/g, " ")
                    .replace(/\s+/g, " ")
                    .trim()
                    .substring(0, 150);

                  results.push({
                    from: parsed.from?.text || "–",
                    subject: parsed.subject || "(kein Betreff)",
                    date: parsed.date ? new Date(parsed.date).toLocaleDateString("de", {
                      day: "2-digit", month: "2-digit", year: "numeric",
                      hour: "2-digit", minute: "2-digit"
                    }) : "–",
                    preview: preview || "(kein Inhalt)",
                    read: true,
                  });
                } catch(e) {
                  results.push({ from: "–", subject: "(Fehler)", date: "–", preview: e.message, read: true });
                }
                res2();
              });
            });
            promises.push(p);
          });

          fetch.once("end", async () => {
            await Promise.all(promises);
            imap.end();
          });
        });
      });

      imap.once("end", () => resolve(results.reverse()));
      imap.once("error", reject);
      imap.connect();
    });

    res.json({ emails });
  } catch (err) {
    res.status(500).json({ error: "IMAP Fehler: " + err.message });
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
//  ZADARMA TELEFONIE API
// ============================================================

const ZADARMA_BASE = "https://api.zadarma.com";

async function zadarmaRequest(method, path, params = {}) {
  const key = process.env.ZADARMA_KEY;
  const secret = process.env.ZADARMA_SECRET;
  if (!key || !secret) throw new Error("ZADARMA_KEY oder ZADARMA_SECRET nicht gesetzt");

  const crypto = require("crypto");

  // Parameter alphabetisch sortieren
  const sortedParams = Object.keys(params).sort().reduce((acc, k) => {
    acc[k] = params[k];
    return acc;
  }, {});

  const paramStr = new URLSearchParams(sortedParams).toString();

  // Zadarma Signatur: HMAC-SHA1 von (path + paramStr + MD5(paramStr))
  const md5Hash = crypto.createHash("md5").update(paramStr).digest("hex");
  const signData = path + paramStr + md5Hash;
  const signature = crypto.createHmac("sha1", secret).update(signData).digest("base64");

  const authHeader = `${key}:${signature}`;
  const url = `${ZADARMA_BASE}${path}${paramStr ? '?' + paramStr : ''}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": authHeader,
      "Accept": "application/json",
    },
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { status: "error", message: text }; }
  if (data.status === "error") throw new Error(`Zadarma: ${data.message}`);
  return data;
}

async function zadarmaPost(path, params = {}) {
  const key = process.env.ZADARMA_KEY;
  const secret = process.env.ZADARMA_SECRET;
  if (!key || !secret) throw new Error("ZADARMA_KEY oder ZADARMA_SECRET nicht gesetzt");

  const crypto = require("crypto");

  const sortedParams = Object.keys(params).sort().reduce((acc, k) => {
    acc[k] = params[k];
    return acc;
  }, {});

  const paramStr = new URLSearchParams(sortedParams).toString();
  const md5Hash = crypto.createHash("md5").update(paramStr).digest("hex");
  const signData = path + paramStr + md5Hash;
  const signature = crypto.createHmac("sha1", secret).update(signData).digest("base64");

  const res = await fetch(`${ZADARMA_BASE}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `${key}:${signature}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: paramStr,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { status: "error", message: text }; }
  if (data.status === "error") throw new Error(`Zadarma: ${data.message}`);
  return data;
}

// ── Zadarma Signatur (für Browser-Requests) ───────────────
app.post("/api/zadarma/sign", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: "Unauthorized" });

  const { path, params } = req.body;
  const key = process.env.ZADARMA_KEY;
  const secret = process.env.ZADARMA_SECRET;
  if (!key || !secret) return res.status(500).json({ error: "ZADARMA_KEY/SECRET nicht gesetzt" });

  const crypto = require("crypto");
  const sortedKeys = Object.keys(params || {}).sort();
  const paramStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
  const md5Hash = crypto.createHash("md5").update(paramStr).digest("hex");
  const signData = path + paramStr + md5Hash;
  const signature = crypto.createHmac("sha1", secret).update(signData).digest("base64");

  res.json({ signature, key, paramStr });
});

// ── Zadarma Status & Guthaben ─────────────────────────────
app.get("/api/zadarma/status", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  try {
    const data = await zadarmaRequest("GET", "/v1/info/balance/", {});
    res.json({ balance: data.balance, currency: data.currency, calls_today: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Click-to-Call ─────────────────────────────────────────
app.post("/api/zadarma/call", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  const { number, from } = req.body;
  if (!number) return res.status(400).json({ error: "number fehlt" });
  try {
    const data = await zadarmaRequest("GET", "/v1/request/callback/", {
      from: from || process.env.ZADARMA_INTERNAL || "100",
      to: number,
    });
    console.log(`📞 Zadarma Click-to-Call: ${from} → ${number}`);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Anruf-Log ─────────────────────────────────────────────
app.get("/api/zadarma/calls", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  try {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 30);
    const fmt = (d) => d.toISOString().replace("T", " ").substring(0, 19);
    const data = await zadarmaRequest("GET", "/v1/statistics/pbx/", {
      start: fmt(start),
      end: fmt(today),
    });
    res.json({ stats: data.stats || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Server-Sent Events (Live Benachrichtigungen) ──────────
const notificationClients = new Set();

app.get("/api/notifications/stream", (req, res) => {
  const apiKey = req.query.key;
  if (apiKey !== process.env.DASHBOARD_API_KEY) return res.status(401).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Client registrieren
  notificationClients.add(res);
  console.log(`📡 SSE Client verbunden (${notificationClients.size} aktiv)`);

  // Ping alle 30 Sek um Verbindung offen zu halten
  const ping = setInterval(() => {
    res.write("data: {\"type\":\"ping\"}\n\n");
  }, 30000);

  req.on("close", () => {
    notificationClients.delete(res);
    clearInterval(ping);
    console.log(`📡 SSE Client getrennt (${notificationClients.size} aktiv)`);
  });
});

function pushNotification(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  notificationClients.forEach(client => {
    try { client.write(msg); } catch(e) { notificationClients.delete(client); }
  });
}

// ── Zadarma Webhook (eingehende Anrufe) ───────────────────
app.post("/webhook/zadarma", (req, res) => {
  const event = req.body;
  console.log("📞 Zadarma Webhook:", event.event, event.caller_id || event.clid || "");
  res.status(200).send("OK");

  if (event.event === "NOTIFY_START" || event.event === "NOTIFY_ANSWER") {
    const from = event.caller_id || event.clid || "Unbekannt";
    console.log(`📞 Eingehender Anruf von: ${from}`);
    // Live-Benachrichtigung an alle Dashboard-Clients
    pushNotification({
      type: "call",
      from,
      to: event.called_did || "",
      time: new Date().toLocaleTimeString("de"),
    });
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
  POST /webhook/zadarma     → Zadarma Anruf-Events
  GET  /api/packages        → Pakete abrufen
  POST /api/order           → Manuelle Bestellung
  GET  /api/esim/:iccid     → eSIM Status
  GET  /api/orders          → Bestellungen
  GET  /api/zadarma/status  → Zadarma Guthaben
  POST /api/zadarma/call    → Click-to-Call
  GET  /api/zadarma/calls   → Anruf-Log
  `);
});
