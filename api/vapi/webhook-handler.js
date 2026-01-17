/**
 * VAPI Webhook Handler for Calendar Operations
 * Handles tool calls from VAPI AI agent during phone calls
 */

import { checkAvailability, bookMeeting } from './calendar-service.js';

/**
 * Handle VAPI tool calls for calendar operations
 */
export async function handleVAPICalendarWebhook(req, res) {
  const startTime = Date.now();
  console.log("[VAPI Calendar] ========== NEW REQUEST ==========");
  console.log("[VAPI Calendar] Timestamp:", new Date().toISOString());
  
  try {
    const body = req.body;
    
    console.log("[VAPI Calendar] Request body:", JSON.stringify(body, null, 2));

    // VAPI sends tool calls in message.toolCallList
    const toolCallList = body.message?.toolCallList || [];
    
    if (toolCallList.length === 0) {
      console.log("[VAPI Calendar] No tool calls found in request");
      return res.status(400).json({ error: "No tool calls found" });
    }

    // Process first tool call (VAPI typically sends one at a time)
    const toolCall = toolCallList[0];
    const functionName = toolCall.function?.name;
    const argumentsStr = toolCall.function?.arguments || '{}';
    const parameters = JSON.parse(argumentsStr);

    if (!functionName) {
      return res.status(400).json({ error: "Missing function name" });
    }

    // Extract user_id from call metadata (set during call initiation)
    const userId = body.call?.metadata?.user_id;
    
    if (!userId) {
      console.error("[VAPI Calendar] Missing user_id in call metadata");
      return res.json({
        results: [{
          toolCallId: toolCall.id,
          result: "I'm unable to access the calendar right now. Please contact support."
        }]
      });
    }

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
    
    // Return in VAPI's expected format
    return res.json({
      results: [{
        toolCallId: toolCall.id,
        result: result.result || result
      }]
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error("[VAPI Calendar] ========== ERROR ==========");
    console.error("[VAPI Calendar] Error type:", error instanceof Error ? error.constructor.name : typeof error);
    console.error("[VAPI Calendar] Error message:", error instanceof Error ? error.message : String(error));
    console.error("[VAPI Calendar] Error stack:", error instanceof Error ? error.stack : 'N/A');
    console.error(`[VAPI Calendar] Failed after ${duration}ms`);
    console.error("[VAPI Calendar] ========== ERROR END ==========");
    return res.status(500).json({ 
      results: [{
        result: "I apologize, but I encountered an error checking the calendar. Please try again or contact support."
      }]
    });
  }
}

/**
 * Check calendar availability
 */
async function handleCheckAvailability(parameters, userId) {
  const { date, startTime, endTime, timezone = "UTC" } = parameters;

  if (!date || !startTime) {
    return {
      result: "I need both a date and time to check availability. Could you provide those?",
      success: false
    };
  }

  try {
    // Parse date and time
    const proposedDateTime = parseDateTime(date, startTime, timezone);
    const durationMinutes = endTime ? calculateDuration(startTime, endTime) : 30;
    
    console.log(`[VAPI Calendar] Checking availability:`, {
      userId,
      date,
      startTime,
      endTime,
      timezone,
      proposedDateTime: proposedDateTime.toISOString(),
      durationMinutes
    });

    // Check availability
    const availability = await checkAvailability(userId, proposedDateTime, durationMinutes);

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
    startTime,
    endTime,
    timezone = "UTC",
    attendeeName,
    attendeeEmail,
    meetingTitle,
    meetingDescription
  } = parameters;

  if (!date || !startTime || !attendeeName || !attendeeEmail) {
    return {
      result: "I need the date, time, your name, and email to book the meeting. Could you provide those?",
      success: false
    };
  }

  try {
    const scheduledAt = parseDateTime(date, startTime, timezone);
    const durationMinutes = endTime ? calculateDuration(startTime, endTime) : 30;
    
    console.log(`[VAPI Calendar] Booking meeting:`, {
      userId,
      attendeeName,
      attendeeEmail,
      scheduledAt: scheduledAt.toISOString(),
      durationMinutes
    });

    const result = await bookMeeting(
      userId,
      {
        email: attendeeEmail,
        name: attendeeName,
        phone: call.customer?.number
      },
      {
        title: meetingTitle || `Meeting with ${attendeeName}`,
        description: meetingDescription || `Scheduled via AI call`,
        scheduledAt,
        durationMinutes,
        timezone,
        bookedBy: "ai_call"
      }
    );

    if (result.success) {
      return {
        result: `Perfect! I've booked ${formatDateTime(scheduledAt, timezone)} for you. You'll receive a calendar invite at ${attendeeEmail} shortly.`,
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
 * Calculate duration in minutes between two times
 */
function calculateDuration(startTime, endTime) {
  const [startHour, startMin] = startTime.split(':').map(Number);
  const [endHour, endMin] = endTime.split(':').map(Number);
  return (endHour * 60 + endMin) - (startHour * 60 + startMin);
}

/**
 * Parse date and time string into Date object
 */
function parseDateTime(dateStr, timeStr, timezone) {
  // Handle YYYY-MM-DD format
  const [year, month, day] = dateStr.split('-').map(Number);
  
  // Handle HH:MM format (24-hour)
  const [hours, minutes] = timeStr.split(':').map(Number);

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
    timeZone: timezone || 'UTC'
  };
  
  return date.toLocaleString('en-US', options);
}
