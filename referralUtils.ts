import { db } from "../../../server/storage";
import { users, referrals } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import type { IMastraLogger } from "@mastra/core/logger";

/**
 * Generate a unique referral code for a user
 */
export function generateReferralCode(userId: string): string {
  // Create a short code based on user ID and random string
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 8);
  const userHash = userId.slice(-4); // Last 4 digits of user ID
  
  return `${userHash}${timestamp}${randomStr}`.toUpperCase();
}

/**
 * Get or create referral code for a user
 */
export async function getOrCreateReferralCode(userId: string, logger?: IMastraLogger): Promise<string> {
  logger?.info('🔗 [Referral] Getting or creating referral code', { userId });
  
  try {
    // Check if user already has a referral code
    const existing = await db
      .select({ referralCode: users.referral_code })
      .from(users)
      .where(eq(users.user_id, userId))
      .limit(1);
    
    if (existing.length > 0 && existing[0].referralCode) {
      logger?.info('🔗 [Referral] Found existing referral code', { 
        userId, 
        hasCode: true
      });
      return existing[0].referralCode;
    }
    
    // Generate new unique referral code
    let referralCode: string;
    let attempts = 0;
    const maxAttempts = 10;
    
    do {
      referralCode = generateReferralCode(userId);
      attempts++;
      
      // Check if code is unique across all users
      const codeExists = await db
        .select({ user_id: users.user_id })
        .from(users)
        .where(eq(users.referral_code, referralCode))
        .limit(1);
      
      if (codeExists.length === 0) {
        // Code is unique, save it to user profile
        await db
          .update(users)
          .set({ referral_code: referralCode })
          .where(eq(users.user_id, userId));
        
        logger?.info('🔗 [Referral] Created and saved new referral code', { 
          userId, 
          attempts,
          codeLength: referralCode.length
        });
        return referralCode;
      }
      
      logger?.warn('🔗 [Referral] Referral code collision, retrying', { 
        userId, 
        attempts,
        maxAttempts
      });
      
    } while (attempts < maxAttempts);
    
    throw new Error('Failed to generate unique referral code after maximum attempts');
    
  } catch (error) {
    logger?.error('🔗 [Referral] Error getting or creating referral code', { 
      userId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/**
 * Process referral when user starts with referral code
 */
export async function processReferral(
  referredUserId: string, 
  referralCode: string, 
  logger?: IMastraLogger
): Promise<{ success: boolean; referrerUserId?: string }> {
  logger?.info('🔗 [Referral] Processing referral', { referredUserId, referralCode: "***" });
  
  try {
    // Find the referrer by referral code in users table
    const referrer = await db
      .select({ 
        user_id: users.user_id 
      })
      .from(users)
      .where(eq(users.referral_code, referralCode))
      .limit(1);
    
    if (referrer.length === 0) {
      logger?.warn('🔗 [Referral] Invalid referral code', { referredUserId, referralCode: "***" });
      return { success: false };
    }
    
    const referrerUserId = referrer[0].user_id;
    
    // Prevent self-referral
    if (referrerUserId === referredUserId) {
      logger?.warn('🔗 [Referral] Self-referral attempt blocked', { 
        referredUserId, 
        referralCode: "***" 
      });
      return { success: false };
    }
    
    // Check if user was already referred
    const existingReferral = await db
      .select({ id: referrals.id })
      .from(referrals)
      .where(eq(referrals.referred_user_id, referredUserId))
      .limit(1);
    
    if (existingReferral.length > 0) {
      logger?.warn('🔗 [Referral] User already referred', { 
        referredUserId, 
        referralCode: "***" 
      });
      return { success: false };
    }
    
    // Create referral record
    await db.insert(referrals).values({
      referrer_user_id: referrerUserId,
      referred_user_id: referredUserId,
      referral_code: referralCode,
      created_at: new Date()
    });
    
    logger?.info('🔗 [Referral] Referral processed successfully', { 
      referredUserId, 
      referrerUserId,
      referralCode 
    });
    
    return { success: true, referrerUserId };
    
  } catch (error) {
    logger?.error('🔗 [Referral] Error processing referral', { 
      referredUserId,
      referralCode,
      error: error instanceof Error ? error.message : String(error)
    });
    return { success: false };
  }
}

/**
 * Send referral notification to admin
 */
export async function notifyAdminAboutReferral(
  referrerUserId: string,
  referredUserId: string,
  logger?: IMastraLogger
): Promise<void> {
  logger?.info('🔔 [Referral] Sending admin notification', { 
    referrerUserId, 
    referredUserId 
  });
  
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      throw new Error("TELEGRAM_BOT_TOKEN not found in environment variables");
    }
    
    // Get usernames from database for better notifications
    const referrerData = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.user_id, referrerUserId))
      .limit(1);
      
    const referredData = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.user_id, referredUserId))
      .limit(1);
    
    const referrerName = referrerData.length > 0 ? referrerData[0].username : `ID:${referrerUserId}`;
    const referredName = referredData.length > 0 ? referredData[0].username : `ID:${referredUserId}`;
    
    const adminUserId = "6913446846"; // dmitriy_ferixdi
    const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
    
    const message = `🎉 *Новый реферал!*\n\n` +
                   `👤 Пригласил: @${referrerName}\n` +
                   `🆕 Новый пользователь: @${referredName}\n\n` +
                   `📊 Система рефералов работает!`;
    
    await fetch(`${telegramApiUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminUserId,
        text: message,
        parse_mode: 'Markdown'
      })
    });
    
    logger?.info('🔔 [Referral] Admin notification sent successfully', { 
      referrerUserId, 
      referredUserId,
      referrerName,
      referredName
    });
    
  } catch (error) {
    logger?.error('🔔 [Referral] Error sending admin notification', { 
      referrerUserId,
      referredUserId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}