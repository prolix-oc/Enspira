import fs from "fs-extra"
import { Tokenizer } from "tokenizers";
import moment from "moment";
import { socialMedias, returnTwitchEvent } from "./twitch_helper.js";
import { interpretEmotions } from "./data-helper.js";
import { returnAuthObject } from "./api-helper.js";

const tokenConfig = fs.readFileSync("./resources/system_tokens.json", "utf-8");
const tokensJson = JSON.parse(tokenConfig)
const tokenParams = tokensJson[process.env.LLM_MODEL_TYPE]
const promptTokenCount = async (prompt, type) => {
    const modelToken = Tokenizer.fromFile(`./resources/${type}/tokenizer.json`);
    const encoded = await modelToken.encode(prompt)
    return encoded.getLength()
}
const contextPrompt = async (message, promptData) => {
    const instructTemplate = fs.readFileSync(`./instructs/${process.env.LLM_MODEL_TYPE}/instruct.txt`, "utf-8");
    const timeStamp = moment().format('MM/DD/YY [at] hh:mm A');

    const files = {
        personality: './world_info/character_personality.txt',
        worldInfo: './world_info/world_lore.txt',
        scenario: './world_info/scenario.txt',
        characterCard: './world_info/character_card.txt',
        weatherInfo: './world_info/weather.txt',
        recentChat: './world_info/twitch_chat.txt',
        ruleSet: './world_info/rules.txt',
        playerInfo: './world_info/player_info.txt'
    };

    const fileContents = {};
    for (const [key, filePath] of Object.entries(files)) {
        fileContents[key] = fs.readFileSync(filePath, 'utf-8');
    }

    var replacements = {
        '{{system_start}}': `${tokenParams.tokens.systemOpen}`,
        '{{control_end}}': tokenParams.controlToken ? `${tokenParams.controlClose}` : ``,
        '{{control_start}}': tokenParams.controlToken ? `${tokenParams.controlStart}` : ``,
        '{{assistant_start}}': `${tokenParams.tokens.assistantOpen}`,
        '{{assistant_end}}': `${tokenParams.tokens.assistantClose}`,
        '{{system_end}}': `${tokenParams.tokens.systemClose}`,
        '{{user_start}}': `${tokenParams.tokens.userOpen}`,
        '{{user_end}}': `${tokenParams.tokens.userClose}`,
        '{{datetime}}': `\n- The date and time where you and ${process.env.USER_NAME} live is currently: ${timeStamp}`,
        '{{ctx}}': '\n\n## Additional Information:\nExternal context relevant to the conversation:\n' + promptData.relContext,
        '{{ruleset}}': `\n# Guidelines\n${fileContents.ruleSet}`,
        '{{chat}}': '\n## Other Relevant Chat Context:\nBelow are potentially relevant chat messages sent previously, that may be relevant to the conversation:\n' + promptData.relChats,
        '{{card}}': `\n\n## {{char}}'s Description:\n` + fileContents.characterCard,
        '{{persona}}': `\n\n## {{char}}'s Personality:\n` + fileContents.personality,
        '{{lore}}': '\n\n## World Information:\nUse this information to reflect the world and context around {{char}}:\n' + fileContents.worldInfo,
        '{{scene}}': '\n\n## Scenario:\n' + fileContents.scenario,
        '{{player_info}}': `\n\n## Information about {{player}}:\nThis is pertinent information regarding {{player}} that you should always remember.\n` + fileContents.playerInfo,
        '{{weather}}': '\n\n' + (process.env.WEATHER_ENABLED ? fileContents.weatherInfo : ''),
        '{{voice}}': `\n## Previous Voice Interactions:\nNon-exhaustive list of prior vocal interactions you've had with {{player}}:\n` + promptData.relVoice,
        '{{recent_chat}}': `## Current Messages from Chat:\nUp to the last ${process.env.MAX_CHATS_TO_SAVE} messages are provided to you from ${process.env.USER_NAME}'s Twitch chat. Use these messages to keep up with the current conversation:\n${fileContents.recentChat}`,
        '{{assistant}}': `I understand the instructions completely. I will now assume the role of ${process.env.CHARACTER_NAME} fully and respond to ${promptData.user}'s message.`
    };

    const postProcessReplacements = {
        '{{player}}': process.env.USER_NAME,
        '{{char}}': process.env.CHARACTER_NAME,
        '{{message}}': message,
        '{{char_limit}}': process.env.RESPONSE_LIMIT,
        '{{emotion}}': `\n\nCurrent Emotional Assessment of Message:\n${interpretEmotions(message)}`
    }

    let instructionTemplate = instructTemplate

    for (const [placeholder, value] of Object.entries(replacements)) {
        instructionTemplate = instructionTemplate.split(placeholder).join(value);
    }
    for (const [placeholder, value] of Object.entries(postProcessReplacements)) {
        instructionTemplate = instructionTemplate.split(placeholder).join(value);
    }
    const tokenCount = await promptTokenCount(instructionTemplate, process.env.LLM_MODEL_TYPE)
    fs.writeFileSync(`./sample_prompt_${process.env.LLM_MODEL_TYPE}.txt`, instructionTemplate)
    logger.log('LLM', `Prompt is using ${sysPromptCount + userPromptCount} of your available ${process.env.MAX_TOKEN_COUNT} tokens.`);
    return instructionTemplate;
}

