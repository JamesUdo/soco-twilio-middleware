/**
 * Voice Webhook Routes
 * Handles incoming calls, voicemail, and call status updates
 */

const express = require('express');
const router = express.Router();
const base44 = require('../lib/base44');
const { twiml: createTwiml } = require('../lib/twilio-client');
const { findMatchingRule } = require('../lib/auto-reply');

/**
 * POST /webhooks/voice/incoming
 * Twilio sends this when someone calls one of your numbers
 *
 * Flow: Ring team member's mobile → if no answer → voicemail
 */
router.post('/incoming', async (req, res) => {
  const { From, To, CallSid } = req.body;

  console.log(`📞 Incoming call from ${From} to ${To}`);

  try {
    // 1. Find which team member owns this number
    const teamPhone = await base44.findTeamPhoneByNumber(To);
    if (!teamPhone) {
      console.warn(`No TeamPhone found for number ${To}`);
      const resp = createTwiml();
      resp.say('Sorry, this number is not configured. Goodbye.');
      resp.hangup();
      return res.type('text/xml').send(resp.toString());
    }

    // 2. Find the contact
    const contact = await base44.findContactByPhone(From);

    // 3. Create a CallLog entry (status: Ringing)
    const callData = {
      team_phone_id: teamPhone.id || teamPhone._id,
      user_id: teamPhone.user_id,
      contact_id: contact ? (contact.id || contact._id) : undefined,
      company_id: contact ? contact.company_id : undefined,
      direction: 'Inbound',
      from_number: From,
      to_number: To,
      status: 'Ringing',
      twilio_call_sid: CallSid,
      started_at: new Date().toISOString()
    };

    await base44.createEntity('CallLog', callData);

    // 4. Build TwiML: forward to mobile, then voicemail on timeout
    const resp = createTwiml();

    if (teamPhone.forward_to_mobile) {
      // Ring the team member's personal phone
      const dial = resp.dial({
        timeout: teamPhone.ring_timeout_seconds || 25,
        callerId: To, // Show business number as caller ID
        action: `${process.env.BASE_URL}/webhooks/voice/dial-complete?teamPhoneId=${teamPhone.id || teamPhone._id}&from=${encodeURIComponent(From)}&callSid=${CallSid}`,
        method: 'POST'
      });
      dial.number(teamPhone.forward_to_mobile);
    } else {
      // No forwarding number — go straight to voicemail
      await playVoicemail(resp, teamPhone, From, CallSid);
    }

    res.type('text/xml').send(resp.toString());

  } catch (error) {
    console.error('Error handling incoming call:', error);
    const resp = createTwiml();
    resp.say('We are experiencing technical difficulties. Please try again later.');
    resp.hangup();
    res.type('text/xml').send(resp.toString());
  }
});

/**
 * POST /webhooks/voice/dial-complete
 * Called after the Dial attempt completes (answered, no-answer, busy, failed)
 */
router.post('/dial-complete', async (req, res) => {
  const { DialCallStatus } = req.body;
  const { teamPhoneId, from, callSid } = req.query;

  console.log(`📞 Dial complete: ${DialCallStatus} for call ${callSid}`);

  const resp = createTwiml();

  try {
    const teamPhone = await base44.getEntity('TeamPhone', teamPhoneId);

    if (DialCallStatus === 'completed') {
      // Call was answered — nothing more to do, status webhook handles the rest
      resp.hangup();
    } else {
      // No answer, busy, or failed → go to voicemail
      if (teamPhone.voicemail_enabled !== false) {
        await playVoicemail(resp, teamPhone, from, callSid);
      } else {
        resp.say('The person you are calling is unavailable. Please try again later.');
        resp.hangup();
      }

      // Update call status
      await updateCallLogStatus(callSid, DialCallStatus === 'no-answer' ? 'No Answer' : 'Busy');
    }
  } catch (error) {
    console.error('Error in dial-complete:', error);
    resp.say('The person you are calling is unavailable. Goodbye.');
    resp.hangup();
  }

  res.type('text/xml').send(resp.toString());
});

/**
 * Play voicemail greeting and record
 */
async function playVoicemail(resp, teamPhone, callerNumber, callSid) {
  // Play greeting
  if (teamPhone.voicemail_greeting_url) {
    resp.play(teamPhone.voicemail_greeting_url);
  } else if (teamPhone.voicemail_greeting_text) {
    resp.say({ voice: 'Polly.Matthew' }, teamPhone.voicemail_greeting_text);
  } else {
    resp.say(
      { voice: 'Polly.Matthew' },
      `You've reached ${teamPhone.user_name} at SOCO Production. ` +
      `Please leave a message after the beep and we'll get back to you as soon as possible.`
    );
  }

  resp.pause({ length: 1 });

  // Record voicemail
  resp.record({
    maxLength: 120, // 2 minutes max
    transcribe: true,
    transcribeCallback: `${process.env.BASE_URL}/webhooks/voice/transcription?callSid=${callSid}`,
    action: `${process.env.BASE_URL}/webhooks/voice/voicemail-complete?callSid=${callSid}&from=${encodeURIComponent(callerNumber)}`,
    method: 'POST',
    playBeep: true,
    finishOnKey: '#'
  });
}

