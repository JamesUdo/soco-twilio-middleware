require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const { Resend } = require('resend');

const base44 = require('./lib/base44');
const quo = require('./lib/quo-client');
const smsRoutes = require('./routes/sms');
const voiceRoutes = require('./routes/voice');
const apiRoutes = require('./routes/api');
const docusignRoutes = require('./routes/docusign');
const quoRoutes = require('./routes/quo');

const app = express();

// CORS: open to any origin. Safe because public form endpoints + server-side credential
// endpoints aren't gated by Origin; webhooks come from providers, not browsers.
app.use(cors({ origin: true, credentials: false }));

// Twilio webhooks use form-encoded; everything else is JSON.
app.use('/webhooks/sms', express.urlencoded({ extended: false }));
app.use('/webhooks/voice', express.urlencoded({ extended: false }));
// Quo sends JSON, but we need the raw body to verify signatures — handled inside routes/quo.js
app.use('/api', express.json({ limit: '25mb' }));

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'SOCO Middleware (Twilio + Quo + Resend)' });
});

// =====================================================================
// EMAIL (Resend)
// =====================================================================
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

app.post('/api/email/send', async (req, res) => {
    if (!resend) {
        return res.status(500).json({ error: 'RESEND_API_KEY is not configured on the server.' });
    }
    try {
        const { to, from, subject, html, text, attachments, reply_to } = req.body || {};
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
            reply_to: reply_to || undefined,
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

// =====================================================================
// OUTBOUND SMS — uses Quo if QUO_API_KEY is set, otherwise falls back to Twilio.
// =====================================================================
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

const SMS_PROVIDER = process.env.SMS_PROVIDER || (process.env.QUO_API_KEY ? 'quo' : 'twilio');

function normalizeToE164(raw) {
    let n = String(raw || '').trim();
    if (!n) return '';
    if (n.startsWith('+')) return n;
    const digits = n.replace(/\D/g, '');
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
    if (digits.length) return '+' + digits;
    return '';
}

app.post('/api/sms/send', async (req, res) => {
    try {
        const { to, body, from, media_urls } = req.body || {};
        if (!to || !body) {
            return res.status(400).json({ error: 'Missing required fields: to, body.' });
        }
        const toNumber = normalizeToE164(to);
        if (!toNumber) return res.status(400).json({ error: 'Invalid `to` phone number.' });

        // -----------------------------
        // Provider: Quo (preferred)
        // -----------------------------
        if (SMS_PROVIDER === 'quo' && process.env.QUO_API_KEY) {
            // Resolve sender: either explicit `from` or the rep's TeamPhone Quo number
            let fromNumber = from;
            if (!fromNumber && req.body.team_phone_id) {
                const tp = await base44.getEntity('TeamPhone', req.body.team_phone_id);
                fromNumber = tp?.twilio_phone_number; // re-using field name; populated with the Quo number after porting/setup
            }
            if (!fromNumber) {
                fromNumber = process.env.QUO_DEFAULT_FROM_NUMBER;
            }
            if (!fromNumber) {
                return res.status(500).json({ error: 'No from-number resolved. Pass `from`, `team_phone_id`, or set QUO_DEFAULT_FROM_NUMBER.' });
            }
            try {
                const msg = await quo.sendSMS({ from: fromNumber, to: toNumber, content: String(body) });
                console.log(`Quo SMS sent: ${fromNumber} -> ${toNumber} (id=${msg.id})`);
                return res.json({ ok: true, provider: 'quo', sid: msg.id, status: msg.status, to: toNumber, from: fromNumber });
            } catch (err) {
                console.error('Quo SMS send failed:', err.message);
                return res.status(502).json({ error: err.message, provider: 'quo' });
            }
        }

        // -----------------------------
        // Provider: Twilio (fallback / legacy)
        // -----------------------------
        if (!twilioClient) {
            return res.status(500).json({ error: 'No SMS provider configured (need QUO_API_KEY or TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN).' });
        }
        const params = { to: toNumber, body: String(body) };
        if (from) params.from = from;
        else if (process.env.MESSAGING_SERVICE_SID) params.messagingServiceSid = process.env.MESSAGING_SERVICE_SID;
        else if (process.env.TWILIO_PHONE_NUMBER) params.from = process.env.TWILIO_PHONE_NUMBER;
        else return res.status(500).json({ error: 'No Twilio from-number / messaging service configured.' });

        if (Array.isArray(media_urls) && media_urls.length) params.mediaUrl = media_urls;
        if (process.env.BASE_URL) params.statusCallback = `${process.env.BASE_URL}/webhooks/sms/status`;

        const msg = await twilioClient.messages.create(params);
        console.log(`Twilio SMS sent to ${toNumber} (sid=${msg.sid})`);
        return res.json({ ok: true, provider: 'twilio', sid: msg.sid, status: msg.status, to: msg.to, from: msg.from });
    } catch (err) {
        console.error('sms send failed:', err);
        return res.status(500).json({ error: err.message || 'Unknown error', code: err.code });
    }
});

// =====================================================================
// PUBLIC LEAD CAPTURE (unchanged)
// =====================================================================
app.post('/api/leads', async (req, res) => {
    try {
        const body = req.body || {};
        let firstName = body.contact_first_name || '';
        let lastName = body.contact_last_name || '';
        if (!firstName && !lastName && body.name) {
            const parts = String(body.name).trim().split(/\s+/);
            firstName = parts.shift() || '';
            lastName = parts.join(' ');
        }
        if (!firstName || !body.email || !body.phone) {
            return res.status(400).json({ error: 'Missing required fields: first name, email, phone.' });
        }
        const phone = normalizeToE164(body.phone);

        let referral_source = body.referral_source || null;
        let source = body.source || 'Website Lead Form';
        let source_detail = body.source_detail || '';
        if (body.affiliate_name || body.affiliate_slug) {
            source = 'Affiliate Link';
            source_detail = body.affiliate_name || body.affiliate_slug;
            referral_source = referral_source || 'Existing Customer Referral';
        }

        const leadData = {
            contact_first_name: firstName,
            contact_last_name: lastName,
            email: body.email,
            phone,
            company_name: body.company_name || body.company || '',
            service_type: body.service_type || null,
            referral_source,
            shipping_address: body.shipping_address || body.address || '',
            shipping_city: body.shipping_city || body.city || '',
            shipping_state: body.shipping_state || body.state || '',
            shipping_zip: body.shipping_zip || body.zip || '',
            location: body.location || '',
            screen_size: body.screen_size || '',
            viewing_distance: body.viewing_distance || '',
            install_method: body.install_method || '',
            install_requested: body.install_requested || '',
            project_type: body.project_type || '',
            project_date_start: body.project_date_start || null,
            project_date_end: body.project_date_end || null,
            budget_range: body.budget_range || '',
            timeline: body.timeline || '',
            message: body.message || body.project_details || '',
            requested_call_date: body.requested_call_date || null,
            requested_call_time: body.requested_call_time || null,
            sms_consent: !!body.sms_consent,
            source,
            source_detail,
            status: 'New',
            priority: 'Medium',
        };

        let lead;
        try {
            lead = await base44.createEntity('Lead', leadData);
        } catch (e) {
            console.error('Base44 Lead create failed:', e.message);
            return res.status(502).json({ error: 'Could not save lead. Please try again or call us.', detail: e.message });
        }

        if (resend) {
            const fullName = [firstName, lastName].filter(Boolean).join(' ');
            const sourceLabel = source_detail ? `${source} — ${source_detail}` : source;
            const subject = body.affiliate_name ? `New Lead via ${body.affiliate_name}: ${fullName}` : `New Lead: ${fullName}`;
            const addr = [leadData.shipping_address, leadData.shipping_city, leadData.shipping_state, leadData.shipping_zip].filter(Boolean).join(', ');
            const rows = [
                ['Source', sourceLabel],
                ['Name', fullName],
                ['Email', `<a href="mailto:${escapeHtml(leadData.email)}">${escapeHtml(leadData.email)}</a>`],
                ['Phone', `<a href="tel:${escapeHtml(leadData.phone)}">${escapeHtml(leadData.phone)}</a>`],
                ['Company', leadData.company_name],
                ['Service', leadData.service_type],
                ['Address', addr],
                ['Indoor/Outdoor', leadData.location],
                ['Screen Size', leadData.screen_size],
                ['Viewing Distance', leadData.viewing_distance],
                ['Install Method', leadData.install_method],
                ['SOCO Install?', leadData.install_requested],
                ['Project Type', leadData.project_type],
                ['Timeline', leadData.timeline],
                ['Budget Range', leadData.budget_range],
                ['Requested Call', [leadData.requested_call_date, leadData.requested_call_time].filter(Boolean).join(' ')],
                ['SMS Consent', leadData.sms_consent ? 'Yes' : 'No'],
            ].filter(([, v]) => v && String(v).trim());

            const html = `
              <div style="font-family: Arial, sans-serif; max-width:600px;">
                <h2 style="color:#111827; border-bottom:3px solid #F97316; padding-bottom:8px;">New Lead Submitted</h2>
                <table style="border-collapse:collapse; width:100%; margin-top:12px;">
                  ${rows.map(([label, val]) => `<tr><td style="padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb;"><strong>${escapeHtml(label)}</strong></td><td style="padding:6px 10px; border:1px solid #e5e7eb;">${label === 'Email' || label === 'Phone' ? val : escapeHtml(String(val))}</td></tr>`).join('')}
                </table>
                ${leadData.message ? `<p style="margin-top:18px;"><strong>Project Details:</strong></p><div style="white-space:pre-wrap; background:#f9fafb; border:1px solid #e5e7eb; padding:12px; border-radius:6px;">${escapeHtml(leadData.message)}</div>` : ''}
                <p style="margin-top:18px; font-size:12px; color:#6b7280;">Open in Base44 to convert this lead into a deal.</p>
              </div>
            `;
            resend.emails.send({
                from: process.env.RESEND_FROM_EMAIL || 'SOCO Production <noreply@socoproduction.com>',
                to: ['james@socoproduction.com', 'colton@socoproduction.com'],
                subject,
                html,
                reply_to: leadData.email,
            }).then(() => console.log('Lead notification email sent.'))
              .catch(e => console.warn('Lead notification email failed:', e.message));
        }

        return res.json({ ok: true, lead });
    } catch (err) {
        console.error('lead capture failed:', err);
        return res.status(500).json({ error: err.message || 'Unknown error' });
    }
});

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// =====================================================================
// Routes
// =====================================================================
app.use('/webhooks/sms', smsRoutes);
app.use('/webhooks/voice', voiceRoutes);
app.use('/webhooks/quo', quoRoutes);      // NEW — Quo (OpenPhone) webhooks
app.use('/api', apiRoutes);
app.use('/api/docusign', docusignRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('SOCO Middleware running on port ' + PORT);
    console.log('SMS provider: ' + SMS_PROVIDER);
    console.log('Resend configured: ' + (!!process.env.RESEND_API_KEY));
    console.log('Twilio configured: ' + (!!twilioClient));
    console.log('Quo configured: ' + (!!process.env.QUO_API_KEY));
});