const contextPromptChat = async (promptData, message, userID) => {

    const currentAuthObject = await returnAuthObject(userID)

    const instructTemplate = fs.readFileSync(`./instructs/sys_prompt.txt`, "utf-8");
    const timeStamp = moment().format('dddd, MMMM Do YYYY, [at] hh:mm A');

    const files = {
        personality: `./world_info/${userID}/character_personality.txt`,
        worldInfo: `./world_info/${userID}/world_lore.txt`,
        scenario: `./world_info/${userID}/scenario.txt`,
        characterCard: `./world_info/${userID}/character_card.txt`,
        weatherInfo: `./world_info/${userID}/weather.txt`,
        recentChat: `./world_info/${userID}/twitch_chat.txt`,
        ruleSet: `./world_info/${userID}/rules.txt`,
        playerInfo: `./world_info/${userID}/player_info.txt`,
        voiceMessages: `./world_info/${userID}/voice_messages.txt`
    };

    const fileContents = {};
    for (const [key, filePath] of Object.entries(files)) {
        fileContents[key] = fs.readFileSync(filePath, 'utf-8');
    }
    const sentiment = await interpretEmotions(message)
    logger.log('LLM', `Analysis of emotions: ${sentiment}`)
    var replacements = {
        '{{datetime}}': `\n- The date and time where you and ${currentAuthObject.player_name} live is currently: ${timeStamp}`,
        '{{ctx}}': '\n\n## Additional Information:\nExternal context relevant to the conversation:\n' + promptData.relContext,
        '{{ruleset}}': `\n\n# Guidelines\n${fileContents.ruleSet}`,
        '{{chat}}': '\n## Other Relevant Chat Context:\nBelow are potentially relevant chat messages sent previously, that may be relevant to the conversation:\n' + promptData.relChats,
        '{{card}}': `\n\n## {{char}}'s Description:\n` + fileContents.characterCard,
        '{{persona}}': `\n\n## {{char}}'s Personality:\n` + fileContents.personality,
        '{{player_info}}': `\n\n## Information about {{player}}:\nThis is pertinent information regarding {{player}} that you should always remember.\n${fileContents.playerInfo}`,
        '{{lore}}': '\n\n## World Information:\nUse this information to reflect the world and context around {{char}}:\n' + fileContents.worldInfo,
        '{{scene}}': '\n\n## Scenario:\n' + fileContents.scenario,
        '{{weather}}': '\n\n' + (process.env.WEATHER_ENABLED ? fileContents.weatherInfo : ''),
        '{{voice}}': `\n## Previous Voice Interactions:\nNon-exhaustive list of prior vocal interactions you've had with {{player}}:\n` + promptData.relVoice,
        '{{recent_voice}}': `\n\n## Current Voice Conversations with {{player}}:\nUp to the last ${process.env.MAX_CHATS_TO_SAVE} voice messages are provided to you. Use these voice messages to help you keep up with the current conversation:\n${fileContents.voiceMessages}`,
        '{{recent_chat}}': `\n\n## Current Messages from Chat:\nUp to the last ${process.env.MAX_CHATS_TO_SAVE} messages are provided to you from ${currentAuthObject.player_name}'s Twitch chat. Use these messages to keep up with the current conversation:\n${fileContents.recentChat}`,
        '{{emotion}}': `\n\n## Current Emotional Assessment of Message:\n- ${sentiment}`

    };

    const postProcessReplacements = {
        '{{player}}': currentAuthObject.player_name,
        '{{char}}': currentAuthObject.bot_name,
        '{{char_limit}}': process.env.RESPONSE_LIMIT,
        '{{user}}': promptData.user,
        '{{socials}}': await socialMedias(userID),
        '{{soc_tiktok}}': await socialMedias(userID, 'tiktok'),
    }

    let instructionTemplate = instructTemplate

    for (const [placeholder, value] of Object.entries(replacements)) {
        instructionTemplate = instructionTemplate.split(placeholder).join(value);
    }
    for (const [placeholder, value] of Object.entries(postProcessReplacements)) {
        instructionTemplate = instructionTemplate.split(placeholder).join(value);
    }
    fs.writeFileSync(`./sample_prompt_${process.env.LLM_MODEL_TYPE}_chat.txt`, instructionTemplate)
    const promptWithSamplers = await formChatRequestBody(instructionTemplate, message, promptData.user)
    const sysPromptCount = await promptTokenCount(instructionTemplate, process.env.LLM_MODEL_TYPE)
    const userPromptCount = await promptTokenCount(message, process.env.LLM_MODEL_TYPE)
    logger.log('LLM', `Prompt is using ${sysPromptCount + userPromptCount} of your available ${process.env.MAX_TOKEN_COUNT} tokens.`);
    return promptWithSamplers;
}