/**
 * POST /webhooks/voice/voicemail-complete
 * Called after voicemail recording finishes
 */
router.post('/voicemail-complete', async (req, res) => {
  const { RecordingUrl, RecordingDuration, RecordingSid } = req.body;
  const { callSid, from } = req.query;

  console.log(`📬 Voicemail recorded: ${RecordingUrl} (${RecordingDuration}s)`);

  try {
    // Update the CallLog with voicemail info
    await updateCallLogByTwilioSid(callSid, {
      status: 'Voicemail',
      voicemail_url: RecordingUrl,
      recording_sid: RecordingSid,
      duration_seconds: parseInt(RecordingDuration || '0', 10)
    });

    // Check for "Missed Call" auto-reply rules
    const callLog = await findCallLogByTwilioSid(callSid);
    if (callLog && callLog.team_phone_id) {
      const teamPhone = await base44.getEntity('TeamPhone', callLog.team_phone_id);
      if (teamPhone && teamPhone.auto_reply_enabled) {
        const match = await findMatchingRule(
          teamPhone.id || teamPhone._id,
          teamPhone,
          '__MISSED_CALL__' // Special trigger
        );

        // Also check rules with trigger_type "Missed Call"
        const rules = await base44.getActiveAutoReplies(teamPhone.id || teamPhone._id);
        const missedCallRule = rules.find(r => r.trigger_type === 'Missed Call' && r.enabled !== false);

        if (missedCallRule) {
          const { sendSMS } = require('../lib/twilio-client');
          let replyBody = missedCallRule.response_message;
          if (teamPhone.sms_signature) {
            replyBody += `\n${teamPhone.sms_signature}`;
          }

          await sendSMS(callLog.to_number, from, replyBody);

          // Save the auto-reply SMS
          await base44.createEntity('Message', {
            team_phone_id: callLog.team_phone_id,
            user_id: callLog.user_id,
            contact_id: callLog.contact_id,
            direction: 'Outbound',
            from_number: callLog.to_number,
            to_number: from,
            body: replyBody,
            status: 'Sent',
            is_auto_reply: true,
            auto_reply_id: missedCallRule.id || missedCallRule._id,
            sent_at: new Date().toISOString()
          });

          console.log(`🤖 Missed call auto-reply sent to ${from}`);
        }
      }
    }
  } catch (error) {
    console.error('Error processing voicemail:', error);
  }

  const resp = createTwiml();
  resp.say('Thank you. Goodbye.');
  resp.hangup();
  res.type('text/xml').send(resp.toString());
});

/**
 * POST /webhooks/voice/transcription
 * Called when Twilio finishes transcribing a voicemail
 */
router.post('/transcription', async (req, res) => {
  const { TranscriptionText, TranscriptionStatus } = req.body;
  const { callSid } = req.query;

  console.log(`📝 Voicemail transcription for ${callSid}: "${TranscriptionText}"`);

  if (TranscriptionStatus === 'completed' && TranscriptionText) {
    try {
      await updateCallLogByTwilioSid(callSid, {
        voicemail_transcription: TranscriptionText
      });
    } catch (error) {
      console.error('Error saving transcription:', error);
    }
  }

  res.sendStatus(200);
});

/**
 * POST /webhooks/voice/status
 * Call status updates from Twilio
 */
router.post('/status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;

  console.log(`📞 Call status: ${CallSid} → ${CallStatus}`);

  try {
    const statusMap = {
      'completed': 'Completed',
      'busy': 'Busy',
      'no-answer': 'No Answer',
      'failed': 'Failed',
      'canceled': 'Missed'
    };

    const updateData = {
      status: statusMap[CallStatus] || CallStatus,
      ended_at: new Date().toISOString()
    };

    if (CallDuration) {
      updateData.duration_seconds = parseInt(CallDuration, 10);
    }

    await updateCallLogByTwilioSid(CallSid, updateData);
  } catch (error) {
    console.error('Error updating call status:', error);
  }

  res.sendStatus(200);
});

// ============ Helpers ============

async function findCallLogByTwilioSid(twilioCallSid) {
  const logs = await base44.queryEntities('CallLog', {}, 50);
  const list = Array.isArray(logs) ? logs : (logs.results || logs.data || []);
  return list.find(l => l.twilio_call_sid === twilioCallSid);
}

async function updateCallLogByTwilioSid(twilioCallSid, data) {
  const log = await findCallLogByTwilioSid(twilioCallSid);
  if (log) {
    await base44.updateEntity('CallLog', log.id || log._id, data);
  }
}

async function updateCallLogStatus(callSid, status) {
  await updateCallLogByTwilioSid(callSid, { status });
}

module.exports = router;
