/**
 * /api/lark-task — Fin Action endpoint. Fin calls this from a Procedure when it
 * detects an exception; the Worker dedupes and posts a structured card to the
 * Lark ops group. Auth: Bearer GATEWAY_API_TOKEN (same as data connectors).
 * Accepts GET (query params, easiest for the Intercom connector builder) or POST (JSON body).
 */
import type { Env } from "./env";
import { safeEqual } from "./crypto";
import { isExceptionType, buildCard, postLarkCard, type LarkTaskInput } from "./lark";
import { alreadyEscalatedToLark } from "./kv";

interface RawInput {
  member_id?: string;
  brand_id?: string;
  business_ref?: string;
  exception_type?: string;
  summary?: string;
  source?: string;
  intercom_conversation_id?: string;
}

export async function handleLarkTask(request: Request, env: Env): Promise<Response> {
  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || !safeEqual(token, env.GATEWAY_API_TOKEN)) return json({ error: "unauthorized" }, 401);

  const raw = await readInput(request);
  if (!raw.member_id || !raw.business_ref || !raw.exception_type) {
    return json({ error: "member_id, business_ref, exception_type are required" }, 400);
  }
  if (!isExceptionType(raw.exception_type)) return json({ error: "unknown exception_type" }, 400);

  const input: LarkTaskInput = {
    member_id: raw.member_id,
    brand_id: raw.brand_id,
    business_ref: raw.business_ref,
    exception_type: raw.exception_type,
    summary: raw.summary,
    source: raw.source ?? "Telegram",
    intercom_conversation_id: raw.intercom_conversation_id,
  };

  if (await alreadyEscalatedToLark(env, `${input.business_ref}:${input.exception_type}`)) {
    return json({ created: false, deduplicated: true });
  }

  const result = await postLarkCard(env, buildCard(input));
  return json({ created: true, posted: result.posted, mock: result.mock });
}

async function readInput(request: Request): Promise<RawInput> {
  if (request.method === "GET") {
    const p = new URL(request.url).searchParams;
    const g = (k: string) => p.get(k) ?? undefined;
    return {
      member_id: g("member_id"),
      brand_id: g("brand_id"),
      business_ref: g("business_ref"),
      exception_type: g("exception_type"),
      summary: g("summary"),
      source: g("source"),
      intercom_conversation_id: g("intercom_conversation_id"),
    };
  }
  return ((await request.json().catch(() => null)) as RawInput | null) ?? {};
}

function json(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
}
