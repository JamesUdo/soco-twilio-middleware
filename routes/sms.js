/**
 * SMS Webhook Routes
 * Handles incoming SMS from Twilio and delivery status updates
 */

const express = require('express');
const router = express.Router();
const base44 = require('../lib/base44');
const { sendSMS, messagingResponse } = require('../lib/twilio-client');
const { findMatchingRule, getAfterHoursMessage } = require('../lib/auto-reply');

/**
 * POST /webhooks/sms/incoming
 * Twilio sends this when someone texts one of your numbers
 */
router.post('/incoming', async (req, res) => {
  const { From, To, Body, MessageSid, NumMedia } = req.body;

  console.log(`📩 Incoming SMS from ${From} to ${To}: "${Body}"`);

  try {
    // 1. Find which team member owns this number
    const teamPhone = await base44.findTeamPhoneByNumber(To);
    if (!teamPhone) {
      console.warn(`No TeamPhone found for number ${To}`);
      return res.type('text/xml').send('<Response></Response>');
    }

    // 2. Find the contact by their phone number
    const contact = await base44.findContactByPhone(From);

    // 3. Collect any MMS media URLs
    const mediaUrls = [];
    const numMedia = parseInt(NumMedia || '0', 10);
    for (let i = 0; i < numMedia; i++) {
      if (req.body[`MediaUrl${i}`]) {
        mediaUrls.push(req.body[`MediaUrl${i}`]);
      }
    }

    // 4. Save the inbound message to base44
    const messageData = {
      team_phone_id: teamPhone.id || teamPhone._id,
      user_id: teamPhone.user_id,
      contact_id: contact ? (contact.id || contact._id) : undefined,
      company_id: contact ? contact.company_id : undefined,
      direction: 'Inbound',
      from_number: From,
      to_number: To,
      body: Body,
      media_urls: mediaUrls.length > 0 ? mediaUrls : undefined,
      status: 'Received',
      twilio_message_sid: MessageSid,
      sent_at: new Date().toISOString()
    };

    await base44.createEntity('Message', messageData);
    console.log(`✅ Saved inbound message from ${From}`);

    // 5. Check for auto-reply rules
    const twimlResp = messagingResponse();

    if (teamPhone.auto_reply_enabled) {
      const match = await findMatchingRule(
        teamPhone.id || teamPhone._id,
        teamPhone,
        Body
      );

      if (match) {
        console.log(`🤖 Auto-reply triggered: "${match.rule.name}"`);

        // Send the auto-reply
        let replyBody = match.response_message;

        // Append SMS signature if set
        if (teamPhone.sms_signature) {
          replyBody += `\n${teamPhone.sms_signature}`;
        }

        twimlResp.message(replyBody);

        // Save the auto-reply as an outbound message
        await base44.createEntity('Message', {
          team_phone_id: teamPhone.id || teamPhone._id,
          user_id: teamPhone.user_id,
          contact_id: contact ? (contact.id || contact._id) : undefined,
          company_id: contact ? contact.company_id : undefined,
          direction: 'Outbound',
          from_number: To,
          to_number: From,
          body: replyBody,
          status: 'Sent',
          is_auto_reply: true,
          auto_reply_id: match.rule.id || match.rule._id,
          sent_at: new Date().toISOString()
        });

        return res.type('text/xml').send(twimlResp.toString());
      }
    }

    // 6. Check for after-hours auto-message (separate from rules)
    const afterHoursMsg = getAfterHoursMessage(teamPhone);
    if (afterHoursMsg) {
      let replyBody = afterHoursMsg;
      if (teamPhone.sms_signature) {
        replyBody += `\n${teamPhone.sms_signature}`;
      }
      twimlResp.message(replyBody);

      await base44.createEntity('Message', {
        team_phone_id: teamPhone.id || teamPhone._id,
        user_id: teamPhone.user_id,
        contact_id: contact ? (contact.id || contact._id) : undefined,
        direction: 'Outbound',
        from_number: To,
        to_number: From,
        body: replyBody,
        status: 'Sent',
        is_auto_reply: true,
        sent_at: new Date().toISOString()
      });
    }

    res.type('text/xml').send(twimlResp.toString());

  } catch (error) {
    console.error('Error processing incoming SMS:', error);
    res.type('text/xml').send('<Response></Response>');
  }
});

/**
 * POST /webhooks/sms/status
 * Twilio sends delivery status updates here
 */
router.post('/status', async (req, res) => {
  const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body;

  console.log(`📬 SMS status update: ${MessageSid} → ${MessageStatus}`);

  try {
    // Find the message by Twilio SID and update its status
    const messages = await base44.queryEntities('Message', {}, 50);
    const list = Array.isArray(messages) ? messages : (messages.results || messages.data || []);
    const msg = list.find(m => m.twilio_message_sid === MessageSid);

    if (msg) {
      const statusMap = {
        'queued': 'Queued',
        'sent': 'Sent',
        'delivered': 'Delivered',
        'failed': 'Failed',
        'undelivered': 'Failed'
      };

      const updateData = {
        status: statusMap[MessageStatus] || msg.status
      };

      if (ErrorMessage) {
        updateData.error_message = `${ErrorCode}: ${ErrorMessage}`;
      }

      await base44.updateEntity('Message', msg.id || msg._id, updateData);
    }
  } catch (error) {
    console.error('Error updating SMS status:', error);
  }

  res.sendStatus(200);
});

module.exports = router;
