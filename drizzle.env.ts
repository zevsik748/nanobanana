// Alternative Drizzle configuration using environment variables
export const drizzleConfig = {
  schema: './shared/schema.ts',
  out: './drizzle',
  dialect: 'postgresql' as const,
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/mastra',
  },
  verbose: true,
  strict: true,
};