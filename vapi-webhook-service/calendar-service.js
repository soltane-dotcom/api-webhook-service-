/**
 * Calendar Integration Service
 * Simplified version for standalone webhook service
 */

import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;

let cachedClient = null;
let cachedDb = null;

/**
 * Get MongoDB connection (with caching)
 */
async function getMongoDb() {
  if (cachedDb) {
    return cachedDb;
  }

  if (!cachedClient) {
    cachedClient = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
    });
    await cachedClient.connect();
    console.log('[MongoDB] Connected');
  }

  cachedDb = cachedClient.db();
  return cachedDb;
}

/**
 * Get user's Google Calendar integration
 */
async function getUserIntegration(userId) {
  const db = await getMongoDb();
  const collection = db.collection('user_integrations');
  const integration = await collection.findOne({ userId, provider: 'google-calendar' });
  
  if (!integration) {
    return null;
  }
  
  return {
    userId: integration.userId,
    provider: integration.provider,
    accessToken: integration.accessToken,
    refreshToken: integration.refreshToken,
    expiresAt: new Date(integration.expiresAt),
    createdAt: new Date(integration.createdAt),
    updatedAt: new Date(integration.updatedAt),
  };
}

/**
 * Refresh Google OAuth access token
 */
async function refreshAccessToken(userId, refreshToken) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Token refresh failed: ${errorText}`);
  }

  const tokens = await tokenResponse.json();
  
  // Update access token in MongoDB
  const db = await getMongoDb();
  const collection = db.collection('user_integrations');
  
  const now = new Date();
  const expiresAt = new Date(now.getTime() + tokens.expires_in * 1000);
  
  await collection.updateOne(
    { userId, provider: 'google-calendar' },
    {
      $set: {
        accessToken: tokens.access_token,
        expiresAt,
        updatedAt: now,
      },
    }
  );

  return tokens.access_token;
}

/**
 * Get valid access token (refreshes if expired)
 */
async function getValidAccessToken(userId) {
  const integration = await getUserIntegration(userId);
  
  if (!integration || !integration.accessToken) {
    throw new Error("Google Calendar not connected. Please connect your calendar in Integrations.");
  }

  // Check if token is expired or about to expire (within 5 minutes)
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  if (integration.expiresAt < fiveMinutesFromNow) {
    // Token expired or about to expire, refresh it
    if (!integration.refreshToken) {
      throw new Error("No refresh token available. Please reconnect your calendar.");
    }
    return await refreshAccessToken(userId, integration.refreshToken);
  }

  return integration.accessToken;
}

/**
 * Get calendar events from Google Calendar
 */
async function getGoogleCalendarEvents(accessToken, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
  });

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch Google Calendar events: ${errorText}`);
  }

  const data = await response.json();
  
  return (data.items || []).map((event) => ({
    id: event.id,
    title: event.summary || "Busy",
    start: new Date(event.start.dateTime || event.start.date),
    end: new Date(event.end.dateTime || event.end.date),
    allDay: !event.start.dateTime,
  }));
}

/**
 * Check availability for a proposed time
 */
