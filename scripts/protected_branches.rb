# frozen_string_literal: true

# protected_branches.rb — the ONE place that derives the protected-branch list from PROJECT.md
# (Option A, issue #6 / ADR 0009). PROJECT.md is the single authored source; the git hooks read a
# generated sidecar (.githooks/protected-branches). Parsing lives here so it is unit-tested once and
# reused by both `bin/protected-branches` (generate) and `scripts/parity_check.rb` (verify no drift).
#
# Dependency-free: Ruby standard library only, mirroring scripts/parity_check.rb (ADR 0008).
#
# Contract with PROJECT.md → "## Branch & PR Policy":
#   - the list is authored on the bullet line beginning `- **Protected branches:**`
#   - every `backticked` token on that line UP TO the first ` — ` (em dash) separator is a protected
#     branch; text after the separator is human prose and is ignored.
#
# Returns [] when the section or the line is absent — callers apply their own fail-closed default.

module ProtectedBranches
  SECTION = "## Branch & PR Policy"
  LINE_PREFIX = "- **Protected branches:**"
  EM_DASH = "—"
  BACKTICKED = /`([^`]+)`/.freeze

  module_function

  # Parse the protected-branch names out of PROJECT.md text. Deterministic and order-preserving.
  def extract(text)
    lines = text.to_s.lines.map(&:chomp)
    start = lines.index { |l| l.strip == SECTION }
    return [] unless start

    line = nil
    lines[(start + 1)..].each do |l|
      break if l.start_with?("## ") # the next H2 ends the section
      if l.strip.start_with?(LINE_PREFIX)
        line = l
        break
      end
    end
    return [] unless line

    head = line.split(" #{EM_DASH} ", 2).first # drop prose after the ` — ` separator
    head.scan(BACKTICKED).flatten.map(&:strip).reject(&:empty?).uniq
  end

  def from_file(path)
    extract(File.read(path, encoding: "UTF-8"))
  end
end
