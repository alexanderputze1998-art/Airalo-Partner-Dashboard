# 🌐 Airalo × Shopify – Automatischer eSIM Server

Wenn ein Kunde in deinem Shopify-Shop eine eSIM kauft, bestellt dieser Server
automatisch die eSIM bei Airalo und schickt dem Kunden eine E-Mail mit dem
QR-Code und Installationsanleitung.

---

## 🏗 Wie es funktioniert

```
Kunde kauft eSIM
      ↓
Shopify sendet Webhook (order/paid)
      ↓
Dieser Server empfängt den Webhook
      ↓
Airalo API → eSIM wird bestellt
      ↓
QR-Code + Installationslink per E-Mail an Kunden
```

---

## 🚀 Deployment auf Railway (kostenlos, 5 Minuten)

### Schritt 1 – GitHub Repository erstellen

1. Gehe zu **github.com** → **New Repository**
2. Name: `airalo-shopify-server`
3. Privat stellen ✅
4. Erstellen

Dann lade diese Dateien hoch:
- `server.js`
- `package.json`
- `.gitignore`
- `.env.example`

> ⚠️ Die `.env` Datei **NIEMALS** hochladen!

---

### Schritt 2 – Railway einrichten

1. Gehe zu **railway.app** → mit GitHub anmelden
2. **New Project** → **Deploy from GitHub repo**
3. Dein `airalo-shopify-server` Repository auswählen
4. Railway erkennt automatisch Node.js und deployt

---

### Schritt 3 – Environment Variables auf Railway setzen

Im Railway Dashboard → dein Projekt → **Variables** → folgende eintragen:

| Variable | Wert |
|----------|------|
| `AIRALO_CLIENT_ID` | Aus dem Airalo Partner Portal |
| `AIRALO_CLIENT_SECRET` | Aus dem Airalo Partner Portal |
| `SHOPIFY_WEBHOOK_SECRET` | Aus Shopify Admin (kommt später) |
| `SMTP_HOST` | z.B. `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `false` |
| `SMTP_USER` | Deine E-Mail-Adresse |
| `SMTP_PASS` | Dein E-Mail-Passwort / App-Passwort |
| `SHOP_NAME` | Name deines Shops |
| `SUPPORT_EMAIL` | Deine Support-E-Mail |
| `DASHBOARD_API_KEY` | Langer zufälliger String (dein Passwort) |

Nach dem Speichern startet Railway den Server neu. Du bekommst eine URL wie:
`https://airalo-shopify-server-production-xxxx.railway.app`

**Das ist deine Server-URL – notiere sie!**

---

### Schritt 4 – Shopify Webhook einrichten

1. Shopify Admin → **Settings** → **Notifications**
2. Ganz unten: **Webhooks** → **Create webhook**
3. Einstellungen:
   - **Event:** `Order payment`
   - **Format:** `JSON`
   - **URL:** `https://DEINE-RAILWAY-URL/webhook/order-paid`
4. Speichern
5. Den **Webhook Signing Secret** kopieren
6. Diesen als `SHOPIFY_WEBHOOK_SECRET` in Railway eintragen

---

### Schritt 5 – Shopify Produkte vorbereiten

**Das ist der wichtigste Schritt!**

Für jedes eSIM-Produkt in deinem Shop:

1. Shopify Admin → **Products** → Produkt öffnen
2. Runterscrollen zu **Variants** oder direkt zum Produkt
3. Das **SKU Feld** = die Airalo Package-ID

Beispiele:
| Produkt | SKU (= Airalo Package-ID) |
|---------|--------------------------|
| Deutschland 1GB 7 Tage | `change-7days-1gb` |
| Europa 3GB 30 Tage | `europe-30days-3gb` |
| USA 5GB 15 Tage | `change-15days-5gb` |

Die Package-IDs findest du im Packages-Tab deines Dashboards.

---

### Schritt 6 – Testen

1. Öffne `https://DEINE-RAILWAY-URL/` im Browser
   → Du siehst: `{"status":"✅ Server läuft"}`
   
2. In Shopify Admin → Webhooks → **Send test notification**
   → Im Railway Log siehst du die Verarbeitung

3. Echte Testbestellung aufgeben (oder Airalo Sandbox-Modus nutzen)

---

## 📧 E-Mail Setup (Gmail)

Für Gmail brauchst du ein **App-Passwort** (kein normales Passwort):

1. Google Account → **Sicherheit** → **2-Schritt-Verifizierung** aktivieren
2. Dann: **App-Passwörter** → **Mail** → **Windows-Computer**
3. Das 16-stellige Passwort als `SMTP_PASS` eintragen

---

## 🔧 Eigenes Dashboard verbinden

Die Dashboard-App (airalo-shopify-dashboard.jsx) kannst du so verbinden:

Statt direkt zur Airalo API zu zeigen, zeige auf deinen Server:
- Base URL: `https://DEINE-RAILWAY-URL`
- API Key Header: `x-api-key: DEIN_DASHBOARD_API_KEY`

---

## ❓ Häufige Fragen

**Was passiert wenn die Bestellung fehlschlägt?**
Der Fehler wird geloggt. Du siehst es im Railway Dashboard → Logs.
Empfehlung: Richte Railway Alerts ein oder check die Logs täglich.

**Kann ich mehrere eSIMs in einer Bestellung verkaufen?**
Ja! Der Server verarbeitet automatisch alle Artikel (line_items) einer Bestellung.

**Was ist der Sandbox-Modus?**
Im Airalo Partner Portal kannst du auf Sandbox umschalten – dann werden keine echten eSIMs bestellt. Perfekt zum Testen.

**Wie sehe ich die Logs?**
Railway Dashboard → dein Projekt → **Deployments** → **View Logs**
