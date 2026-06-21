/**
 * POST /api/lark-task — Fin Action endpoint. Fin calls this from a Procedure
 * when it detects an exception; the Worker dedupes and posts a structured card
 * to the Lark ops group. Auth: Bearer GATEWAY_API_TOKEN (same as data connectors).
 */
import type { Env } from "./env";
import { safeEqual } from "./crypto";
import { isExceptionType, buildCard, postLarkCard, type LarkTaskInput } from "./lark";
import { alreadyEscalatedToLark } from "./kv";

export async function handleLarkTask(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || !safeEqual(token, env.GATEWAY_API_TOKEN)) return json({ error: "unauthorized" }, 401);

  const body = (await request.json().catch(() => null)) as Partial<LarkTaskInput> | null;
  if (!body?.member_id || !body?.business_ref || !body?.exception_type) {
    return json({ error: "member_id, business_ref, exception_type are required" }, 400);
  }
  if (!isExceptionType(body.exception_type)) return json({ error: "unknown exception_type" }, 400);

  const input: LarkTaskInput = {
    member_id: body.member_id,
    brand_id: body.brand_id,
    business_ref: body.business_ref,
    exception_type: body.exception_type,
    summary: body.summary,
    source: body.source ?? "Telegram",
    intercom_conversation_id: body.intercom_conversation_id,
  };

  if (await alreadyEscalatedToLark(env, `${input.business_ref}:${input.exception_type}`)) {
    return json({ created: false, deduplicated: true });
  }

  const result = await postLarkCard(env, buildCard(input));
  return json({ created: true, posted: result.posted, mock: result.mock });
}

function json(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
}
