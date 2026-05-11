import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL ?? "./database.sqlite";
const dialect = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")
  ? "postgresql"
  : "sqlite";

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect,
  dbCredentials: {
    url: databaseUrl,
  },
});
