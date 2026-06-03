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

// CORS: allow Base44 frontends, the SOCO Wix site, and any wixsite.com subdomain.
// Anonymous Lead/Contact creation is gated by RLS on the Base44 side, so it's
// safe to open these origins for the /api/leads form-embed endpoint.
app.use(cors({
    origin: [
        'https://avlproj.base44.app',
        /\.base44\.app$/,
        'https://socoproduction.com',
        'https://www.socoproduction.com',
        /\.wixsite\.com$/,
        /\.wix\.com$/,
        /\.editorx\.io$/,
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

// PUBLIC LEAD CAPTURE (POST /api/leads)
// Used by embedded HTML lead forms (Wix, affiliate landing pages, etc).
// Creates a Lead in Base44 and emails the team. No auth required — Base44
// RLS already allows anonymous create on the Lead entity.
app.post('/api/leads', async (req, res) => {
    try {
        const body = req.body || {};
        const {
            name,
            email,
            phone,
            company,
            service_type,
            address,
            city,
            state,
            zip,
            requested_call_date,
            requested_call_time,
            project_details,
            message,
            sms_consent,
            affiliate_slug,
            affiliate_name,
            referral_source: rawReferralSource,
        } = body;

        if (!name || !email || !phone) {
            return res.status(400).json({ error: 'Missing required fields: name, email, phone.' });
        }

        // Normalize phone to E.164 (US default)
        let normalizedPhone = String(phone).trim();
        if (!normalizedPhone.startsWith('+')) {
            const digits = normalizedPhone.replace(/\D/g, '');
            if (digits.length === 10) normalizedPhone = '+1' + digits;
            else if (digits.length === 11 && digits.startsWith('1')) normalizedPhone = '+' + digits;
            else if (digits.length) normalizedPhone = '+' + digits;
        }

        // Affiliate-aware referral source
        let referral_source = rawReferralSource;
        if (affiliate_name) referral_source = `Affiliate: ${affiliate_name}`;
        else if (affiliate_slug) referral_source = `Affiliate: ${affiliate_slug}`;

        const leadData = {
            name,
            email,
            phone: normalizedPhone,
            company: company || '',
            service_type: service_type || null,
            address: address || '',
            city: city || '',
            state: state || '',
            zip: zip || '',
            requested_call_date: requested_call_date || null,
            requested_call_time: requested_call_time || null,
            message: project_details || message || '',
            sms_consent: !!sms_consent,
            referral_source: referral_source || null,
            affiliate_slug: affiliate_slug || null,
            status: 'New',
        };

        let lead;
        try {
            lead = await base44.createEntity('Lead', leadData);
        } catch (e) {
            console.error('Base44 Lead create failed:', e.message);
            return res.status(502).json({ error: 'Could not save lead. Please try again or call us.', detail: e.message });
        }

        // Fire team notification email (non-blocking — don't fail the request if email fails)
        if (resend) {
            const sourceLabel = referral_source || 'Direct (website)';
            const subject = affiliate_name
                ? `New Lead via ${affiliate_name}: ${name}`
                : `New Lead: ${name}`;
            const htmlBody = `
              <div style="font-family: Arial, sans-serif; max-width:600px;">
                <h2 style="color:#111827; border-bottom:3px solid #F97316; padding-bottom:8px;">New Lead Submitted</h2>
                <p><strong>Source:</strong> ${sourceLabel}</p>
                <table style="border-collapse:collapse; width:100%; margin-top:12px;">
                  <tr><td style="padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb;"><strong>Name</strong></td><td style="padding:6px 10px; border:1px solid #e5e7eb;">${escapeHtml(name)}</td></tr>
                  <tr><td style="padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb;"><strong>Email</strong></td><td style="padding:6px 10px; border:1px solid #e5e7eb;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
                  <tr><td style="padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb;"><strong>Phone</strong></td><td style="padding:6px 10px; border:1px solid #e5e7eb;"><a href="tel:${escapeHtml(normalizedPhone)}">${escapeHtml(normalizedPhone)}</a></td></tr>
                  <tr><td style="padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb;"><strong>Company</strong></td><td style="padding:6px 10px; border:1px solid #e5e7eb;">${escapeHtml(company || '-')}</td></tr>
                  <tr><td style="padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb;"><strong>Service</strong></td><td style="padding:6px 10px; border:1px solid #e5e7eb;">${escapeHtml(service_type || '-')}</td></tr>
                  <tr><td style="padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb;"><strong>Address</strong></td><td style="padding:6px 10px; border:1px solid #e5e7eb;">${escapeHtml([address, city, state, zip].filter(Boolean).join(', ') || '-')}</td></tr>
                  ${requested_call_date ? `<tr><td style="padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb;"><strong>Requested Call</strong></td><td style="padding:6px 10px; border:1px solid #e5e7eb;">${escapeHtml(requested_call_date)} ${escapeHtml(requested_call_time || '')}</td></tr>` : ''}
                  <tr><td style="padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb; vertical-align:top;"><strong>Details</strong></td><td style="padding:6px 10px; border:1px solid #e5e7eb; white-space:pre-wrap;">${escapeHtml(project_details || message || '-')}</td></tr>
                  <tr><td style="padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb;"><strong>SMS consent</strong></td><td style="padding:6px 10px; border:1px solid #e5e7eb;">${sms_consent ? 'Yes' : 'No'}</td></tr>
                </table>
                <p style="margin-top:18px; font-size:12px; color:#6b7280;">Open in Base44 to convert this lead into a deal.</p>
              </div>
            `;
            resend.emails.send({
                from: process.env.RESEND_FROM_EMAIL || 'SOCO Production <noreply@socoproduction.com>',
                to: ['james@socoproduction.com', 'colton@socoproduction.com'],
                subject,
                html: htmlBody,
                reply_to: email,
            }).then(() => {
                console.log('Lead notification email sent.');
            }).catch(e => {
                console.warn('Lead notification email failed:', e.message);
            });
        }

        return res.json({ ok: true, lead });
    } catch (err) {
        console.error('lead capture failed:', err);
        return res.status(500).json({ error: err.message || 'Unknown error' });
    }
});

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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
