import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";

export const subscriptionCheckTool = createTool({
  id: "subscription-check-tool",
  description: "Check if a Telegram user is subscribed to the @ferixdi_ai channel using Telegram Bot API. Returns subscription status for access control.",
  inputSchema: z.object({
    user_id: z.string().describe("Telegram user ID to check subscription status for"),
  }),
  outputSchema: z.object({
    is_subscribed: z.boolean().describe("Whether the user is subscribed to the channel"),
    status: z.string().describe("User's membership status (member, administrator, creator, left, kicked, or restricted)"),
    message: z.string().describe("Human-readable message about subscription status"),
    channel: z.string().describe("Channel username that was checked"),
  }),
  execute: async ({ context: { user_id }, mastra }) => {
    const logger = mastra?.getLogger();
    const channelUsername = "@ferixdi_ai";
    
    logger?.info('🔧 [SubscriptionCheckTool] Checking subscription status', { 
      user_id,
      channel: channelUsername
    });

    try {
      // Check if Telegram bot token is available
      if (!process.env.TELEGRAM_BOT_TOKEN) {
        logger?.error('❌ [SubscriptionCheckTool] TELEGRAM_BOT_TOKEN not found in environment');
        return {
          is_subscribed: false,
          status: "unknown",
          message: "❌ Не удалось проверить подписку. Сервис временно недоступен.",
          channel: channelUsername
        };
      }

      logger?.info('📝 [SubscriptionCheckTool] Making API request to Telegram');

      // Make API request to check user's membership in the channel
      const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
      const response = await fetch(`${telegramApiUrl}/getChatMember`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: channelUsername,
          user_id: parseInt(user_id),
        }),
      });

      const result = await response.json();

      logger?.info('📝 [SubscriptionCheckTool] Received API response', { 
        ok: result.ok,
        status: result.result?.status,
        error_code: result.error_code,
        description: result.description
      });

      if (!result.ok) {
        logger?.warn('⚠️ [SubscriptionCheckTool] API request failed', { 
          error_code: result.error_code,
          description: result.description
        });

        // Handle specific error cases
        if (result.error_code === 400 && result.description?.includes('user not found')) {
          return {
            is_subscribed: false,
            status: "not_found",
            message: "❌ Пользователь не найден в канале.",
            channel: channelUsername
          };
        }

        if (result.error_code === 400 && result.description?.includes('chat not found')) {
          return {
            is_subscribed: false,
            status: "channel_not_found",
            message: "❌ Канал не найден. Проверьте настройки.",
            channel: channelUsername
          };
        }

        return {
          is_subscribed: false,
          status: "error",
          message: "❌ Не удалось проверить подписку. Попробуйте позже.",
          channel: channelUsername
        };
      }

      const memberStatus = result.result?.status;
      logger?.info('📝 [SubscriptionCheckTool] User membership status', { 
        user_id,
        status: memberStatus 
      });

      // Check if user is subscribed (member, administrator, or creator)
      const subscribedStatuses = ['member', 'administrator', 'creator'];
      const isSubscribed = subscribedStatuses.includes(memberStatus);

      let message = "";
      switch (memberStatus) {
        case 'member':
          message = "✅ Пользователь подписан на канал.";
          break;
        case 'administrator':
          message = "✅ Пользователь является администратором канала.";
          break;
        case 'creator':
          message = "✅ Пользователь является создателем канала.";
          break;
        case 'left':
          message = "❌ Пользователь покинул канал. Подпишитесь на @ferixdi_ai для доступа.";
          break;
        case 'kicked':
          message = "🚫 Пользователь заблокирован в канале.";
          break;
        case 'restricted':
          message = "⚠️ Пользователь ограничен в канале.";
          break;
        default:
          message = "❓ Неизвестный статус подписки.";
      }

      logger?.info('✅ [SubscriptionCheckTool] Subscription check completed', {
        user_id,
        is_subscribed: isSubscribed,
        status: memberStatus,
        channel: channelUsername
      });

      return {
        is_subscribed: isSubscribed,
        status: memberStatus,
        message: message,
        channel: channelUsername
      };

    } catch (error) {
      logger?.error('❌ [SubscriptionCheckTool] Error during subscription check', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        user_id,
        channel: channelUsername
      });

      return {
        is_subscribed: false,
        status: "error",
        message: "❌ Произошла ошибка при проверке подписки. Попробуйте позже.",
        channel: channelUsername
      };
    }
  },
});