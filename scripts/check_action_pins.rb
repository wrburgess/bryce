#!/usr/bin/env ruby
# frozen_string_literal: true

# check_action_pins.rb — supply-chain guard: every external GitHub Action must be
# pinned to a full 40-character commit SHA, not a mutable tag or branch.
#
# A mutable ref (`@v4`, `@main`) can be silently repointed by whoever controls the
# action's repo, injecting code into this repo's CI ("pipeline injection"). Pinning
# to a commit SHA makes the referenced code immutable. This guard fails the build if
# any workflow reintroduces an unpinned external `uses:`, so the hardening in
# renovate.json + the workflows cannot erode as new steps are added (issue #59).
#
# Dependency-free: standard library only (no gems, no bundler), so it runs on a bare
# Ruby in CI. Output is ASCII-only and greppable (rules/scripting.md, ADR 0011).
#
# Usage:
#   ruby scripts/check_action_pins.rb [--root DIR]
#     --root DIR   Directory to scan (default: current directory). Used by the
#                  self-test to point the checker at fixture workflow trees.
#
# Exit status: 0 when every external `uses:` is SHA-pinned; 1 when any is not
# (all offenders are printed as `path:line -> value`).

require "optparse"

class ActionPinCheck
  SHA_RE = /\A[0-9a-f]{40}\z/.freeze
  # Capture the token after `uses:` (quotes optional), stopping before any trailing
  # `# vX.Y.Z` comment or whitespace.
  USES_RE = /^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/.freeze

  def initialize(root)
    @root = root
    @offenders = []
  end

  # Local (`./…`, `../…`) and docker refs are first-party or out of scope for tag
  # repointing; every other `uses:` is a `owner/repo[/path]@ref` that must pin a SHA.
  def unpinned?(value)
    return false if value.start_with?("./", "../")
    return false if value.start_with?("docker://")

    owner, ref = value.split("@", 2)
    return true if ref.nil? || ref.empty? || owner.empty? # no ref at all -> floating

    !SHA_RE.match?(ref)
  end

  def workflow_files
    Dir.glob(File.join(@root, ".github", "workflows", "*.{yml,yaml}")).sort
  end

  def run
    workflow_files.each do |path|
      rel = path.sub(%r{\A#{Regexp.escape(@root)}/?}, "")
      File.foreach(path).with_index(1) do |line, lineno|
        m = USES_RE.match(line)
        next unless m

        value = m[1]
        @offenders << "#{rel}:#{lineno} -> uses: #{value}" if unpinned?(value)
      end
    end

    if @offenders.empty?
      puts "check_action_pins: OK - every external `uses:` is pinned to a commit SHA."
      0
    else
      puts "check_action_pins: FAIL - #{@offenders.length} unpinned external action(s):"
      @offenders.each { |o| puts "  #{o}" }
      puts "Pin each to a full 40-char commit SHA (e.g. `uses: owner/repo@<sha> # vX.Y.Z`)."
      1
    end
  end
end

root = "."
OptionParser.new do |o|
  o.banner = "Usage: ruby scripts/check_action_pins.rb [--root DIR]"
  o.on("--root DIR", "Directory to scan (default: current directory)") { |v| root = v }
end.parse!(ARGV)

exit ActionPinCheck.new(root).run
