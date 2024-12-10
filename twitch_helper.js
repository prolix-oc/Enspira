import fs from "fs-extra"
import { join } from 'path';
import { funFact, returnAuthObject } from "./api-helper.js";
import moment from 'moment';


async function returnTwitchEvent(eventThing, userId) {
    const userObj = await returnAuthObject(userId)
    var event = {}
    event = { ...eventThing };
    event.playerName = userObj.player_name
    event.playerId = userObj.user_id
    logger.log('API', `Twitch event data: ${JSON.stringify(event, null, '  ')}`)
    switch (event.eventType) {
        case "sub":
            return (await subMessage(event))
        case "dono":
            return (await donoMessage(event))
        case "chat":
            return (await chatMessage(event))
        case "raid":
            return (await raidMessage(event))
        case "follow":
            return (await followMessage(event))
        case "hype":
            return (await hypeMessage(event))
        case "gen":
            return (await generalMessage(event))
        case "trivia":
            return (await triviaMessage(event))
    }
}

async function maintainChatContext(newLine, userID) {
    const chatContextPath = join(process.cwd(), `/world_info/${userID}/twitch_chat.txt`);

    if (!fs.existsSync(chatContextPath)) {
        fs.writeFileSync(chatContextPath, '');
    }

    const currentLines = fs.readFileSync(chatContextPath, 'utf-8')
        .split('\n')
        .filter(Boolean);

    currentLines.push("- " + newLine);

    if (currentLines.length > process.env.MAX_CHATS_TO_SAVE) {
        currentLines.shift();
    }

    await fs.promises.writeFile(chatContextPath, currentLines.join('\n') + '\n');
}
  

const getTimeDifferenceFromNow = (inputDate) => {
    const format = 'MM/DD/YYYY hh:mm:ss A';
    const momentDate = moment.utc(inputDate, format);
    const now = moment.utc();

    const diffInMinutes = momentDate.diff(now, 'minutes');
    const absDiff = Math.abs(diffInMinutes);

    if (diffInMinutes > 0) {
        if (absDiff < 60) {
            const minutesWord = absDiff === 1 ? 'minute' : 'minutes';
            return `in ${absDiff} ${minutesWord}`;
        } else {
            const hours = Math.round(absDiff / 60);
            const hoursWord = hours === 1 ? 'hour' : 'hours';
            return `in ${hours} ${hoursWord}`;
        }
    } else {
        if (absDiff < 60) {
            const minutesWord = absDiff === 1 ? 'minute' : 'minutes';
            return `${absDiff} ${minutesWord} ago`;
        } else {
            const hours = Math.round(absDiff / 60);
            const hoursWord = hours === 1 ? 'hour' : 'hours';
            return `${hours} ${hoursWord} ago`;
        }
    }
};

