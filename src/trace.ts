import { propagateAttributes, startObservation, type LangfuseObservation } from "@langfuse/tracing";

import type { Config } from "./config.js";
import { buildTurns } from "./parse.js";
import { loadState, readAllRows, readNewRows, saveState } from "./state.js";
import { discoverSubagents, type SubagentIndex, type SubagentInfo } from "./subagents.js";
import type { AssistantStep, ToolCall, Turn } from "./types.js";
import { debugLog, makeClip, toText, type Clip } from "./utils.js";

/** A Date is required to backdate a span; fall back to `undefined` (= now). */
function asDate(ts: number | undefined): Date | undefined {
  return ts !== undefined ? new Date(ts) : undefined;
}

/** Shared state threaded through the recursive emit functions. */
type EmitCtx = {
  clip: Clip;
  subagents: SubagentIndex;
  /** Subagent transcript files already expanded — guards against cycles. */
  visited: Set<string>;
};

function buildGenerationOutput(
  step: AssistantStep,
  clip: Clip,
): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = { role: "assistant" };
  if (step.text) output.content = clip(step.text);
  if (step.toolCalls.length > 0) {
    output.tool_calls = step.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      input: clip(tc.input),
    }));
  }
  // Only "role" present → nothing meaningful to show.
  return Object.keys(output).length > 1 ? output : undefined;
}

/**
 * Emit a sequence of assistant steps (one generation each, with nested tool
 * observations) under `parent`. Returns the timestamp the last step ended, so
 * the caller can close the parent observation cleanly.
 */
async function emitSteps(
  parent: LangfuseObservation,
  steps: AssistantStep[],
  firstInput: unknown,
  startTs: number | undefined,
  ctx: EmitCtx,
): Promise<number | undefined> {
  // The moment the next generation could have started: the parent's start
  // (user message / subagent prompt), or when the previous tool batch returned.
  let prevTs = startTs;
  let prevToolResults: Array<Record<string, unknown>> | undefined;

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    const input =
      idx === 0
        ? firstInput
        : prevToolResults
          ? { role: "tool", tool_results: prevToolResults }
          : undefined;

    const generation = startObservation(
      "Claude Generation",
      {
        input,
        output: buildGenerationOutput(step, ctx.clip),
        model: step.model,
        usageDetails: step.usage,
        metadata: { "claude.step_index": idx, "claude.tool_count": step.toolCalls.length },
      },
      {
        asType: "generation",
        startTime: asDate(prevTs ?? step.timestamp),
        parentSpanContext: parent.otelSpan.spanContext(),
      },
    );

    const resultTimes: number[] = [];
    for (const tc of step.toolCalls) {
      await emitToolCall(tc, generation, step.timestamp, ctx);
      if (tc.endTime !== undefined) resultTimes.push(tc.endTime);
    }

    // End the generation after its tools so the timeline cleanly contains them.
    const genEnd = resultTimes.length > 0 ? Math.max(...resultTimes) : (step.timestamp ?? prevTs);
    generation.end(asDate(genEnd));

    // Carry this batch's results into the next generation's input.
    prevToolResults =
      step.toolCalls.length > 0
        ? step.toolCalls.map((tc) => ({
            tool_use_id: tc.id,
            tool_name: tc.name,
            output: tc.output != null ? ctx.clip(toText(tc.output)) : undefined,
          }))
        : undefined;

    // The next generation can only start once this batch's results returned.
    if (resultTimes.length > 0) prevTs = Math.max(...resultTimes);
    else if (step.timestamp !== undefined) prevTs = step.timestamp;
  }

  return prevTs;
}

async function emitToolCall(
  tc: ToolCall,
  parent: LangfuseObservation,
  fallbackEnd: number | undefined,
  ctx: EmitCtx,
): Promise<void> {
  const tool = startObservation(
    `Tool: ${tc.name}`,
    {
      input: ctx.clip(tc.input),
      output: tc.output != null ? ctx.clip(toText(tc.output)) : undefined,
      metadata: { "claude.tool_id": tc.id, "claude.tool_name": tc.name },
    },
    {
      asType: "tool",
      startTime: asDate(tc.startTime),
      parentSpanContext: parent.otelSpan.spanContext(),
    },
  );

  // If this tool call spawned a subagent, nest the subagent's work under it.
  const subagent = ctx.subagents.get(tc.id);
  if (subagent && !ctx.visited.has(subagent.file)) {
    await emitSubagent(tool, subagent, tc, ctx);
  }

  tool.end(asDate(tc.endTime ?? tc.startTime ?? fallbackEnd));
}

