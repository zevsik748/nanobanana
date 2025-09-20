/**
 * Rate Limiter System for Telegram Bot
 * Implements rolling window 24-hour rate limiting with configurable storage backends
 */

import type { IMastraLogger } from "@mastra/core/logger";

export interface RateLimitResult {
  allowed: boolean;
  remainingRequests: number;
  resetTime: Date;
  totalRequests: number;
}

export interface RateLimiterStorage {
  getUserRequests(userId: string): Promise<number[]>;
  addUserRequest(userId: string, timestamp: number): Promise<void>;
  cleanupExpiredRequests(userId: string, cutoffTime: number): Promise<void>;
}

/**
 * In-memory implementation of rate limiter storage
 * Easily replaceable with PostgreSQL/Redis implementation
 */
export class InMemoryRateLimiterStorage implements RateLimiterStorage {
  private userRequests = new Map<string, number[]>();
  private logger?: IMastraLogger;

  constructor(logger?: IMastraLogger) {
    this.logger = logger;
  }

  async getUserRequests(userId: string): Promise<number[]> {
    return this.userRequests.get(userId) || [];
  }

  async addUserRequest(userId: string, timestamp: number): Promise<void> {
    const requests = await this.getUserRequests(userId);
    requests.push(timestamp);
    this.userRequests.set(userId, requests);
    
    this.logger?.debug('📊 [RateLimiter] Added request for user', { 
      userId, 
      timestamp: new Date(timestamp).toISOString(),
      totalRequests: requests.length 
    });
  }

  async cleanupExpiredRequests(userId: string, cutoffTime: number): Promise<void> {
    const requests = await this.getUserRequests(userId);
    const validRequests = requests.filter(timestamp => timestamp > cutoffTime);
    
    if (validRequests.length !== requests.length) {
      this.userRequests.set(userId, validRequests);
      this.logger?.debug('🧹 [RateLimiter] Cleaned up expired requests', {
        userId,
        before: requests.length,
        after: validRequests.length,
        removed: requests.length - validRequests.length
      });
    }
  }
}

/**
 * Rate Limiter with rolling window implementation
 * Supports 24-hour rolling window with configurable limits
 */
export class RateLimiter {
  private storage: RateLimiterStorage;
  private logger?: IMastraLogger;
  private readonly windowHours: number;
  private readonly maxRequests: number;

  constructor(
    storage: RateLimiterStorage,
    options: {
      windowHours?: number;
      maxRequests?: number;
      logger?: IMastraLogger;
    } = {}
  ) {
    this.storage = storage;
    this.windowHours = options.windowHours ?? 24;
    this.maxRequests = options.maxRequests ?? 100;
    this.logger = options.logger;

    this.logger?.info('🚦 [RateLimiter] Initialized', {
      windowHours: this.windowHours,
      maxRequests: this.maxRequests
    });
  }

  /**
   * Check if user can make a request and optionally consume a request slot
   */
  async checkLimit(userId: string, consumeRequest: boolean = false): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStartTime = now - (this.windowHours * 60 * 60 * 1000);

    this.logger?.debug('🔍 [RateLimiter] Checking limit for user', { 
      userId, 
      consumeRequest,
      windowStart: new Date(windowStartTime).toISOString()
    });

    // Clean up expired requests first
    await this.storage.cleanupExpiredRequests(userId, windowStartTime);

    // Get current valid requests
    const userRequests = await this.storage.getUserRequests(userId);
    const validRequests = userRequests.filter(timestamp => timestamp > windowStartTime);

    const currentCount = validRequests.length;
    const allowed = currentCount < this.maxRequests;
    const remainingRequests = Math.max(0, this.maxRequests - currentCount);

    // Calculate reset time (24 hours from the oldest request, or now if no requests)
    const oldestRequestTime = validRequests.length > 0 ? Math.min(...validRequests) : now;
    const resetTime = new Date(oldestRequestTime + (this.windowHours * 60 * 60 * 1000));

    const result: RateLimitResult = {
      allowed,
      remainingRequests,
      resetTime,
      totalRequests: currentCount
    };

