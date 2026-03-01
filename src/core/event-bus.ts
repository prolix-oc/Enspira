/**
 * Event Bus - Pub/Sub system for broadcasting events to extensions
 * Provides a centralized event distribution mechanism with middleware support
 * @module core/event-bus
 */

import { randomUUID } from 'crypto';
import type {
  EnspiraEvent,
  EnspiraEventType,
  EnspiraEventSource,
  EnspiraResponse,
  EventHandler,
  Unsubscribe,
  MiddlewareHandler,
  ResponseMiddlewareHandler,
  EventSubscription,
  EventBusStats,
  EventBusClient,
} from '@/types/extension.types.js';
import { getLogger, type Logger } from './logger.js';

// ==================== CONSTANTS ====================

/** Maximum number of subscriptions per extension */
const MAX_SUBSCRIPTIONS_PER_EXTENSION = 50;

/** Maximum number of global middlewares */
const MAX_MIDDLEWARES = 20;

/** Event processing timeout in milliseconds */
const EVENT_TIMEOUT_MS = 5000;

/** Stats collection interval */
const STATS_WINDOW_SIZE = 1000;

// ==================== EVENT BUS CLASS ====================

/**
 * Central event bus for broadcasting events to extensions
 * Implements a pub/sub pattern with middleware support
 */
export class EventBus {
  private logger: Logger;
  private subscribers: Map<string, Set<EventSubscription>> = new Map();
  private wildcardSubscribers: Set<EventSubscription> = new Set();
  private middlewares: MiddlewareHandler[] = [];
  private responseMiddlewares: ResponseMiddlewareHandler[] = [];
  private stats: EventBusStatsInternal;
  private isShuttingDown = false;

  constructor() {
    this.logger = getLogger();
    this.stats = {
      eventsPublished: 0,
      eventsByType: {},
      processingTimes: [],
      errors: 0,
    };
  }

  // ==================== SUBSCRIPTION METHODS ====================

  /**
   * Subscribe to events of a specific type
   * @param extensionId - ID of the subscribing extension
   * @param eventType - Event type to subscribe to, or '*' for all events
   * @param handler - Handler function to call when event is received
   * @returns Unsubscribe function
   */
  subscribe(
    extensionId: string,
    eventType: EnspiraEventType | '*',
    handler: EventHandler
  ): Unsubscribe {
    // Validate subscription limits
    const extensionSubCount = this.getSubscriptionCountForExtension(extensionId);
    if (extensionSubCount >= MAX_SUBSCRIPTIONS_PER_EXTENSION) {
      this.logger.warn(
        'EventBus',
        `Extension ${extensionId} has reached max subscriptions (${MAX_SUBSCRIPTIONS_PER_EXTENSION})`
      );
      throw new Error(`Maximum subscriptions reached for extension ${extensionId}`);
    }

    const subscription: EventSubscription = {
      extensionId,
      eventType,
      handler,
      createdAt: new Date(),
    };

    if (eventType === '*') {
      this.wildcardSubscribers.add(subscription);
    } else {
      if (!this.subscribers.has(eventType)) {
        this.subscribers.set(eventType, new Set());
      }
      this.subscribers.get(eventType)!.add(subscription);
    }

    this.logger.debug('EventBus', `Extension ${extensionId} subscribed to ${eventType}`);

    // Return unsubscribe function
    return () => {
      if (eventType === '*') {
        this.wildcardSubscribers.delete(subscription);
      } else {
        this.subscribers.get(eventType)?.delete(subscription);
      }
      this.logger.debug('EventBus', `Extension ${extensionId} unsubscribed from ${eventType}`);
    };
  }

  /**
   * Unsubscribe all handlers for an extension
   * @param extensionId - Extension ID to unsubscribe
   */
  unsubscribeAll(extensionId: string): void {
    // Remove from wildcard subscribers
    for (const sub of this.wildcardSubscribers) {
      if (sub.extensionId === extensionId) {
        this.wildcardSubscribers.delete(sub);
      }
    }

    // Remove from type-specific subscribers
    for (const [, subs] of this.subscribers) {
      for (const sub of subs) {
        if (sub.extensionId === extensionId) {
          subs.delete(sub);
        }
      }
    }

    this.logger.debug('EventBus', `Unsubscribed all handlers for extension ${extensionId}`);
  }

  // ==================== MIDDLEWARE METHODS ====================

  /**
   * Add a middleware handler for event processing
   * Middlewares are called in order before event handlers
   * @param handler - Middleware handler function
   */
  addMiddleware(handler: MiddlewareHandler): void {
    if (this.middlewares.length >= MAX_MIDDLEWARES) {
      throw new Error(`Maximum middlewares reached (${MAX_MIDDLEWARES})`);
    }
    this.middlewares.push(handler);
    this.logger.debug('EventBus', `Added middleware (total: ${this.middlewares.length})`);
  }