/** Expand a subagent transcript as nested observations under its tool call. */
async function emitSubagent(
  parentTool: LangfuseObservation,
  subagent: SubagentInfo,
  tc: ToolCall,
  ctx: EmitCtx,
): Promise<void> {
  ctx.visited.add(subagent.file);

  let rows;
  try {
    rows = await readAllRows(subagent.file);
  } catch (error) {
    debugLog(`failed to read subagent transcript ${subagent.file}:`, error);
    return;
  }

  const turns = buildTurns(rows);
  if (turns.length === 0) return;

  for (const turn of turns) {
    const agent = startObservation(
      `Subagent: ${subagent.agentType}`,
      {
        input: { role: "user", content: ctx.clip(turn.userText) },
        output:
          turn.finalAssistantText != null
            ? { role: "assistant", content: ctx.clip(turn.finalAssistantText) }
            : undefined,
        metadata: {
          "claude.subagent_type": subagent.agentType,
          "claude.subagent_description": subagent.description,
          "claude.spawning_tool_id": tc.id,
        },
      },
      {
        asType: "agent",
        startTime: asDate(turn.userTimestamp),
        parentSpanContext: parentTool.otelSpan.spanContext(),
      },
    );

    const lastTs = await emitSteps(
      agent,
      turn.steps,
      { role: "user", content: ctx.clip(turn.userText) },
      turn.userTimestamp,
      ctx,
    );

    agent.end(asDate(turn.endTimestamp ?? lastTs ?? turn.userTimestamp));
  }
}

/** Emit a single turn as a Langfuse observation tree. */
async function emitTurn(
  turn: Turn,
  turnNum: number,
  transcriptPath: string,
  ctx: EmitCtx,
): Promise<void> {
  const root = startObservation(
    "Claude Code Turn",
    {
      input: { role: "user", content: ctx.clip(turn.userText) },
      output:
        turn.finalAssistantText != null
          ? { role: "assistant", content: ctx.clip(turn.finalAssistantText) }
          : undefined,
      metadata: {
        "claude.source": "claude-code",
        "claude.turn_number": turnNum,
        "claude.transcript_path": transcriptPath,
        "claude.assistant_message_count": turn.steps.length,
      },
    },
    {
      asType: "agent",
      startTime: asDate(turn.userTimestamp),
    },
  );

  const lastTs = await emitSteps(
    root,
    turn.steps,
    { role: "user", content: ctx.clip(turn.userText) },
    turn.userTimestamp,
    ctx,
  );

  root.end(asDate(turn.endTimestamp ?? lastTs ?? turn.userTimestamp));
}

/**
 * Convert the newly appended part of a Claude Code transcript into Langfuse
 * traces. Each turn becomes its own trace, grouped into a Langfuse session via
 * the Claude Code session id. Subagent transcripts are nested under the tool
 * call that spawned them. State is tracked in a sidecar so each turn is
 * uploaded exactly once.
 */
export async function convertTranscript(
  transcriptPath: string,
  sessionId: string,
  config: Config,
): Promise<void> {
  const state = await loadState(transcriptPath);
  const { rows, offset } = await readNewRows(transcriptPath, state);

  if (rows.length === 0) {
    debugLog("no new transcript rows to process");
    await saveState(transcriptPath, { ...state, offset });
    return;
  }

  const turns = buildTurns(rows);
  debugLog(`parsed ${turns.length} new turn(s) from ${transcriptPath}`);

  const subagents = await discoverSubagents(transcriptPath);

  let emitted = 0;
  for (const turn of turns) {
    const turnNum = state.turnCount + emitted + 1;
    const ctx: EmitCtx = { clip: makeClip(config.max_chars), subagents, visited: new Set() };
    try {
      await propagateAttributes(
        {
          sessionId,
          traceName: "Claude Code Turn",
          tags: ["claude-code", ...(config.tags ?? [])],
          ...(config.user_id ? { userId: config.user_id } : {}),
          ...(config.metadata ? { metadata: config.metadata } : {}),
        },
        async () => {
          await emitTurn(turn, turnNum, transcriptPath, ctx);
        },
      );
      emitted += 1;
    } catch (error) {
      debugLog(`failed to emit turn ${turnNum}:`, error);
      if (config.fail_on_error) throw error;
    }
  }

  await saveState(transcriptPath, { offset, turnCount: state.turnCount + emitted });
}