const eventPromptChat = async (message, userId) => {
    const userObject = await returnAuthObject(userId);
    logger.log('System', `Doing eventing stuff for: ${userObject.player_name} and ${userId}`)
    const instructTemplate = fs.readFileSync(`./instructs/sys_prompt.txt`, "utf-8");
    const timeStamp = moment().format('dddd, MMMM Do YYYY, [at] hh:mm A');
    
    const files = {
        personality: `./world_info/${userId}/character_personality.txt`,
        worldInfo: `./world_info/${userId}/world_lore.txt`,
        scenario: `./world_info/${userId}/scenario.txt`,
        characterCard: `./world_info/${userId}/character_card.txt`,
        weatherInfo: `./world_info/${userId}/weather.txt`,
        recentChat: `./world_info/${userId}/twitch_chat.txt`,
        ruleSet: `./world_info/${userId}/rules.txt`,
        playerInfo: `./world_info/${userId}/player_info.txt`
    };

    const fileContents = {};
    for (const [key, filePath] of Object.entries(files)) {
        fileContents[key] = fs.readFileSync(filePath, 'utf-8');
    }
    var replacements = {
        '{{datetime}}': `\n- The date and time where you and ${userObject.player_name} live is currently: ${timeStamp}`,
        '{{ruleset}}': `\n\n# Guidelines\n${fileContents.ruleSet}`,
        '{{card}}': `\n\n## {{char}}'s Description:\n` + fileContents.characterCard,
        '{{persona}}': `\n\n## {{char}}'s Personality:\n` + fileContents.personality,
        '{{lore}}': '\n\n## World Information:\nUse this information to reflect the world and context around {{char}}:\n' + fileContents.worldInfo,
        '{{scene}}': '\n\n## Scenario:\n' + fileContents.scenario,
        '{{weather}}': '\n\n' + (process.env.WEATHER_ENABLED ? fileContents.weatherInfo : ''),
        '{{recent_chat}}': `\n\n## Current Messages from Chat:\nUp to the last ${process.env.MAX_CHATS_TO_SAVE} messages are provided to you from ${userObject.player_name}'s Twitch chat. Use these messages to keep up with the current conversation:\n${fileContents.recentChat}`,
        '{{player_info}}': `\n\n## Information about {{player}}:\nThis is pertinent information regarding {{player}} that you should always remember.\n` + fileContents.playerInfo,
        '{{emotion}}': '',
        '{{voice}}': '',
        '{{ctx}}': '',
        '{{chat}}': '',
        '{{recent_voice}}': ''
    };

    const postProcessReplacements = {
        '{{player}}': userObject.player_name,
        '{{char}}': userObject.bot_name,
        '{{char_limit}}': process.env.RESPONSE_LIMIT,
        '{{socials}}': await socialMedias(userId),
    }

    let instructionTemplate = instructTemplate

    for (const [placeholder, value] of Object.entries(replacements)) {
        instructionTemplate = instructionTemplate.split(placeholder).join(value);
    }
    for (const [placeholder, value] of Object.entries(postProcessReplacements)) {
        instructionTemplate = instructionTemplate.split(placeholder).join(value);
    }
    fs.writeFileSync(`./sample_prompt_${process.env.LLM_MODEL_TYPE}_event.txt`, instructionTemplate)
    const promptWithSamplers = await formChatRequestBody(instructionTemplate, message)
    const sysPromptCount = await promptTokenCount(instructionTemplate, process.env.LLM_MODEL_TYPE)
    const userPromptCount = await promptTokenCount(message, process.env.LLM_MODEL_TYPE)
    logger.log('LLM', `Prompt is using ${sysPromptCount + userPromptCount} of your available ${process.env.MAX_TOKEN_COUNT} tokens.`);
    return promptWithSamplers;
}

