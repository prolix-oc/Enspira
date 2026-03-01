/**
 * Enspira Extension Template
 *
 * This is a starter template for building Enspira extensions.
 * Modify this file to add your extension's functionality.
 *
 * Documentation: See ../DEVELOPER_GUIDE.md for full API reference
 */

import type {
  Extension,
  ExtensionContext,
  ExtensionManifest,
  EnspiraEvent,
} from '@enspira/sdk';

// Import manifest for type-safe access
import manifest from '../manifest.json';

/**
 * Extension state and configuration
 */
interface ExtensionState {
  isEnabled: boolean;
  eventCount: number;
}

/**
 * Main extension class
 */
class MyExtension implements Extension {
  manifest: ExtensionManifest = manifest as ExtensionManifest;

  private context!: ExtensionContext;
  private state: ExtensionState = {
    isEnabled: false,
    eventCount: 0,
  };
  private unsubscribers: Array<() => void> = [];

  /**
   * Called when the extension is loaded
   * Initialize resources and set up event subscriptions here
   */
  async onLoad(context: ExtensionContext): Promise<void> {
    this.context = context;

    // Load saved state from storage
    const savedState = context.storage.get<ExtensionState>('state');
    if (savedState) {
      this.state = savedState;
    }

    context.logger.info('MyExtension', 'Extension loading...');

    // Subscribe to events
    this.setupEventHandlers();

    context.logger.info('MyExtension', `Loaded! Previous event count: ${this.state.eventCount}`);
  }

  /**
   * Called when the extension is unloaded
   * Clean up resources here
   */
  async onUnload(): Promise<void> {
    // Unsubscribe from all events
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];

    // Save state
    this.context.storage.set('state', this.state);

    this.context.logger.info('MyExtension', 'Extension unloaded');
  }

  /**
   * Called when the extension is enabled
   */
  async onEnable(): Promise<void> {
    this.state.isEnabled = true;
    this.context.logger.info('MyExtension', 'Extension enabled');
  }

  /**
   * Called when the extension is disabled
   */
  async onDisable(): Promise<void> {
    this.state.isEnabled = false;
    this.context.logger.info('MyExtension', 'Extension disabled');
  }

  /**
   * Set up event handlers
   */
  private setupEventHandlers(): void {
    // Handle new followers
    const unsubFollow = this.context.eventBus.subscribe('twitch:follow', async (event) => {
      await this.handleFollow(event);
    });
    this.unsubscribers.push(unsubFollow);

    // Handle chat messages
    const unsubChat = this.context.eventBus.subscribe('twitch:chat', async (event) => {
      await this.handleChat(event);
    });
    this.unsubscribers.push(unsubChat);

    // Handle subscriptions
    const unsubSub = this.context.eventBus.subscribe('twitch:subscribe', async (event) => {
      await this.handleSubscribe(event);
    });
    this.unsubscribers.push(unsubSub);
  }

  /**
   * Handle follow events
   */
  private async handleFollow(event: EnspiraEvent): Promise<void> {
    this.state.eventCount++;
    const username = event.data.username as string;

    this.context.logger.info('MyExtension', `New follower: ${username}`);

    // Add your custom logic here
    // Examples:
    // - Send notification to Discord
    // - Track follower statistics
    // - Trigger overlay animation
  }

  /**
   * Handle chat messages
   */
  private async handleChat(event: EnspiraEvent): Promise<void> {
    this.state.eventCount++;
    const user = event.data.user as string;
    const message = event.data.message as string;
    const firstMessage = event.data.firstMessage as boolean;

    // Log first-time chatters
    if (firstMessage) {
      this.context.logger.info('MyExtension', `First message from ${user}: ${message}`);
    }

    // Add your custom logic here
    // Examples:
    // - Track chat statistics
    // - Detect specific keywords
    // - Log messages to external service
  }

  /**
   * Handle subscription events
   */
  private async handleSubscribe(event: EnspiraEvent): Promise<void> {
    this.state.eventCount++;
    const user = event.data.user as string;
    const tier = event.data.subTier as string;
    const isGift = event.data.isGift as boolean;

    this.context.logger.info(
      'MyExtension',
      `New ${tier} subscription: ${user}${isGift ? ' (gifted)' : ''}`
    );

    // Add your custom logic here
    // Examples:
    // - Send notification
    // - Update subscriber count
    // - Trigger special effects
  }
}

// Export the extension instance
export default new MyExtension();