  /**
   * Remove a middleware handler
   * @param handler - Middleware handler to remove
   */
  removeMiddleware(handler: MiddlewareHandler): void {
    const index = this.middlewares.indexOf(handler);
    if (index > -1) {
      this.middlewares.splice(index, 1);
      this.logger.debug('EventBus', `Removed middleware (total: ${this.middlewares.length})`);
    }
  }

  /**
   * Add a response middleware handler
   * Called after response generation but before sending
   * @param handler - Response middleware handler function
   */
  addResponseMiddleware(handler: ResponseMiddlewareHandler): void {
    if (this.responseMiddlewares.length >= MAX_MIDDLEWARES) {
      throw new Error(`Maximum response middlewares reached (${MAX_MIDDLEWARES})`);
    }
    this.responseMiddlewares.push(handler);
    this.logger.debug(
      'EventBus',
      `Added response middleware (total: ${this.responseMiddlewares.length})`
    );
  }

  /**
   * Remove a response middleware handler
   * @param handler - Response middleware handler to remove
   */
  removeResponseMiddleware(handler: ResponseMiddlewareHandler): void {
    const index = this.responseMiddlewares.indexOf(handler);
    if (index > -1) {
      this.responseMiddlewares.splice(index, 1);
    }
  }

  // ==================== EVENT PUBLISHING ====================

