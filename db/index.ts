import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getD1Database() {
  if (!env.DB) {
    throw new Error(
      "Local company-profile database `DB` is unavailable. Start the app through its normal local development command so the D1 binding is created."
    );
  }

  return env.DB;
}

export function getDb() {
  return drizzle(getD1Database(), { schema });
}
