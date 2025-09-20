import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";

export const telegramResponseTool = createTool({
  id: "telegram-response",
  description: "Send a response message back to a Telegram chat",
  inputSchema: z.object({
    chatId: z.string().describe("Telegram chat ID where to send the message"),
    message: z.string().describe("Message text to send to the user"),
    replyToMessageId: z.string().optional().describe("Message ID to reply to (optional)"),
  }),
  outputSchema: z.object({
    success: z.boolean().describe("Whether the message was sent successfully"),
    messageId: z.string().optional().describe("ID of the sent message if successful"),
    error: z.string().optional().describe("Error message if sending failed"),
  }),
  execute: async ({ context: { chatId, message, replyToMessageId }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔧 [TelegramResponseTool] Starting execution', { 
      chatId, 
      messageLength: message.length,
      replyToMessageId 
    });

    try {
      if (!process.env.TELEGRAM_BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN not found in environment variables");
      }

      const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
      
      logger?.info('📝 [TelegramResponseTool] Sending message to Telegram API');

      // Prepare the request payload
      const payload: any = {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML', // Support basic HTML formatting
      };

      if (replyToMessageId) {
        payload.reply_parameters = {
          message_id: parseInt(replyToMessageId)
        };
      }

      // Send message via Telegram Bot API
      const response = await fetch(`${telegramApiUrl}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(`Telegram API error: ${result.description || 'Unknown error'}`);
      }

      logger?.info('✅ [TelegramResponseTool] Message sent successfully', { 
        messageId: result.result?.message_id,
        chatId 
      });

      return {
        success: true,
        messageId: result.result?.message_id?.toString(),
      };

    } catch (error) {
      logger?.error('❌ [TelegramResponseTool] Error sending message', { 
        error: error instanceof Error ? error.message : String(error),
        chatId
      });
      
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred"
      };
    }
  },
});