  /**
   * Publish an event to all subscribers
   * @param event - Event to publish
   * @returns Promise that resolves when all handlers complete
   */
  async publish(event: EnspiraEvent): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.debug('EventBus', 'Ignoring event during shutdown');
      return;
    }

    const startTime = performance.now();

    try {
      // Run through middlewares
      const processedEvent = await this.runMiddlewares(event);
      if (!processedEvent) {
        this.logger.debug('EventBus', `Event ${event.id} cancelled by middleware`);
        return;
      }

      // Get all applicable subscribers
      const typeSubscribers = this.subscribers.get(processedEvent.type) || new Set();
      const allSubscribers = [...typeSubscribers, ...this.wildcardSubscribers];

      if (allSubscribers.length === 0) {
        this.logger.debug('EventBus', `No subscribers for event type ${processedEvent.type}`);
        this.updateStats(processedEvent.type, startTime);
        return;
      }

      // Call all handlers with timeout
      const handlerPromises = allSubscribers.map((sub) =>
        this.callHandlerWithTimeout(sub, processedEvent)
      );

      await Promise.allSettled(handlerPromises);

      this.updateStats(processedEvent.type, startTime);
      this.logger.debug(
        'EventBus',
        `Published ${processedEvent.type} to ${allSubscribers.length} subscribers`
      );
    } catch (error) {
      this.stats.errors++;
      this.logger.error('EventBus', `Error publishing event: ${error}`);
    }
  }

  /**
   * Process a response through response middlewares
   * @param event - Original event
   * @param response - Response to process
   * @returns Processed response
   */
  async processResponse(event: EnspiraEvent, response: EnspiraResponse): Promise<EnspiraResponse> {
    if (this.responseMiddlewares.length === 0) {
      return response;
    }

    let currentResponse = response;

    for (const middleware of this.responseMiddlewares) {
      try {
        currentResponse = await middleware(event, currentResponse, async (res) => res);
      } catch (error) {
        this.logger.error('EventBus', `Response middleware error: ${error}`);
        // Continue with current response on error
      }
    }

    return currentResponse;
  }

  // ==================== HELPER METHODS ====================

  /**
   * Run event through all middlewares
   */
  private async runMiddlewares(event: EnspiraEvent): Promise<EnspiraEvent | null> {
    if (this.middlewares.length === 0) {
      return event;
    }

    let currentEvent: EnspiraEvent | null = event;
    let index = 0;

    const next = async (ev: EnspiraEvent | null): Promise<void> => {
      currentEvent = ev;
      if (ev && index < this.middlewares.length) {
        const middleware = this.middlewares[index++];
        if (middleware) {
          try {
            await middleware(ev, next);
          } catch (error) {
            this.logger.error('EventBus', `Middleware error: ${error}`);
            // Continue to next middleware on error
            await next(ev);
          }
        }
      }
    };

    await next(event);
    return currentEvent;
  }

  /**
   * Call a handler with timeout protection
   */
  private async callHandlerWithTimeout(
    subscription: EventSubscription,
    event: EnspiraEvent
  ): Promise<void> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.logger.warn(
          'EventBus',
          `Handler timeout for extension ${subscription.extensionId} on ${event.type}`
        );
        resolve();
      }, EVENT_TIMEOUT_MS);

      Promise.resolve(subscription.handler(event))
        .then(() => {
          clearTimeout(timeoutId);
          resolve();
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          this.stats.errors++;
          this.logger.error(
            'EventBus',
            `Handler error for extension ${subscription.extensionId}: ${error}`
          );
          resolve();
        });
    });
  }

  /**
   * Update statistics after event processing
   */
  private updateStats(eventType: string, startTime: number): void {
    const processingTime = performance.now() - startTime;

    this.stats.eventsPublished++;
    this.stats.eventsByType[eventType] = (this.stats.eventsByType[eventType] || 0) + 1;
    this.stats.processingTimes.push(processingTime);

    // Keep processing times bounded
    if (this.stats.processingTimes.length > STATS_WINDOW_SIZE) {
      this.stats.processingTimes.shift();
    }
  }

  /**
   * Get subscription count for an extension
   */
  private getSubscriptionCountForExtension(extensionId: string): number {
    let count = 0;

    for (const sub of this.wildcardSubscribers) {
      if (sub.extensionId === extensionId) count++;
    }

    for (const [, subs] of this.subscribers) {
      for (const sub of subs) {
        if (sub.extensionId === extensionId) count++;
      }
    }

    return count;
  }

  // ==================== PUBLIC UTILITIES ====================

  /**
   * Create a new event with generated ID and timestamp
   */
  createEvent(
    type: EnspiraEventType,
    source: EnspiraEventSource,
    data: Record<string, unknown>,
    user?: { id: string; name: string; roles: string[] }
  ): EnspiraEvent {
    return {
      id: randomUUID(),
      timestamp: new Date(),
      type,
      source,
      data,
      user,
      meta: {},
    };
  }

  /**
   * Create an EventBusClient for an extension
   */
  createClient(extensionId: string): EventBusClient {
    return {
      subscribe: (eventType, handler) => this.subscribe(extensionId, eventType, handler),
      emit: async (type, data) => {
        const event = this.createEvent(type, 'extension', data);
        event.meta = { ...event.meta, extensionId };
        await this.publish(event);
      },
    };
  }

  /**
   * Get current statistics
   */
  getStats(): EventBusStats {
    const avgProcessingTime =
      this.stats.processingTimes.length > 0
        ? this.stats.processingTimes.reduce((a, b) => a + b, 0) / this.stats.processingTimes.length
        : 0;

    // Count subscriptions by extension
    const subscriptionsByExtension: Record<string, number> = {};

    for (const sub of this.wildcardSubscribers) {
      subscriptionsByExtension[sub.extensionId] =
        (subscriptionsByExtension[sub.extensionId] || 0) + 1;
    }

    for (const [, subs] of this.subscribers) {
      for (const sub of subs) {
        subscriptionsByExtension[sub.extensionId] =
          (subscriptionsByExtension[sub.extensionId] || 0) + 1;
      }
    }

    let totalSubscriptions = 0;
    for (const count of Object.values(subscriptionsByExtension)) {
      totalSubscriptions += count;
    }

    return {
      eventsPublished: this.stats.eventsPublished,
      eventsByType: { ...this.stats.eventsByType },
      activeSubscriptions: totalSubscriptions,
      subscriptionsByExtension,
      avgProcessingTime,
    };
  }

  /**
   * Prepare for shutdown - stop accepting new events
   */
  shutdown(): void {
    this.isShuttingDown = true;
    this.logger.info('EventBus', 'Shutting down event bus');
  }

  /**
   * Clear all subscriptions and middlewares (for testing)
   */
  clear(): void {
    this.subscribers.clear();
    this.wildcardSubscribers.clear();
    this.middlewares = [];
    this.responseMiddlewares = [];
    this.stats = {
      eventsPublished: 0,
      eventsByType: {},
      processingTimes: [],
      errors: 0,
    };
  }
}

// ==================== INTERNAL TYPES ====================

interface EventBusStatsInternal {
  eventsPublished: number;
  eventsByType: Record<string, number>;
  processingTimes: number[];
  errors: number;
}

// ==================== SINGLETON INSTANCE ====================

let eventBusInstance: EventBus | null = null;

/**
 * Get or create the global event bus instance
 */
export function getEventBus(): EventBus {
  if (!eventBusInstance) {
    eventBusInstance = new EventBus();
  }
  return eventBusInstance;
}

/**
 * Create a new event bus instance (for testing)
 */
export function createEventBus(): EventBus {
  return new EventBus();
}

/**
 * Reset the global event bus instance (for testing)
 */
export function resetEventBus(): void {
  if (eventBusInstance) {
    eventBusInstance.clear();
  }
  eventBusInstance = null;
}
