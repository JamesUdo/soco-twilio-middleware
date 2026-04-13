/**
 * Internal API Routes
 * Called by the base44 frontend to send SMS, make calls, etc.
 */

const express = require('express');
const router = express.Router();
const base44 = require('../lib/base44');
const { sendSMS, makeCall, twiml: createTwiml } = require('../lib/twilio-client');

/**
 * POST /api/send-sms
 * Send an outbound SMS from the base44 UI
 *
 * Body: { team_phone_id, to_number, body, contact_id?, company_id?, media_urls? }
 */
router.post('/send-sms', async (req, res) => {
  const { team_phone_id, to_number, body, contact_id, company_id, media_urls } = req.body;

  try {
    // Get the team phone to find the Twilio number
    const teamPhone = await base44.getEntity('TeamPhone', team_phone_id);
    if (!teamPhone) {
      return res.status(404).json({ error: 'TeamPhone not found' });
    }

    // Append SMS signature if configured
    let messageBody = body;
    if (teamPhone.sms_signature) {
      messageBody += `\n${teamPhone.sms_signature}`;
    }

    // Send via Twilio
    const twilioMsg = await sendSMS(
      teamPhone.twilio_phone_number,
      to_number,
      messageBody,
      media_urls || []
    );

    // Save to base44
    const message = await base44.createEntity('Message', {
      team_phone_id,
      user_id: teamPhone.user_id,
      contact_id,
      company_id,
      direction: 'Outbound',
      from_number: teamPhone.twilio_phone_number,
      to_number,
      body: messageBody,
      media_urls: media_urls || [],
      status: 'Sent',
      twilio_message_sid: twilioMsg.sid,
      sent_at: new Date().toISOString()
    });

    console.log(`📤 Sent SMS to ${to_number}: "${body.substring(0, 50)}..."`);
    res.json({ success: true, message, twilio_sid: twilioMsg.sid });

  } catch (error) {
    console.error('Error sending SMS:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/make-call
 * Initiate an outbound call from base44 UI
 *
 * Body: { team_phone_id, to_number, contact_id?, company_id? }
 */
router.post('/make-call', async (req, res) => {
  const { team_phone_id, to_number, contact_id, company_id } = req.body;

  try {
    const teamPhone = await base44.getEntity('TeamPhone', team_phone_id);
    if (!teamPhone) {
      return res.status(404).json({ error: 'TeamPhone not found' });
    }

    if (!teamPhone.forward_to_mobile) {
      return res.status(400).json({
        error: 'No mobile forwarding number configured. Set forward_to_mobile on the TeamPhone record.'
      });
    }

    // The flow: call the team member first, when they answer, connect to the client
    // This way the client sees the business number as caller ID
    const twimlUrl = `${process.env.BASE_URL}/api/outbound-twiml?to=${encodeURIComponent(to_number)}&callerId=${encodeURIComponent(teamPhone.twilio_phone_number)}`;

    const twilioCall = await makeCall(
      teamPhone.twilio_phone_number,
      teamPhone.forward_to_mobile, // Call the team member's personal phone first
      twimlUrl
    );

    // Create CallLog
    const callLog = await base44.createEntity('CallLog', {
      team_phone_id,
      user_id: teamPhone.user_id,
      contact_id,
      company_id,
      direction: 'Outbound',
      from_number: teamPhone.twilio_phone_number,
      to_number,
      status: 'Ringing',
      twilio_call_sid: twilioCall.sid,
      started_at: new Date().toISOString()
    });

    console.log(`📞 Outbound call initiated to ${to_number}`);
    res.json({ success: true, callLog, twilio_sid: twilioCall.sid });

  } catch (error) {
    console.error('Error making call:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/outbound-twiml
 * TwiML for outbound calls — connects the team member to the client
 */
router.get('/outbound-twiml', (req, res) => {
  const { to, callerId } = req.query;

  const resp = createTwiml();
  resp.say({ voice: 'Polly.Matthew' }, 'Connecting your call now.');
  resp.dial({ callerId }).number(to);

  res.type('text/xml').send(resp.toString());
});

/**
 * GET /api/team-phones
 * List all team phone configurations
 */
router.get('/team-phones', async (req, res) => {
  try {
    const phones = await base44.getTeamPhones();
    res.json(phones);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/conversations/:teamPhoneId
 * Get conversation threads for a team phone
 */
router.get('/conversations/:teamPhoneId', async (req, res) => {
  try {
    const messages = await base44.queryEntities('Message', {}, 500);
    const list = Array.isArray(messages) ? messages : (messages.results || messages.data || []);

    // Filter to this team phone and group by contact number
    const teamMessages = list.filter(m => m.team_phone_id === req.params.teamPhoneId);

    // Group into conversations by the other party's number
    const convos = {};
    for (const msg of teamMessages) {
      const otherNumber = msg.direction === 'Inbound' ? msg.from_number : msg.to_number;
      if (!convos[otherNumber]) {
        convos[otherNumber] = {
          phone_number: otherNumber,
          contact_id: msg.contact_id,
          company_id: msg.company_id,
          messages: [],
          last_message: null
        };
      }
      convos[otherNumber].messages.push(msg);
      if (!convos[otherNumber].last_message ||
          new Date(msg.sent_at) > new Date(convos[otherNumber].last_message.sent_at)) {
        convos[otherNumber].last_message = msg;
      }
    }

    // Sort by most recent message
    const sorted = Object.values(convos).sort((a, b) =>
      new Date(b.last_message?.sent_at || 0) - new Date(a.last_message?.sent_at || 0)
    );

    res.json(sorted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/bulk-sms
 * Send the same SMS to multiple contacts (for automated campaigns)
 *
 * Body: { team_phone_id, contact_ids: [], body }
 */
router.post('/bulk-sms', async (req, res) => {
  const { team_phone_id, contact_ids, body } = req.body;

  try {
    const teamPhone = await base44.getEntity('TeamPhone', team_phone_id);
    if (!teamPhone) {
      return res.status(404).json({ error: 'TeamPhone not found' });
    }

    const results = { sent: 0, failed: 0, errors: [] };

    for (const contactId of contact_ids) {
      try {
        const contact = await base44.getEntity('Contact', contactId);
        const phoneNum = contact.mobile || contact.phone;
        if (!phoneNum) {
          results.failed++;
          results.errors.push({ contactId, error: 'No phone number' });
          continue;
        }

        let messageBody = body;
        if (teamPhone.sms_signature) {
          messageBody += `\n${teamPhone.sms_signature}`;
        }

        const twilioMsg = await sendSMS(teamPhone.twilio_phone_number, phoneNum, messageBody);

        await base44.createEntity('Message', {
          team_phone_id,
          user_id: teamPhone.user_id,
          contact_id: contactId,
          company_id: contact.company_id,
          direction: 'Outbound',
          from_number: teamPhone.twilio_phone_number,
          to_number: phoneNum,
          body: messageBody,
          status: 'Sent',
          twilio_message_sid: twilioMsg.sid,
          sent_at: new Date().toISOString()
        });

        results.sent++;

        // Small delay to respect Twilio rate limits
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        results.failed++;
        results.errors.push({ contactId, error: err.message });
      }
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
