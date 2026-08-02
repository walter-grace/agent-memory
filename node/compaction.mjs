// Memory compaction: the accuracy-first core, backend-agnostic (works over local JSONL or on-chain).
//
// Model = two ideas combined:
//   • openclaw#51612 hierarchical compaction: raw memories are never deleted (they stay as leaves);
//     compaction builds an INDEX on top: a small, constant-cost "ROOT" the agent reads each session
//     so it knows what it knows without replaying everything.
//   • RocksDB leveled compaction: a log-structured MERGE: when two memories conflict about the same
//     "key", the NEWER value supersedes the older and the stale one is dropped. So the ROOT is the
//     CURRENT merged state, not a contradictory pile.
//
// The prompt pushes hard on "preserve every concrete fact, never invent, newest-wins", which is what
// keeps the index trustworthy: verified against a preference-change + identifier + chit-chat fixture.

export const COMPACT_SYS =
  "You maintain an AI agent's long-term memory as a faithful ROOT INDEX. You are given the current " +
  "ROOT (may be empty) and the raw memories recorded since it, in chronological order. Rewrite the " +
  "ROOT so it captures the CURRENT durable state. RULES: (1) Preserve EVERY concrete fact, decision, " +
  "preference, name, number, date, identifier, and unresolved thread: verbatim where it matters. " +
  "(2) NEVER invent, guess, or infer anything not present in the inputs. (3) MERGE like a " +
  "log-structured store: when memories conflict about the same thing, the MORE RECENT one supersedes " +
  "the older: keep the current value and drop the stale one (a changed preference, a reversed " +
  "decision keeps only the new state). (4) Merge duplicates; drop only pure chit-chat that carries no " +
  "fact. (5) If unsure whether something is durable, KEEP it. Output GitHub-flavored markdown with " +
  "exactly these sections, terse and keyword-dense:\n" +
  "## Facts & preferences\n## People, entities & identifiers\n## Decisions & state\n## Open threads / TODO\n## Topics index\n" +
  "No preamble, no commentary: only the updated ROOT.";

// entries: [{ role, text }] recorded since the last ROOT. priorRoot: the previous index (string).
export async function compact(provider, { priorRoot = "", entries }) {
  const raw = entries.map((e) => `[${e.role}] ${e.text}`).join("\n");
  const msg = await provider.chat({
    model: "auto", maxTokens: 1600,
    messages: [
      { role: "system", content: COMPACT_SYS },
      { role: "user", content: `CURRENT ROOT:\n${priorRoot || "(empty: first compaction)"}\n\nRAW MEMORIES SINCE:\n${raw}` },
    ],
  });
  return (msg.content || "").trim();
}
