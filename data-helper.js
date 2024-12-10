import axios from "axios"
import { inferSearchParam, searchBraveAPI, retrieveWebContext, rerankString } from "./ai-logic.js"
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';
import fs from 'fs-extra'
import { Readability } from "@mozilla/readability";
import { join } from 'path'
import { randomBytes } from "crypto";

const userAgentStrings = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.2227.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.3497.92 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
];

async function maintainVoiceContext(newLine) {
    const chatContextPath = join(process.cwd(), "/world_info/voice_messages.txt");

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

const resultsReranked = async (contextBody, message, userId, requiresSearch = false) => {
    try {
        if (!contextBody) {
            logger.log('Embedding', 'Missing contextBody parameter');
            return "- No additional information to provide.\n";
        }
        if (!message) {
            logger.log('Embedding', 'Missing message parameter');
            return "- No additional information to provide.\n";
        }

        if (contextBody.length === 0) {
            return "- No additional context provided for this section.";
        }
        var resultsRaw = []
        var contextString = "";
        if (Array.isArray(contextBody)) {
            for (const item of contextBody) {
                const content = item.text_content || item.summary;
                if (content) {
                    resultsRaw.push(content);
                    //logger.log('Embedding', 'Pushing document over.');
                }
            }
            logger.log('Reranker', `Documents sent: ${resultsRaw.length}`);
            logger.log('Embedding', 'Asking rerank helper to optimize...');
            const rerankOptimized = await rerankString(message, userId);
            const rerankData = {
                model: process.env.RERANKING_MODEL,
                query: rerankOptimized,
                documents: resultsRaw
            };

            const fileName = `./sample-post-${requiresSearch ? 'context' : 'chat'}.txt`;
            fs.writeFileSync(fileName, JSON.stringify(rerankData, null, 2));

            var rerankedMissed = 0;
            var rerankProcessed = [];

            logger.log('Embedding', `Starting rerank...`);

            const response = await axios({
                method: "post",
                url: `${process.env.EMBEDDING_ENDPOINT}/rerank`,
                data: rerankData,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive'
                },
                timeout: 30000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });
            const fileEnding = randomBytes(12).toString("hex")
            fs.writeFileSync(`./sample-rerank-${fileEnding}.txt`, JSON.stringify(response.data.results));
            logger.log('Embedding', `Rerank finished. Sorting results.`);
            const rerankedArray = response.data.results;
            logger.log('Reranker', `Documents received: ${rerankedArray.length}`);

            for (const item of rerankedArray) {
                if (item.relevance_score > 0.5) {
                    logger.log('Embedding', `Matched a document with high score.`);
                    const indexNum = parseInt(item.index);
                    rerankProcessed.push(resultsRaw[indexNum]);
                } else {
                    rerankedMissed++;
                }
            }

            if (rerankProcessed.length < 6) {
                logger.log('Embedding', `Not enough high-scoring matches, taking top 5 results.`);
                rerankProcessed = rerankedArray
                    .slice(0, 6)
                    .map(item => resultsRaw[parseInt(item.index)]);
            }

            if (rerankedMissed > Math.ceil(rerankedArray.length / 5) && requiresSearch) {
                logger.log('Embedding', `Attempting web search for additional context.`);
                const augmentResult = await startWebResults(message, userId);
                if (augmentResult) {
                    rerankProcessed.push(augmentResult);
                }
            }

            contextString = rerankProcessed.join('\n');
            return contextString;
        } else {
            return "- No additional information to provide.\n";
        }
    } catch (error) {
        logger.log('Embedding', `Error in resultsReranked: ${error.message}`);
        console.error('Full error:', error);
        return "- Error processing information.\n";
    }
};

async function startWebResults(message, userId) {
    logger.log('LLM', `Starting web search for ${message}`)
    var searchedResults = ""
    const query = await inferSearchParam(message, userId)
    if (query === "pass") {
        logger.log('Search', 'No additional query needed.')
        return ''
    } else {
        const splitQuery = query.split(';')
        const pmWebSearch = await searchBraveAPI(splitQuery[0], splitQuery[3])
        searchedResults = await retrieveWebContext(pmWebSearch, splitQuery[2].trim(), splitQuery[1].trim(), userId)
    }
    return searchedResults
}

