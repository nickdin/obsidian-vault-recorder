/**
 * The hand-off agent (spec #69 § 9; the rule is `docs/hand-off-rule.md`, "The
 * agent lines").
 *
 * A hand-off agent is a program of the user's, not the plugin. The plugin's
 * whole part is the request: when a transcript is done and a mode's agent is
 * `hand-off`, the lifecycle writes `agent: requested`, `agent-attempt` and
 * `agent-for` (`Lifecycle.requestAgentIfDone`, the same step for every kind).
 * From then on the program writes `agent-by`, `agent-state`, `agent-at`,
 * `agent-attempt-answered`, its `## Agent` section and, on a failure,
 * `agent-reason`; the plugin only reads those lines back, derives working,
 * done, failed and overdue from them on its own clock (`deriveState`), and
 * shows them in the note and the panel.
 *
 * So this adapter has no `tick`: it sends nothing and takes nothing. In
 * particular a serving device never gives it a request (`isServedKind`), and a
 * wait has no per-device reason to give — the program, not this device, is
 * what the recording waits on.
 *
 * It has no instruction either: the settings page draws no instruction box for
 * it, and `AgentEntry.instruction` is ignored whatever it holds, because the
 * program carries its own.
 */

import type { AgentAdapter } from "./lifecycle";

export const HAND_OFF_AGENT: AgentAdapter = { kind: "hand-off", waitingReason: () => null };
