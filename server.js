import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { config } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, '.env') });

import express from 'express';
import cors from 'cors';
import { Resend } from 'resend';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const WAITLIST_FILE = join(__dirname, 'waitlist.json');
const PORT = process.env.PORT || 3457;

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Helpers ──────────────────────────────────────────────────────────────────
function loadWaitlist() {
  if (!existsSync(WAITLIST_FILE)) return [];
  return JSON.parse(readFileSync(WAITLIST_FILE, 'utf-8'));
}

function saveWaitlist(list) {
  writeFileSync(WAITLIST_FILE, JSON.stringify(list, null, 2));
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/count  — liefert aktuelle Anzahl der Anmeldungen
app.get('/api/count', (_req, res) => {
  res.json({ count: loadWaitlist().length });
});

// POST /api/waitlist  — trägt neue E-Mail ein und verschickt Bestätigung
app.post('/api/waitlist', async (req, res) => {
  const { email } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Ungültige E-Mail-Adresse.' });
  }

  const list = loadWaitlist();

  if (list.some(e => e.email === email)) {
    return res.status(409).json({ error: 'Bereits eingetragen.' });
  }

  list.push({ email, signedUpAt: new Date().toISOString() });
  saveWaitlist(list);

  // Bestätigungsmail
  try {
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'Nihongo <waitlist@nihongo.app>',
      to: email,
      subject: 'Du bist auf der Nihongo-Warteliste 🎌',
      html: `
        <!DOCTYPE html>
        <html lang="de">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;padding:0;background:#0a1f2e;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a1f2e;padding:40px 20px">
            <tr><td align="center">
              <table width="520" cellpadding="0" cellspacing="0" style="background:#0f2535;border-radius:16px;overflow:hidden;border:1px solid rgba(45,139,139,.3)">
                <!-- Header -->
                <tr>
                  <td style="background:linear-gradient(135deg,#1A4F6B,#2D8B8B);padding:32px 40px;text-align:center">
                    <p style="margin:0;font-size:48px;line-height:1">語</p>
                    <h1 style="margin:12px 0 0;color:#fff;font-size:28px;font-weight:700;letter-spacing:-.5px">Nihongo</h1>
                    <p style="margin:4px 0 0;color:rgba(255,255,255,.7);font-size:13px;letter-spacing:.1em;text-transform:uppercase">Japanisch für Deutsche</p>
                  </td>
                </tr>
                <!-- Body -->
                <tr>
                  <td style="padding:36px 40px">
                    <h2 style="margin:0 0 12px;color:#fff;font-size:22px;font-weight:600">Du bist dabei. 🎉</h2>
                    <p style="margin:0 0 16px;color:#9bbfbf;font-size:15px;line-height:1.65">
                      Wir benachrichtigen dich, sobald Nihongo im App Store verfügbar ist.
                      Mehr Infos kommen noch — halte Ausschau.
                    </p>
                    <p style="margin:0;color:#6ea8a8;font-size:13px;line-height:1.6">
                      Du hast dich mit <strong style="color:#9bbfbf">${email}</strong> eingetragen.
                    </p>
                  </td>
                </tr>
                <!-- Footer -->
                <tr>
                  <td style="padding:20px 40px;border-top:1px solid rgba(45,139,139,.2);text-align:center">
                    <p style="margin:0;color:#4a7a7a;font-size:12px">
                      Nihongo · iOS · Bald verfügbar<br>
                      <a href="#" style="color:#4a7a7a">Abmelden</a>
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
    // E-Mail-Fehler soll den Signup nicht blockieren — trotzdem loggen
    console.error('[Resend]', err.message);
  }

  res.json({ ok: true, count: list.length });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  Nihongo Waitlist Backend läuft auf http://localhost:${PORT}`);
  console.log(`    POST /api/waitlist   → E-Mail eintragen + Bestätigung senden`);
  console.log(`    GET  /api/count      → aktuelle Anzahl Anmeldungen`);
});
