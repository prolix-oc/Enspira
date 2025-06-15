// response-monitor.js
import { logger } from './create-global-logger.js';
import fs from 'fs-extra';
import path from 'path';

// Simple in-memory stats
const responseStats = {
  totalRequests: 0,
  largeResponses: 0,  // Responses over 50KB
  hugeResponses: 0,   // Responses over 500KB
  emptyResponses: 0,  // Empty or failed responses
  lastReset: Date.now(),
  largeResponseTimestamps: [], // Track when large responses occurred
  responseSizes: []  // Store recent response sizes for analysis
};

// Keep only the most recent 100 response sizes
const MAX_HISTORY = 100;

/**
 * Records statistics about a response
 * @param {string} responseType - The type of response (e.g., 'chat', 'event', 'voice')
 * @param {any} responseBody - The response body
 * @param {string} userId - The user ID
 * @param {boolean} success - Whether the request was successful
 */
export function recordResponseStats(responseType, responseBody, userId, success = true) {
  responseStats.totalRequests++;
  
  // Handle empty or failed responses
  if (!success || !responseBody || responseBody.error) {
    responseStats.emptyResponses++;
    logger.log("Monitor", `Empty/failed ${responseType} response recorded for user ${userId}`);
    return;
  }
  
  // Calculate response size
  let responseSize = 0;
  if (typeof responseBody === 'string') {
    responseSize = responseBody.length;
  } else if (responseBody.response && typeof responseBody.response === 'string') {
    responseSize = responseBody.response.length;
  } else {
    responseSize = JSON.stringify(responseBody).length;
  }
  
  // Record the size
  responseStats.responseSizes.push({
    timestamp: Date.now(),
    size: responseSize,
    type: responseType,
    userId
  });
  
  // Trim history if needed
  if (responseStats.responseSizes.length > MAX_HISTORY) {
    responseStats.responseSizes.shift();
  }
  
  // Track large responses
  if (responseSize > 50000) { // 50KB
    responseStats.largeResponses++;
    responseStats.largeResponseTimestamps.push(Date.now());
    
    // Only keep the last 20 timestamps
    if (responseStats.largeResponseTimestamps.length > 20) {
      responseStats.largeResponseTimestamps.shift();
    }
    
    logger.log("Monitor", `Large ${responseType} response (${(responseSize/1024).toFixed(2)}KB) recorded for user ${userId}`);
    
    // Check for response burst (more than 5 large responses in 5 minutes)
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    const recentLargeResponses = responseStats.largeResponseTimestamps.filter(
      timestamp => timestamp > fiveMinutesAgo
    );
    
    if (recentLargeResponses.length > 5) {
      logger.log("Monitor", `WARNING: Burst of large responses detected (${recentLargeResponses.length} in 5 minutes)`);
    }
  }
  
  // Track huge responses
  if (responseSize > 500000) { // 500KB
    responseStats.hugeResponses++;
    logger.log("Monitor", `ALERT: Huge ${responseType} response (${(responseSize/1024).toFixed(2)}KB) for user ${userId}`);
    
    // If you want to save examples of huge responses for analysis
    try {
      const logsDir = path.join(process.cwd(), 'logs', 'huge_responses');
      fs.ensureDirSync(logsDir);
      const filePath = path.join(logsDir, `huge_response_${Date.now()}_${responseType}_${userId}.json`);
      fs.writeJSONSync(filePath, {
        type: responseType,
        userId,
        timestamp: new Date().toISOString(),
        size: responseSize,
        sample: typeof responseBody === 'string' 
          ? responseBody.substring(0, 10000) 
          : JSON.stringify(responseBody).substring(0, 10000)
      }, { spaces: 2 });
    } catch (err) {
      logger.log("Monitor", `Error saving huge response sample: ${err.message}`);
    }
  }
}

/**
 * Gets current response statistics
 * @returns {Object} The current response statistics
 */