const queryPrompt = async (message, userId) => {
    const userObject = await returnAuthObject(userId);
    const instructTemplate = fs.readFileSync("./instructs/helpers/instruct_query.txt", "utf-8");
    const timeStamp = moment().format('MM/DD/YY [at] HH:mm');
    const splitDate = timeStamp.split(' at ')
    const dateString = splitDate[0].trim()
    const timeString = splitDate[1].trim()
    var replacements = {
        '{{datetime}}': `${dateString}. The current time is ${timeString}`,
        '{{query}}': message,
        '{{player}}': userObject.player_name,
        '{{socials}}': await socialMedias(userId),
    };

    let instructionTemplate = instructTemplate

    for (const [placeholder, value] of Object.entries(replacements)) {
        instructionTemplate = instructionTemplate.split(placeholder).join(value);
    }
    fs.writeFileSync('./sample_query_prompt.txt', instructionTemplate)
    const sysPromptCount = await promptTokenCount(instructionTemplate, process.env.QUERY_MODEL_TYPE)
    const userPromptCount = await promptTokenCount(message, process.env.QUERY_MODEL_TYPE)
    logger.log('LLM', `Prompt is using ${sysPromptCount + userPromptCount} of your available ${process.env.QUERY_MAX_TOKENS} tokens.`);
    return instructionTemplate + '\n';
}

const rerankPrompt = async (message, userId) => {
    const userObject = await returnAuthObject(userId);
    const instructTemplate = fs.readFileSync("./instructs/helpers/instruct_rerank.txt", "utf-8");
    var replacements = {
        '{{query}}': message,
        '{{socials}}': await socialMedias(userId),
        '{{player}}': userObject.player_name
    };

    let instructionTemplate = instructTemplate

    for (const [placeholder, value] of Object.entries(replacements)) {
        instructionTemplate = instructionTemplate.split(placeholder).join(value);
    }
    const promptWithSamplers = await formToolRequestBody(instructionTemplate, process.env.RERANK_STR_MODEL, message)
    const sysPromptCount = await promptTokenCount(instructionTemplate, process.env.RERANK_STR_MODEL_TYPE)
    const userPromptCount = await promptTokenCount(message, process.env.RERANK_STR_MODEL_TYPE)
    logger.log('LLM', `Prompt is using ${sysPromptCount + userPromptCount} of your available ${process.env.RERANK_MAX_TOKENS} tokens.`);
    return promptWithSamplers
}

