import { PostgresStore } from "@mastra/pg";

// Create a single shared PostgreSQL storage instance
export const sharedPostgresStorage = new PostgresStore({
  connectionString:
    process.env.DATABASE_URL || "postgresql://localhost:5432/mastra",
});
