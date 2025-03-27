// setup-templates.js
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Layout template HTML
const layoutTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{pageTitle}} - Enspira</title>
  <style>
    :root {
      --background: #0d1117;
      --card-bg: #161b22;
      --primary-text: #e6edf3;
      --secondary-text: #8b949e;
      --accent: #58a6ff;
      --accent-hover: #79c0ff;
      --error: #f85149;
      --success: #56d364;
      --border: #30363d;
      --input-bg: #0d1117;
      --button-bg: #238636;
      --button-hover: #2ea043;
      --button-secondary-bg: #21262d;
      --button-secondary-hover: #30363d;
      --nav-bg: #161b22;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--background);
      color: var(--primary-text);
      line-height: 1.6;
      overflow-x: hidden;
    }
    
    .container {
      width: 100%;
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 20px;
    }
    
    header {
      background-color: var(--nav-bg);
      border-bottom: 1px solid var(--border);
      padding: 15px 0;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    
    .header-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .logo {
      font-size: 24px;
      font-weight: bold;
      color: var(--primary-text);
      text-decoration: none;
      display: flex;
      align-items: center;
    }
    
    .logo svg {
      margin-right: 10px;
    }
    
    nav ul {
      display: flex;
      list-style: none;
      gap: 20px;
    }
    
    nav a {
      color: var(--primary-text);
      text-decoration: none;
      font-weight: 500;
      padding: 8px 12px;
      border-radius: 6px;
      transition: background-color 0.2s;
    }
    
    nav a:hover {
      background-color: var(--button-secondary-hover);
    }
    
    nav a.active {
      background-color: var(--button-secondary-bg);
    }
    
    main {
      padding: 40px 0;
      min-height: calc(100vh - 140px);
    }
    
    .card {
      background-color: var(--card-bg);
      border-radius: 10px;
      border: 1px solid var(--border);
      padding: 20px;
      margin-bottom: 20px;
    }
    
    .card-header {
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 20px;
    }
    
    h2 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 15px;
    }
    
    h3 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 10px;
    }
    
    p {
      margin-bottom: 15px;
      color: var(--secondary-text);
    }
    
    a {
      color: var(--accent);
      text-decoration: none;
    }
    
    a:hover {
      color: var(--accent-hover);
      text-decoration: underline;
    }
    
    .btn {
      display: inline-block;
      padding: 8px 16px;
      font-size: 14px;
      font-weight: 500;
      border-radius: 6px;
      transition: background-color 0.2s;
      border: none;
      cursor: pointer;
      text-align: center;
    }
    
    .btn-primary {
      background-color: var(--button-bg);
      color: white;
    }
    
    .btn-primary:hover {
      background-color: var(--button-hover);
      text-decoration: none;
    }
    
    .btn-secondary {
      background-color: var(--button-secondary-bg);
      color: var(--primary-text);
    }
    
    .btn-secondary:hover {
      background-color: var(--button-secondary-hover);
      text-decoration: none;
    }
    
    .form-group {
      margin-bottom: 20px;
    }
    
    label {
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
    }
    
    input[type="text"],
    input[type="password"],
    input[type="email"],
    textarea,
    select {
      width: 100%;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background-color: var(--input-bg);
      color: var(--primary-text);
      font-size: 14px;
      transition: border-color 0.2s;
    }
    
    textarea {
      min-height: 150px;
      resize: vertical;
    }
    
    input:focus,
    textarea:focus,
    select:focus {
      outline: none;
      border-color: var(--accent);
    }
    
    .alert {
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 20px;
    }
    
    .alert-success {
      background-color: rgba(86, 211, 100, 0.1);
      border: 1px solid var(--success);
      color: var(--success);
    }
    
    .alert-error {
      background-color: rgba(248, 81, 73, 0.1);
      border: 1px solid var(--error);
      color: var(--error);
    }
    
    footer {
      padding: 20px 0;
      border-top: 1px solid var(--border);
      font-size: 14px;
      color: var(--secondary-text);
    }
    
    .footer-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    
    .tab {
      padding: 10px 20px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
    }
    
    .tab.active {
      border-bottom-color: var(--accent);
      color: var(--accent);
    }
    
    .tab-content {
      display: none;
    }
    
    .tab-content.active {
      display: block;
    }
    
    .two-column {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    
    @media (max-width: 768px) {
      .two-column {
        grid-template-columns: 1fr;
      }
      
      nav ul {
        gap: 10px;
      }
    }
    
    .loading {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 3px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: var(--accent);
      animation: spin 1s ease-in-out infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
  {{extraStyles}}
</head>
<body>
  <header>
    <div class="container header-content">
      <a href="/dashboard" class="logo">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="#58a6ff"/>
          <path d="M2 17L12 22L22 17" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2 12L12 17L22 12" stroke="#58a6ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Enspira</span>
      </a>
      <nav>
        <ul>
          <li><a href="/dashboard" class="{{dashboardActive}}">Dashboard</a></li>
          <li><a href="/character" class="{{characterActive}}">Character</a></li>
          <li><a href="/world" class="{{worldActive}}">World</a></li>
          <li><a href="/api/v1/auth/twitch/manage" class="{{twitchActive}}">Twitch</a></li>
          <li><a href="/api/v1/auth/logout" class="btn btn-secondary">Logout</a></li>
        </ul>
      </nav>
    </div>
  </header>

  <main>
    <div class="container">
      {{mainContent}}
    </div>
  </main>

  <footer>
    <div class="container footer-content">
      <div>Enspira &copy; 2025</div>
      <div>
        <a href="https://github.com/Prolix-LLC/enspira" target="_blank">GitHub</a>
      </div>
    </div>
  </footer>

  <script>
    // Common JavaScript functions
    document.addEventListener('DOMContentLoaded', () => {
      // Tab handling
      const tabGroups = document.querySelectorAll('.tabs');
      tabGroups.forEach(tabGroup => {
        const tabs = tabGroup.querySelectorAll('.tab');
        const tabContents = document.querySelectorAll('.tab-content');
        
        tabs.forEach(tab => {
          tab.addEventListener('click', () => {
            // Remove active class from all tabs
            tabs.forEach(t => t.classList.remove('active'));
            
            // Add active class to clicked tab
            tab.classList.add('active');
            
            // Show corresponding tab content
            const target = tab.getAttribute('data-target');
            tabContents.forEach(content => {
              if (content.id === target) {
                content.classList.add('active');
              } else {
                content.classList.remove('active');
              }
            });
          });
        });
      });
      
      // Form submission handling
      const forms = document.querySelectorAll('form[data-async]');
      forms.forEach(form => {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          
          const formData = new FormData(form);
          const submitBtn = form.querySelector('button[type="submit"]');
          const originalBtnText = submitBtn.textContent;
          
          // Show loading state
          submitBtn.disabled = true;
          submitBtn.innerHTML = '<span class="loading"></span> Processing...';
          
          try {
            const response = await fetch(form.action, {
              method: form.method || 'POST',
              body: formData,
              headers: {
                'Accept': 'application/json'
              }
            });
            
            const result = await response.json();
            
            if (response.ok) {
              // Show success message
              const alertEl = document.createElement('div');
              alertEl.className = 'alert alert-success';
              alertEl.textContent = result.message || 'Changes saved successfully!';
              form.prepend(alertEl);
              
              // Remove alert after 3 seconds
              setTimeout(() => alertEl.remove(), 3000);
              
              // If there's a redirect URL, navigate there
              if (result.redirect) {
                window.location.href = result.redirect;
              }
            } else {
              // Show error message
              const alertEl = document.createElement('div');
              alertEl.className = 'alert alert-error';
              alertEl.textContent = result.error || 'An error occurred. Please try again.';
              form.prepend(alertEl);
            }
          } catch (error) {
            console.error('Error:', error);
            const alertEl = document.createElement('div');
            alertEl.className = 'alert alert-error';
            alertEl.textContent = 'An unexpected error occurred. Please try again.';
            form.prepend(alertEl);
          } finally {
            // Restore button state
            submitBtn.disabled = false;
            submitBtn.textContent = originalBtnText;
          }
        });
      });
    });
    
    {{extraScripts}}
  </script>
