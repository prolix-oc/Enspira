// debug-mention-detection.js
// Utility script to test and debug mention detection
import { returnAuthObject } from './api-helper.js';
import { logger } from './create-global-logger.js';

/**
 * Helper function to escape special regex characters
 * @param {string} string - String to escape
 * @returns {string} - Escaped string safe for regex
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Enhanced containsCharacterName function with debugging
 * @param {string} message - The message to check.
 * @param {string} userId - The user ID.
 * @returns {Promise<object>} - Result with debug information
 */
async function debugContainsCharacterName(message, userId) {
  try {
    const userObj = await returnAuthObject(userId);
    
    const debugInfo = {
      message: message,
      userId: userId,
      userObj: {
        bot_name: userObj.bot_name,
        bot_twitch: userObj.bot_twitch,
        twitch_tokens: {
          bot: userObj.twitch_tokens?.bot ? {
            twitch_login: userObj.twitch_tokens.bot.twitch_login,
            twitch_display_name: userObj.twitch_tokens.bot.twitch_display_name
          } : null,
          streamer: userObj.twitch_tokens?.streamer ? {
            twitch_login: userObj.twitch_tokens.streamer.twitch_login,
            twitch_display_name: userObj.twitch_tokens.streamer.twitch_display_name
          } : null
        }
      },
      namesToCheck: [],
      matchResults: [],
      finalResult: false
    };
    
    if (!message || typeof message !== 'string') {
      debugInfo.error = 'Invalid message';
      return debugInfo;
    }

    const normalizedMessage = message.toLowerCase().trim();
    debugInfo.normalizedMessage = normalizedMessage;
    
    // Get all possible name variations
    const namesToCheck = new Set();
    
    // Add character/bot name
    if (userObj.bot_name) {
      namesToCheck.add(userObj.bot_name.toLowerCase());
    }
    
    // Add Twitch bot username variations
    if (userObj.bot_twitch) {
      const botTwitch = userObj.bot_twitch.toLowerCase();
      namesToCheck.add(botTwitch);
      // Remove @ if present and add both versions
      const cleanBotTwitch = botTwitch.startsWith('@') ? botTwitch.slice(1) : botTwitch;
      namesToCheck.add(cleanBotTwitch);
      namesToCheck.add('@' + cleanBotTwitch);
    }
    
    // Add the actual bot account username from tokens if available
    if (userObj.twitch_tokens?.bot?.twitch_login) {
      const botLogin = userObj.twitch_tokens.bot.twitch_login.toLowerCase();
      namesToCheck.add(botLogin);
      namesToCheck.add('@' + botLogin);
    }
    
    if (userObj.twitch_tokens?.bot?.twitch_display_name) {
      const botDisplayName = userObj.twitch_tokens.bot.twitch_display_name.toLowerCase();
      namesToCheck.add(botDisplayName);
      namesToCheck.add('@' + botDisplayName);
    }
    
    // Also check against streamer account in case bot_twitch points to streamer
    if (userObj.twitch_tokens?.streamer?.twitch_login) {
      const streamerLogin = userObj.twitch_tokens.streamer.twitch_login.toLowerCase();
      namesToCheck.add(streamerLogin);
      namesToCheck.add('@' + streamerLogin);
    }
    
    // Remove empty/undefined entries
    const validNames = Array.from(namesToCheck).filter(name => name && name.length > 0);
    debugInfo.namesToCheck = validNames;
    
    if (validNames.length === 0) {
      debugInfo.error = 'No valid bot names found';
      return debugInfo;
    }
    
    // Check each name variation
    for (const nameToCheck of validNames) {
      const testResult = {
        name: nameToCheck,
        wordBoundaryMatch: false,
        atMentionMatch: false,
        matched: false
      };
      
      // Exact word match (handles @mentions and regular mentions)
      const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(nameToCheck)}\\b`, 'i');
      testResult.wordBoundaryMatch = wordBoundaryRegex.test(normalizedMessage);
      testResult.wordBoundaryRegex = wordBoundaryRegex.toString();
      
      // Also check for @ mentions without word boundaries (for usernames with special chars)
      if (nameToCheck.startsWith('@')) {
        const atMentionRegex = new RegExp(`${escapeRegExp(nameToCheck)}`, 'i');
        testResult.atMentionMatch = atMentionRegex.test(normalizedMessage);
        testResult.atMentionRegex = atMentionRegex.toString();
      }
      
      testResult.matched = testResult.wordBoundaryMatch || testResult.atMentionMatch;
      
      if (testResult.matched) {
        debugInfo.finalResult = true;
      }
      
      debugInfo.matchResults.push(testResult);
    }
    
    return debugInfo;
  } catch (error) {
    return {
      message: message,
      userId: userId,
      error: error.message,
      finalResult: false
    };
  }
}

/**
 * Test multiple messages against mention detection
 * @param {string} userId - The user ID to test against
 * @param {string[]} testMessages - Array of test messages
 */
async function testMentionDetection(userId, testMessages = []) {
  console.log(`\n=== Testing Mention Detection for User ${userId} ===\n`);
  
  // Default test messages if none provided
  if (testMessages.length === 0) {
    testMessages = [
      "Hello Layla",
      "@Layla how are you?",
      "Hey layla, what's up?",
      "Layla, can you help me?",
      "I think Layla is great",
      "Not mentioning anyone here",
      "This is just a regular message",
      "@layla123",
      "LAYLA!!"
    ];
  }
  
  for (const message of testMessages) {
    console.log(`\nTesting: "${message}"`);
    console.log('─'.repeat(50));
    
    const result = await debugContainsCharacterName(message, userId);
    
    console.log(`Result: ${result.finalResult ? '✅ MATCH' : '❌ NO MATCH'}`);
    
    if (result.error) {
      console.log(`Error: ${result.error}`);
      continue;
    }
    
    console.log(`Names checked: ${result.namesToCheck.join(', ')}`);
    
    // Show detailed match results
    result.matchResults.forEach(matchResult => {
      if (matchResult.matched) {
        console.log(`  ✅ "${matchResult.name}" matched`);
        if (matchResult.wordBoundaryMatch) {
          console.log(`     - Word boundary: ${matchResult.wordBoundaryRegex}`);
        }
        if (matchResult.atMentionMatch) {
          console.log(`     - @ mention: ${matchResult.atMentionRegex}`);
        }
      }
    });
  }
  
  console.log('\n=== Test Complete ===\n');
}

/**
 * Debug user configuration for mention detection
 * @param {string} userId - The user ID to debug
 */
async function debugUserConfiguration(userId) {
  try {
    console.log(`\n=== User Configuration Debug for ${userId} ===\n`);
    
    const userObj = await returnAuthObject(userId);
    
    if (!userObj) {
      console.log('❌ User not found');
      return;
    }
    
    console.log('Bot Configuration:');
    console.log(`  bot_name: "${userObj.bot_name || 'NOT SET'}"`);
    console.log(`  bot_twitch: "${userObj.bot_twitch || 'NOT SET'}"`);
    
    console.log('\nTwitch Tokens:');
    if (userObj.twitch_tokens?.bot) {
      console.log('  Bot Account:');
      console.log(`    access_token: ${userObj.twitch_tokens.bot.access_token ? 'SET' : 'NOT SET'}`);
      console.log(`    twitch_login: "${userObj.twitch_tokens.bot.twitch_login || 'NOT SET'}"`);
      console.log(`    twitch_display_name: "${userObj.twitch_tokens.bot.twitch_display_name || 'NOT SET'}"`);
      console.log(`    twitch_user_id: "${userObj.twitch_tokens.bot.twitch_user_id || 'NOT SET'}"`);
    } else {
      console.log('  Bot Account: NOT CONNECTED');
    }
    
    if (userObj.twitch_tokens?.streamer) {
      console.log('  Streamer Account:');
      console.log(`    access_token: ${userObj.twitch_tokens.streamer.access_token ? 'SET' : 'NOT SET'}`);
      console.log(`    twitch_login: "${userObj.twitch_tokens.streamer.twitch_login || 'NOT SET'}"`);
      console.log(`    twitch_display_name: "${userObj.twitch_tokens.streamer.twitch_display_name || 'NOT SET'}"`);
      console.log(`    twitch_user_id: "${userObj.twitch_tokens.streamer.twitch_user_id || 'NOT SET'}"`);
    } else {
      console.log('  Streamer Account: NOT CONNECTED');
    }
    
    console.log('\nAux Bots:');
    if (userObj.aux_bots && userObj.aux_bots.length > 0) {
      userObj.aux_bots.forEach((bot, index) => {
        console.log(`  ${index + 1}. "${bot}"`);
      });
    } else {
      console.log('  None configured');
    }
    
    console.log('\n=== Configuration Debug Complete ===\n');
  } catch (error) {
    console.log(`❌ Error debugging user configuration: ${error.message}`);
  }
}

// Export functions for use
export {
  debugContainsCharacterName,
  testMentionDetection,
  debugUserConfiguration
};

// If run directly from command line
if (import.meta.url === `file://${process.argv[1]}`) {
  const userId = process.argv[2];
  
  if (!userId) {
    console.log('Usage: node debug-mention-detection.js <userId> [test|config]');
    console.log('  test   - Run mention detection tests');
    console.log('  config - Show user configuration');
    process.exit(1);
  }
  
  const action = process.argv[3] || 'test';
  
  if (action === 'config') {
    await debugUserConfiguration(userId);
  } else {
    await testMentionDetection(userId);
  }
}