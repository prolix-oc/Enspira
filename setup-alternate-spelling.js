// setup-alternate-spelling.js - Script to configure alternate spellings
// Run this script to add alternate spelling support to your Enspira installation

import { connectToMongoDB, getAllUsers, updateUserData, addAlternateSpelling } from './mongodb-client.js';
import { logger } from './create-global-logger.js';

/**
 * Setup script to configure alternate spellings for your bot
 * This script will:
 * 1. Add the alternateSpell field to all users who don't have it
 * 2. Configure common alternate spellings for bot names
 * 3. Set up your specific "Leila" -> "Layla" mapping
 */
async function setupAlternateSpelling() {
  try {
    logger.log("Setup", "Starting alternate spelling configuration...");

    // Connect to MongoDB
    const connected = await connectToMongoDB();
    if (!connected) {
      logger.error("Setup", "Failed to connect to MongoDB");
      return false;
    }

    // Get all users
    const users = await getAllUsers();
    logger.log("Setup", `Found ${users.length} users to configure`);

    let configuredCount = 0;

    for (const user of users) {
      try {
        // Initialize alternateSpell array if it doesn't exist
        if (!user.alternateSpell) {
          await updateUserData(user.user_id, 'alternateSpell', []);
          logger.log("Setup", `Initialized alternateSpell for user ${user.user_id}`);
        }

        // Configure based on bot name
        const botName = user.bot_name;
        if (!botName) {
          logger.warn("Setup", `User ${user.user_id} has no bot_name, skipping`);
          continue;
        }

        let alternateSpellings = [];

        // Common alternate spellings for popular bot names
        switch (botName.toLowerCase()) {
          case 'layla':
            alternateSpellings = ['Leila', 'Lila', 'Laila', 'Leyla', 'Laela'];
            break;
          case 'sarah':
            alternateSpellings = ['Sara', 'Sera'];
            break;
          case 'catherine':
            alternateSpellings = ['Katherine', 'Kathryn', 'Catherine', 'Kate', 'Katie'];
            break;
          case 'elena':
            alternateSpellings = ['Helena', 'Alena', 'Elaina'];
            break;
          case 'sophia':
            alternateSpellings = ['Sofia', 'Sophie'];
            break;
          case 'maya':
            alternateSpellings = ['Maia', 'Mya'];
            break;
          case 'aria':
            alternateSpellings = ['Arya', 'Aria'];
            break;
          default:
            // For other names, we'll add basic variations
            alternateSpellings = [];
        }

        // Add the alternate spellings
        for (const spelling of alternateSpellings) {
          const success = await addAlternateSpelling(user.user_id, spelling);
          if (success) {
            logger.log("Setup", `Added "${spelling}" as alternate for ${botName} (user: ${user.user_id})`);
          }
        }

        configuredCount++;

      } catch (userError) {
        logger.error("Setup", `Error configuring user ${user.user_id}: ${userError.message}`);
      }
    }

    logger.log("Setup", `Successfully configured alternate spellings for ${configuredCount} users`);
    return true;

  } catch (error) {
    logger.error("Setup", `Error in setupAlternateSpelling: ${error.message}`);
    return false;
  }
}

/**
 * Add a custom alternate spelling for a specific user
 * @param {string} userId - User ID
 * @param {string} alternateSpelling - The alternate spelling to add
 */
async function addCustomAlternateSpelling(userId, alternateSpelling) {
  try {
    const success = await addAlternateSpelling(userId, alternateSpelling);
    if (success) {
      logger.log("Setup", `Added custom alternate spelling "${alternateSpelling}" for user ${userId}`);
    } else {
      logger.error("Setup", `Failed to add alternate spelling for user ${userId}`);
    }
    return success;
  } catch (error) {
    logger.error("Setup", `Error adding custom alternate spelling: ${error.message}`);
    return false;
  }
}

/**
 * Advanced setup for complex name mappings
 * This allows mapping from specific incorrect names to specific correct names
 * @param {string} userId - User ID
 * @param {string} fromName - The incorrect name (e.g., "Leila")
 * @param {string} toName - The correct name (e.g., "Layla")
 */
async function addAdvancedMapping(userId, fromName, toName) {
  try {
    const mapping = { from: fromName, to: toName };
    const success = await addAlternateSpelling(userId, mapping);
    if (success) {
      logger.log("Setup", `Added advanced mapping "${fromName}" -> "${toName}" for user ${userId}`);
    } else {
      logger.error("Setup", `Failed to add mapping for user ${userId}`);
    }
    return success;
  } catch (error) {
    logger.error("Setup", `Error adding advanced mapping: ${error.message}`);
    return false;
  }
}

/**
 * Test the alternate spelling functionality
 * @param {string} testText - Text to test
 * @param {Array} alternateSpellings - Array of alternate spellings
 */
function testAlternateSpelling(testText, alternateSpellings, botName) {
  logger.log("Test", `Testing text: "${testText}"`);
  
  let processedText = testText;
  
  for (const alternateEntry of alternateSpellings) {
    if (typeof alternateEntry === 'string') {
      const regex = new RegExp(`\\b${alternateEntry}\\b`, 'gi');
      processedText = processedText.replace(regex, botName);
    } else if (typeof alternateEntry === 'object' && alternateEntry.from && alternateEntry.to) {
      const regex = new RegExp(`\\b${alternateEntry.from}\\b`, 'gi');
      processedText = processedText.replace(regex, alternateEntry.to);
    }
  }
  
  logger.log("Test", `Processed text: "${processedText}"`);
  return processedText;
}

// Example usage and tests
async function runSetup() {
  logger.log("Setup", "Starting Enspira Alternate Spelling Setup");
  
  // Run the main setup
  const success = await setupAlternateSpelling();
  
  if (success) {
    // Example: Add a custom mapping for a specific user
    // Replace 'your_user_id' with your actual user ID
    // await addAdvancedMapping('your_user_id', 'Leila', 'Layla');
    
    // Example: Test the functionality
    const testAlternates = ['Leila', 'Lila', 'Laila'];
    testAlternateSpelling("Hey Leila, how are you feeling today?", testAlternates, "Layla");
    testAlternateSpelling("Lila, can you help me?", testAlternates, "Layla");
    testAlternateSpelling("What do you think, Laila?", testAlternates, "Layla");
    
    logger.log("Setup", "Setup completed successfully!");
    logger.log("Setup", "Restart your Enspira server to apply the changes.");
  } else {
    logger.error("Setup", "Setup failed. Please check the logs above.");
  }
}

// Export functions for use in other modules
export {
  setupAlternateSpelling,
  addCustomAlternateSpelling,
  addAdvancedMapping,
  testAlternateSpelling
};

// Run setup if this file is executed directly
if (import.meta.url === import.meta.resolve(process.argv[1])) {
  runSetup().then(() => {
    process.exit(0);
  }).catch((error) => {
    logger.error("Setup", `Unhandled error: ${error.message}`);
    process.exit(1);
  });
}