const subMessage = async (event) => {
    let addonStrings = await fs.promises.readFile(`./world_info/${event.playerId}/event_messages.txt`, 'utf-8')
    const parsedAddons = JSON.parse(addonStrings)
    const subValues = {
        'prime': '$4.99',
        'tier 1': '$4.99',
        'tier 2': '$9,99',
        'tier 3': '$24.99'
    }
    const subValNum = {
        'prime': 4.99,
        'tier 1': 4.99,
        'tier 2': 9.99,
        'tier 3': 24.99
    }
    let subString = ""
    console.log('API', `Received event type: ${JSON.stringify(event.eventData, null, '  ')}`)
    switch (event.eventData.subType) {
        case "sub":
            subString += `${event.eventData.user} just gave ${event.playerName} a ${event.eventData.subTier} sub! ${event.eventData.user} spent ${subValues[event.eventData.subTier]} to give them a subscription. `
            subString += event.eventData.multiMonth ? `They also decided to subscribe for ${event.eventData.monthLength} months, and have been subscribed for ${event.eventData.tenure} months so far!`: ``
            subString += event.eventData.primeUpgrade ? ` They upgraded from their Twitch Prime subscription right into being a ${event.eventData.subTier} subscriber, paying ${subValues(event.eventData.subTier)} to do so!` : ``
            subString += event.eventData.paidForward ? ` They decided to pay their gifted subscription forward!` : ``
            subString += event.eventData.message !== "" ? ` ${event.eventData.user} said this in the Twitch chat afterward:\n${event.eventData.message}` : ``
            break;
        case "resub":
            subString += `${event.eventData.user} just decided to resubscribe to ${event.playerName}'s Twitch channel! `
            subString += `${event.eventData.user} resubscribed with a ${event.eventData.subTier} sub! `
            subString += `${event.eventData.user} spent ${subValues[event.eventData.subTier]} resubscribe to their channel. `
            subString += `They're on a ${event.eventData.streak} month streak so far, and have been a subscriber for ${event.eventData.tenure} months so far. `
            subString += `${event.eventData.user} said the following in the Twitch chat afterward:\n${event.eventData.sharedChat}`
            break;
        case "gift_sub":
            if (event.eventData.anonymous) {
                subString += `Some generous person just gave ${event.eventData.recipientUserName} a ${event.eventData.subTier} sub to ${event.playerName}'s Twitch channel!`
                subString += `They spent ${subValues[event.eventData.subTier]} to gift this sub to ${event.playerName}'s channel. `
                subString += event.eventData.random ? `This sub was randomly given to ${event.eventData.recipientUserName}. `: `This sub was specifically given to ${event.eventData.recipientUserName}. `
                subString += `They're on a ${event.eventData.streak} month streak with their own sub, and have been a subscriber for ${event.eventData.tenure} months so far. `
                subString += `Though they wished to be anonymous, they said the following in the Twitch chat afterward:\n${event.eventData.message}`
            } else {
                subString += `${event.eventData.user} just gave ${event.eventData.recipientUserName} a ${event.eventData.subTier} sub to ${event.playerName}'s Twitch channel! `
                subString += `They spent ${subValues[event.eventData.subTier]} to gift this sub to ${event.playerName}'s channel. `
                subString += event.eventData.random ? `This sub was randomly given to ${event.eventData.recipientUserName}. `: `This sub was specifically given to ${event.eventData.recipientUserName}. `
                subString += `They're on a ${event.eventData.streak} month streak with their own sub, and have been a subscriber for ${event.eventData.tenure} months so far. `
                subString += `${event.eventData.user} said the following in the Twitch chat afterward:\n${event.eventData.message}`
            }
            break;
        case "gift_bomb":
            if (event.eventData.anonymous == true) {
                subString += `Some generous person just gave out ${event.eventData.giftAmt} ${event.eventData.subTier} subs to ${event.playerName}'s channel! `
                subString += event.eventData.sharedAmt ? `Some generous person just gave out ${event.eventData.giftAmt} ${event.eventData.subTier} subs to ${event.playerName}'s channel! ` : `Some generous person just gave out a few ${event.eventData.subTier} subs to ${event.playerName}'s channel!` 
                subString += event.eventData.bonusGifts > 0 ? `Twitch themselves also decided to add subs towards ${event.playerName}'s channel too!` : ``
                subString += event.eventData.sharedAmt ? `They spent $${(subValNum[event.eventData.subTier] * event.eventData.giftAmt).toFixed(2)} worth of their hard earned money on these subs to ${event.playerName}'s channel.` : `Each sub to ${event.playerName}'s channel was worth ${subValNum[event.eventData.subTier]}. `
                subString += `They said this in the chat afterward:\n${event.eventData.systemMessage}`
            } else {
                subString += `${event.eventData.user} just gave out ${event.eventData.giftAmt} ${event.eventData.subTier} subs to ${event.playerName}'s channel! `
                subString += event.eventData.sharedAmt ? `Some generous person just gave out ${event.eventData.giftAmt} ${event.eventData.subTier} subs to ${event.playerName}'s channel! ` : `Some generous person just gave out a few ${event.eventData.subTier} subs to ${event.playerName}'s channel!` 
                subString += event.eventData.bonusGifts > 0 ? `Twitch themselves also decided to add subs towards ${event.playerName}'s channel too!` : ``
                subString += `They spent $${(subValNum[event.eventData.subTier] * event.eventData.giftAmt).toFixed(2)} worth of their hard earned money on these subs to ${event.playerName}'s channel.`
                subString += `${event.eventData.user} said this in the chat afterward:\n${event.eventData.systemMessage}`
            }
            break;
        default:
            break;
    }
    subString += `\n${parsedAddons.sub.replace('{{player}}', event.playerName)}`
    logger.log('API', `Event string: ${subString}`)
    return subString;
};

const donoMessage = async (event) => {
    let addonStrings = await fs.promises.readFile(`./world_info/${event.playerId}/event_messages.txt`, 'utf-8')
    const parsedAddons = JSON.parse(addonStrings)
    let subString = ``
    switch (event.eventData.donoType) {
        case "tip":
            subString += `A donation for ${event.eventData.donoAmt} just came through from ${event.eventData.donoFrom}! `
            break;
        case "charity":
            subString += `A donation towards our favorite charity ${event.eventData.forCharity} just came through, in the amount of $${event.eventData.donoAmt}! `
            break;
        case "bits":
            subString += `${event.eventData.donoFrom} just donated ${event.eventData.donoAmt} bits to Prolix's channel! While each one of these is only worth a cent, they do stack up! `
        default:
            break;
    }
    subString += event.eventData.donoType === "charity" ? `\n${parsedAddons.charity.replace('{{player}}', event.playerName)}` : `They said this in a message:\n${event.eventData.donoMessage}\n${parsedAddons.dono.replace('{{player}}', event.playerName)}`
    return subString;
};

