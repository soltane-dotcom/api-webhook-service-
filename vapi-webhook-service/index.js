import express from 'express';
import { handleVAPICalendarWebhook } from './webhook-handler.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'vapi-webhook-service' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// VAPI webhook endpoint
app.post('/api/vapi/calendar', handleVAPICalendarWebhook);

// Start server
app.listen(PORT, () => {
  console.log(`VAPI Webhook Service running on port ${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/api/vapi/calendar`);
});

export default app;