const interpretEmotions = async (message) => {
    const classifyBody = {
        model: process.env.CLASSIFICATION_MODEL,
        input: [message]
    }
    const response = await axios({
        method: "post",
        url: `${process.env.EMBEDDING_ENDPOINT}/classify`,
        data: classifyBody
    });
    const results = response.data.data[0]
    let emotionsResult = getEmotionRanking(results)
    return emotionsResult
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const pullFromWeb = async (urls) => {
    let pageContentText = '';
    const randomAgent = userAgentStrings[Math.floor(userAgentStrings.length * Math.random())];
    const options = { headers: { 'User-Agent': randomAgent }, timeout: 10000 };

    const resourceLoader = new ResourceLoader({
        fetch: (url, options) => {
            if (url.includes('iframe') || url.includes('external') || url.endsWith('.css') || url.includes('stylesheet')) {
                return null
            }
            ResourceLoader.prototype.fetch.call(this, url, options)
        }

    });

    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => {
        if (error.message.includes('Could not parse CSS stylesheet')) return; // Ignore specific errors
        console.error(error); // Log other errors
    });

    for (const link of urls) {
        try {
            const pageRaw = await axios.get(link.url, options);
            const dom = new JSDOM(pageRaw.data, {
                url: link.url,
                resources: resourceLoader,
                virtualConsole,
            });

            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (article) {
                const content = `- From the web page ${link.url}:\n${cleanContentWithNewlines(article.textContent)}\n`;
                pageContentText += content;
                fs.appendFileSync('./sample-scrape.txt', content);
                logger.log('Augment', `Successfully pulled the page contents for "${link.url}".`);
            } else {
                logger.log('Augment', `Could not parse content from "${link.url}".`);
            }
        } catch (error) {
            if (error.response) {
                logger.log('Augment', `HTTP error: ${error.response.status} - ${error.response.statusText}`);
            } else if (error.request) {
                logger.log('Augment', `No response received for "${link.url}".`);
            } else {
                logger.log('Augment', `Request setup error: ${error.message}`);
            }
        }
    }

    return pageContentText;
};


function cleanContentWithNewlines(content) {
    return content
        .replace(/\s+/g, ' ')
        .replace(/(?:\s*\n\s*)+/g, '\n')
        .trim();
}

const getEmotionRanking = (emotions) => {

    const getModifier = (score) => {
        if (score <= 0.33) {
            return "a bit of";
        } else if (score <= 0.66) {
            return "quite a bit of";
        } else {
            return "a lot of";
        }
    };

    const getEmotionDescription = (label) => {
        switch (label) {
            case "curious":
            case "surprise":
            case "think":
                return "curiosity or wonder";
            case "cheeky":
                return "cheeky banter";
            case "grumpy":
                return "a grumpy vibe";
            case "whiny":
                return "a whiny tone";
            case "empathetic":
                return "a sense of compassion"
            case "guilty":
                return "regret";
            case "anger":
                return "a heated emotion"
            case "disgust":
                return "a disgusted tone"
            case "impatient":
                return "frustration";
            case "energetic":
            case "joy":
                return "an uplifting and vibrant energy";
            case "serious":
                return "a stone-cold serious vibe"
            case "neutral":
                return "a lack of emotional energy"
            case "fear":
                return "a reserved or tense mood";
            case "love":
                return "a heartfelt or warm sentiment";
            case "confuse":
            case "suspicious":
                return "a puzzled or doubtful tone";
            case "sadness":
                return "melancholy";
            default:
                return "an undefined or mixed feeling";
        }
    };

    const topEmotions = emotions
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

    const messageParts = topEmotions.map(({ label, score }) => {
        const modifier = getModifier(score);
        const description = getEmotionDescription(label);
        return `${modifier} ${description}`;
    });

    const formattedMessage = messageParts.length > 1
        ? `${messageParts.slice(0, -1).join(", ")}, and ${messageParts.slice(-1)}`
        : messageParts[0];

    return `You feel that this message gives off ${formattedMessage}.`;
};

export { interpretEmotions, maintainVoiceContext, resultsReranked, pullFromWeb }