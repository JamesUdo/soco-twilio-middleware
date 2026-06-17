/**
 * Quo (formerly OpenPhone) webhook receiver.
 * Mounted at /webhooks/quo in server.js.
 *
 * Handles inbound events from Quo and writes them to Base44:
 *   - message.received  -> creates Message record (direction=Inbound)
 *   - message.delivered -> updates outbound Message status
 *   - call.completed    -> creates/updates CallLog
 *   - call.recording.completed
 *   - call.summary.completed
 *   - call.transcript.completed
 *
 * Each webhook subscription has its own signing key. Store them as:
 *   QUO_MESSAGES_WEBHOOK_KEY
 *   QUO_CALLS_WEBHOOK_KEY
 *   QUO_CALL_SUMMARIES_WEBHOOK_KEY
 *   QUO_CALL_TRANSCRIPTS_WEBHOOK_KEY
 */

const express = require('express');
const router = express.Router();
const base44 = require('../lib/base44');
const quo = require('../lib/quo-client');

// Raw body capture so we can verify HMAC signatures BEFORE Express parses JSON.
// Mount this middleware on the Quo routes before any JSON-parsing middleware.
const captureRawBody = (req, res, next) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
        req.rawBody = data;
        try { req.body = data ? JSON.parse(data) : {}; }
        catch { req.body = {}; }
        next();
    });
};

router.use(captureRawBody);