const summaryPrompt = async (subject, textContent) => {
    const instructTemplate = fs.readFileSync("./instructs/helpers/instruct_summary.txt", "utf-8");

    var replacements = {
        '{{subject}}': subject,
        '{{text_content}}': textContent
    };

    let instructionTemplate = instructTemplate

    for (const [placeholder, value] of Object.entries(replacements)) {
        instructionTemplate = instructionTemplate.split(placeholder).join(value);
    }
    const sysPromptCount = await promptTokenCount(instructionTemplate, process.env.RERANK_STR_MODEL_TYPE)
    logger.log('LLM', `Prompt is using ${sysPromptCount} of your available ${process.env.SUMMARY_MAX_TOKENS} tokens.`);
    return instructionTemplate;
}

const nonContextPrompt = async (message) => {
    const instructTemplate = fs.readFileSync(`./instructs/${process.env.LLM_MODEL_TYPE}/instruct.txt`, "utf-8");
    const timeStamp = moment().format('MM/DD/YY [at] HH:mm');
    const files = {
        personality: './world_info/character_personality.txt',
        worldInfo: './world_info/world_lore.txt',
        scenario: './world_info/scenario.txt',
        characterCard: './world_info/character_card.txt',
        weatherInfo: './world_info/weather.txt',
        recentChat: './world_info/twitch_chat.txt',
        ruleSet: './world_info/rules.txt',
        playerInfo: './world_info/player_info.txt',
        voiceMessages: './world_info/voice_messages.txt'
    };

    const fileContents = {};
    for (const [key, filePath] of Object.entries(files)) {
        fileContents[key] = fs.readFileSync(filePath, 'utf-8');
    }

    const replacements = {
        '{{system_start}}': `${tokenParams.tokens.systemOpen}`,
        '{{system_end}}': `${tokenParams.tokens.systemClose}`,
        '{{control_end}}': tokenParams.controlToken ? `${tokenParams.controlClose}` : ``,
        '{{control_start}}': tokenParams.controlToken ? `${tokenParams.controlStart}` : ``,
        '{{assistant_start}}': `${tokenParams.tokens.assistantOpen}`,
        '{{assistant_end}}': `${tokenParams.tokens.assistantClose}`,
        '{{user_start}}': `${tokenParams.tokens.userOpen}`,
        '{{user_end}}': `${tokenParams.tokens.userClose}`,
        '{{ctx}}': '',
        '{{player_info}}': `\n\n## Information about {{player}}:\nThis is pertinent information regarding {{player}} that you should always remember.\n` + fileContents.playerInfo,
        '{{ruleset}}': `\n\n# Guidelines\n${fileContents.ruleSet}`,
        '{{datetime}}': `\n- The date and time where you and ${process.env.USER_NAME} live is currently: ${timeStamp}`,
        '{{card}}': `\n\n## {{char}}'s Description:\n` + fileContents.characterCard,
        '{{persona}}': `\n\n## {{char}}'s Personality:\n` + fileContents.characterCard,
        '{{lore}}': '\n\n## World Information:\nUse this information to reflect the world and context around {{char}}:' + fileContents.worldInfo,
        '{{scene}}': '\n\n## Scenario:\n' + fileContents.scenario,
        '{{weather}}': '\n\n' + (process.env.WEATHER_ENABLED ? fileContents.weatherInfo : ''),
        '{{voice}}': ``,
        '{{recent_chat}}': `\n\n## Current Messages from Chat:\nUp to the last ${process.env.MAX_CHATS_TO_SAVE} messages are provided to you from ${process.env.USER_NAME}'s Twitch chat. Use these messages to help you keep up with the current conversation:\n${fileContents.recentChat}`,
        '{{recent_voice}}': `\n\n## Current Voice Conversations with {{player}}:\nUp to the last ${process.env.MAX_CHATS_TO_SAVE} voice messages are provided to you. Use these voice messages to help you keep up with the current conversation:\n${fileContents.voiceMessages}`,
    };

    const postProcessReplacements = {
        '{{player}}': process.env.USER_NAME,
        '{{char}}': process.env.CHARACTER_NAME,
        '{{message}}': message,
        '{{user}}': user,
        '{{char_limit}}': process.env.RESPONSE_LIMIT,
    }

    let instructionTemplate = instructTemplate

    for (const [placeholder, value] of Object.entries(replacements)) {
        instructionTemplate = instructionTemplate.split(placeholder).join(value);
    }
    for (const [placeholder, value] of Object.entries(postProcessReplacements)) {
        instructionTemplate = instructionTemplate.split(placeholder).join(value);
    }
    const sysPromptCount = await promptTokenCount(instructionTemplate, process.env.LLM_MODEL_TYPE)
    const userPromptCount = await promptTokenCount(message, process.env.LLM_MODEL_TYPE)

    logger.log('LLM', `Prompt is using ${sysPromptCount + userPromptCount} of your available ${process.env.MAX_TOKEN_COUNT} tokens.`);
    return instructionTemplate;
}

