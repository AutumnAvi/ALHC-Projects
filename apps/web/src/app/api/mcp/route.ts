// AI builder round 5 (experimental, note 178): the MCP endpoint (Model Context Protocol, Streamable HTTP,
// stateless). Claude Desktop, Cursor, or any MCP client connects with a personal access token (Settings → AI
// & MCP) and gets the same capability registry as the in-app assistant: read tools answer at once; write
// tools (a token with the "write" scope) are checked against the person's role exactly as by hand, written
// through the typed API as that person, and logged as runs with Undo in the app (/ai-builder). A
// destructive change, or one that messages people, is only previewed until the call says confirm: true.
//
// Only the bearer token counts — never cookies, so the preview's auto-login session can't use this. Only
// workspace admins of the Testing data pilot have tokens, and every tool stays inside that workspace. No
// token, prompt, or tool result is logged.
//   POST /api/mcp   Authorization: Bearer alhc_pat_…   (JSON-RPC: initialize, tools/list, tools/call)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mcpCallTool, mcpListTools } from "@alhc/core/api/mcp/tools";
import { isApiError } from "@alhc/core/api/core/errors";
import { authenticateMcp } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const NO_STORE = { "Cache-Control": "private, no-store" };

function denied(status: number, error: string) {
  return Response.json(
    { jsonrpc: "2.0", error: { code: status === 429 ? -32029 : -32001, message: error }, id: null },
    { status, headers: { ...NO_STORE, ...(status === 401 ? { "WWW-Authenticate": 'Bearer realm="alhc-mcp", error="invalid_token"' } : {}) } },
  );
}

async function handle(request: Request): Promise<Response> {
  const auth = await authenticateMcp(request.headers.get("authorization"));
  if (!auth.ok) return denied(auth.status, auth.error);
  const { ctx, identity } = auth;

  const server = new Server({ name: "alhc-projects", version: "0.5.0" }, { capabilities: { tools: {} }, instructions: "ALHC Projects (Testing data pilot). Tools act as you, with your project roles. Look things up with search_* / get_* first; ids from their results name things in other tools." });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpListTools(identity) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await mcpCallTool(ctx, identity, req.params.name, req.params.arguments ?? {});
      return result.ok
        ? { content: [{ type: "text" as const, text: JSON.stringify(result.data) }] }
        : { content: [{ type: "text" as const, text: result.error }], isError: true };
    } catch (error) {
      return { content: [{ type: "text" as const, text: isApiError(error) ? error.message : "Something went wrong" }], isError: true };
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    return new Response(response.body, { status: response.status, headers });
  } finally {
    void server.close().catch(() => undefined);
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
