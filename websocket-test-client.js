#!/usr/bin/env node

/**
 * Simple WebSocket test client for Enspira VTuber integration
 * Tests connection, authentication, and basic message flow
 */

import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class WebSocketTestClient {
  constructor(serverUrl, authToken) {
    this.serverUrl = serverUrl;
    this.authToken = authToken;
    this.ws = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.messageCount = 0;
    
    console.log('🔧 WebSocket Test Client initialized');
    console.log(`   Server URL: ${this.serverUrl}`);
    console.log(`   Auth Token: ${this.authToken ? 'Provided' : 'NOT PROVIDED'}`);
  }

  /**
   * Connect to the WebSocket server
   */
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        console.log(`\n🔌 Attempting to connect to: ${this.serverUrl}`);
        
        // Configure WebSocket options for self-signed certificates
        const wsOptions = {
          rejectUnauthorized: false, // Allow self-signed certificates
          headers: {
            'User-Agent': 'Enspira-WebSocket-Test-Client/1.0'
          }
        };

        this.ws = new WebSocket(this.serverUrl, wsOptions);
        
        this.ws.on('open', () => {
          console.log('✅ WebSocket connection established successfully!');
          this.isConnected = true;
          resolve();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
          console.log(`\n❌ WebSocket connection closed: ${code} - ${reason}`);
          this.isConnected = false;
          this.isAuthenticated = false;
        });

        this.ws.on('error', (error) => {
          console.error(`\n❌ WebSocket error: ${error.message}`);
          console.error('Full error:', error);
          reject(error);
        });

        // Set connection timeout
        setTimeout(() => {
          if (!this.isConnected) {
            this.ws?.close();
            reject(new Error('Connection timeout after 10 seconds'));
          }
        }, 10000);

      } catch (error) {
        console.error('❌ Error creating WebSocket:', error);
        reject(error);
      }
    });
  }

  /**
   * Handle incoming messages from server
   */
  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      this.messageCount++;
      
      console.log(`\n📨 Message #${this.messageCount} received:`);
      console.log(`   Type: ${message.type}`);
      console.log(`   Timestamp: ${message.timestamp || 'N/A'}`);

      switch (message.type) {
        case 'connection-established':
          console.log(`   ✅ Connection established with client ID: ${message.client_id}`);
          break;

        case 'auth-required':
          console.log('   🔐 Server requesting authentication...');
          this.sendAuthentication();
          break;

        case 'auth-success':
          console.log('   ✅ Authentication successful!');
          console.log(`   User ID: ${message.user_id || 'Unknown'}`);
          this.isAuthenticated = true;
          this.startTests();
          break;

        case 'auth-failed':
          console.error('   ❌ Authentication failed:', message.message);
          break;

        case 'ping':
          console.log('   🏓 Received ping, sending pong...');
          this.sendMessage({ type: 'pong' });
          break;

        case 'pong':
          console.log('   🏓 Pong received - connection alive');
          break;

        case 'connection-test-response':
          console.log('   ✅ Connection test successful:', message.message);
          break;

        case 'response-queued':
          console.log(`   ⏳ AI response queued with ID: ${message.response_id}`);
          break;

        case 'full-text':
          console.log(`   💬 AI Response: "${message.text}"`);
          break;

        case 'model-info-received':
          console.log('   ✅ Model info acknowledged:', message.message);
          break;

        case 'error':
          console.error('   ❌ Server error:', message.message);
          break;

        default:
          console.log(`   ❓ Unknown message type: ${message.type}`);
          if (message.message) {
            console.log(`   Message: ${message.message}`);
          }
      }
    } catch (error) {
      console.error('❌ Error parsing message:', error.message);
      console.error('Raw message:', data.toString());
    }
  }

  /**
   * Send authentication token to server
   */
  sendAuthentication() {
    console.log('📤 Sending authentication...');
    this.sendMessage({
      type: 'auth',
      auth_token: this.authToken
    });
  }

  /**
   * Send a message to the WebSocket server
   */
  sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const jsonMessage = JSON.stringify(message);
      this.ws.send(jsonMessage);
      console.log(`📤 Sent: ${message.type}`);
    } else {
      console.error('❌ Cannot send message: WebSocket not connected');
      console.log(`   WebSocket state: ${this.ws?.readyState || 'undefined'}`);
    }
  }

  /**
   * Run a series of tests to verify WebSocket functionality
   */
  async startTests() {
    console.log('\n🧪 Starting WebSocket functionality tests...\n');

    try {
      // Test 1: Connection test
      await this.delay(1000);
      console.log('🔬 Test 1: Connection test');
      this.sendMessage({ type: 'connection-test' });

      // Test 2: Model info
      await this.delay(2000);
      console.log('🔬 Test 2: Sending model info');
      this.sendMessage({
        type: 'model-info',
        model_info: {
          name: 'Test VTuber Model',
          version: '1.0.0',
          expressions: ['neutral', 'happy', 'sad', 'surprised']
        }
      });

      // Test 3: Text input
      await this.delay(2000);
      console.log('🔬 Test 3: Sending text input');
      this.sendMessage({
        type: 'text-input',
        text: 'Hello, this is a test message from the WebSocket test client!'
      });

      // Test 4: Ping manually
      await this.delay(3000);
      console.log('🔬 Test 4: Manual ping test');
      this.sendMessage({ type: 'ping' });

      // Test 5: Another text input
      await this.delay(2000);
      console.log('🔬 Test 5: Another text input test');
      this.sendMessage({
        type: 'text-input',
        text: 'Can you confirm that the WebSocket connection is working properly?'
      });

      console.log('\n✅ All tests sent! Waiting for responses...\n');
      
      // Keep connection alive for responses
      setTimeout(() => {
        console.log('\n🔚 Test sequence completed. Closing connection...');
        this.disconnect();
      }, 15000);

    } catch (error) {
      console.error('❌ Error during tests:', error);
      this.disconnect();
    }
  }

  /**
   * Utility function to add delays between tests
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect() {
    if (this.ws) {
      console.log('🔌 Disconnecting...');
      this.ws.close(1000, 'Test completed');
      this.ws = null;
    }
  }
}

/**
 * Main test function
 */
