import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { ProviderID, ModelID } from "@/provider/schema"
import { ToolRegistry } from "@/tool"
import { Worktree } from "@/worktree"
import { Instance } from "@/project/instance"
import { Project } from "@/project"
import { MCP } from "@/mcp"
import { Session } from "@/session"
import { Config } from "@/config"
import { ConsoleState } from "@/config/console-state"
import { Account } from "@/account/account"
import { AccountID, OrgID } from "@/account/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { Effect, Option } from "effect"
import { Agent } from "@/agent/agent"
import { jsonRequest, runRequest } from "./trace"
import { MessageID, SessionID } from "@/session/schema"
import { Effect as EffectCore } from "effect"
import { SessionShare } from "@/share"
import { SessionPrompt } from "@/session/prompt"
import { Bus } from "@/bus"
import { NamedError } from "@opencode-ai/shared/util/error"

const ConsoleOrgOption = z.object({
  accountID: z.string(),
  accountEmail: z.string(),
  accountUrl: z.string(),
  orgID: z.string(),
  orgName: z.string(),
  active: z.boolean(),
})

const ConsoleOrgList = z.object({
  orgs: z.array(ConsoleOrgOption),
})

const ConsoleSwitchBody = z.object({
  accountID: z.string(),
  orgID: z.string(),
})

// --- Stream A thin-server schemas (2026-04-20) ---------------------------
// See cutter-core/docs/stream-a-opencode-gap.md for the full rationale.
// These routes let callers (cutter-core _think, the operational dashboard)
// invoke tools / spawn tasks / call MCP servers without triggering OpenCode's
// own agent loop. Stubs only in this commit � implementations follow.

const ToolExecuteInput = z.object({
  tool: z.string().meta({
    description: "Tool name to execute (e.g. bash, read, edit, ha.ha_get_state).",
  }),
  args: z.record(z.string(), z.any()).meta({
    description: "Tool-specific arguments.",
  }),
  sessionID: z.string().meta({
    description:
      "Existing session ID for Context construction. Caller manages session lifecycle (create via POST /session, reuse across calls for audit trail).",
  }),
  agent: z.string().meta({
    description: "Agent name for tool filtering and permission scope (e.g. writer, explorer).",
  }),
  providerID: ProviderID.zod,
  modelID: ModelID.zod,
  correlation_id: z.string().optional().meta({
    description:
      "Caller-side ID for tying log lines and bus events to this invocation.",
  }),
})

const ToolResult = z
  .object({
    ok: z.boolean(),
    output: z.string(),
    structured: z.any().optional(),
    error: z.string().optional(),
    duration_ms: z.number().optional(),
  })
  .meta({ ref: "ToolResult" })

const TaskSpawnInput = z.object({
  description: z.string().meta({
    description: "Short description of what the task does.",
  }),
  prompt: z.string().meta({
    description: "Prompt to give the child agent.",
  }),
  subagent_type: z.string().optional().meta({
    description:
      "Agent YAML name to use (e.g. explorer, implementer). Defaults to parent agent config.",
  }),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional()
    .meta({ description: "Override the model used by the spawned child." }),
  correlation_id: z.string().optional(),
})

const TaskHandle = z
  .object({
    task_id: z.string(),
    session_id: z.string().optional(),
    spawned_at: z.number().optional(),
  })
  .meta({ ref: "TaskHandle" })

const McpInvokeInput = z.object({
  server: z.string().meta({
    description: "MCP server name as registered in opencode.json.",
  }),
  method: z.string().meta({
    description: "Method on the MCP server to invoke.",
  }),
  params: z.record(z.string(), z.any()),
  correlation_id: z.string().optional().meta({
    description: "Caller-side ID for tying log lines to this invocation.",
  }),
})