    this.logger?.info('📊 [RateLimiter] Rate limit check result', {
      userId,
      ...result,
      resetTime: result.resetTime.toISOString()
    });

    // If request is allowed and we should consume it, add it to storage
    if (allowed && consumeRequest) {
      await this.storage.addUserRequest(userId, now);
      result.remainingRequests = Math.max(0, remainingRequests - 1);
      result.totalRequests = currentCount + 1;
      
      this.logger?.info('✅ [RateLimiter] Request consumed', {
        userId,
        newTotal: result.totalRequests,
        remaining: result.remainingRequests
      });
    }

    return result;
  }

  /**
   * Get current usage statistics for a user
   */
  async getUsageStats(userId: string): Promise<{
    totalRequests: number;
    remainingRequests: number;
    resetTime: Date;
    windowHours: number;
    maxRequests: number;
  }> {
    const result = await this.checkLimit(userId, false);
    return {
      totalRequests: result.totalRequests,
      remainingRequests: result.remainingRequests,
      resetTime: result.resetTime,
      windowHours: this.windowHours,
      maxRequests: this.maxRequests
    };
  }
}

/**
 * Global rate limiter instance using in-memory storage
 * Can be easily replaced with database-backed storage in the future
 */
let globalRateLimiter: RateLimiter | null = null;

export function getRateLimiter(logger?: IMastraLogger): RateLimiter {
  if (!globalRateLimiter) {
    const storage = new InMemoryRateLimiterStorage(logger);
    globalRateLimiter = new RateLimiter(storage, {
      windowHours: 24,
      maxRequests: 100,
      logger
    });
  }
  return globalRateLimiter;
}

/**
 * Content moderation function placeholder
 * No-op implementation for future use
 */
export async function moderateContent(
  content: {
    text?: string;
    imageUrls?: string[];
    userId: string;
    chatId: string;
  },
  logger?: IMastraLogger
): Promise<{
  allowed: boolean;
  reason?: string;
  flaggedContent?: string[];
}> {
  logger?.debug('🛡️ [ContentModeration] Processing content', {
    userId: content.userId,
    chatId: content.chatId,
    hasText: !!content.text,
    imageCount: content.imageUrls?.length || 0
  });

  // No-op implementation - always allow content
  // In the future, this will integrate with content moderation APIs
  // such as OpenAI Moderation API, Google Cloud AI, or custom models
  
  return {
    allowed: true
  };
}

/**
 * Exponential backoff utility for API retries
 */
export class ExponentialBackoff {
  private maxRetries: number;
  private baseDelay: number;
  private maxDelay: number;
  private logger?: IMastraLogger;

  constructor(options: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    logger?: IMastraLogger;
  } = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelay = options.baseDelay ?? 1000; // 1 second
    this.maxDelay = options.maxDelay ?? 10000; // 10 seconds
    this.logger = options.logger;
  }

  /**
   * Execute function with exponential backoff retry logic
   */
  async execute<T>(
    operation: () => Promise<T>,
    isRetriableError: (error: any) => boolean = () => true
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        this.logger?.debug('🔄 [ExponentialBackoff] Executing operation', { 
          attempt: attempt + 1,
          maxRetries: this.maxRetries + 1
        });

        const result = await operation();
        
        if (attempt > 0) {
          this.logger?.info('✅ [ExponentialBackoff] Operation succeeded after retries', { 
            successfulAttempt: attempt + 1 
          });
        }
        
        return result;
      } catch (error) {
        lastError = error;
        
        this.logger?.warn('⚠️ [ExponentialBackoff] Operation failed', {
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
          isRetriable: isRetriableError(error)
        });

        // If this is the last attempt or error is not retriable, throw
        if (attempt === this.maxRetries || !isRetriableError(error)) {
          this.logger?.error('❌ [ExponentialBackoff] All attempts exhausted', {
            totalAttempts: attempt + 1,
            finalError: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }

        // Calculate delay for next attempt
        const delay = Math.min(
          this.baseDelay * Math.pow(2, attempt),
          this.maxDelay
        );

        this.logger?.info('⏰ [ExponentialBackoff] Waiting before retry', { 
          delay: `${delay}ms`,
          nextAttempt: attempt + 2
        });

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}