export function getResponseStats() {
  // Calculate some additional metrics
  const uptime = Math.floor((Date.now() - responseStats.lastReset) / 1000);
  
  // Calculate percentiles if we have data
  let p50 = 0, p95 = 0, p99 = 0;
  if (responseStats.responseSizes.length > 0) {
    // Sort by size
    const sortedSizes = [...responseStats.responseSizes]
      .map(item => item.size)
      .sort((a, b) => a - b);
    
    const getPercentile = (arr, p) => {
      const index = Math.floor(arr.length * p / 100);
      return arr[index];
    };
    
    p50 = getPercentile(sortedSizes, 50);
    p95 = getPercentile(sortedSizes, 95);
    p99 = getPercentile(sortedSizes, 99);
  }
  
  return {
    ...responseStats,
    uptime,
    emptyResponseRate: responseStats.totalRequests 
      ? (responseStats.emptyResponses / responseStats.totalRequests * 100).toFixed(2)
      : 0,
    largeResponseRate: responseStats.totalRequests 
      ? (responseStats.largeResponses / responseStats.totalRequests * 100).toFixed(2)
      : 0,
    responseSizePercentiles: {
      p50: (p50 / 1024).toFixed(2) + ' KB',
      p95: (p95 / 1024).toFixed(2) + ' KB',
      p99: (p99 / 1024).toFixed(2) + ' KB'
    }
  };
}

/**
 * Resets the response statistics
 */
export function resetResponseStats() {
  Object.assign(responseStats, {
    totalRequests: 0,
    largeResponses: 0,
    hugeResponses: 0,
    emptyResponses: 0,
    lastReset: Date.now(),
    largeResponseTimestamps: [],
    responseSizes: []
  });
  
  logger.log("Monitor", "Response statistics have been reset");
}

/**
 * Adds the response monitoring middleware to a Fastify instance
 * @param {FastifyInstance} fastify - The Fastify instance to add the middleware to
 */
export function addResponseMonitoring(fastify) {
  // Add response hook
  fastify.addHook('onResponse', (request, reply, done) => {
    try {
      // Get the route
      const route = request.routeOptions?.url || request.url;
      
      // Only monitor actual API endpoints
      if (route.includes('/v1/') && ['POST', 'PUT'].includes(request.method)) {
        const responseTime = reply.getResponseTime();
        const userId = reply.request.headers?.authorization 
          ? reply.request.headers.authorization.split(' ')[1]
          : 'unknown';
        
        // Record response code
        if (reply.statusCode >= 400) {
          recordResponseStats(
            route.split('/').pop(), 
            { error: `HTTP ${reply.statusCode}` }, 
            userId, 
            false
          );
        }
        
        // Log slow responses
        if (responseTime > 5000) {
          logger.log("Monitor", `Slow response detected: ${responseTime.toFixed(0)}ms for ${route}`);
        }
      }
    } catch (err) {
      // Don't let monitoring errors affect the application
      logger.log("Monitor", `Error in response monitoring: ${err.message}`);
    }
    
    done();
  });
  
  // Add status endpoint
  fastify.get('/admin/response-stats', async (request, reply) => {
    // Optional basic auth for this endpoint
    const auth = request.headers.authorization;
    const validAuth = 'Basic ' + Buffer.from('admin:admin123').toString('base64');
    
    if (auth !== validAuth) {
      reply.status(401).send({ error: 'Unauthorized' });
      return;
    }
    
    reply.send(getResponseStats());
  });
  
  // Add reset endpoint
  fastify.post('/admin/response-stats/reset', async (request, reply) => {
    // Optional basic auth for this endpoint
    const auth = request.headers.authorization;
    const validAuth = 'Basic ' + Buffer.from('admin:admin123').toString('base64');
    
    if (auth !== validAuth) {
      reply.status(401).send({ error: 'Unauthorized' });
      return;
    }
    
    resetResponseStats();
    reply.send({ success: true, message: 'Response statistics have been reset' });
  });
  
  // Log initial setup
  logger.log("Monitor", "Response monitoring has been enabled");
}