# VAPI Webhook Service

Standalone webhook service for handling VAPI calendar integration calls.

## Why This Exists

The main application is hosted on Manus, which has firewall restrictions that prevent external services like VAPI from reaching webhook endpoints. This standalone service is deployed on Vercel to bypass those restrictions.

## Deployment to Vercel

### Prerequisites
- Vercel account (free tier works)
- Vercel CLI installed: `npm i -g vercel`

### Steps

1. **Login to Vercel**
   ```bash
   vercel login
   ```

2. **Deploy**
   ```bash
   cd /home/ubuntu/vapi-webhook-service
   vercel --prod
   ```

3. **Configure Environment Variables**
   
   After deployment, add these environment variables in Vercel dashboard:
   
   - `MONGODB_URI` - Your MongoDB connection string
   - `GOOGLE_CALENDAR_CLIENT_ID` - Google OAuth client ID
   - `GOOGLE_CALENDAR_CLIENT_SECRET` - Google OAuth client secret

4. **Get Your Webhook URL**
   
   After deployment, Vercel will give you a URL like:
   ```
   https://vapi-webhook-service.vercel.app
   ```
   
   Your webhook endpoint will be:
   ```
   https://vapi-webhook-service.vercel.app/api/vapi/calendar
   ```

5. **Update VAPI Assistant**
   
   Update your VAPI assistant to use the new webhook URL:
   ```bash
   curl -X PATCH "https://api.vapi.ai/assistant/YOUR_ASSISTANT_ID" \
     -H "Authorization: Bearer YOUR_VAPI_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "functions": [
         {
           "name": "check_calendar_availability",
           "serverUrl": "https://vapi-webhook-service.vercel.app/api/vapi/calendar"
         },
         {
           "name": "book_calendar_meeting",
           "serverUrl": "https://vapi-webhook-service.vercel.app/api/vapi/calendar"
         }
       ]
     }'
   ```

## Testing

Test the health endpoint:
```bash
curl https://vapi-webhook-service.vercel.app/health
```

Test the webhook endpoint:
```bash
curl -X POST https://vapi-webhook-service.vercel.app/api/vapi/calendar \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "type": "function-call",
      "functionCall": {
        "name": "check_calendar_availability",
        "parameters": {
          "date": "2026-01-20",
          "time": "14:00",
          "timezone": "Asia/Dubai"
        }
      }
    },
    "call": {
      "id": "test",
      "assistantOverrides": {
        "variableValues": {
          "user_id": "1"
        }
      }
    }
  }'
```

## Monitoring

View logs in Vercel dashboard:
1. Go to https://vercel.com/dashboard
2. Select your project
3. Click "Logs" tab
4. Filter by "Runtime Logs" to see webhook activity

## Architecture

```
VAPI → Vercel (webhook) → MongoDB + Google Calendar
                ↓
         Main App (Manus)
```

The webhook service is stateless and only handles:
- Checking calendar availability
- Booking meetings

All other functionality remains in the main application on Manus.
