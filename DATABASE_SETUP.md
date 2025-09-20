# Database Setup for Telegram Bot with Image Generation

## 📋 Overview
Полная система управления базой данных для Telegram бота с генерацией изображений, поддерживающая отслеживание ежедневных лимитов и историю генераций.

## 🗃️ Database Schema

### Users Table
```sql
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,           -- Telegram user ID
  username TEXT NOT NULL,             -- Telegram username  
  daily_image_count INTEGER DEFAULT 0, -- Daily image generation count
  last_reset_date DATE DEFAULT CURRENT_DATE -- Last reset date for daily counter
);
```

### Image Generations Table
```sql
CREATE TABLE image_generations (
  id SERIAL PRIMARY KEY,              -- Auto-incrementing ID
  user_id TEXT REFERENCES users(user_id), -- Foreign key to users
  prompt TEXT NOT NULL,               -- Image generation prompt
  image_url TEXT NOT NULL,            -- Generated image URL
  created_at TIMESTAMP DEFAULT NOW()  -- Creation timestamp
);
```

## 📁 Files Created

- **`shared/schema.ts`** - Drizzle ORM schema definitions
- **`server/storage.ts`** - Database connection and helper functions  
- **`drizzle.env.ts`** - Drizzle configuration (alternative to protected config)
- **`test-db.ts`** - Database functionality test file

## 🛠️ Key Features

### Daily Limits (50 images/day)
```typescript
// Check if user has reached daily limit
const hasReached = await hasReachedDailyLimit(userId);

// Increment user's daily count
await incrementUserImageCount(userId);
```

### Automatic Daily Reset
- Счетчик автоматически сбрасывается каждые 24 часа
- Реализовано через проверку `last_reset_date` в функциях

### User Management
```typescript
// Create or update user
await upsertUser(userId, username);

// Get current daily count
const count = await getUserDailyCount(userId);
```

### Image Generation History
```typescript
// Save image generation
await saveImageGeneration(userId, prompt, imageUrl);

// Get user's history (last 20 by default)
const history = await getUserImageHistory(userId, 20);
```

## 🗂️ Database Commands

Since package.json is protected, use these commands directly:

```bash
# Push schema changes to database
npx drizzle-kit push --schema=./shared/schema.ts --dialect=postgresql --url=$DATABASE_URL

# Generate migrations
npx drizzle-kit generate --schema=./shared/schema.ts

# Open Drizzle Studio (database UI)
npx drizzle-kit studio
```

## ✅ Status
- ✅ Dependencies installed: drizzle-orm, drizzle-kit, pg, @types/pg
- ✅ Schema created with proper relations and types
- ✅ Database tables created with indexes for performance
- ✅ Helper functions implemented for all operations
- ✅ Daily limit system (50 images/day) with automatic reset
- ✅ Image generation history tracking
- ✅ TypeScript types exported for better development experience

## 🧪 Testing
Run the test file to verify everything works:
```bash
npx tsx test-db.ts
```