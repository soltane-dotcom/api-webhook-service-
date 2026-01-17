/**
 * VAPI Webhook Handler for Calendar Operations
 * Handles function calls from VAPI AI agent during phone calls
 */

import { checkAvailability, bookMeeting } from './calendar-service.js';

/**
 * Handle VAPI function calls for calendar operations
 */
export async function handleVAPICalendarWebhook(req, res) {
  const startTime = Date.now();
  console.log("[VAPI Calendar] ========== NEW REQUEST ==========");
  console.log("[VAPI Calendar] Timestamp:", new Date().toISOString());
  
  try {
    const body = req.body;
    
    console.log("[VAPI Calendar] Request body:", JSON.stringify(body, null, 2));

    const functionName = body.message?.functionCall?.name;
    const parameters = body.message?.functionCall?.parameters || {};

    if (!functionName) {
      return res.status(400).json({ error: "Missing function name" });
    }

    // Extract user_id from call metadata (set during call initiation)
    const userId = body.call?.assistantOverrides?.variableValues?.user_id;
    
    if (!userId) {
      console.error("[VAPI Calendar] Missing user_id in call metadata");
      return res.json({
        result: "I'm unable to access the calendar right now. Please contact support."
      });
    }

    console.log(`[VAPI Calendar] Processing ${functionName} for user ${userId}`);

    let result;

    switch (functionName) {
      case "check_calendar_availability":
        result = await handleCheckAvailability(parameters, parseInt(userId));
        break;
      
      case "book_calendar_meeting":
        result = await handleBookMeeting(parameters, body.call, parseInt(userId));
        break;
      
      default:
        return res.status(400).json({ error: `Unknown function: ${functionName}` });
    }

    const duration = Date.now() - startTime;
    console.log("[VAPI Calendar] Function result:", result);
    console.log(`[VAPI Calendar] Total duration: ${duration}ms`);
    console.log("[VAPI Calendar] ========== REQUEST COMPLETE ==========");
    return res.json(result);

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error("[VAPI Calendar] ========== ERROR ==========");
    console.error("[VAPI Calendar] Error type:", error instanceof Error ? error.constructor.name : typeof error);
    console.error("[VAPI Calendar] Error message:", error instanceof Error ? error.message : String(error));
    console.error("[VAPI Calendar] Error stack:", error instanceof Error ? error.stack : 'N/A');
    console.error(`[VAPI Calendar] Failed after ${duration}ms`);
    console.error("[VAPI Calendar] ========== ERROR END ==========");
    return res.status(500).json({ 
      result: "I apologize, but I encountered an error checking the calendar. Please try again or contact support." 
    });
  }
}

/**
 * Check calendar availability
 */
async function handleCheckAvailability(parameters, userId) {
  const { date, time, timezone = "UTC", duration_minutes = 30 } = parameters;

  if (!date || !time) {
    return {
      result: "I need both a date and time to check availability. Could you provide those?",
      success: false
    };
  }

  try {
    // Parse date and time
    const proposedDateTime = parseDateTime(date, time, timezone);
    
    console.log(`[VAPI Calendar] Checking availability:`, {
      userId,
      date,
      time,
      timezone,
      proposedDateTime: proposedDateTime.toISOString()
    });

    // Check availability
    const availability = await checkAvailability(userId, proposedDateTime, duration_minutes);

    if (availability.available) {
      return {
        result: `Great! ${formatDateTime(proposedDateTime, timezone)} is available. Would you like to book this time?`,
        success: true
      };
    } else {
      const conflictNames = availability.conflicts.map(c => c.title).join(", ");
      return {
        result: `Unfortunately, ${formatDateTime(proposedDateTime, timezone)} is not available. There's already ${conflictNames} scheduled. Could you suggest another time that works for you?`,
        success: false
      };
    }
  } catch (error) {
    console.error("[VAPI Calendar] Error in handleCheckAvailability:", error);
    return {
      result: "I'm having trouble checking the calendar right now. Could you try a different time?",
      success: false
    };
  }
}

/**
 * Book calendar meeting
 */
async function handleBookMeeting(parameters, call, userId) {
  const {
    date,
    time,
    timezone = "UTC",
    duration = 30,
    leadName,
    leadEmail,
    leadPhone,
    companyName,
    meetingNotes,
    meetingTitle
  } = parameters;

  if (!date || !time || !leadName || !leadEmail) {
    return {
      result: "I need the date, time, your name, and email to book the meeting. Could you provide those?",
      success: false
    };
  }

  try {
    const scheduledAt = parseDateTime(date, time, timezone);
    
    console.log(`[VAPI Calendar] Booking meeting:`, {
      userId,
      leadName,
      leadEmail,
      scheduledAt: scheduledAt.toISOString()
    });

    const result = await bookMeeting(
      userId,
      {
        email: leadEmail,
        name: leadName,
        phone: leadPhone || call.customer?.number
      },
      {
        title: meetingTitle || `Meeting with ${leadName}`,
        description: meetingNotes || `Scheduled via AI call`,
        scheduledAt,
        durationMinutes: duration,
        timezone,
        bookedBy: "ai_call"
      }
    );

    if (result.success) {
      return {
        result: `Perfect! I've booked ${formatDateTime(scheduledAt, timezone)} for you. You'll receive a calendar invite at ${leadEmail} shortly.`,
        success: true
      };
    } else {
      return {
        result: `I wasn't able to book that time. ${result.error || 'Please try a different time.'}`,
        success: false
      };
    }
  } catch (error) {
    console.error("[VAPI Calendar] Error in handleBookMeeting:", error);
    return {
      result: "I encountered an error booking the meeting. Let me transfer you to someone who can help.",
      success: false
    };
  }
}

/**
 * Parse date and time string into Date object
 */
function parseDateTime(dateStr, timeStr, timezone) {
  // Handle various date formats
  let year, month, day;
  
  if (dateStr.includes('-')) {
    // YYYY-MM-DD format
    [year, month, day] = dateStr.split('-').map(Number);
  } else if (dateStr.includes('/')) {
    // DD/MM/YYYY or MM/DD/YYYY format
    const parts = dateStr.split('/').map(Number);
    if (parts[0] > 12) {
      // DD/MM/YYYY
      [day, month, year] = parts;
    } else {
      // MM/DD/YYYY
      [month, day, year] = parts;
    }
  } else {
    throw new Error(`Invalid date format: ${dateStr}`);
  }

  // Handle time (HH:MM or HH:MM AM/PM)
  let hours, minutes;
  const timeLower = timeStr.toLowerCase();
  
  if (timeLower.includes('am') || timeLower.includes('pm')) {
    const isPM = timeLower.includes('pm');
    const timeOnly = timeStr.replace(/am|pm/gi, '').trim();
    [hours, minutes] = timeOnly.split(':').map(Number);
    
    if (isPM && hours !== 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;
  } else {
    [hours, minutes] = timeStr.split(':').map(Number);
  }

  // Create date in UTC
  const date = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));
  
  return date;
}

/**
 * Format date time for display
 */
function formatDateTime(date, timezone) {
  const options = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone
  };
  
  return date.toLocaleString('en-US', options);
}