async function formRequestBody(prompt) {
    var chatCompleteBody = {
        model: process.env.TABBY_MODEL_NAME,
        prompt: prompt,
        max_tokens: process.env.LLM_MAX_TOKENS,
        generate_window: process.env.LLM_MAX_TOKENS,
        stream: false,
        token_healing: process.env.LLM_TOKEN_HEAL,
        min_p: process.env.LLM_MIN_P,
        top_p: process.env.LLM_TOP_P,
        top_a: process.env.LLM_TOP_A,
        typical_p: process.env.LLM_TYPICAL_P,
        dry_base: process.env.LLM_DRY_BASE,
        dry_allowed_length: process.env.LLM_DRY_LENGTH,
        dry_sequence_breakers: ["\n", ":", "\"", "'", "*", "USER:", "ASSISTANT:", "2137:", "Dottore:", "Narrator:", "Zhur:", "Zhur", "<|im_start|>", "<|im_end|>", "<", "|", ">", "im", "end", "_", "start", "system", "USER", "ASSISTANT", "2137", "Dottore", "Narrator", "im_end", "im_start", "user", "assistant", "im_sep", "sep", "<|im_sep|>", "<|im_start|>user", "<|im_start|>assistant", "<|end|>", "_", "[INST]", "[/INST]", "[", "]", "INST"],
        dry_multiplier: process.env.LLM_DRY_MULTI,
        min_tokens: process.env.LLM_MIN_TOKENS,
        mirostat_mode: process.env.LLM_MIROSTAT_MODE,
        repetition_penalty: process.env.LLM_REP_PEN,
        temperature: process.env.LLM_TEMP,
        banned_strings: process.env.LLM_BANNED_STRINGS,
        top_k: process.env.LLM_TOP_K,
        smoothing_factor: process.env.LLM_SMOOTHING_FACTOR,
        xtc_threshold: process.env.LLM_XTC_THRESHOLD,
        xtc_probability: process.env.LLM_XTC_PROB
    }
    return chatCompleteBody;
}

async function formToolRequestBody(prompt, model, message) {
    var chatCompleteBody = {
        model: model,
        messages: [
            {
                role: "system",
                content: prompt
            },
            {
                role: "user",
                content: message
            }
        ],
        temperature: 0.5
    }
    return chatCompleteBody;
}