const raidMessage = async (event) => {
    let addonStrings = await fs.promises.readFile(`./world_info/${event.playerId}/event_messages.txt`, 'utf-8')
    const parsedAddons = JSON.parse(addonStrings)
    let subString = ``
    subString += `${event.eventData.username} just raided ${event.playerName}'s Twitch channel! `
    subString += `This raid brought along ${event.eventData.viewers} viewers with them, who will now be eagerly watching ${event.playerName} stream and game!\n`
    subString += parsedAddons.raid.replace('{{player}}', event.playerName)
    return subString;
};

const followMessage = async (event) => {
    let addonStrings = await fs.promises.readFile(`./world_info/${event.playerId}/event_messages.txt`, 'utf-8')
    const parsedAddons = JSON.parse(addonStrings)
    let subString = `${event.eventData.username} just followed ${event.playerName}'s Twitch channel!\n`
    subString += `\n${parsedAddons.follow.replace('{{player}}', event.playerName)}`
    return subString;
};

const chatMessage = async (event) => {
    let addonStrings = await fs.promises.readFile(`./world_info/${event.playerId}/event_messages.txt`, 'utf-8')
    const parsedAddons = JSON.parse(addonStrings)
    let subString = `${event.user} sent the following message in ${event.playerName}'s Twitch chat:\n${event.message}`
    subString += event.firstMessage ? `\nThis is ${event.user}'s *first ever* chat message in ${event.playerName}'s Twitch channel as well!` : ``
    subString += `\n${parsedAddons.firstchat.replace('{{player}}', event.playerName)}`
    return subString;
};

const hypeMessage = async (event) => {
    let addonStrings = await fs.promises.readFile(`./world_info/${event.playerId}/event_messages.txt`, 'utf-8')
    const parsedAddons = JSON.parse(addonStrings)
    let subString = `A hype train on ${process.env.USER_NAME}'s channel just started! `
    subString += `It is currently at a level ${event.eventData.level}, and started ${getTimeDifferenceFromNow(event.eventData.startedAt)}. `
    subString += `It will expire ${getTimeDifferenceFromNow(event.eventData.expiresAt)}. `
    subString += `We are ${event.eventData.percent} of the way to a level ${parseInt(event.eventData.level) + 1} Hype Train! ` 
    subString += `So far, ${event.eventData.topSubUser} has the most gifted subscriptions at ${event.eventData.topSubTotal} subs! ` 
    subString += `${event.eventData.topBitsUser} has donated the most bits so far, with ${event.eventData.topBitsAmt} bits donated!`
    subString += '\n' + parsedAddons.hype
    return subString;
};

const triviaMessage = async (event) => {
    logger.log('API', `Finished fun facting for ${event.playerName}`)
    let subString = `You should relay this fun fact to the viewers of ${event.playerName}'s channel. Don't disclose that it was given to you, just share this fun fact, and your thoughts about it, to all of the viewers. The fun fact is:\n`
    subString += `${await funFact()}`
    return subString;
};

const socialMedias = async (userId, specify) => {
    const currentUser = await returnAuthObject(userId)
    const currentSocials = currentUser.socials
    var returnedResponse = ""
    Object.keys(currentSocials).forEach(function (key, index, array) {
        if (index !== array.length - 1) {
            returnedResponse += `${currentUser[key]}, `
        } else {
            returnedResponse += `and ${currentUser[key]}`
        }
    });

    if (!specify) {
        return returnedResponse
    } else if (specify === 'all') {
        return currentSocials
    } else {
        return currentSocials[`${specify}`]
    }
}

async function checkForUser(input, userId) {
    const socialMediaObj = await socialMedias(userId, 'all');

    if (Object.keys(socialMediaObj).length === 0) {
        global.logger.log('System', "socialMediaObj is empty.");
        return false;
    }
    
    Object.values(socialMediaObj).forEach(value => {
    });

    const foundMatch = Object.values(socialMediaObj).some(value => {
        const normalizedValue = value.trim().toLowerCase();
        const normalizedInput = input.trim().toLowerCase();
        return normalizedValue === normalizedInput;
    });

    return foundMatch;
}


const isCommandMatch = async (message, userId) => {
    const userObj = await returnAuthObject(userId)
    const cmdList = userObj.commands_list
    //logger.log('Twitch', `Current command list: ${cmdList}`)
    const commandRegex = new RegExp(`^(${cmdList.join('|')})$`, 'i');
    return commandRegex.test(message);
};

export { returnTwitchEvent, isCommandMatch, maintainChatContext, socialMedias, checkForUser }