// =================================================================
// MESSAGE WEBHOOKS
// =================================================================
router.post('/messages', async (req, res) => {
    const signature = req.headers['openphone-signature'] || req.headers['x-openphone-signature']
                   || req.headers['quo-signature']      || req.headers['x-quo-signature'];
    const secret = process.env.QUO_MESSAGES_WEBHOOK_KEY;

    if (secret && !quo.verifySignature(req.rawBody, signature, secret)) {
        console.warn('Quo messages webhook: invalid signature');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body || {};
    const type = event.type || event.event;
    const data = event.data?.object || event.data || event;

    console.log(`Quo message webhook: type=${type} id=${data?.id} from=${data?.from} to=${JSON.stringify(data?.to)}`);

    try {
        if (type === 'message.received' || type === 'message.created' && data?.direction === 'incoming') {
            await handleInboundMessage(data);
        } else if (type === 'message.delivered' || (type === 'message.updated' && data?.status === 'delivered')) {
            await handleMessageDelivered(data);
        } else {
            console.log(`Quo message webhook: unhandled type ${type}`);
        }
        return res.json({ ok: true });
    } catch (err) {
        console.error('Quo message webhook handler error:', err);
        // Respond 200 anyway so Quo doesn't keep retrying — we've logged it
        return res.json({ ok: true, warning: err.message });
    }
});

async function handleInboundMessage(msg) {
    // msg: { id, from, to: [], text/body/content, phoneNumberId, userId, createdAt, ... }
    const fromNumber = msg.from;
    const toNumbers = Array.isArray(msg.to) ? msg.to : [msg.to];
    const body = msg.text || msg.body || msg.content || '';
    const ourNumber = toNumbers[0]; // the SOCO Quo number receiving this

    // Find which TeamPhone owns the receiving number
    const teamPhone = await base44.findTeamPhoneByNumber(ourNumber);
    if (!teamPhone) {
        console.warn(`Quo inbound: no TeamPhone matches receiving number ${ourNumber}`);
    }

    // Find the Contact (by sender number)
    const contact = await base44.findContactByPhone(fromNumber);

    await base44.createEntity('Message', {
        team_phone_id: teamPhone?.id || teamPhone?._id || null,
        user_id: teamPhone?.user_id || null,
        contact_id: contact?.id || contact?._id || null,
        company_id: contact?.company_id || null,
        direction: 'Inbound',
        from_number: fromNumber,
        to_number: ourNumber,
        body,
        media_urls: msg.media || [],
        status: 'Received',
        twilio_message_sid: msg.id, // re-using field for Quo message id
        sent_at: msg.createdAt || new Date().toISOString(),
    });
    console.log(`✅ Quo inbound saved: ${fromNumber} -> ${ourNumber}`);
}

async function handleMessageDelivered(msg) {
    // Update the existing outbound Message status to "Delivered"
    const messages = await base44.queryEntities('Message', {}, 200);
    const list = Array.isArray(messages) ? messages : (messages.results || messages.data || []);
    const match = list.find(m => m.twilio_message_sid === msg.id);
    if (match) {
        await base44.updateEntity('Message', match.id || match._id, { status: 'Delivered' });
    }
}

// =================================================================
// CALL WEBHOOKS
// =================================================================
router.post('/calls', async (req, res) => {
    const signature = req.headers['openphone-signature'] || req.headers['x-openphone-signature']
                   || req.headers['quo-signature']      || req.headers['x-quo-signature'];
    const secret = process.env.QUO_CALLS_WEBHOOK_KEY;

    if (secret && !quo.verifySignature(req.rawBody, signature, secret)) {
        return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body || {};
    const type = event.type || event.event;
    const data = event.data?.object || event.data || event;

    console.log(`Quo call webhook: type=${type} id=${data?.id} direction=${data?.direction}`);

    try {
        if (type === 'call.completed') {
            await handleCallCompleted(data);
        } else if (type === 'call.recording.completed') {
            await handleCallRecording(data);
        } else {
            console.log(`Quo call webhook: unhandled type ${type}`);
        }
        return res.json({ ok: true });
    } catch (err) {
        console.error('Quo call webhook handler error:', err);
        return res.json({ ok: true, warning: err.message });
    }
});

async function handleCallCompleted(call) {
    const direction = call.direction === 'incoming' ? 'Inbound' : 'Outbound';
    const ourNumber = direction === 'Inbound' ? (Array.isArray(call.to) ? call.to[0] : call.to) : call.from;
    const otherNumber = direction === 'Inbound' ? call.from : (Array.isArray(call.to) ? call.to[0] : call.to);

    const teamPhone = await base44.findTeamPhoneByNumber(ourNumber);
    const contact = await base44.findContactByPhone(otherNumber);

    await base44.createEntity('CallLog', {
        team_phone_id: teamPhone?.id || null,
        user_id: teamPhone?.user_id || null,
        contact_id: contact?.id || null,
        company_id: contact?.company_id || null,
        direction,
        from_number: call.from,
        to_number: Array.isArray(call.to) ? call.to[0] : call.to,
        twilio_call_sid: call.id, // re-using for Quo call id
        started_at: call.startedAt || call.createdAt,
        ended_at: call.completedAt || call.endedAt,
        duration_seconds: call.duration,
        status: call.status === 'missed' ? 'Missed' : 'Completed',
    });
    console.log(`✅ Quo call saved: ${direction} ${call.from} -> ${call.to}`);
}

async function handleCallRecording(call) {
    // Attach recording URL to the existing CallLog by quo call id
    const calls = await base44.queryEntities('CallLog', {}, 200);
    const list = Array.isArray(calls) ? calls : (calls.results || calls.data || []);
    const match = list.find(c => c.twilio_call_sid === call.id);
    if (match) {
        await base44.updateEntity('CallLog', match.id || match._id, {
            recording_url: call.recording?.url || call.media?.url,
            recording_sid: call.recording?.id || null,
        });
    }
}

// =================================================================
// CALL SUMMARIES & TRANSCRIPTS (Quo AI features)
// =================================================================
router.post('/call-summaries', async (req, res) => {
    const secret = process.env.QUO_CALL_SUMMARIES_WEBHOOK_KEY;
    const signature = req.headers['openphone-signature'] || req.headers['x-openphone-signature']
                   || req.headers['quo-signature']      || req.headers['x-quo-signature'];
    if (secret && !quo.verifySignature(req.rawBody, signature, secret)) {
        return res.status(401).json({ error: 'Invalid signature' });
    }
    const data = req.body?.data?.object || req.body?.data || req.body;
    const callId = data?.callId || data?.call_id;
    if (!callId) return res.json({ ok: true });

    const calls = await base44.queryEntities('CallLog', {}, 200);
    const list = Array.isArray(calls) ? calls : (calls.results || calls.data || []);
    const match = list.find(c => c.twilio_call_sid === callId);
    if (match) {
        await base44.updateEntity('CallLog', match.id || match._id, {
            notes: data.summary || data.text || '',
        });
    }
    return res.json({ ok: true });
});

router.post('/call-transcripts', async (req, res) => {
    const secret = process.env.QUO_CALL_TRANSCRIPTS_WEBHOOK_KEY;
    const signature = req.headers['openphone-signature'] || req.headers['x-openphone-signature']
                   || req.headers['quo-signature']      || req.headers['x-quo-signature'];
    if (secret && !quo.verifySignature(req.rawBody, signature, secret)) {
        return res.status(401).json({ error: 'Invalid signature' });
    }
    const data = req.body?.data?.object || req.body?.data || req.body;
    const callId = data?.callId || data?.call_id;
    if (!callId) return res.json({ ok: true });

    const calls = await base44.queryEntities('CallLog', {}, 200);
    const list = Array.isArray(calls) ? calls : (calls.results || calls.data || []);
    const match = list.find(c => c.twilio_call_sid === callId);
    if (match) {
        await base44.updateEntity('CallLog', match.id || match._id, {
            voicemail_transcription: data.transcript || data.text || '',
        });
    }
    return res.json({ ok: true });
});

module.exports = router;
