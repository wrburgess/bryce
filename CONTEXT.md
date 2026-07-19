# ai-config

A generic, model-agnostic AI-agent configuration layer for software projects. It ships as a portable, business-neutral baseline that is vendored into a host application and then customized. It drives multiple AI coding agents (Claude, Codex, Copilot, Antigravity, Grok Build) from a single source of truth.

## Language

**Config Bundle**:
The portable set of AI instructions, skills, and per-tool adapters this repo produces — the deliverable that gets vendored into a host app.
_Avoid_: "the config" (ambiguous), "the framework"

**Generic Baseline**:
The business-neutral, ready-to-vendor state of the Config Bundle. Contains no reference to any specific company, product, or domain.
_Avoid_: "default config", "boilerplate"

**Customization**:
The changes a host app makes after vendoring the Generic Baseline to fit its own domain, tooling, and conventions. Kept separate from the baseline so upstream updates stay mergeable.
_Avoid_: "overrides", "config"

**Stack Overlay** (a.k.a. **Sidecar Bundle**):
A stack-specific overlay Config Bundle (e.g. `ai-config-rails`) a Host App vendors *alongside* the Generic Baseline to restore the concrete, stack-named patterns and anti-patterns the baseline states only as neutral, stack-agnostic principles. The baseline names no stack; each overlay supplies one stack's concretes.
_Avoid_: "plugin", "extension", "fork"

**Host App** (a.k.a. **Consuming App**):
A software project that vendors the Config Bundle. The Config Bundle never assumes anything about a specific Host App's domain or stack.
_Avoid_: "client", "target repo"

**Canonical Source** (a.k.a. **Source of Truth**):
The one authored, model-neutral instruction/skill content from which every per-tool Adapter is derived. Agents must never receive drifted or divergent instructions.
_Avoid_: "master file", "the docs"

**Adapter**:
A per-tool projection of the Canonical Source onto a specific agent's native config surface (e.g. `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `GEMINI.md`).
_Avoid_: "wrapper", "integration"

**Harness**:
The tool that carries the Config Bundle and runs the agent loop — **Claude Code**, **Codex**, **Copilot**, **Antigravity**, or **Grok Build** (the CLI/IDE, *not* the model inside it). Named by its own name in prose and attribution, never substituted by the model it runs — the fourth harness is **Antigravity** (Gemini CLI's successor), whose model is Gemini ([ADR 0024](docs/adr/0024-harness-model-naming-convention.md)).
_Avoid_: naming a harness by its model ("Gemini" for Antigravity)

**Model**:
The LLM a Harness runs, and the thing attribution declares — **Opus** / **Fable** (Claude Code), **GPT** (Codex), **Gemini** / **Gemini Flash** (Antigravity), **Grok** (Grok Build); Copilot's varies. The second axis alongside Harness; the *Declared model* column of Project Config names this, never the harness.
_Avoid_: naming a model by its harness ("Codex" for GPT); API ids (use human-readable names)

**Skill**:
A portable, model-agnostic capability the Config Bundle provides (e.g. `distill`, `assess`, `devise`, `verify`, `listen`, `final`, `ship`). Authored once as a canonical body; invokable by any configured agent through an Invocation Shim.
_Avoid_: "command", "workflow" (both are tool-specific invocation mechanisms, not the skill itself)

**Invocation Shim**:
The thin, tool-specific entry point that routes a tool's native invocation (a Claude slash command, a Codex/Copilot/Antigravity/Grok Build prompt or documented procedure) to a Skill's canonical body. Carries no procedure of its own.
_Avoid_: "wrapper", "stub"

**Graceful Degradation**:
The rule that a Skill's procedure and quality gates are identical on every tool, while tool-specific *execution enhancements* (e.g. `ship`'s sub-agent-per-phase offloading) fall back to a documented inline path on tools that lack them. The mechanism degrades; the quality bar never does.
_Avoid_: "fallback mode", "compatibility mode"

**Project Config**:
The thin, per-Host-App file the Skills read for host-specific values (attribution string, quality-check commands, branch policy, review-severity framework, Lifecycle Host, issue/PR conventions). Lets Skills stay generic.
_Avoid_: "settings", "the customization" (Customization is broader)

**Lifecycle Host**:
The external platform where lifecycle artifacts live — assessments/plans on an issue, the PR that `invoke` opens, the SOW on the PR. GitHub by default; set in Project Config and remappable to another platform.
_Avoid_: "the repo", "CI"

**Rules Layer**:
The tiered home for host guidance — patterns and anti-patterns. Split into a **Lean Core** (always resident) and **Deferred Deep Docs** (read on demand). Distinct from Project Config, which holds settings, not knowledge.
_Avoid_: "docs", "guidelines"

**Lean Core**:
Tier 1 of the Rules Layer — small, invariant per-domain rule files that are always loaded, each with a Patterns and an Anti-Patterns section.
_Avoid_: "the rules" (ambiguous with the whole Rules Layer)

**Deferred Deep Docs**:
Tier 2 of the Rules Layer — heavy, subsystem-specific case studies (`docs/rules/<domain>-postmortems.md`) loaded only when a trigger fires. Keeping these out of the Lean Core is what keeps session context lean.
_Avoid_: "postmortems" (host may use another word), "reference docs"

**Anti-Pattern**:
A first-class, required section of every rule file: an imperative "**Never** X — *because* Y" entry (with an optional host-filled reference slot) that steers agents away from choices we never want.
_Avoid_: "gotcha", "warning"

## Relationships

- The **Config Bundle** contains one **Canonical Source**, many **Adapters**, many **Skills**, one **Rules Layer**, and one **Project Config**.
- The **Rules Layer** = **Lean Core** (Tier 1, always resident) + **Deferred Deep Docs** (Tier 2, on demand); a trigger table links a Tier-1 file to its Tier-2 deep doc.
- A **Host App** vendors the **Generic Baseline**, then applies **Customization** (including its **Project Config**).
- A **Host App** may also vendor one or more **Stack Overlays** (e.g. `ai-config-rails`) alongside the **Generic Baseline**: the baseline states each rule as a neutral, stack-agnostic principle; the overlay supplies that stack's concrete patterns and anti-patterns.
- Each **Adapter** is derived from the **Canonical Source**; every **Skill** reads the **Project Config** for host-specific values.

## Example dialogue

> **Dev:** "Where does Markaz's rights-data rule go in the **Generic Baseline**?"
> **Maintainer:** "It doesn't. The baseline is business-neutral — that rule is a **Customization** a **Host App** would add after vendoring. Markaz is only a pattern reference for us."

## Flagged ambiguities

- "config" was used to mean the whole **Config Bundle**, the **Project Config**, and a **Host App's Customization** — resolved: these are three distinct things.
