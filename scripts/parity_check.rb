#!/usr/bin/env ruby
# frozen_string_literal: true

# parity_check.rb — structural parity check for the Config Bundle (ADR 0008).
#
# Verifies, WITHOUT any model-in-the-loop testing, that every per-tool Adapter still resolves to the
# Canonical Source and that the Project Config is structurally intact. Dependency-free: standard
# library only (no gems, no bundler), so it runs on a bare Ruby in CI.
#
# Usage:
#   ruby scripts/parity_check.rb [--root DIR]
#     --root DIR   Directory to check (default: current directory). Used by the self-test to point
#                  the checker at fixture bundles.
#
# Exit status: 0 when every invariant holds; 1 when any fails (all failures are printed).
#
# Adapter marker conventions (kept in lockstep with AGENTS.md / PROJECT.md):
#   Native-discovery adapter:  <!-- parity:native source=AGENTS.md -->
#   Rendered adapter:          <!-- parity:render source=AGENTS.md --> … <!-- parity:endrender -->
#                              (the region between the markers must equal AGENTS.md byte-for-byte)

require "optparse"
require_relative "protected_branches"

class ParityCheck
  CANONICAL = "AGENTS.md"

  # Import Adapters: files that resolve to the Canonical Source. The existence + count invariants apply
  # to every entry; how each is allowed to resolve is governed by NATIVE_CAPABLE_ADAPTERS below.
  IMPORT_ADAPTERS = ["CLAUDE.md", "GEMINI.md"].freeze

  # Adapters that may resolve via NATIVE discovery instead of an `@AGENTS.md` import. `GEMINI.md`
  # qualifies: Google's Antigravity CLI (which superseded Gemini CLI, announced 2026-05-19) reads
  # `AGENTS.md` natively since v1.20.3, and a host may point the tool straight at `AGENTS.md` via the
  # `context.fileName` setting — both are first-class resolutions per ADR 0002, so a Gemini adapter
  # that declares native discovery (a `parity:native source=AGENTS.md` marker, the same mechanism the
  # Copilot adapter uses) must not false-fail parity. `CLAUDE.md` is NOT native-capable — Claude Code
  # has no native `AGENTS.md` discovery, so the import is its only resolution.
  #
  # ADR 0008 boundary: this stays a purely STRUCTURAL check — it verifies the Adapter *file* resolves
  # to `AGENTS.md`, not that the external tool actually reads that filename. No structural check can
  # detect a future tool renaming its default context file (a false-green); that liveness is re-verified
  # out-of-band in docs/research/tool-config-discovery.md (last re-verified for Antigravity CLI, #56).
  NATIVE_CAPABLE_ADAPTERS = ["GEMINI.md"].freeze

  COPILOT_ADAPTER = ".github/copilot-instructions.md"
  PROJECT_CONFIG = "PROJECT.md"

  # Files whose relative markdown links must resolve. Beyond the Canonical Source, its Adapters, and
  # the Project Config, this covers the top-level human-facing docs (README + the usage/lifecycle
  # guides) so a dead link in the onboarding path reddens too. Each is link-checked only if present
  # (check_links skips missing files), so a minimal fixture bundle is unaffected.
  LINK_CHECKED = [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    "PROJECT.md",
    ".github/copilot-instructions.md",
    "README.md",
    "docs/standards/development-lifecycle.md",
    "docs/guides/usage.md",
    "docs/guides/branch-protection.md",
    "docs/cli/README.md",
    "docs/api/README.md",
    "docs/mcp/README.md",
  ].freeze

  # Usage guides (ADR 0008 surface finalization, issue #11). Checked only for a bundle that ships a
  # docs/guides/ tree (the GUIDES_DIR gate) so a minimal fixture bundle is unaffected — the same "only
  # for a bundle that ships them" stance as check_rules / check_skills / check_guardrails. The floor is
  # existence: each required guide must be shipped, so a future manifest change can't silently drop the
  # vendor/customize/run walkthrough. Reachability is deliberately NOT anchored to README.md — README
  # is not vendored (ai-config-sync skips it) and a Host App owns its own, so a "referenced by README"
  # rule would fail in-host, breaking the vendored-copy parity invariant the guide itself documents.
  # In-host the guide is discoverable under docs/guides/; in this repo README links it (guarded by
  # check_links, since README is in LINK_CHECKED).
  GUIDES_DIR = "docs/guides"
  REQUIRED_GUIDES = ["docs/guides/usage.md"].freeze

  # ADR log (ADR 0008 structural hygiene). Each decision file is `NNNN-slug.md`, and the NNNN number
  # must be UNIQUE across the log. Two branches that each grab the next free number independently and
  # then both merge is a real collision (issue #55: two `0036`s), invisible to a link check because
  # both files exist — this catches it at PR time so the later branch renumbers before merge, not
  # after. Gated on the docs/adr/ tree existing, so a minimal fixture bundle is unaffected.
  ADR_DIR = "docs/adr"
  ADR_FILENAME = /\A(\d+)-.+\.md\z/.freeze

  # Tier-1 Lean Core rule files (ADR 0004). Each must exist, be referenced by AGENTS.md so every tool
  # can reach the Lean Core, and declare its Patterns + Anti-Patterns sections. Checked only for a
  # bundle that ships a rules/ tree (the RULES_DIR gate) so a minimal fixture bundle is unaffected —
  # the same "only for a bundle that ships them" stance as check_guardrails.
  RULES_DIR = "rules"
  REQUIRED_RULES = [
    "rules/backend.md", "rules/frontend.md", "rules/testing.md",
    "rules/security.md", "rules/self-review.md", "rules/scripting.md", "rules/skills.md"
  ].freeze
  # Section presence is asserted (the heading line), not content — so a host freely extends the body.
  RULE_REQUIRED_SECTIONS = ["## Patterns", "## Anti-Patterns"].freeze

  # Skills (ADR 0003 / ADR 0010). Each Skill is a canonical body at skills/<name>/SKILL.md reached
  # through a thin Invocation Shim. Checked only for a bundle that ships a skills/ tree (the
  # SKILLS_DIR gate) so a minimal fixture bundle is unaffected — the same "only for a bundle that
  # ships them" stance as check_rules / check_guardrails. REQUIRED_SKILLS is a floor (the baseline
  # ships all 13 today); it grows as later issues add skills. The per-present-skill invariants apply
  # to EVERY skills/<name>/ dir, so those later skills are covered by construction — no rewrite.
  SKILLS_DIR = "skills"
  CLAUDE_COMMANDS_DIR = ".claude/commands"
  # The six lifecycle Skills (ADR 0006). Each MUST route host values through PROJECT.md, so each body
  # is asserted to reference the Project Config (the content-neutrality positive check in check_skills).
  LIFECYCLE_SKILLS = %w[assess devise invoke verify listen final].freeze
  # Floor: the skills this host vendors (Customization: the baseline's intake-pipeline skills —
  # scout, clip, follow, restock — are trimmed; see PROJECT.md → Lifecycle Host). The shape check
  # applies to every *present* skill regardless, so additions are covered by construction.
  # `ship` is the orchestrator (ADR 0005/0006) and `create-skill` is the authoring front door
  # (ADR 0019): both belong in the floor but NOT in LIFECYCLE_SKILLS — neither is a lifecycle
  # stage, so neither is forced through the PROJECT.md-reference check (each body references
  # PROJECT.md by choice, not by that mandate).
  REQUIRED_SKILLS = (["distill"] + LIFECYCLE_SKILLS + ["ship", "create-skill"]).freeze

  # Content-neutrality (ADR 0003): a generic Skill body reads host values from PROJECT.md, so a
  # stack/domain proper noun in a body is leftover coupling the purely-structural checks cannot see.
  # This denylist is deliberately tight and unambiguous to avoid false positives on generic prose, and
  # is scoped to skills/<name>/SKILL.md only (docs/ may legitimately illustrate). Pure-alphabetic
  # tokens match on ASCII-letter word boundaries (so `rspec` matches the standalone word but not
  # "underspecified"); tokens with punctuation match as plain substrings (no benign word contains them).
  HOST_SPECIFIC_TOKENS = [
    "Searchkick", "Elasticsearch", "Pundit", "Devise", "Kamal", "SimpleCov",
    "strong_migrations", "Ransack", "Markaz", "admin_root_path", "SKIP_TITLE_REINDEX",
    "rubocop", "rspec", "brakeman", "bundler-audit", ".claude/rules/", "docs/rules/"
  ].freeze

  # Required PROJECT.md H2 sections (verbatim). This is the parity contract with PROJECT.md.
  REQUIRED_PROJECT_SECTIONS = [
    "## Quality Checks",
    "## Attribution & Model Declaration",
    "## Branch & PR Policy",
    "## Review Severity Framework",
    "## Lifecycle Host",
  ].freeze

  # Branch-protection guardrails (ADR 0009). Checked only for a bundle that ships them — signalled by
  # the derived sidecar's presence — so minimal fixture bundles are unaffected.
  SIDECAR = ".githooks/protected-branches"
  GUARDRAIL_FILES = [
    ".githooks/pre-commit", ".githooks/pre-push", ".githooks/pre-merge-commit", ".githooks/pre-rebase",
    "bin/guard-protected-branch", "bin/install-git-hooks", "bin/protected-branches",
    ".claude/hooks/enforce-branch-creation.sh", ".claude/settings.json"
  ].freeze

  IMPORT_TOKEN = /(?:^|\s)@AGENTS\.md(?:\s|$)/.freeze
  # Markers are only recognized when alone on their own line — so prose that *describes* a marker
  # (e.g. inside a backtick span in documentation) is never mistaken for a real one.
  NATIVE_MARKER = /\A<!--\s*parity:native\s+source=AGENTS\.md\s*-->\z/.freeze
  RENDER_OPEN = /\A<!--\s*parity:render\s+source=AGENTS\.md\s*-->\z/.freeze
  RENDER_CLOSE = /\A<!--\s*parity:endrender\s*-->\z/.freeze

  def initialize(root)
    @root = root
    @errors = []
  end

  def run
    check_canonical_exists
    check_import_adapters
    check_copilot_adapter
    check_rendered_regions
    check_project_sections
    check_rules
    check_skills
    check_guardrails
    check_guides
    check_adr_numbers
    check_links
    report
    @errors.empty? ? 0 : 1
  end

  private

  def path(rel) = File.join(@root, rel)
  def exist?(rel) = File.file?(path(rel))
  def read(rel) = File.read(path(rel), encoding: "UTF-8")
  def err(msg) = @errors << msg

  def check_canonical_exists
    if !exist?(CANONICAL)
      err("Canonical Source missing: #{CANONICAL} not found")
    elsif read(CANONICAL).strip.empty?
      err("Canonical Source empty: #{CANONICAL} has no content")
    end
  end

  def check_import_adapters
    IMPORT_ADAPTERS.each do |adapter|
      unless exist?(adapter)
        err("Import Adapter missing: #{adapter} not found")
        next
      end
      body = read(adapter)
      next if body.match?(IMPORT_TOKEN)

      # No `@AGENTS.md` import: allowed only for a native-capable adapter that declares native discovery
      # (a `parity:native source=AGENTS.md` marker) — the context.fileName / Antigravity-native path.
      if NATIVE_CAPABLE_ADAPTERS.include?(adapter)
        next if body.lines.any? { |l| l.strip.match?(NATIVE_MARKER) }

        err("Adapter #{adapter} neither imports the Canonical Source (`@#{CANONICAL}`) nor declares " \
            "native discovery (expected an `@#{CANONICAL}` line or a `parity:native source=#{CANONICAL}` marker)")
      else
        err("Import Adapter #{adapter} does not import the Canonical Source (expected an `@#{CANONICAL}` line)")
      end
    end
    # The import target itself must exist (a dangling `@AGENTS.md` is drift).
    err("Import target missing: adapters reference @#{CANONICAL} but #{CANONICAL} not found") unless exist?(CANONICAL)
  end

  def check_copilot_adapter
    unless exist?(COPILOT_ADAPTER)
      err("Copilot Adapter missing: #{COPILOT_ADAPTER} not found")
      return
    end
    marker_lines = read(COPILOT_ADAPTER).lines.map(&:strip)
    native = marker_lines.any? { |l| l.match?(NATIVE_MARKER) }
    render = marker_lines.any? { |l| l.match?(RENDER_OPEN) }
    unless native || render
      err("Copilot Adapter #{COPILOT_ADAPTER} has neither a `parity:native` marker nor a `parity:render` block")
    end
    # If it declares a render block, check_rendered_regions verifies the byte-match.
  end

  # Any file carrying a parity:render block must reproduce AGENTS.md byte-for-byte in that region.
  def check_rendered_regions
    return unless exist?(CANONICAL)

    canonical = read(CANONICAL)
    LINK_CHECKED.each do |rel|
      next unless exist?(rel)

      lines = read(rel).lines
      open_i = lines.index { |l| l.strip.match?(RENDER_OPEN) }
      next unless open_i

      close_i = lines[(open_i + 1)..].index { |l| l.strip.match?(RENDER_CLOSE) }
      if close_i.nil?
        err("Rendered region in #{rel} opens with `parity:render` but has no `parity:endrender` close")
        next
      end
      close_i += open_i + 1
      captured = lines[(open_i + 1)...close_i].join
      if captured != canonical
        err("Rendered region in #{rel} does not match #{CANONICAL} byte-for-byte (drift)")
      end
    end
  end

  def check_project_sections
    unless exist?(PROJECT_CONFIG)
      err("Project Config missing: #{PROJECT_CONFIG} not found")
      return
    end
    headings = read(PROJECT_CONFIG).lines.map(&:rstrip)
    REQUIRED_PROJECT_SECTIONS.each do |section|
      err("Project Config #{PROJECT_CONFIG} missing required section: `#{section}`") unless headings.include?(section)
    end
  end

  # Tier-1 Rules Layer (ADR 0004). Runs only when the bundle ships a rules/ tree, so a minimal bundle
  # without the Rules Layer is unaffected (the same gate stance as check_guardrails). Three invariants
  # per rule file: (1) it exists, (2) AGENTS.md references it (the Lean Core must be reachable from the
  # Canonical Source so every tool receives it), and (3) it declares each required section — presence
  # of the heading, not its content, so a host freely extends the body.
  def check_rules
    return unless Dir.exist?(path(RULES_DIR))

    agents = exist?(CANONICAL) ? read(CANONICAL) : ""
    REQUIRED_RULES.each do |rel|
      unless exist?(rel)
        err("Tier-1 rule missing: #{rel} not found")
        next
      end
      unless agents.include?(rel)
        err("Tier-1 rule #{rel} is not referenced by #{CANONICAL} (the Lean Core must be reachable from the Canonical Source)")
      end
      headings = read(rel).lines.map(&:rstrip)
      RULE_REQUIRED_SECTIONS.each do |section|
        err("Tier-1 rule #{rel} missing required section: `#{section}`") unless headings.include?(section)
      end
    end
  end

  # Skills Layer (ADR 0003 / ADR 0010). Runs only when the bundle ships a skills/ tree, so a minimal
  # bundle is unaffected (the same gate stance as check_rules). Two tiers:
  #   (1) Floor  — every REQUIRED_SKILLS entry has skills/<name>/SKILL.md (the expected skill ships).
  #   (2) Shape  — EVERY present skills/<name>/ dir must have: a SKILL.md, that SKILL.md carrying YAML
  #                frontmatter with a `name:` key, a paired Claude shim .claude/commands/<name>.md,
  #                that shim referencing the canonical body (so a hollow stub can't pass), and a
  #                reference to skills/<name>/SKILL.md in AGENTS.md (the documented invocation the
  #                native-discovery tools reach). Applying the shape to every present dir is what makes
  #                the check cover skills a later issue adds without editing this list.
  #   (3) Neutrality — no HOST_SPECIFIC_TOKENS in any present body, and every LIFECYCLE_SKILLS body
  #                references PROJECT.md. This is the one content check (ADR 0003): the structural
  #                invariants can't see a leftover stack/domain token or a hardcoded quality check.
  def check_skills
    return unless Dir.exist?(path(SKILLS_DIR))

    agents = exist?(CANONICAL) ? read(CANONICAL) : ""

    REQUIRED_SKILLS.each do |name|
      err("Required skill missing: #{SKILLS_DIR}/#{name}/SKILL.md not found") unless exist?("#{SKILLS_DIR}/#{name}/SKILL.md")
    end

    present_skills.each do |name|
      body_rel = "#{SKILLS_DIR}/#{name}/SKILL.md"
      unless exist?(body_rel)
        err("Skill #{name} missing its canonical body: #{body_rel} not found")
        next
      end
      body = read(body_rel)
      err("Skill #{name}: #{body_rel} lacks YAML frontmatter with a `name:` key") unless frontmatter_name?(body)

      shim_rel = "#{CLAUDE_COMMANDS_DIR}/#{name}.md"
      if !exist?(shim_rel)
        err("Skill #{name} missing its Claude Invocation Shim: #{shim_rel} not found")
      elsif !read(shim_rel).include?(body_rel)
        err("Claude Invocation Shim #{shim_rel} does not reference its canonical body (expected `#{body_rel}`)")
      end

      unless agents.include?(body_rel)
        err("Skill #{name} is not referenced by #{CANONICAL} (the documented invocation must be reachable from the Canonical Source)")
      end

      # Content-neutrality: no host-specific token in ANY Skill body (structural checks can't see it) …
      HOST_SPECIFIC_TOKENS.each do |token|
        next unless host_token?(body, token)

        err("Skill #{name}: #{body_rel} contains host-specific token `#{token}` (a generic Skill body " \
            "must read host values from #{PROJECT_CONFIG}, not name a stack/domain)")
      end

      # … and every lifecycle Skill must route its host values through the Project Config.
      if LIFECYCLE_SKILLS.include?(name) && !body.include?(PROJECT_CONFIG)
        err("Lifecycle Skill #{name}: #{body_rel} does not reference #{PROJECT_CONFIG} (it must read " \
            "quality checks / attribution / severities / lifecycle host from Project Config, not hardcode them)")
      end
    end
  end

  # True when `token` appears in `body` as a host-specific mention. Pure-alphabetic tokens require
  # ASCII-letter word boundaries (so `rspec` matches the standalone word but not "underspecified");
  # tokens carrying punctuation (paths, `bundler-audit`, `admin_root_path`) match as plain substrings.
  def host_token?(body, token)
    if token.match?(/\A[A-Za-z]+\z/)
      body.match?(/(?<![A-Za-z])#{Regexp.escape(token)}(?![A-Za-z])/)
    else
      body.include?(token)
    end
  end

  # Names of every skills/<name>/ subdirectory that actually ships a body dir (ignores stray files).
  def present_skills
    Dir.children(path(SKILLS_DIR))
       .select { |c| Dir.exist?(File.join(path(SKILLS_DIR), c)) }
       .sort
  end

  # True when `content` opens with a YAML frontmatter block (--- … ---) carrying a non-empty `name:`.
  def frontmatter_name?(content)
    lines = content.lines
    first = lines.index { |l| !l.strip.empty? }
    return false if first.nil? || lines[first].strip != "---"

    close = lines[(first + 1)..].index { |l| l.strip == "---" }
    return false if close.nil?

    lines[(first + 1)...(first + 1 + close)].any? { |l| l.match?(/\Aname:\s*\S/) }
  end

  # Branch-protection guardrails (ADR 0009). Runs only when the derived sidecar is present, so a
  # minimal bundle without guardrails is unaffected. Two invariants: (1) the guardrail files exist,
  # and (2) the committed sidecar equals the list derived from PROJECT.md — closing the staleness
  # hole that a generated-then-committed artifact would otherwise open.
  def check_guardrails
    return unless exist?(SIDECAR)

    GUARDRAIL_FILES.each do |f|
      err("Guardrail file missing: #{f} not found") unless exist?(f)
    end

    unless exist?(PROJECT_CONFIG)
      err("Guardrails present but #{PROJECT_CONFIG} is missing (cannot verify the protected-branch list)")
      return
    end

    derived = ProtectedBranches.from_file(path(PROJECT_CONFIG))
    # Read the sidecar the same way the guards do (skip blank + `#` comment lines) so a hand-added
    # comment never reads as drift — the machine-generated sidecar has none, but the three readers
    # must stay consistent.
    committed = read(SIDECAR).lines.map(&:strip).reject { |l| l.empty? || l.start_with?("#") }
    if derived != committed
      err("Protected-branch sidecar drift: #{SIDECAR} has #{committed.inspect} but PROJECT.md derives " \
          "#{derived.inspect} - run bin/install-git-hooks to regenerate it")
    end
  end

  # Usage guides (issue #11). Runs only when the bundle ships a docs/guides/ tree, so a minimal bundle
  # is unaffected (the same gate stance as check_rules / check_skills). One host-safe invariant per
  # required guide: it exists (is shipped). Its internal links are resolved by check_links (each guide
  # is in LINK_CHECKED). Reachability is intentionally not asserted against README (see REQUIRED_GUIDES).
  def check_guides
    return unless Dir.exist?(path(GUIDES_DIR))

    REQUIRED_GUIDES.each do |rel|
      err("Required guide missing: #{rel} not found") unless exist?(rel)
    end
  end

  # ADR numbering uniqueness (issue #55). Runs only when the bundle ships a docs/adr/ tree, so a
  # minimal bundle is unaffected (the same gate stance as check_guides). Groups every `NNNN-slug.md`
  # file by its number and reddens on any number shared by two or more files; filenames that don't
  # match the `NNNN-slug.md` shape (e.g. a README) are ignored.
  def check_adr_numbers
    return unless Dir.exist?(path(ADR_DIR))

    by_number = Hash.new { |h, k| h[k] = [] }
    Dir.children(path(ADR_DIR)).sort.each do |name|
      next unless File.file?(File.join(path(ADR_DIR), name))

      m = ADR_FILENAME.match(name)
      by_number[m[1]] << name unless m.nil?
    end

    by_number.each do |number, files|
      next if files.length < 2

      err("Duplicate ADR number #{number}: #{files.sort.inspect} share it - renumber all but one to " \
          "the next free number and update its references")
    end
  end

  # Every repo-relative markdown link in the checked files must resolve to an existing path.
  # Skips external (http/https/mailto) and bare-anchor (#...) links.
  def check_links
    link_re = /\[[^\]]*\]\(([^)]+)\)/
    LINK_CHECKED.each do |rel|
      next unless exist?(rel)

      dir = File.dirname(path(rel))
      read(rel).scan(link_re).each do |(target)|
        target = target.strip
        next if target.empty?
        next if target.start_with?("http://", "https://", "mailto:", "#")

        target = target.split("#", 2).first # drop any #anchor fragment
        next if target.nil? || target.empty?

        resolved = File.expand_path(target, dir)
        unless File.exist?(resolved)
          err("Dead link in #{rel}: `#{target}` does not resolve")
        end
      end
    end
  end

  def report
    if @errors.empty?
      skills = Dir.exist?(path(SKILLS_DIR)) ? present_skills.length : 0
      puts "parity_check: OK - Canonical Source, #{IMPORT_ADAPTERS.length + 1} Adapters, Project Config, " \
           "#{skills} Skill#{'s' if skills != 1}, and links all resolve."
    else
      puts "parity_check: FAILED (#{@errors.length} problem#{'s' if @errors.length != 1})"
      @errors.each { |e| puts "  - #{e}" }
    end
  end
end

if $PROGRAM_NAME == __FILE__
  root = "."
  OptionParser.new do |opts|
    opts.banner = "Usage: ruby scripts/parity_check.rb [--root DIR]"
    opts.on("--root DIR", "Directory to check (default: .)") { |v| root = v }
  end.parse!(ARGV)

  exit ParityCheck.new(root).run
end
