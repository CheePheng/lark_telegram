/**
 * Worker entry point / router for the Telegram <-> Intercom Fin bridge.
 *
 *   POST /telegram/webhook   inbound Telegram messages
 *   POST /fin/webhook        inbound Fin events (fin_replied, ...)
 *   GET  /api/kyc|deposit|withdrawal   iGaming data gateway (Fin Data Connectors)
 *   GET  /verify             mock signed-login page
 *   POST /verify/complete    completes verification
 *   GET  /                   health check
 */
import type { Env } from "./env";
import { handleTelegramWebhook } from "./telegram";
import { handleFinWebhook } from "./finwebhook";
import { handleIntercomWebhook } from "./intercomwebhook";
import { handleGateway, isGatewayPath } from "./gateway";
import { handleLarkTask } from "./larktask";
import { handleVerifyPage, handleVerifyComplete } from "./identity";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/" && method === "GET") {
      return new Response("tg-fin-bridge: ok", { status: 200 });
    }
    if (pathname === "/telegram/webhook" && method === "POST") {
      return handleTelegramWebhook(request, env);
    }
    if (pathname === "/fin/webhook" && method === "POST") {
      return handleFinWebhook(request, env);
    }
    if (pathname === "/intercom/webhook" && method === "POST") {
      return handleIntercomWebhook(request, env);
    }
    if (pathname === "/api/lark-task" && method === "POST") {
      return handleLarkTask(request, env);
    }
    if (isGatewayPath(pathname)) {
      return handleGateway(request, env, url);
    }
    if (pathname === "/verify" && method === "GET") {
      return handleVerifyPage(url);
    }
    if (pathname === "/verify/complete" && method === "POST") {
      return handleVerifyComplete(request, env, ctx);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
