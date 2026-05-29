require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const { Resend } = require('resend');

const base44 = require('./lib/base44');
const smsRoutes = require('./routes/sms');
const voiceRoutes = require('./routes/voice');
const apiRoutes = require('./routes/api');
const docusignRoutes = require('./routes/docusign');

const app = express();

// Allow browser requests from Base44 frontends
app.use(cors({
    origin: [
        'https://avlproj.base44.app',
        /\.base44\.app$/,
        'http://localhost:3000'
    ],
}));

// Twilio sends form-encoded data for webhooks
app.use('/webhooks', express.urlencoded({ extended: false }));
// Our API endpoints use JSON (raise limit for attached PDF data URLs)
app.use('/api', express.json({ limit: '25mb' }));

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'SOCO Twilio + Email Middleware' });
});

// EXTERNAL EMAIL via Resend (POST /api/email/send)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

app.post('/api/email/send', async (req, res) => {
    if (!resend) {
        return res.status(500).json({ error: 'RESEND_API_KEY is not configured on the server.' });
    }
    try {
        const { to, from, subject, html, text, attachments } = req.body || {};
        if (!to || !subject || (!html && !text)) {
            return res.status(400).json({ error: 'Missing required fields: to, subject, and html or text.' });
        }
        const fromAddress = from || process.env.RESEND_FROM_EMAIL || 'SOCO Production <noreply@socoproduction.com>';
        const recipients = Array.isArray(to) ? to : [to];

        let attachmentObjs = [];
        if (Array.isArray(attachments) && attachments.length > 0) {
            for (const a of attachments) {
                if (a.url) {
                    try {
                        const r = await fetch(a.url);
                        if (!r.ok) throw new Error('fetch ' + a.url + ' status ' + r.status);
                        const buf = Buffer.from(await r.arrayBuffer());
                        attachmentObjs.push({ filename: a.filename || 'attachment.pdf', content: buf });
                    } catch (e) { console.warn('attachment fetch failed:', a.url, e.message); }
                } else if (a.content) {
                    attachmentObjs.push({ filename: a.filename || 'attachment', content: Buffer.from(a.content, 'base64') });
                }
            }
        }

        const result = await resend.emails.send({
            from: fromAddress,
            to: recipients,
            subject,
            html: html || undefined,
            text: text || undefined,
            attachments: attachmentObjs.length ? attachmentObjs : undefined,
        });

        if (result.error) {
            console.error('Resend error:', result.error);
            return res.status(502).json({ error: result.error.message || 'Resend rejected', details: result.error });
        }
        return res.json({ id: result.data?.id, ok: true });
    } catch (err) {
        console.error('email send failed:', err);
        return res.status(500).json({ error: err.message || 'Unknown error' });
    }
});

// SIMPLE OUTBOUND SMS via Twilio (POST /api/sms/send)
// Used by the Base44 frontend Communication page. No Base44 lookups —
// the frontend already knows the contact and is responsible for writing
// the Message entity. This endpoint only fires the Twilio send.
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

app.post('/api/sms/send', async (req, res) => {
    if (!twilioClient) {
        return res.status(500).json({ error: 'Twilio credentials are not configured on the server.' });
    }
    try {
        const { to, body, from, media_urls } = req.body || {};
        if (!to || !body) {
            return res.status(400).json({ error: 'Missing required fields: to, body.' });
        }

        // Normalize US 10-digit to E.164
        let toNumber = String(to).trim();
        if (!toNumber.startsWith('+')) {
            const digits = toNumber.replace(/\D/g, '');
            if (digits.length === 10) toNumber = '+1' + digits;
            else if (digits.length === 11 && digits.startsWith('1')) toNumber = '+' + digits;
            else toNumber = '+' + digits;
        }

        const params = { to: toNumber, body: String(body) };
        if (from) {
            params.from = from;
        } else if (process.env.MESSAGING_SERVICE_SID) {
            params.messagingServiceSid = process.env.MESSAGING_SERVICE_SID;
        } else if (process.env.TWILIO_PHONE_NUMBER) {
            params.from = process.env.TWILIO_PHONE_NUMBER;
        } else {
            return res.status(500).json({ error: 'No from-number or MESSAGING_SERVICE_SID configured on the server.' });
        }
        if (Array.isArray(media_urls) && media_urls.length) {
            params.mediaUrl = media_urls;
        }
        if (process.env.BASE_URL) {
            params.statusCallback = `${process.env.BASE_URL}/webhooks/sms/status`;
        }

        const msg = await twilioClient.messages.create(params);
        console.log(`SMS sent to ${toNumber} (sid=${msg.sid}, status=${msg.status})`);
        return res.json({ ok: true, sid: msg.sid, status: msg.status, to: msg.to, from: msg.from });
    } catch (err) {
        console.error('sms send failed:', err);
        return res.status(500).json({
            error: err.message || 'Unknown error',
            code: err.code,
            moreInfo: err.moreInfo,
        });
    }
});

app.use('/webhooks/sms', smsRoutes);
app.use('/webhooks/voice', voiceRoutes);
app.use('/api', apiRoutes);
app.use('/api/docusign', docusignRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('SOCO Twilio + Email Middleware running on port ' + PORT);
    console.log('Resend configured: ' + (!!process.env.RESEND_API_KEY));
    console.log('Twilio configured: ' + (!!twilioClient));
});
