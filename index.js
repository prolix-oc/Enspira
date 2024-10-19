import moment from 'moment';
import ansi from './node_modules/ansi-colors-es6/index.js';
import Fastify from "fastify";
import * as aiHelper from './ai-logic.js'

var aiResponse = '';

const fastify = Fastify({
    logger: true,
    requestTimeout: 30000, // 30 seconds
});

fastify.route({
    method: 'POST',
    url: '/chatreq',
    schema: {
        querystring: {
            type: 'object',
            properties: {
                message: { type: 'string'},
                username: { type: 'string'}
            },
            required: ['message', 'username'],
        },
    response: {
        200: {
            type: 'object',
            properties: {
                response: { type: 'string' }
            }
        },
        401: {
            type: 'object',
            properties: {
                error: { type: 'string' }
            }
        }
    }},
    // this function is executed for every request before the handler is executed
    preHandler: async (request, reply) => {
        aiHelper.findRelevantDocuments(request.query.message)
        aiResponse = await aiHelper.genTextComplete(decodeURIComponent(request.query.message, request.query.message, ""))
    },
    handler: async (request, reply) => {
        return { response:  aiResponse }
    }
  })
  
try {
    await fastify.listen({ port: 3002 })
} catch (err) {
    fastify.log.error(err)
    process.exit(1)
}

aiHelper.startIndexingVectors();
