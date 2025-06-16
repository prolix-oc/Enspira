import WebSocket from 'ws';
import readline from 'readline';

/**
 * Simple WebSocket test client for Enspira VTuber integration
 * Usage: node websocket-test-client.js
 */

class EnspiraWebSocketTestClient {
  constructor(url, authToken) {
    this.url = url;
    this.authToken = authToken;
    this.ws = null;
    this.isAuthenticated = false;
    
    // Setup readline interface for interactive testing
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  connect() {
    console.log(`Connecting to ${this.url}...`);
    
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      console.log('✅ Connected to Enspira WebSocket server');
      this.sendModelInfo();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(JSON.parse(data.toString()));
    });

    this.ws.on('close', (code, reason) => {
      console.log(`❌ Connection closed: ${code} - ${reason}`);
      this.rl.close();
      process.exit(0);
    });

    this.ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error.message);
      this.rl.close();
      process.exit(1);
    });
  }

  handleMessage(message) {
    const timestamp = new Date().toLocaleTimeString();
    
    switch (message.type) {
      case 'auth-required':
        console.log(`[${timestamp}] 🔐 Server requesting authentication...`);
        // We'll authenticate when we send our first message
        break;

      case 'auth-success':
        console.log(`[${timestamp}] ✅ Authentication successful!`);
        this.isAuthenticated = true;
        this.startInteractiveMode();
        break;

      case 'auth-failed':
        console.log(`[${timestamp}] ❌ Authentication failed: ${message.message}`);
        process.exit(1);
        break;

      case 'response-queued':
        console.log(`[${timestamp}] ⏳ AI response queued (ID: ${message.response_id})`);
        break;

      case 'synthesis-started':
        console.log(`[${timestamp}] 🎵 TTS synthesis started (ID: ${message.response_id})`);
        break;

      case 'synthesis-complete':
        console.log(`[${timestamp}] ✅ TTS synthesis complete (ID: ${message.response_id})`);
        break;

      case 'full-text':
        console.log(`[${timestamp}] 💬 AI Response: "${message.text}"`);
        break;

      case 'audio':
        const audioSize = message.audio ? message.audio.length : 0;
        const hasExpressions = message.actions?.expressions?.length > 0;
        console.log(`[${timestamp}] 🔊 Audio received:`);
        console.log(`   📦 Size: ${audioSize} characters (base64)`);
        console.log(`   👤 Speaker: ${message.display_text?.name || 'Unknown'}`);
        console.log(`   😊 Expressions: ${hasExpressions ? message.actions.expressions.join(', ') : 'None'}`);
        break;

      case 'error':
        console.log(`[${timestamp}] ❌ Error: ${message.message}`);
        break;

      case 'interrupt':
        console.log(`[${timestamp}] ⛔ Response interrupted`);
        break;

      case 'ping':
        // Respond to server ping
        this.sendMessage({ type: 'pong' });
        break;

      case 'pong':
        console.log(`[${timestamp}] 🏓 Pong received`);
        break;

      default:
        console.log(`[${timestamp}] ❓ Unknown message type: ${message.type}`);
        console.log('   Full message:', JSON.stringify(message, null, 2));
    }
  }

  sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Add auth token to all messages except ping/pong
      if (message.type !== 'ping' && message.type !== 'pong') {
        message.auth_token = this.authToken;
      }
      
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  sendModelInfo() {
    // Send sample model info to test the integration
    const modelInfo = {
      type: 'model-info',
      model_info: {
        name: 'Test Live2D Model',
        url: 'test-model.model3.json',
        expressions: ['neutral', 'smile', 'happy', 'sad', 'surprised', 'angry'],
        scale: 1.0,
        width: 512,
        height: 512
      }
    };

    this.sendMessage(modelInfo);
    console.log('📤 Sent model info to server');
  }

  startInteractiveMode() {
    console.log('\n🎉 Ready for interactive mode!');
    console.log('Commands:');
    console.log('  - Type any message to send as text input');
    console.log('  - Type "!interrupt" to send an interrupt signal');
    console.log('  - Type "!ping" to send a ping');
    console.log('  - Type "!quit" to exit');
    console.log('');
    
    this.promptForInput();
  }

  promptForInput() {
    this.rl.question('💭 Enter message: ', (input) => {
      if (!input.trim()) {
        this.promptForInput();
        return;
      }

      // Handle special commands
      if (input.startsWith('!')) {
        this.handleCommand(input.substring(1));
      } else {
        // Send as text input
        const success = this.sendMessage({
          type: 'text-input',
          text: input.trim()
        });

        if (success) {
          console.log('📤 Message sent to server');
        } else {
          console.log('❌ Failed to send message - connection may be closed');
        }
      }

      if (input !== '!quit') {
        this.promptForInput();
      }
    });
  }

  handleCommand(command) {
    switch (command.toLowerCase()) {
      case 'interrupt':
        this.sendMessage({ type: 'interrupt' });
        console.log('📤 Interrupt signal sent');
        break;

      case 'ping':
        this.sendMessage({ type: 'ping' });
        console.log('📤 Ping sent');
        break;

      case 'quit':
        console.log('👋 Goodbye!');
        this.ws.close();
        break;

      default:
        console.log(`❓ Unknown command: ${command}`);
        console.log('Available commands: interrupt, ping, quit');
    }
  }
}

// Configuration - Update these values for your setup
const WS_URL = 'ws://localhost:3000/ws-client';
const AUTH_TOKEN = 'your_bearer_token_here';

// Validate configuration
if (AUTH_TOKEN === 'your_bearer_token_here') {
  console.error('❌ Please update the AUTH_TOKEN in this script with a valid bearer token');
  console.error('   Check your auth_keys.json file for a valid api_token');
  process.exit(1);
}

// Start the test client
console.log('🚀 Enspira WebSocket Test Client');
console.log('================================');
console.log(`🔗 URL: ${WS_URL}`);
console.log(`🔑 Token: ${AUTH_TOKEN.substring(0, 8)}...`);
console.log('');

const client = new EnspiraWebSocketTestClient(WS_URL, AUTH_TOKEN);
client.connect();