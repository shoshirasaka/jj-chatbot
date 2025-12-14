import { Redis } from "@upstash/redis";

// Vercel KV(Upstash) が自動で作る env を使う
const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;

// build時に落とさないため null にしておく
export const redis = url && token ? new Redis({ url, token }) : null;

export function requireRedis() {
  if (!redis) {
    throw new Error("Upstash env vars are missing: set KV_REST_API_URL and KV_REST_API_TOKEN");
  }
  return redis;
}