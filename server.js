import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { Resend } from 'resend';

const PORT = process.env.PORT || 3457;
const NETLIFY_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://nihongo-waitlist.netlify.app';

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Proxy-Trust (Railway) ─────────────────────────────────────────────────────
// Railway liegt hinter einem eigenen Reverse-Proxy und setzt:
//   X-Forwarded-For: <client-ip>[, gespoofter-wert-vom-attacker]
//   X-Real-IP:       <client-ip>   ← vom Proxy gesetzt, nicht überschreibbar
//
// Sicherheitsproblem mit trust proxy: 1 + X-Forwarded-For:
//   Angreifer schickt X-Forwarded-For: fake-ip →
//   Railway hängt echte IP an → "fake-ip, real-ip" →
//   Express mit trust proxy: 1 nimmt "fake-ip" als req.ip → Bypass möglich.
//
// Lösung: Wir NICHT trust proxy einsetzen, sondern einen eigenen
// IP-Resolver, der X-Real-IP bevorzugt (nur vom Proxy gesetzt).
// Fallback: rechteste IP aus X-Forwarded-For (von Railway gesetzt).
// Angreifer-kontrollierte Felder werden ignoriert.
function getRealIP(req) {
  // X-Real-IP: setzt Railway selbst, Clients können ihn nicht überschreiben
  const xRealIp = req.headers['x-real-ip'];
  if (xRealIp && /^[\d.]+$|^[0-9a-f:]+$/i.test(xRealIp.trim())) {
    return xRealIp.trim();
  }
  // Fallback: rechteste IP aus X-Forwarded-For (von Railway hinzugefügt)
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const ips = xff.split(',').map(s => s.trim());
    return ips[ips.length - 1]; // letzte = von Railway gesetzt
  }
  return req.socket.remoteAddress ?? 'unknown';
}

// ── Security middleware ───────────────────────────────────────────────────────

// CORS — nur die eigene Netlify-Domain + lokal
app.use(cors({
  origin: (origin, cb) => {
    const allowed = [NETLIFY_ORIGIN, 'http://localhost:3456', 'http://localhost:7842'];
    if (!origin || allowed.includes(origin)) return cb(null, true);
    cb(new Error('CORS: Origin nicht erlaubt'));
  }
}));

// Rate limiting — max 5 Signup-Versuche pro IP pro 15 Minuten
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte warte 15 Minuten.' },
  keyGenerator: (req) => getRealIP(req)   // spoofing-resistenter IP-Key
});

// Allgemeines Rate Limit — 60 req/min pro IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getRealIP(req)
});

app.use(generalLimiter);
app.use(express.json({ limit: '10kb' })); // Verhindert große Payload-Angriffe

// ── Email validation ──────────────────────────────────────────────────────────
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

// ── Resend Audience (persistenter Speicher) ───────────────────────────────────
let audienceId = process.env.RESEND_AUDIENCE_ID || null;

async function getOrCreateAudience() {
  if (audienceId) return audienceId;
  try {
    const list = await resend.audiences.list();
    const existing = list.data?.data?.find(a => a.name === 'Nihongo Waitlist');
    if (existing) {
      audienceId = existing.id;
    } else {
      const created = await resend.audiences.create({ name: 'Nihongo Waitlist' });
      audienceId = created.data?.id;
    }
    return audienceId;
  } catch (e) {
    console.error('[Audience]', e.message);
    return null;
  }
}

async function getCount() {
  try {
    const id = await getOrCreateAudience();
    if (!id) return 0;
    const contacts = await resend.contacts.list({ audienceId: id });
    return contacts.data?.data?.length ?? 0;
  } catch { return 0; }
}

async function addContact(email) {
  const id = await getOrCreateAudience();
  if (!id) throw new Error('Audience nicht verfügbar');
  // Resend gibt keinen Fehler bei Duplikaten zurück — sicher gegen Enumeration
  await resend.contacts.create({ audienceId: id, email, unsubscribed: false });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Debug: zeigt wie Railway die IP auflöst (nur während Pentest, dann entfernen)
app.get('/api/debug-ip', (req, res) => {
  res.json({
    resolvedKey: getRealIP(req),
    socketRemote: req.socket.remoteAddress,
    xRealIp: req.headers['x-real-ip'] ?? null,
    xForwardedFor: req.headers['x-forwarded-for'] ?? null,
    reqIp: req.ip
  });
});

app.get('/api/count', async (_req, res) => {
  res.json({ count: await getCount() });
});

app.post('/api/waitlist', signupLimiter, async (req, res) => {
  const { email } = req.body ?? {};

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Ungültige E-Mail-Adresse.' });
  }

  const clean = email.trim().toLowerCase();

  try {
    await addContact(clean);
  } catch (err) {
    console.error('[Contact]', err.message);
    // Trotzdem weiter — E-Mail senden (Duplikat-Enumeration verhindern)
  }

  // Bestätigungsmail
  try {
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'Nihongo <waitlist@nihongo.app>',
      to: clean,
      subject: 'Du bist auf der Nihongo-Warteliste 🎌',
      html: `
        <!DOCTYPE html>
        <html lang="de">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;padding:0;background:#0a1f2e;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a1f2e;padding:40px 20px">
            <tr><td align="center">
              <table width="520" cellpadding="0" cellspacing="0" style="background:#0f2535;border-radius:16px;overflow:hidden;border:1px solid rgba(45,139,139,.3)">
                <tr>
                  <td style="background:linear-gradient(135deg,#1A4F6B,#2D8B8B);padding:32px 40px;text-align:center">
                    <p style="margin:0;font-size:48px;line-height:1">語</p>
                    <h1 style="margin:12px 0 0;color:#fff;font-size:28px;font-weight:700">Nihongo</h1>
                    <p style="margin:4px 0 0;color:rgba(255,255,255,.7);font-size:13px;letter-spacing:.1em;text-transform:uppercase">Japanisch für Deutsche</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:36px 40px">
                    <h2 style="margin:0 0 12px;color:#fff;font-size:22px;font-weight:600">Du bist dabei. 🎉</h2>
                    <p style="margin:0 0 16px;color:#9bbfbf;font-size:15px;line-height:1.65">
                      Wir benachrichtigen dich, sobald Nihongo im App Store verfügbar ist.
                    </p>
                    <p style="margin:0;color:#6ea8a8;font-size:13px;line-height:1.6">
                      Eingetragen mit <strong style="color:#9bbfbf">${clean}</strong>.
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px 40px;border-top:1px solid rgba(45,139,139,.2);text-align:center">
                    <p style="margin:0;color:#4a7a7a;font-size:12px">
                      Nihongo · iOS · Bald verfügbar
                    </p>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `,
    });
  } catch (err) {
    console.error('[Resend]', err.message);
  }

  // Immer 200 zurück — verhindert E-Mail-Enumeration (409 würde verraten ob Adresse existiert)
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅  Nihongo Waitlist Backend läuft auf http://localhost:${PORT}`);
  await getOrCreateAudience();
  console.log(`    Audience ID: ${audienceId ?? 'wird beim ersten Signup erstellt'}`);
});