export async function checkAvailability(userId, proposedTime, durationMinutes = 30) {
  console.log(`[Calendar Service] ===== checkAvailability START =====`);
  console.log(`[Calendar Service] userId: ${userId}, proposedTime: ${proposedTime.toISOString()}, duration: ${durationMinutes}min`);
  
  try {
    // Get valid access token
    const accessToken = await getValidAccessToken(userId);

    // Calculate time range to check (proposed time + duration)
    const duration = durationMinutes * 60 * 1000;
    const proposedEnd = new Date(proposedTime.getTime() + duration);

    // Query events in a wider window to catch any conflicts
    const timeMin = new Date(proposedTime.getTime() - 60 * 60 * 1000); // 1 hour before
    const timeMax = new Date(proposedEnd.getTime() + 60 * 60 * 1000); // 1 hour after

    console.log(`[Calendar] Checking availability for user ${userId}:`, {
      proposedTime: proposedTime.toISOString(),
      proposedEnd: proposedEnd.toISOString(),
      durationMinutes,
      queryRange: { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString() }
    });

    const events = await getGoogleCalendarEvents(accessToken, timeMin, timeMax);
    
    console.log(`[Calendar] Found ${events.length} events in range:`, events.map(e => ({
      title: e.title,
      start: e.start.toISOString(),
      end: e.end.toISOString()
    })));

    // Check for conflicts - any event that overlaps with the proposed time slot
    const conflicts = events.filter((event) => {
      const hasConflict = event.start < proposedEnd && event.end > proposedTime;
      console.log(`[Calendar] Checking event "${event.title}":`, {
        eventStart: event.start.toISOString(),
        eventEnd: event.end.toISOString(),
        proposedStart: proposedTime.toISOString(),
        proposedEnd: proposedEnd.toISOString(),
        hasConflict
      });
      return hasConflict;
    });

    console.log(`[Calendar] Found ${conflicts.length} conflicts`);

    if (conflicts.length > 0) {
      return {
        available: false,
        conflicts,
        nextAvailable: undefined,
      };
    }

    return { available: true, conflicts: [] };
  } catch (error) {
    console.error('[Calendar] Error checking availability:', error);
    // If calendar not connected, return available (fail open)
    if (error.message.includes("not connected")) {
      return { available: true, conflicts: [] };
    }
    throw error;
  }
}

/**
 * Create calendar event on Google Calendar
 */
async function createGoogleCalendarEvent(
  accessToken,
  title,
  description,
  startTime,
  endTime,
  attendeeEmails
) {
  console.log(`[Calendar] Creating Google Calendar event:`, {
    title,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    attendees: attendeeEmails
  });

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: title,
        description,
        start: { 
          dateTime: startTime.toISOString(),
          timeZone: 'UTC',
        },
        end: { 
          dateTime: endTime.toISOString(),
          timeZone: 'UTC',
        },
        attendees: attendeeEmails.map(email => ({ email })),
        reminders: {
          useDefault: false,
          overrides: [
            { method: "email", minutes: 60 },
            { method: "popup", minutes: 15 },
          ],
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error('[Calendar] Failed to create event:', error);
    throw new Error(`Failed to create Google Calendar event: ${error}`);
  }

  const data = await response.json();
  
  console.log(`[Calendar] Event created successfully:`, {
    eventId: data.id,
    eventUrl: data.htmlLink
  });

  return {
    eventId: data.id,
    eventUrl: data.htmlLink,
  };
}

/**
 * Book a meeting on Google Calendar
 * Simplified version - only creates calendar event, doesn't save to database
 */
export async function bookMeeting(userId, leadInfo, meetingDetails) {
  try {
    const durationMinutes = meetingDetails.durationMinutes || 30;
    const endTime = new Date(meetingDetails.scheduledAt.getTime() + durationMinutes * 60 * 1000);

    console.log(`[Calendar] Booking meeting for user ${userId}:`, {
      lead: leadInfo.name,
      title: meetingDetails.title,
      scheduledAt: meetingDetails.scheduledAt.toISOString(),
      durationMinutes
    });

    // Check availability first
    const availability = await checkAvailability(userId, meetingDetails.scheduledAt, durationMinutes);
    
    if (!availability.available) {
      console.log('[Calendar] Time slot not available, conflicts:', availability.conflicts);
      return {
        success: false,
        error: `Time slot not available. Conflicts with: ${availability.conflicts.map(c => c.title).join(', ')}`,
      };
    }

    // Get valid access token and create calendar event
    const accessToken = await getValidAccessToken(userId);
    const result = await createGoogleCalendarEvent(
      accessToken,
      meetingDetails.title,
      meetingDetails.description || `Meeting with ${leadInfo.name}`,
      meetingDetails.scheduledAt,
      endTime,
      [leadInfo.email]
    );

    console.log(`[Calendar] Meeting booked successfully:`, {
      calendarEventId: result.eventId
    });

    return {
      success: true,
      calendarEventId: result.eventId,
    };
  } catch (error) {
    console.error('[Calendar] Error booking meeting:', error);
    return {
      success: false,
      error: error.message || "Failed to book meeting",
    };
  }
}