// Stub response for routes that are registered but not yet implemented.
// Used by the three thin-server routes below until their handlers land.
const NotImplementedResponse = {
  501: {
    description: "Route stub � implementation pending.",
    content: {
      "application/json": {
        schema: resolver(z.object({ error: z.string() })),
      },
    },
  },
} as const

export const ExperimentalRoutes = lazy(() =>
  new Hono()
    .get(
      "/console",
      describeRoute({
        summary: "Get active Console provider metadata",
        description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
        operationId: "experimental.console.get",
        responses: {
          200: {
            description: "Active Console provider metadata",
            content: {
              "application/json": {
                schema: resolver(ConsoleState.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.console.get", c, function* () {
          const config = yield* Config.Service
          const account = yield* Account.Service
          const [state, groups] = yield* Effect.all([config.getConsoleState(), account.orgsByAccount()], {
            concurrency: "unbounded",
          })
          return {
            ...state,
            switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
          }
        }),
    )
    .get(
      "/console/orgs",
      describeRoute({
        summary: "List switchable Console orgs",
        description: "Get the available Console orgs across logged-in accounts, including the current active org.",
        operationId: "experimental.console.listOrgs",
        responses: {
          200: {
            description: "Switchable Console orgs",
            content: {
              "application/json": {
                schema: resolver(ConsoleOrgList),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.console.listOrgs", c, function* () {
          const account = yield* Account.Service
          const [groups, active] = yield* Effect.all([account.orgsByAccount(), account.active()], {
            concurrency: "unbounded",
          })
          const info = Option.getOrUndefined(active)
          const orgs = groups.flatMap((group) =>
            group.orgs.map((org) => ({
              accountID: group.account.id,
              accountEmail: group.account.email,
              accountUrl: group.account.url,
              orgID: org.id,
              orgName: org.name,
              active: !!info && info.id === group.account.id && info.active_org_id === org.id,
            })),
          )
          return { orgs }
        }),
    )
    .post(
      "/console/switch",
      describeRoute({
        summary: "Switch active Console org",
        description: "Persist a new active Console account/org selection for the current local OpenCode state.",
        operationId: "experimental.console.switchOrg",
        responses: {
          200: {
            description: "Switch success",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("json", ConsoleSwitchBody),
      async (c) =>
        jsonRequest("ExperimentalRoutes.console.switchOrg", c, function* () {
          const body = c.req.valid("json")
          const account = yield* Account.Service
          yield* account.use(AccountID.make(body.accountID), Option.some(OrgID.make(body.orgID)))
          return true
        }),
    )
    .get(
      "/tool/ids",
      describeRoute({
        summary: "List tool IDs",
        description:
          "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
        operationId: "tool.ids",
        responses: {
          200: {
            description: "Tool IDs",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string()).meta({ ref: "ToolIDs" })),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.tool.ids", c, function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.ids()
        }),
    )
    .get(
      "/tool",
      describeRoute({
        summary: "List tools",
        description:
          "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
        operationId: "tool.list",
        responses: {
          200: {
            description: "Tools",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .array(
                      z
                        .object({
                          id: z.string(),
                          description: z.string(),
                          parameters: z.any(),
                        })
                        .meta({ ref: "ToolListItem" }),
                    )
                    .meta({ ref: "ToolList" }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          provider: z.string(),
          model: z.string(),
        }),
      ),
      async (c) => {
        const { provider, model } = c.req.valid("query")
        const tools = await runRequest(
          "ExperimentalRoutes.tool.list",
          c,
          Effect.gen(function* () {
            const agents = yield* Agent.Service
            const registry = yield* ToolRegistry.Service
            return yield* registry.tools({
              providerID: ProviderID.make(provider),
              modelID: ModelID.make(model),
              agent: yield* agents.get(yield* agents.defaultAgent()),
            })
          }),
        )
        return c.json(
          tools.map((t) => ({
            id: t.id,
            description: t.description,
            parameters: z.toJSONSchema(t.parameters),
          })),
        )
      },
    )
    .post(
      "/worktree",
      describeRoute({
        summary: "Create worktree",
        description: "Create a new git worktree for the current project and run any configured startup scripts.",
        operationId: "worktree.create",
        responses: {
          200: {
            description: "Worktree created",
            content: {
              "application/json": {
                schema: resolver(Worktree.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.CreateInput.optional()),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.create", c, function* () {
          const body = c.req.valid("json")
          const svc = yield* Worktree.Service
          return yield* svc.create(body)
        }),
    )
    .get(
      "/worktree",
      describeRoute({
        summary: "List worktrees",
        description: "List all sandbox worktrees for the current project.",
        operationId: "worktree.list",
        responses: {
          200: {
            description: "List of worktree directories",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string())),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.list", c, function* () {
          const svc = yield* Project.Service
          return yield* svc.sandboxes(Instance.project.id)
        }),
    )
    .delete(
      "/worktree",
      describeRoute({
        summary: "Remove worktree",
        description: "Remove a git worktree and delete its branch.",
        operationId: "worktree.remove",
        responses: {
          200: {
            description: "Worktree removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.RemoveInput),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.remove", c, function* () {
          const body = c.req.valid("json")
          const worktree = yield* Worktree.Service
          const project = yield* Project.Service
          yield* worktree.remove(body)
          yield* project.removeSandbox(Instance.project.id, body.directory)
          return true
        }),
    )
    .post(
      "/worktree/reset",
      describeRoute({
        summary: "Reset worktree",
        description: "Reset a worktree branch to the primary default branch.",
        operationId: "worktree.reset",
        responses: {
          200: {
            description: "Worktree reset",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.ResetInput),
      async (c) =>
        jsonRequest("ExperimentalRoutes.worktree.reset", c, function* () {
          const body = c.req.valid("json")
          const svc = yield* Worktree.Service
          yield* svc.reset(body)
          return true
        }),
    )
    .get(
      "/session",
      describeRoute({
        summary: "List sessions",
        description:
          "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
        operationId: "experimental.session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.GlobalInfo.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
          roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: z.coerce
            .number()
            .optional()
            .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
          cursor: z.coerce
            .number()
            .optional()
            .meta({ description: "Return sessions updated before this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
          archived: z.coerce.boolean().optional().meta({ description: "Include archived sessions (default false)" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const limit = query.limit ?? 100
        const sessions: Session.GlobalInfo[] = []
        for await (const session of Session.listGlobal({
          directory: query.directory,
          roots: query.roots,
          start: query.start,
          cursor: query.cursor,
          search: query.search,
          limit: limit + 1,
          archived: query.archived,
        })) {
          sessions.push(session)
        }
        const hasMore = sessions.length > limit
        const list = hasMore ? sessions.slice(0, limit) : sessions
        if (hasMore && list.length > 0) {
          c.header("x-next-cursor", String(list[list.length - 1].time.updated))
        }
        return c.json(list)
      },
    )
    .get(
      "/resource",
      describeRoute({
        summary: "Get MCP resources",
        description: "Get all available MCP resources from connected servers. Optionally filter by name.",
        operationId: "experimental.resource.list",
        responses: {
          200: {
            description: "MCP resources",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Resource)),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ExperimentalRoutes.resource.list", c, function* () {
          const mcp = yield* MCP.Service
          return yield* mcp.resources()
        }),
    )
    // --- Stream A thin-server routes (2026-04-20) ------------------------
    // Stubs returning 501. Implementations follow in subsequent commits.
    // Gap analysis: cutter-core/docs/stream-a-opencode-gap.md.
    .post(
      "/tool/execute",
      describeRoute({
        summary: "Execute a tool (thin-server)",
        description:
          "Run a named tool with args, bypassing the agent loop. For callers that have already decided what tool to run (cutter-core _think, operational dashboards). Returns 501 until implementation lands.",
        operationId: "experimental.tool.execute",
        responses: {
          200: {
            description: "Tool result",
            content: {
              "application/json": { schema: resolver(ToolResult) },
            },
          },
          ...NotImplementedResponse,
          ...errors(400),
        },
      }),
      validator("json", ToolExecuteInput),
      async (c) =>
        jsonRequest("ExperimentalRoutes.tool.execute", c, function* () {
          const body = c.req.valid("json")
          const start = Date.now()

          // Validate the session exists � cheap check that the caller is
          // managing session lifecycle. Tools use sessionID in their Context
          // for message allocation and bus correlation.
          const sessions = yield* Session.Service
          yield* sessions.get(SessionID.make(body.sessionID))

          // Resolve the agent + tool set for this provider/model. ToolRegistry
          // filters tools per (provider, model, agent) � we honour that here.
          const agents = yield* Agent.Service
          const agentInfo = yield* agents.get(body.agent)
          const registry = yield* ToolRegistry.Service
          const tools = yield* registry.tools({
            providerID: ProviderID.make(body.providerID),
            modelID: ModelID.make(body.modelID),
            agent: agentInfo,
          })

          const def = tools.find((t) => t.id === body.tool)
          if (!def) {
            return {
              ok: false,
              output: "",
              error: `unknown tool '${body.tool}' for agent '${body.agent}' on ${body.providerID}/${body.modelID}`,
              duration_ms: Date.now() - start,
            }
          }

          // Validate args against the tool's zod schema. The tool itself
          // would also validate, but giving an explicit error here avoids
          // downstream tools surfacing cryptic zod errors as strings.
          const parsed = def.parameters.safeParse(body.args)
          if (!parsed.success) {
            return {
              ok: false,
              output: "",
              error: `args failed validation: ${parsed.error.message}`,
              duration_ms: Date.now() - start,
            }
          }

          // Construct minimal Context. First-pass MVP:
          // - metadata is no-op (nothing stores per-tool metadata on this path yet)
          // - ask rejects every permission request (destructive tools won't run
          //   via this route until a bus-routing implementation lands)
          // - abort signal is a fresh unused one
          const abort = new AbortController()
          const messageID = MessageID.ascending()
          const ctx = {
            sessionID: SessionID.make(body.sessionID),
            messageID,
            agent: body.agent,
            abort: abort.signal,
            callID: body.correlation_id,
            messages: [],
            metadata: () => EffectCore.void,
            ask: () =>
              EffectCore.fail(
                new Error(
                  "permission asks are not yet routed on /experimental/tool/execute � destructive tools cannot run via this path",
                ) as never,
              ),
          } as any

          try {
            const result = yield* def.execute(parsed.data, ctx)
            return {
              ok: true,
              output: result.output,
              structured: result.metadata ?? undefined,
              duration_ms: Date.now() - start,
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
              ok: false,
              output: "",
              error: msg,
              duration_ms: Date.now() - start,
            }
          }
        }),
    )
    .post(
      "/task/spawn",
      describeRoute({
        summary: "Spawn a sub-agent task (thin-server)",
        description:
          "Create a sub-agent session and submit a prompt. Returns a handle the caller follows via the event bus. For parent-side orchestration where cutter-core spawns parallel children. Returns 501 until implementation lands.",
        operationId: "experimental.task.spawn",
        responses: {
          200: {
            description: "Task handle",
            content: {
              "application/json": { schema: resolver(TaskHandle) },
            },
          },
          ...NotImplementedResponse,
          ...errors(400),
        },
      }),
      validator("json", TaskSpawnInput),
      async (c) =>
        jsonRequest("ExperimentalRoutes.task.spawn", c, function* () {
          const body = c.req.valid("json")
          const spawned_at = Date.now()

          // Create the child session. title is the description so the
          // session list surface ("what's running") shows meaningful labels.
          const share = yield* SessionShare.Service
          const session = yield* share.create({ title: body.description })

          // Fire the prompt fire-and-forget, same pattern as
          // /session/:id/prompt_async (session.ts:892). Callers follow the
          // child's progress by subscribing to /event filtered by sessionID,
          // and read the final output from the session's messages when
          // message.updated fires with time.completed set.
          const promptParts: Array<{ type: "text"; text: string }> = [
            { type: "text", text: body.prompt },
          ]
          const sessionID = session.id
          void runRequest(
            "ExperimentalRoutes.task.spawn.prompt",
            c,
            SessionPrompt.Service.use((svc) =>
              svc.prompt({
                sessionID,
                agent: body.subagent_type,
                model: body.model,
                parts: promptParts,
              }),
            ),
          ).catch((err) => {
            // Surface child-session failures onto the bus so followers see them.
            void Bus.publish(Session.Event.Error, {
              sessionID,
              error: new NamedError.Unknown({
                message: err instanceof Error ? err.message : String(err),
              }).toObject(),
            })
          })

          return {
            task_id: sessionID,
            session_id: sessionID,
            spawned_at,
          }
        }),
    )
    .post(
      "/mcp/invoke",
      describeRoute({
        summary: "Invoke an MCP server method directly (thin-server)",
        description:
          "Call a named method on a registered MCP server without wrapping in the agent loop. For cutter-core memory and side-channel reaches. Returns 501 until implementation lands.",
        operationId: "experimental.mcp.invoke",
        responses: {
          200: {
            description: "MCP result",
            content: {
              "application/json": { schema: resolver(ToolResult) },
            },
          },
          ...NotImplementedResponse,
          ...errors(400),
        },
      }),
      validator("json", McpInvokeInput),
      async (c) =>
        jsonRequest("ExperimentalRoutes.mcp.invoke", c, function* () {
          const body = c.req.valid("json")
          const start = Date.now()

          // MCP tools are keyed in tools() as sanitize(server) + "_" + sanitize(method).
          // sanitize matches packages/opencode/src/mcp/index.ts:130.
          const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

          const mcp = yield* MCP.Service
          const tools = yield* mcp.tools()
          const key = sanitize(body.server) + "_" + sanitize(body.method)
          const tool = tools[key]
          if (!tool) {
            return {
              ok: false,
              output: "",
              error: `unknown MCP tool '${body.server}.${body.method}' (key='${key}'). Available: ${Object.keys(tools).slice(0, 10).join(", ")}${Object.keys(tools).length > 10 ? " ..." : ""}`,
              duration_ms: Date.now() - start,
            }
          }

          // MCP tools are ai-sdk dynamicTool instances — plain async execute(args).
          // No opencode Context needed; MCP server validates args against its own
          // JSON Schema at the other end. If params are wrong, the server returns
          // an error which we surface as ok=false.
          const execute = (tool as any).execute as
            | ((args: unknown) => Promise<unknown>)
            | undefined
          if (!execute) {
            return {
              ok: false,
              output: "",
              error: `MCP tool '${body.server}.${body.method}' has no execute handler`,
              duration_ms: Date.now() - start,
            }
          }

          try {
            const result = yield* EffectCore.promise(() => execute(body.params))
            // Normalise MCP result to the ToolResult shape. Content-block format
            // (an array of {text, ...} blocks) is the standard MCP response;
            // collapse to a single string for output, preserve structured for
            // dashboard-side parsing.
            const r = result as any
            const outputText =
              typeof r === "string"
                ? r
                : Array.isArray(r?.content)
                  ? r.content
                      .map((b: any) => (typeof b?.text === "string" ? b.text : JSON.stringify(b)))
                      .join("\n")
                  : JSON.stringify(r)
            return {
              ok: true,
              output: outputText,
              structured: typeof r === "object" ? r : undefined,
              duration_ms: Date.now() - start,
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
              ok: false,
              output: "",
              error: msg,
              duration_ms: Date.now() - start,
            }
          }
        }),
    ),
)