async function runWebSocketTest() {
  console.log('🚀 Enspira WebSocket Test Client Starting...\n');
  
  // Configuration - update these values for your setup
  const SERVER_PORT = 443; // Update with your server port
  const SERVER_HOST = 'enspira.tools'; // Update with your server host  
  const USE_HTTPS = true; // Set to true if using HTTPS/WSS
  const AUTH_TOKEN = 'd194dc9c75eaa9695d826f069a769bbf5eaf85a4bd8f7d50'; // Update with a valid auth token

  const protocol = USE_HTTPS ? 'wss' : 'ws';
  const serverUrl = `${protocol}://${SERVER_HOST}:${SERVER_PORT}/ws-client`;

  console.log('📋 Configuration:');
  console.log(`   Server URL: ${serverUrl}`);
  console.log(`   Protocol: ${protocol.toUpperCase()}`);
  console.log(`   Auth Token: ${AUTH_TOKEN && AUTH_TOKEN !== 'your-test-auth-token-here' ? 'Valid token provided' : 'NO VALID TOKEN'}`);

  if (!AUTH_TOKEN || AUTH_TOKEN === 'your-test-auth-token-here') {
    console.warn('\n⚠️  WARNING: No valid auth token provided!');
    console.warn('   Authentication will fail unless you update AUTH_TOKEN');
    console.warn('   Get a valid token from your Enspira API keys configuration\n');
  }

  const testClient = new WebSocketTestClient(serverUrl, AUTH_TOKEN);

  try {
    await testClient.connect();
    console.log('⏳ Waiting for server messages...');
    // Tests will start automatically after authentication
  } catch (error) {
    console.error('\n❌ Test failed with error:', error.message);
    
    // Provide detailed troubleshooting
    console.log('\n🔧 Troubleshooting steps:');
    console.log('1. 📡 Ensure your Enspira server is running');
    console.log(`2. 🔌 Verify server is listening on ${SERVER_HOST}:${SERVER_PORT}`);
    console.log('3. 🛡️  Check firewall allows connections on this port');
    console.log('4. 🔍 Check server logs for WebSocket errors');
    
    if (error.message.includes('ECONNREFUSED')) {
      console.log('5. ❌ Connection refused - server may not be running');
    }
    
    if (error.message.includes('certificate') || error.message.includes('SSL')) {
      console.log('5. 🔒 SSL/Certificate issue - try setting USE_HTTPS = false');
    }
    
    if (error.message.includes('timeout')) {
      console.log('5. ⏰ Connection timeout - server may be slow to respond');
    }

    console.log('\n💡 Quick test: Try accessing your server status page first');
    console.log(`   ${USE_HTTPS ? 'https' : 'http'}://${SERVER_HOST}:${SERVER_PORT}/ws-status`);
    
    process.exit(1);
  }
}

// Run the test
console.log('Starting WebSocket test client...\n');
runWebSocketTest().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});