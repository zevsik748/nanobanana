# Overview

This is a Telegram bot application built on the Mastra framework for AI agent orchestration. The bot specializes in AI image generation using Google Gemini 2.5 Flash Image Preview model (nicknamed "Nano Banana" internally at Google) via hubai.loe.gg API. It features a complete user management system with daily usage limits, database storage for tracking image generations, and direct Google Generative AI SDK integration for enhanced functionality.

🎯 **How to Use:**
📝 Describe what you want - get an image
🖼️ Send photo(s) + description of changes

Simply type or send photos! Supports multiple photo processing for complex image generation tasks.

# Recent Changes

**September 20, 2025** - Critical Issues Resolved:
- ✅ Fixed /start command display issues by properly escaping Markdown symbols 
- ✅ Resolved image generation failures by implementing proper MIME type detection in telegramFileResolver.ts
- ✅ Successfully debugged and fixed hubai.loe.gg API integration issues that were causing "Unsupported MIME type" errors
- ✅ Added comprehensive logging system throughout HubaiGemini generator for detailed API response tracking
- ✅ Achieved complete end-to-end functionality: images are now successfully generated and sent to Telegram users

**System Status**: Image generation system is now fully operational with successful test results.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **Telegram Bot Interface**: Primary user interaction through Telegram Bot API webhooks
- **Playground Interface**: Web-based development and testing interface via Mastra's built-in playground
- **Real-time Updates**: Server-sent events for live development feedback

## Backend Architecture
- **Mastra Core Framework**: Orchestrates AI agents, workflows, and tools with TypeScript support
- **Agent-Based Design**: Modular AI agents with specific capabilities (telegramBot for multimodal processing)
- **Workflow System**: Step-based processing using Inngest for reliable execution and error handling
- **Tool System**: Extensible tools for image generation, user stats, subscription checks, and multimodal processing with support for multiple photo inputs
- **Memory Management**: Persistent conversation context with thread support for maintaining chat history

## Data Storage Solutions
- **PostgreSQL Database**: Primary data store using Drizzle ORM for type-safe database operations
- **Schema Design**: 
  - Users table for Telegram user management and daily limits tracking
  - Image generations table for history and audit trails
  - Foreign key relationships for data integrity
- **Daily Reset Logic**: Automatic counter resets based on date comparison for usage limits

## Authentication and Authorization
- **Telegram Integration**: Bot token-based authentication with webhook verification
- **Subscription System**: Channel membership verification (@ferixdi_ai) for access control
- **Rate Limiting**: Dual limit system - 3 images/day for private chats, 30 images/day for group chats (admin unlimited)
- **User Context**: Telegram user ID and username tracking for personalization

## External Dependencies
- **Hubai.loe.gg API**: Primary access to Gemini 2.5 Flash Image Preview (Nano Banana) model via custom base URL
- **Google Generative AI SDK**: Direct integration with Google's AI models through hubai.loe.gg proxy
- **Telegram Bot API**: Core messaging platform integration with webhook support
- **Inngest**: Workflow orchestration and background job processing with retry logic
- **PostgreSQL**: Database backend with SSL support for production environments
- **Drizzle ORM**: Type-safe database operations with automatic migrations

## Key Design Patterns
- **Microservices Architecture**: Separate tools and agents for specific functionalities
- **Event-Driven Processing**: Webhook triggers initiate workflow execution chains
- **Graceful Degradation**: Fallback mechanisms for API failures and rate limits
- **Configuration Management**: Environment-based settings for different deployment stages
- **Error Handling**: Comprehensive logging and retry mechanisms for robust operation