</body>
</html>`;

// Dashboard template HTML
const dashboardTemplate = `{{pageTitle = "Dashboard"}}
{{dashboardActive = "active"}}

<div class="card">
  <div class="card-header">
    <h1>Welcome, {{user.display_name}}</h1>
  </div>
  
  <p>Manage your Enspira AI assistant for your Twitch channel.</p>
  
  <div class="two-column">
    <div class="card">
      <h2>Character Settings</h2>
      <p>Customize your AI assistant's personality, appearance, and behavior.</p>
      <a href="/character" class="btn btn-primary">Edit Character</a>
    </div>
    
    <div class="card">
      <h2>World Settings</h2>
      <p>Set up the environment and context for your AI assistant.</p>
      <a href="/world" class="btn btn-primary">Edit World</a>
    </div>
  </div>
  
  <div class="card">
    <h2>Twitch Integration</h2>
    <p>Connect your Twitch streamer and bot accounts.</p>
    
    <div class="two-column">
      <div>
        <h3>Streamer Account</h3>
        {{#if streamerConnected}}
          <p class="alert alert-success">Connected as: {{streamerName}}</p>
        {{else}}
          <p class="alert alert-error">Not connected</p>
        {{/if}}
        <a href="/api/v1/auth/twitch/manage" class="btn btn-secondary">Manage Connection</a>
      </div>
      
      <div>
        <h3>Bot Account</h3>
        {{#if botConnected}}
          <p class="alert alert-success">Connected as: {{botName}}</p>
        {{else}}
          <p class="alert alert-error">Not connected</p>
        {{/if}}
        <a href="/api/v1/auth/twitch/manage" class="btn btn-secondary">Manage Connection</a>
      </div>
    </div>
  </div>
  
  <div class="card">
    <h2>Quick Stats</h2>
    <div class="two-column">
      <div>
        <h3>Chat Messages</h3>
        <p>{{stats.chatMessages}} messages processed</p>
      </div>
      <div>
        <h3>Status</h3>
        <p>{{#if isOnline}}
          <span class="alert alert-success" style="padding: 4px 8px;">Online</span>
        {{else}}
          <span class="alert alert-error" style="padding: 4px 8px;">Offline</span>
        {{/if}}</p>
      </div>
    </div>
  </div>
</div>`;

// Character template HTML
const characterTemplate = `{{pageTitle = "Character Editor"}}
{{characterActive = "active"}}

<div class="card">
  <div class="card-header">
    <h1>Character Editor</h1>
  </div>
  
  <p>Customize your AI assistant's personality, description, and behavior. These settings help define how your assistant interacts with your Twitch chat.</p>
  
  <div class="tabs">
    <div class="tab active" data-target="personality-tab">Personality</div>
    <div class="tab" data-target="description-tab">Description</div>
    <div class="tab" data-target="example-messages-tab">Example Messages</div>
  </div>
  
  <div id="personality-tab" class="tab-content active">
    <form action="/api/v1/character/personality" method="POST" data-async>
      <div class="form-group">
        <label for="bot_name">Character Name</label>
        <input type="text" id="bot_name" name="bot_name" value="{{character.bot_name}}" required>
        <p>This is the name your AI assistant will use.</p>
      </div>
      
      <div class="form-group">
        <label for="personality">Personality</label>
        <textarea id="personality" name="personality" rows="12" required>{{characterPersonality}}</textarea>
        <p>Describe your assistant's personality traits, mannerisms, speaking style, interests, and attitudes.</p>
      </div>
      
      <button type="submit" class="btn btn-primary">Save Personality</button>
    </form>
  </div>
  
  <div id="description-tab" class="tab-content">
    <form action="/api/v1/character/description" method="POST" data-async>
      <div class="form-group">
        <label for="description">Physical Description</label>
        <textarea id="description" name="description" rows="12" required>{{characterDescription}}</textarea>
        <p>Describe your assistant's appearance, physical attributes, clothing, and other visual aspects.</p>
      </div>
      
      <div class="form-group">
        <label for="bot_twitch">Bot Twitch Username</label>
        <input type="text" id="bot_twitch" name="bot_twitch" value="{{character.bot_twitch}}" required>
        <p>The Twitch username your bot will use (include @ if necessary).</p>
      </div>
      
      <button type="submit" class="btn btn-primary">Save Description</button>
    </form>
  </div>
  
  <div id="example-messages-tab" class="tab-content">
    <form action="/api/v1/character/examples" method="POST" data-async>
      <div class="form-group">
        <label for="examples">Example Interactions</label>
        <textarea id="examples" name="examples" rows="15" required>{{characterExamples}}</textarea>
        <p>Provide examples of how your assistant would respond to different situations. This helps establish the assistant's tone and style. Format as:</p>
        <pre style="background-color: var(--input-bg); padding: 10px; margin-top: 5px; border-radius: 6px;">
User: [Example user message]
{{character.bot_name}}: [Example response]

User: [Another example]
{{character.bot_name}}: [Another response]</pre>
      </div>
      
      <button type="submit" class="btn btn-primary">Save Examples</button>
    </form>
  </div>
</div>

{{extraScripts}}
<script>
  // Auto-resize textareas as content grows
  document.addEventListener('DOMContentLoaded', () => {
    const textareas = document.querySelectorAll('textarea');
    textareas.forEach(textarea => {
      const adjustHeight = () => {
        textarea.style.height = 'auto';
        textarea.style.height = (textarea.scrollHeight) + 'px';
      };
      
      // Initial adjustment
      adjustHeight();
      
      // Adjust on input
      textarea.addEventListener('input', adjustHeight);
      
      // Adjust when tab is shown
      document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
          setTimeout(adjustHeight, 10);
        });
      });
    });
  });
</script>`;

// World template HTML
const worldTemplate = `{{pageTitle = "World Editor"}}
{{worldActive = "active"}}

<div class="card">
  <div class="card-header">
    <h1>World Editor</h1>
  </div>
  
  <p>Define the context and environment for your AI assistant. These settings help create the world in which your assistant exists and operates.</p>
  
  <div class="tabs">
    <div class="tab active" data-target="world-info-tab">World Information</div>
    <div class="tab" data-target="player-info-tab">Player Information</div>
    <div class="tab" data-target="scenario-tab">Scenario</div>
  </div>
  
  <div id="world-info-tab" class="tab-content active">
    <form action="/api/v1/world/info" method="POST" data-async>
      <div class="form-group">
        <label for="world_info">World Information</label>
        <textarea id="world_info" name="world_info" rows="15" required>{{worldInfo}}</textarea>
        <p>Describe the setting, background, lore, and context where your assistant exists. This could include fictional elements, time period, relevant history, or any other details that help establish the world.</p>
      </div>
      
      <div class="form-group">
        <label for="weather_enabled">Enable Weather</label>
        <select id="weather_enabled" name="weather_enabled">
          <option value="true" {{#if character.weather}}selected{{/if}}>Enabled</option>
          <option value="false" {{#unless character.weather}}selected{{/unless}}>Disabled</option>
        </select>
        <p>When enabled, your assistant will have access to real-time weather information based on your location.</p>
      </div>
      
      <button type="submit" class="btn btn-primary">Save World Information</button>
    </form>
  </div>
  
  <div id="player-info-tab" class="tab-content">
    <form action="/api/v1/world/player" method="POST" data-async>
      <div class="form-group">
        <label for="player_info">Player Information</label>
        <textarea id="player_info" name="player_info" rows="15" required>{{playerInfo}}</textarea>
        <p>Information about you (the streamer) that the assistant should know. This could include your preferences, streaming style, topics to focus on or avoid, personal details you're comfortable sharing, etc.</p>
      </div>
      
      <div class="form-group">
        <label for="commands_list">Chat Commands</label>
        <textarea id="commands_list" name="commands_list" rows="5">{{commandsList}}</textarea>
        <p>List of chat commands your bot should recognize but not respond to (one per line, e.g., !discord, !socials).</p>
      </div>
      
      <button type="submit" class="btn btn-primary">Save Player Information</button>
    </form>
  </div>
  
  <div id="scenario-tab" class="tab-content">
    <form action="/api/v1/world/scenario" method="POST" data-async>
      <div class="form-group">
        <label for="scenario">Scenario</label>
        <textarea id="scenario" name="scenario" rows="15" required>{{scenario}}</textarea>
        <p>Describe the specific situation or context in which the assistant is participating. This could be the premise of your stream, the assistant's role, or the ongoing narrative.</p>
      </div>
      
      <div class="form-group">
        <label for="aux_bots">Auxiliary Bots</label>
        <textarea id="aux_bots" name="aux_bots" rows="5">{{auxBots}}</textarea>
        <p>List of other bot usernames in your chat that your assistant should ignore (one per line, e.g., Nightbot, StreamElements).</p>
      </div>
      
      <button type="submit" class="btn btn-primary">Save Scenario</button>
    </form>
  </div>
</div>

{{extraScripts}}
<script>
  // Auto-resize textareas as content grows
  document.addEventListener('DOMContentLoaded', () => {
    const textareas = document.querySelectorAll('textarea');
    textareas.forEach(textarea => {
      const adjustHeight = () => {
        textarea.style.height = 'auto';
        textarea.style.height = (textarea.scrollHeight) + 'px';
      };
      
      // Initial adjustment
      adjustHeight();
      
      // Adjust on input
      textarea.addEventListener('input', adjustHeight);
      
      // Adjust when tab is shown
      document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
          setTimeout(adjustHeight, 10);
        });
      });
    });
  });
</script>`;

// Create directory structure
async function setup() {
  try {
    // Create directories
    await fs.ensureDir(path.join(process.cwd(), 'pages'));
    await fs.ensureDir(path.join(process.cwd(), 'routes'));
    
    // Write template files
    await fs.writeFile(path.join(process.cwd(), 'pages/layout.html'), layoutTemplate);
    await fs.writeFile(path.join(process.cwd(), 'pages/dashboard.html'), dashboardTemplate);
    await fs.writeFile(path.join(process.cwd(), 'pages/character.html'), characterTemplate);
    await fs.writeFile(path.join(process.cwd(), 'pages/world.html'), worldTemplate);
    
    console.log('Templates set up successfully!');
  } catch (error) {
    console.error('Error setting up templates:', error);
  }
}

setup();