async function formChatRequestBody(prompt, message, user = "") {
    const userFrom = (user === "" ? message : `${user} sends the following message: ${message}`)
    var chatCompleteBody = {
        model: process.env.CHAT_COMPLETION_MODEL,
        messages: [
            {
                role: "system",
                content: prompt
            },
            {
                role: "user",
                content: userFrom
            }
        ],
        max_tokens: process.env.LLM_MAX_TOKENS,
        generate_window: 512,
        stream: false,
        token_healing: process.env.LLM_TOKEN_HEAL,
        min_p: process.env.LLM_MIN_P,
        top_p: process.env.LLM_TOP_P,
        top_a: process.env.LLM_TOP_A,
        typical_p: process.env.LLM_TYPICAL_P,
        dry_base: process.env.LLM_DRY_BASE,
        dry_allowed_length: process.env.LLM_DRY_LENGTH,
        dry_sequence_breakers: ["\n", ":", "\"", "'", "*", "USER:", "ASSISTANT:", "2137:", "Dottore:", "Narrator:", "Zhur:", "Zhur", "<|im_start|>", "<|im_end|>", "<", "|", ">", "im", "end", "_", "start", "system", "USER", "ASSISTANT", "2137", "Dottore", "Narrator", "im_end", "im_start", "user", "assistant", "im_sep", "sep", "<|im_sep|>", "<|im_start|>user", "<|im_start|>assistant", "<|end|>", "_", "[INST]", "[/INST]", "[", "]", "INST"],
        dry_multiplier: process.env.LLM_DRY_MULTI,
        min_tokens: process.env.LLM_MIN_TOKENS,
        mirostat_mode: process.env.LLM_MIROSTAT_MODE,
        repetition_penalty: process.env.LLM_REP_PEN,
        temperature: process.env.LLM_TEMP,
        banned_strings: process.env.LLM_BANNED_STRINGS,
        top_k: process.env.LLM_TOP_K,
        xtc_threshold: process.env.LLM_XTC_THRESHOLD,
        xtc_probability: process.env.LLM_XTC_PROB
    }
    return chatCompleteBody;
}

const promptWithBody = async (contextOn, message, promptData, event = false) => {
    if (contextOn) {
        const prompt = await contextPrompt(message, promptData)
        return await formRequestBody(prompt)
    } else {
        if (event) {

        } else {
            const prompt = await nonContextPrompt(message)
            return await formRequestBody(prompt)
        }
    }
}

const replyStripped = async (message, userId) => {
    const userObj = await returnAuthObject(userId)
    let formatted = message
        .replace(/(\r\n|\n|\r)/gm, "")
        .replace(new RegExp(`${userObj.bot_name}:\\s?`, 'g'), '')
        .replace(/\(500 characters\)/g, '')
        .replace(/\\/g, '')
        .replace(/\*[^*]*\*/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^["']|["']$/g, '')
        .trim();
    return formatted;
}

const filterCharacterFromMessage = async (str, userId) => {
    const userObject = await returnAuthObject(userId)
    const twitchRegex = new RegExp(`@?${userObject.bot_twitch}`, 'i');
    const nameRegex = new RegExp(`,?\\s*\\b(?:${userObject.bot_name}|hey ${userObject.bot_name})\\b,?\\s*`, 'i');

    let result = str.replace(twitchRegex, '').trim();

    result = result.replace(nameRegex, '').trim();

    return result;
};

async function containsCharacterName(message, userId) {
    const userObj = await returnAuthObject(userId)
    const characterName = userObj.bot_name;
    const characterTwitchUser = userObj.bot_twitch;

    if (!characterName || !characterTwitchUser) {
        throw new Error("Either CHARACTER_NAME or CHARACTER_TWITCH_USER environment variable is not set.");
    }

    const nameRegex = new RegExp(characterName, 'i');

    const twitchHandle = characterTwitchUser.startsWith('@') ? characterTwitchUser.slice(1) : characterTwitchUser;
    const twitchHandleRegex = new RegExp(twitchHandle, 'i');

    return nameRegex.test(message) || twitchHandleRegex.test(message);
}

const stripNonStandardSpeech = (str) => {
    const nonStandardSpeechRegex = /[^\x20-\x7E\xA0-\xFF\u2000-\u206F\u2E00-\u2E7F\u25A0-\u25FF\uD83C-\uDBFF\uDC00-\uDFFF]+/g;
    return str.replace(nonStandardSpeechRegex, '');
};


export { stripNonStandardSpeech, promptWithBody, promptTokenCount, replyStripped, filterCharacterFromMessage, summaryPrompt, queryPrompt, contextPromptChat, rerankPrompt, eventPromptChat, containsCharacterName }