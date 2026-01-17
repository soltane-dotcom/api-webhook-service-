/**
 * VAPI Calendar Webhook - Vercel Serverless Function
 * Self-contained with no external dependencies
 * Handles BOTH VAPI payload formats (toolCallList AND toolCalls)
 */

import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;

let cachedClient = null;

async function getMongoClient() {
  if (cachedClient) return cachedClient;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  cachedClient = client;
  return client;
}

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  console.log("[VAPI Calendar] ========== NEW REQUEST ==========");
  console.log("[VAPI Calendar] Timestamp:", new Date().toISOString());
  
  try {
    const body = req.body;
    console.log("[VAPI Calendar] Request body:", JSON.stringify(body, null, 2));

    // VAPI sends tool calls in DIFFERENT formats depending on context:
    // Format 1: message.toolCallList (from docs)
    // Format 2: message.toolCalls (actual API calls)
    let toolCallList = body.message?.toolCallList || body.message?.toolCalls || [];
    
    if (toolCallList.length === 0) {
      console.log("[VAPI Calendar] No tool calls found in request");
      return res.status(400).json({ error: "No tool calls found" });
    }

    // Process first tool call
    const toolCall = toolCallList[0];
    
    // Handle BOTH formats:
    // Format 1: { id, name, arguments: {} }
    // Format 2: { id, type: "function", function: { name, arguments: "{}" } }
    let functionName, parameters;
    
    if (toolCall.function) {
      // Format 2: VAPI actual API format
      functionName = toolCall.function.name;
      const argsStr = toolCall.function.arguments || '{}';
      parameters = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
    } else {
      // Format 1: VAPI docs format
      functionName = toolCall.name;
      parameters = toolCall.arguments || {};
    }

    console.log("[VAPI Calendar] Extracted function:", functionName);
    console.log("[VAPI Calendar] Extracted parameters:", parameters);

    if (!functionName) {
      console.error("[VAPI Calendar] Could not extract function name from toolCall:", toolCall);
      return res.status(400).json({ error: "Missing function name" });
    }

    // Extract user_id from various possible locations
    const userId = body.call?.metadata?.user_id || 
                   body.call?.assistantOverrides?.variableValues?.user_id ||
                   body.message?.call?.metadata?.user_id ||
                   "1"; // Default to user 1 for testing
    
    console.log(`[VAPI Calendar] Processing ${functionName} for user ${userId}`);
    console.log(`[VAPI Calendar] Parameters:`, parameters);

    let result;

    switch (functionName) {
      case "check_calendar_availability":
        result = await handleCheckAvailability(parameters, userId);
        break;
      
      case "book_calendar_meeting":
        result = await handleBookMeeting(parameters, body.call, userId);
        break;
      
      default:
        return res.status(400).json({ error: `Unknown function: ${functionName}` });
    }

    const duration = Date.now() - startTime;
    console.log("[VAPI Calendar] Function result:", result);
    console.log(`[VAPI Calendar] Total duration: ${duration}ms`);
    console.log("[VAPI Calendar] ========== REQUEST COMPLETE ==========");
    
    return res.json({
      results: [{
        toolCallId: toolCall.id,
        result: result.result || result
      }]
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error("[VAPI Calendar] ========== ERROR ==========");
    console.error("[VAPI Calendar] Error:", error);
    console.error(`[VAPI Calendar] Failed after ${duration}ms`);
    return res.status(500).json({ 
      results: [{
        result: "I apologize, but I encountered an error. Please try again."
      }]
    });
  }
}

async function handleCheckAvailability(parameters, userId) {
  const { date, startTime, endTime } = parameters;

  if (!date || !startTime) {
    return {
      result: "I need both a date and time to check availability. Could you provide those?"
    };
  }

  try {
    const proposedDateTime = parseDateTime(date, startTime);
    const durationMinutes = endTime ? calculateDuration(startTime, endTime) : 30;
    
    console.log(`[VAPI Calendar] Checking availability:`, {
      userId,
      date,
      startTime,
      proposedDateTime: proposedDateTime.toISOString()
    });

    // Get user's calendar integration
    const client = await getMongoClient();
    const db = client.db('organization');
    const integration = await db.collection('user_integrations').findOne({
      userId: parseInt(userId),
      provider: 'google-calendar'
    });

    if (!integration) {
      return {
        result: "Your calendar is not connected. Please connect your Google Calendar first."
      };
    }

    // Check availability via Google Calendar API
    const accessToken = await getValidAccessToken(integration);
    const available = await checkGoogleCalendar(accessToken, proposedDateTime, durationMinutes);

    if (available) {
      return {
        result: `Great! ${formatDateTime(proposedDateTime)} is available. Would you like to book this time?`
      };
    } else {
      return {
        result: `Unfortunately, ${formatDateTime(proposedDateTime)} is not available. Could you suggest another time?`
      };
    }
  } catch (error) {
    console.error("[VAPI Calendar] Error in handleCheckAvailability:", error);
    return {
      result: "I'm having trouble checking the calendar right now. Could you try a different time?"
    };
  }
}

async function handleBookMeeting(parameters, call, userId) {
  const { date, startTime, endTime, attendeeName, attendeeEmail, meetingTitle } = parameters;

  if (!date || !startTime || !attendeeName || !attendeeEmail) {
    return {
      result: "I need the date, time, your name, and email to book the meeting."
    };
  }

  try {
    const scheduledAt = parseDateTime(date, startTime);
    const durationMinutes = endTime ? calculateDuration(startTime, endTime) : 30;
    
    console.log(`[VAPI Calendar] Booking meeting:`, {
      userId,
      attendeeName,
      attendeeEmail,
      scheduledAt: scheduledAt.toISOString()
    });

    // Get user's calendar integration
    const client = await getMongoClient();
    const db = client.db('organization');
    const integration = await db.collection('user_integrations').findOne({
      userId: parseInt(userId),
      provider: 'google-calendar'
    });

    if (!integration) {
      return {
        result: "Your calendar is not connected. Please connect your Google Calendar first."
      };
    }

    // Book meeting via Google Calendar API
    const accessToken = await getValidAccessToken(integration);
    await bookGoogleCalendarEvent(
      accessToken,
      meetingTitle || `Meeting with ${attendeeName}`,
      scheduledAt,
      durationMinutes,
      attendeeEmail
    );

    return {
      result: `Perfect! I've booked ${formatDateTime(scheduledAt)} for you. You'll receive a calendar invite at ${attendeeEmail} shortly.`
    };
  } catch (error) {
    console.error("[VAPI Calendar] Error in handleBookMeeting:", error);
    return {
      result: "I encountered an error booking the meeting. Please try again."
    };
  }
}

async function getValidAccessToken(integration) {
  // Check if token is expired
  if (integration.expiresAt && new Date(integration.expiresAt) > new Date()) {
    return integration.accessToken;
  }

  // Refresh token
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: integration.refreshToken,
      grant_type: 'refresh_token'
    } )
  });

  const data = await response.json();
  
  // Update token in database
  const client = await getMongoClient();
  const db = client.db('organization');
  await db.collection('user_integrations').updateOne(
    { _id: integration._id },
    {
      $set: {
        accessToken: data.access_token,
        expiresAt: new Date(Date.now() + data.expires_in * 1000)
      }
    }
  );

  return data.access_token;
}

async function checkGoogleCalendar(accessToken, startTime, durationMinutes) {
  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
    `timeMin=${startTime.toISOString( )}&timeMax=${endTime.toISOString()}&singleEvents=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );

  const data = await response.json();
  return !data.items || data.items.length === 0;
}

async function bookGoogleCalendarEvent(accessToken, title, startTime, durationMinutes, attendeeEmail) {
  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  
  const event = {
    summary: title,
    start: { dateTime: startTime.toISOString(), timeZone: 'UTC' },
    end: { dateTime: endTime.toISOString(), timeZone: 'UTC' },
    attendees: [{ email: attendeeEmail }],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 },
        { method: 'popup', minutes: 30 }
      ]
    }
  };

  const response = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event )
    }
  );

  return await response.json();
}

function calculateDuration(startTime, endTime) {
  const [startHour, startMin] = startTime.split(':').map(Number);
  const [endHour, endMin] = endTime.split(':').map(Number);
  return (endHour * 60 + endMin) - (startHour * 60 + startMin);
}

function parseDateTime(dateStr, timeStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = timeStr.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));
}

function formatDateTime(date) {
  return date.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC'
  });
}
