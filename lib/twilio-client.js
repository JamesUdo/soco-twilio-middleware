/**
 * Twilio client wrapper
 */

const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Send an SMS
async function sendSMS(from, to, body, mediaUrls = []) {
  const params = { from, to, body };
  if (mediaUrls.length > 0) {
    params.mediaUrl = mediaUrls;
  }
  // Add status callback so we get delivery updates
  params.statusCallback = `${process.env.BASE_URL}/webhooks/sms/status`;
  return client.messages.create(params);
}

// Initiate an outbound call
async function makeCall(from, to, twimlUrl) {
  return client.calls.create({
    from,
    to,
    url: twimlUrl,
    statusCallback: `${process.env.BASE_URL}/webhooks/voice/status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
  });
}

// Generate TwiML response helper
function twiml() {
  return new twilio.twiml.VoiceResponse();
}

function messagingResponse() {
  return new twilio.twiml.MessagingResponse();
}

module.exports = {
  client,
  sendSMS,
  makeCall,
  twiml,
  messagingResponse
};
