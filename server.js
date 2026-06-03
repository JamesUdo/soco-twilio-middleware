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

app.use('/webhooks', express.urlencoded({ extended: false }));
app.use('/api', express.json({ limit: '25mb' }));

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'SOCO Twilio + Email Middleware' });
});

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
        return res.status(500).json({ error: err.message || 'Unknown error', code: err.code, moreInfo: err.moreInfo });
    }
});

// PUBLIC LEAD CAPTURE (POST /api/leads)
// Accepts the full SOCO lead form schema and writes a Lead record to Base44
// using the canonical field names (contact_first_name, shipping_address,
// screen_size, etc.). Used by embedded HTML lead forms on Wix and affiliate pages.
app.post('/api/leads', async (req, res) => {
    try {
        const body = req.body || {};

        // Accept either {name} or {contact_first_name, contact_last_name}
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

        // Normalize phone to E.164 (US default)
        let phone = String(body.phone).trim();
        if (!phone.startsWith('+')) {
            const digits = phone.replace(/\D/g, '');
            if (digits.length === 10) phone = '+1' + digits;
            else if (digits.length === 11 && digits.startsWith('1')) phone = '+' + digits;
            else if (digits.length) phone = '+' + digits;
        }

        // Affiliate-aware referral source / source labels
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

        // Fire team notification email (non-blocking)
        if (resend) {
            const fullName = [firstName, lastName].filter(Boolean).join(' ');
            const sourceLabel = source_detail ? `${source} — ${source_detail}` : source;
            const subject = body.affiliate_name
                ? `New Lead via ${body.affiliate_name}: ${fullName}`
                : `New Lead: ${fullName}`;
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
