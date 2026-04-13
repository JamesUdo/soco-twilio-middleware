require('dotenv').config();
const express = require('express');
const twilio = require('twilio');

const base44 = require('./lib/base44');
const smsRoutes = require('./routes/sms');
const voiceRoutes = require('./routes/voice');
const apiRoutes = require('./routes/api');

const app = express();

// Twilio sends form-encoded data for webhooks
app.use('/webhooks', express.urlencoded({ extended: false }));
// Our API endpoints use JSON
app.use('/api', express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SOCO Twilio Middleware' });
});

// Twilio webhook routes (incoming SMS, call events)
app.use('/webhooks/sms', smsRoutes);
app.use('/webhooks/voice', voiceRoutes);

// Internal API routes (called by base44 frontend to send SMS, make calls)
app.use('/api', apiRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SOCO Twilio Middleware running on port ${PORT}`);
  console.log(`SMS webhook:   ${process.env.BASE_URL}/webhooks/sms/incoming`);
  console.log(`Voice webhook: ${process.env.BASE_URL}/webhooks/voice/incoming`);
});
