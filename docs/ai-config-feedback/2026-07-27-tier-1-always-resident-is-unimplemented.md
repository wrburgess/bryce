# 2026-07-27 — The baseline calls Tier 1 "always-resident" and ships no mechanism that makes it so (bryce issue #186)

## F19 — ADR 0004, `AGENTS.md`, `CONTEXT.md` and all seven `rules/*.md` headers assert a loading model the bundle does not implement

**Disposition: `upstream` · Status: recorded**

Upstream [ADR 0004](../adr/0004-two-tier-rules-layer-progressive-context.md) defines the Rules Layer's
two tiers by *when each is loaded*: Tier 1 is **"always resident"**, Tier 2 is **"not auto-loaded — read
on demand"**. That distinction is repeated in the baseline's `AGENTS.md` *Rules Layer* section, in three
`CONTEXT.md` glossary entries, and verbatim in the header blockquote of every vendored `rules/*.md`.

**Nothing in the bundle makes Tier 1 resident.** The whole import chain is:

```
CLAUDE.md ──@AGENTS.md──> AGENTS.md
```

`AGENTS.md` imports nothing further. The baseline ships no `.claude/rules/` projection, no
`context.fileName` rule listing, and no other loader — ADR 0004 itself calls the Claude auto-load *"a
tool-specific accelerator"*, which is to say something a host would have to build. So both tiers are read
on demand, and the property that distinguishes them does not exist.

**Why this is not a harmless wording slip.** In this host it directed real work for eight days. Issues
#148, #151, #152, #157, #159, #160 and #166 — plus #175, #177 and #178, still open at the time of writing
— all optimized Tier-1 *leanness* to protect a per-session context budget that nothing was spending. The
per-bullet narrative budget (upstream ADR 0051) is a guard built to enforce that budget. The work was
carefully done and repeatedly reviewed; it was measured against a constraint that does not bind.

It also makes the leanness argument **unfalsifiable**: a claim about session cost cannot be tested when
no session receives the files.

**Baseline-generic without qualification.** The claim, the four surfaces carrying it, and the absent
mechanism are all in vendored files with no stack or domain content. Any Host App that vendors the bundle
inherits the identical text and the identical absence, whatever it is building. That clears the ledger's
upstream test as written.

**The fix as shipped here** (bryce PR for issue #186) — documentation only, no mechanism:

- Tier 1 is restated as **mandatory and task-routed**: an agent reads the applicable file when its work
  enters that domain, routed by the trigger table `AGENTS.md` already carries. That table *is* the loading
  mechanism; only the words describing it were wrong.
- ADR 0004 gains the distinction the two tiers need now that neither is auto-loaded — Tier 1 is read
  whenever work enters its domain and is not optional; Tier 2 is read when a *specific* case study is
  wanted. It keeps a correction note rather than silently rewriting its own history.
- `AGENTS.md`, `CONTEXT.md` (the glossary that *defines* Lean Core) and all seven `rules/*.md` headers are
  corrected together. Correcting only some of them leaves the contradiction in the places a reader looks
  first, and no guard checks prose consistency, so the drift would be silent and durable.

**Deliberately not done, and the recommendation to upstream is the same:** do **not** wire a loading
mechanism. This host's corpus is ~46 KB across 102 bullets; making it resident would trade a governance
problem for a permanent context tax on every session, in every host, forever. Upstream ADR 0022 already
prices the always-loaded surface (`AGENTS.md` + `CLAUDE.md`) at roughly 200 lines — a resident Rules Layer
would be an order of magnitude past that.

**A second, sharper reading is available and is the one worth arguing upstream.** If Tier 1 were meant to
be resident and simply never was, the fix is a loader. If it was never going to be resident — which the
absence of any mechanism across the baseline's whole life suggests — then the two-tier split was never
about *loading* at all; it is about **obligation** (must read for this domain) versus **depth** (read for
one question). That is a better architecture and it is what the bundle already does. The ADR should say
so directly rather than describing a cache it does not have.

**Related.** The measurements behind this entry, including the bullet inventory that established the
5-of-102 enforcement rate and the 1.96-bullets-per-issue minting rate, are in bryce issue #185. The
disposition change that addresses the minting rate ships in the same PR as this correction.
