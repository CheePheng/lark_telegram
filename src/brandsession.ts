/**
 * Durable Object holding the per-conversation brand selection.
 *
 * Why a DO and not KV: KV is eventually consistent, so the card-tap write (one
 * webhook request) and the next message's read (a different request, often a
 * different Cloudflare edge) can race — making the brand picker re-appear after
 * the customer already chose. A Durable Object is a single strongly-consistent
 * instance per {channel,cuid}, so a tap is always visible to the next message.
 */
import type { Env } from "./env";

export class BrandSessionDO {
  private storage: DurableObjectStorage;

  constructor(state: DurableObjectState, _env: Env) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    switch (request.method) {
      case "GET": {
        const brand = (await this.storage.get<string>("brand")) ?? null;
        return new Response(JSON.stringify({ brand }), { headers: { "Content-Type": "application/json" } });
      }
      case "PUT": {
        const { brand } = (await request.json()) as { brand: string };
        await this.storage.put("brand", brand);
        return new Response("ok");
      }
      case "DELETE": {
        await this.storage.delete("brand");
        return new Response("ok");
      }
      default:
        return new Response("method not allowed", { status: 405 });
    }
  }
}
