// Enhanced chat-handler.js with better logging and debugging
import { respondToChat, respondToEvent } from './ai-logic.js';
import { containsCharacterName, containsAuxBotName } from './prompt-helper.js';
import { isCommandMatch } from './twitch-helper.js';
import { logger } from './create-global-logger.js';
import { returnAuthObject } from './api-helper.js';
import { addChatMessageAsVector } from './ai-logic.js';
import { sendChatMessage } from './twitch-eventsub-manager.js';

/**
 * Central handler for all chat messages from any source (API or EventSub)
 * Enhanced with better logging and debugging
 * @param {object} chatData - Normalized chat message data
 * @param {string} userId - The system user ID
 * @param {boolean} autoRespond - Whether to automatically send Twitch chat responses
 * @returns {Promise<object>} - Processing result with response if applicable
 */
export async function handleChatMessage(chatData, userId, autoRespond = false) {
  try {
    const user = await returnAuthObject(userId);
    if (!user) {
      logger.error("Chat", `User ${userId} not found`);
      return { success: false, error: "User not found" };
    }

    // Extract message details
    const { message, user: chatUser, firstMessage = false } = chatData;
    
    // Enhanced logging for debugging
    logger.log("Chat", `Processing message from ${chatUser}: "${message}" (firstMessage: ${firstMessage})`);
    
    // Format date for context
    const formattedDate = new Date().toLocaleString();
    
    // Check for conditions that lead to ignoring the message
    const fromBot = await containsAuxBotName(chatUser, userId);
    if (fromBot) {
      logger.log("Chat", `Ignoring message from bot: ${chatUser}`);
      return { success: true, ignored: true, reason: "bot_user" };
    }
    
    const isCommand = await isCommandMatch(message, userId);
    if (isCommand) {
      logger.log("Chat", `Ignoring command message: ${message}`);
      return { success: true, ignored: true, reason: "command" };
    }
    
    // Check if message mentions the character - Enhanced logging
    logger.log("Chat", `Checking if message mentions character for user ${userId}...`);
    const mentionsChar = await containsCharacterName(message, userId);
    logger.log("Chat", `Character mention check result: ${mentionsChar ? 'YES' : 'NO'}`);
    
    // Process the message based on conditions
    if (mentionsChar) {
      // Regular mention - process through chat system
      logger.log("Chat", `Processing mention from ${chatUser}: ${message}`);
      
      // Create message data for AI processing
      const messageData = { message, user: chatUser };
      
      // Get AI response
      logger.log("Chat", `Getting AI response for mention from ${chatUser}...`);
      const aiResponse = await respondToChat(messageData, userId);
      
      if (!aiResponse.success) {
        logger.error("Chat", `Error getting AI response: ${aiResponse.error}`);
        return { 
          success: false, 
          error: aiResponse.error || "Failed to generate response" 
        };
      }
      
      logger.log("Chat", `AI response generated: "${aiResponse.text.substring(0, 100)}..."`);
      
      // Create summary for vector storage
      const summaryString = `On ${formattedDate} ${chatUser} said in ${user.user_name || user.twitch_name}'s Twitch chat: "${message}". You responded by saying: ${aiResponse.text}`;
      
      // Store in vector memory (don't await to avoid blocking)
      addChatMessageAsVector(
        summaryString,
        message,
        chatUser,
        formattedDate,
        aiResponse.text,
        userId
      ).catch(err => logger.error("Chat", `Error storing chat vector: ${err.message}`));
      
      // Send to Twitch chat if autoRespond is enabled
      let chatResponse = null;
      if (autoRespond && user.twitch_tokens?.bot?.access_token) {
        logger.log("Chat", `Sending response to Twitch chat: "${aiResponse.text}"`);
        chatResponse = await sendChatMessage(aiResponse.text, userId);
        
        if (chatResponse.success) {
          logger.log("Chat", `Successfully sent response to Twitch chat`);
        } else {
          logger.error("Chat", `Failed to send response to Twitch chat: ${chatResponse.error}`);
        }
      } else if (autoRespond) {
        logger.warn("Chat", `AutoRespond enabled but no bot token available for user ${userId}`);
      }
      
      return {
        success: true,
        processed: true,
        response: aiResponse.text,
        thoughtProcess: aiResponse.thoughtProcess,
        chatResponse,
        summaryString
      };
    } else if (firstMessage) {
      // First-time chatter - handle as an event
      logger.log("Chat", `Processing first-time chatter event from ${chatUser}`);
      
      // Create event data object
      const eventData = {
        eventType: 'chat',
        user: chatUser,
        message: message,
        firstMessage: true
      };
      
      // Process through event system
      const eventResponse = await respondToEvent(eventData, userId);
      
      if (!eventResponse || !eventResponse.response) {
        logger.error("Chat", `Error getting event response for first-time chatter`);
        return { 
          success: false, 
          error: "Failed to generate first-time chatter response" 
        };
      }
      
      // Create summary for vector storage
      const summaryString = `On ${formattedDate} ${chatUser} sent their first message in ${user.user_name || user.twitch_name}'s Twitch chat: "${message}". You responded by saying: ${eventResponse.response}`;
      
      // Store in vector memory
      addChatMessageAsVector(
        summaryString,
        message,
        chatUser,
        formattedDate,
        eventResponse.response,
        userId
      ).catch(err => logger.error("Chat", `Error storing first-time chat vector: ${err.message}`));
      
      // Send to Twitch chat if autoRespond is enabled
      let chatResponse = null;
      if (autoRespond && user.twitch_tokens?.bot?.access_token) {
        chatResponse = await sendChatMessage(eventResponse.response, userId);
      }
      
      return {
        success: true,
        processed: true,
        firstTimeChatter: true,
        response: eventResponse.response,
        thoughtProcess: eventResponse.thoughtProcess,
        chatResponse,
        summaryString
      };
    } else {
      // Regular message - just store for context
      logger.log("Chat", `Regular message from ${chatUser}, storing for context (if enabled)`);
      const summaryString = `On ${formattedDate} ${chatUser} said in ${user.user_name || user.twitch_name}'s Twitch chat: "${message}"`;
      
      // Store in vector memory if enabled in user settings
      if (user.store_all_chat) {
        logger.log("Chat", `Storing regular chat message for context`);
        addChatMessageAsVector(
          summaryString,
          message,
          chatUser,
          formattedDate,
          "", // No response
          userId
        ).catch(err => logger.error("Chat", `Error storing regular chat: ${err.message}`));
      }
      
      return {
        success: true,
        processed: false,
        requiresResponse: false,
        summaryString
      };
    }
  } catch (error) {
    logger.error("Chat", `Error in chat handler: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Normalizes chat messages from various sources into a standard format
 * @param {object} messageData - Raw message from EventSub or API
 * @returns {object} - Standardized chat object
 */
export function normalizeMessageFormat(messageData) {
  // From EventSub webhook
  if (messageData.chatter && messageData.message && messageData.message.text) {
    return {
      user: messageData.chatter.user_name,
      userId: messageData.chatter.user_id,
      message: messageData.message.text,
      firstMessage: messageData.message.is_first || false,
      badges: messageData.chatter.badges?.map(badge => badge.set_id) || [],
      emotes: messageData.message.fragments
        ?.filter(f => f.type === 'emote')
        .map(e => ({ id: e.id, code: e.text })) || [],
      emoteCount: messageData.message.fragments?.filter(f => f.type === 'emote').length || 0,
      color: messageData.chatter.color,
      source: 'eventsub'
    };
  }
  
  // From API
  return {
    user: messageData.user,
    userId: messageData.userId || null,
    message: messageData.message,
    firstMessage: messageData.firstMessage || false,
    badges: messageData.badges || [],
    emotes: messageData.emotes || [],
    emoteCount: messageData.emoteCount || 0,
    color: messageData.color || null,
    source: 'api'
  };
}