#!/usr/bin/env ruby
# frozen_string_literal: true

# summon_reviewer.rb — summon the local Codex CLI as the independent Reviewer (issue #39).
#
# Produces a plan critique (`--mode plan`) or a work review of a branch (`--mode work`) by running the
# LOCAL Codex CLI, classifies the outcome, and writes the reviewer's body to a file. The AC reads the
# classification and posts the body to the lifecycle host.
#
# This script NEVER touches the network and NEVER calls the lifecycle host. That split is deliberate:
# no token handling in a bundled script, no credential prompt mid-run, and the entire failure ladder is
# testable offline against a fake `codex` (scripts/summon_reviewer.test.sh).
#
# Dependency-free: standard library only (no gems, no bundler), per rules/scripting.md, so it runs on a
# bare Ruby in CI.
#
# Usage:
#   ruby scripts/summon_reviewer.rb --mode work --out FILE [--base BRANCH]
#   ruby scripts/summon_reviewer.rb --mode plan --input FILE --out FILE
#     --mode plan|work    plan = critique the plan text in --input; work = review the branch's diff
#     --input FILE        plan mode only: the plan text to critique (required in plan mode)
#     --base BRANCH       work mode only: the branch to review against (default: main)
#     --out FILE          where to write the reviewer's body, raw bytes (required)
#     --codex-bin PATH    the Codex CLI to summon (default: codex, resolved on PATH)
#     --timeout SECONDS   wall-clock cap on the review (default: 900)
#     --ac NAME           the acting agent, so a self-review can be refused (default: claude)
#     --min-bytes N       substance floor on the review body (default: 200; 0 disables)
#
# Output (stdout, ASCII only — rules/scripting.md / ADR 0011), exactly two shapes:
#   summon_reviewer: OK - {mode} review, {n} bytes -> {path}
#   summon_reviewer: FAILED ({classification})        [followed by "  - detail" lines]
# Classifications: ok | not_found | not_authenticated | exit_nonzero | empty_output |
#                  insufficient_output | drain_timeout | timeout | self_review
#   insufficient_output — exit 0 with output too short to be a review (a banner or a "nothing to do"
#                         line), so a CLI that starts and immediately gives up cannot pass as a review.
#   drain_timeout       — the review finished but its stdout could not be read to EOF (a grandchild
#                         still holds the pipe open), so the body was discarded. Distinct from
#                         `empty_output`: the CLI was not silent, we lost what it said.
# Usage errors and an unwritable --out are NOT classifications: they go to stderr and exit 1. Callers
# must therefore branch on the EXIT STATUS (any non-zero = summon failed, fall back to the secondary
# Reviewer), using the classification only to explain which failure it was.
#
# Exit status: 0 when the review succeeded (classification `ok`); 1 for every failure.

require "optparse"

class SummonReviewer
  USAGE = <<~TEXT
    Usage: ruby scripts/summon_reviewer.rb --mode work --out FILE [--base BRANCH]
           ruby scripts/summon_reviewer.rb --mode plan --input FILE --out FILE
  TEXT

  MODES = %w[plan work].freeze

  # Defaults chosen so a bare `--mode work --out FILE` is the common case: review the branch against the
  # host's integration branch, with the CLI resolved from PATH.
  DEFAULT_BASE = "main"
  DEFAULT_CODEX_BIN = "codex"
  DEFAULT_AC = "claude"

  # 15 minutes: a real work review of a large diff routinely runs several minutes, and a cap that fires
  # on a healthy review is worse than no cap — it would burn the Reviewer gate on a false negative.
  DEFAULT_TIMEOUT = 900

  # The auth preflight is a metadata call; if it has not answered in 30s the CLI is not usable, and
  # waiting the full review budget to learn that only delays the fallback Reviewer.
  PREFLIGHT_TIMEOUT = 30

  # The AC whose own work is under review — refusing here is the whole point of --ac. A Reviewer that is
  # the same model as the author is not an independent second model, so the gate would be theatre.
  SELF_REVIEW_AC = "codex"

  # Seconds between waitpid polls. Small enough that a fast review is not padded perceptibly, large
  # enough that a 15-minute wait costs no meaningful CPU.
  POLL_INTERVAL = 0.05

  # Grace between SIGTERM and SIGKILL on a timeout, so the CLI can flush and exit cleanly before it is
  # killed outright.
  TERM_GRACE = 2.0

  # Cap on how long to wait for the output-draining threads after the child is reaped. They finish the
  # instant the pipes close; the cap only guards a pathological grandchild holding a pipe open.
  DRAIN_TIMEOUT = 5.0

  # After the wall-clock deadline passes, wait this long and poll waitpid ONE more time before
  # concluding `timeout`. The poll loop can cross the deadline in the instant a child that has already
  # finished its review is exiting; declaring a timeout there would discard a complete review and burn
  # the gate. A quarter second is invisible against a 900-second cap and closes that race.
  FINAL_POLL_GRACE = 0.25

  # Minimum bytes of stdout that can plausibly BE a review. The Codex CLI prints a workdir/model/
  # provider preamble before it says anything, and "No changes to review." is a legitimate short exit —
  # both are tens of bytes, while a real critique (findings, quoted text, a verdict) runs to hundreds
  # or thousands. 200 sits in that gap: high enough that no banner or one-line bail clears it, low
  # enough that a terse but genuine review does. Deliberately a BYTE floor, not a content heuristic —
  # pattern-matching banners would break on every CLI release and could not be tested honestly.
  # `--min-bytes 0` disables the floor for a caller that wants the old behavior.
  DEFAULT_MIN_BYTES = 200

  # A detail line is context for a human, not a payload: one line, bounded, so a CLI that dumps a
  # thousand lines of trace cannot flood the caller's status output.
  DETAIL_MAX = 200

  # The plan critique prompt. Kept ASCII and explicitly adversarial: the Reviewer's value at the plan
  # gate is finding what the plan MISSES, so a prompt that invites a summary wastes the gate.
  PLAN_CRITIQUE_PROMPT = <<~PROMPT
    You are an independent second-model Reviewer critiquing an implementation plan before any code is
    written. Be adversarial and specific: your job is to find what the plan misses, not to summarize it.

    Report, in markdown:
    1. Must-fix findings - steps too vague to implement without guessing, missing edge cases or sad
       paths, a stated requirement the plan does not address, an unsafe data/schema step, or a risk the
       plan leaves unhandled. Quote the plan text each finding refers to.
    2. Should-consider findings - ordering, test strategy, or structural improvements.
    3. A one-line verdict: APPROVE or REVISE.

    If you find nothing must-fix, say so explicitly rather than inventing a finding.

    The plan follows.

    ----- BEGIN PLAN -----
  PROMPT

  def initialize(mode:, out:, input: nil, base: DEFAULT_BASE, codex_bin: DEFAULT_CODEX_BIN,
                 timeout: DEFAULT_TIMEOUT, ac: DEFAULT_AC, min_bytes: DEFAULT_MIN_BYTES)
    @mode = mode
    @out = out
    @input = input
    @base = base
    @codex_bin = codex_bin
    @timeout = timeout
    @ac = ac
    @min_bytes = min_bytes
  end

  def run
    problem = usage_problem
    return usage_error(problem) if problem

    # Refuse before spawning anything: a self-review is a policy failure, not a CLI failure.
    return failed(:self_review, "acting agent is `#{ascii(@ac)}` - the Reviewer must be a different model") if self_review?

    write_problem = out_path_problem
    return write_error(write_problem) if write_problem

    bin = resolve_bin
    return failed(:not_found, "no executable Codex CLI at `#{ascii(@codex_bin)}`") if bin.nil?

    auth = run_child([bin, "login", "status"], "".b, PREFLIGHT_TIMEOUT)
    return failed(:not_found, "cannot execute `#{ascii(bin)}`", detail(auth[:stderr])) if auth[:status] == :spawn_failed
    unless auth[:status] == :ok
      return failed(:not_authenticated, "`#{ascii(File.basename(bin))} login status` did not confirm a session",
                    detail(auth[:stderr]))
    end

    review = run_child(command_for(bin), stdin_for, @timeout)
    case review[:status]
    when :spawn_failed
      return failed(:not_found, "cannot execute `#{ascii(bin)}`", detail(review[:stderr]))
    when :timeout
      return failed(:timeout, "no review within #{@timeout.round} seconds - child process group terminated")
    when :drain_timeout
      return failed(:drain_timeout,
                    "the Codex CLI exited but its output could not be read within " \
                    "#{DRAIN_TIMEOUT.round} seconds - a surviving child is holding the pipe open",
                    "the review text, if any, was discarded rather than reported as an empty review")
    when :exit_nonzero
      return failed(:exit_nonzero, exit_reason(review[:exit_code]), detail(review[:stderr]))
    end

    body = review[:stdout]
    return failed(:empty_output, "the Codex CLI exited 0 but produced no review text") if blank?(body)

    if body.bytesize < @min_bytes.to_i
      return failed(:insufficient_output,
                    "the Codex CLI exited 0 but produced only #{body.bytesize} bytes " \
                    "(floor: #{@min_bytes.to_i}) - too short to be a review",
                    detail(body))
    end

    begin
      File.binwrite(@out, body)
    rescue SystemCallError, IOError => e
      return write_error("#{ascii(@out)} (#{ascii(e.class.name)})")
    end

    puts "summon_reviewer: OK - #{@mode} review, #{body.bytesize} bytes -> #{ascii(@out)}"
    0
  end

  private

  # --- validation ------------------------------------------------------------

  def usage_problem
    return "missing required --mode (one of: #{MODES.join(', ')})" if @mode.nil? || @mode.to_s.empty?
    return "unknown --mode `#{ascii(@mode)}` (one of: #{MODES.join(', ')})" unless MODES.include?(@mode)
    return "missing required --out FILE" if @out.nil? || @out.to_s.empty?
    return "--timeout must be greater than zero" unless @timeout.to_f.positive?
    return "--min-bytes must be zero or greater" if @min_bytes.to_i.negative?

    if @mode == "plan"
      return "--mode plan requires --input FILE (the plan text to critique)" if @input.nil? || @input.to_s.empty?
      return "--input file not found: #{ascii(@input)}" unless File.file?(@input)
      return "--input file not readable: #{ascii(@input)}" unless File.readable?(@input)
    end
    nil
  end

  def self_review? = @ac.to_s.strip.downcase == SELF_REVIEW_AC

  # Checked BEFORE the CLI is spawned: discovering the destination is unwritable after a 15-minute
  # review would throw away the review itself.
  def out_path_problem
    dir = File.dirname(@out)
    return "#{ascii(dir)} is not a directory" unless File.directory?(dir)
    return "#{ascii(@out)} exists but is not writable" if File.exist?(@out) && !File.writable?(@out)
    return "#{ascii(dir)} is not writable" unless File.writable?(dir)

    nil
  end

  # --- invocation ------------------------------------------------------------

  def command_for(bin)
    if @mode == "work"
      [bin, "review", "--base", @base]
    else
      [bin, "exec"]
    end
  end

  # Built in BINARY throughout. The plan file is read as raw bytes, and interpolating those into a
  # UTF-8 literal only survives while the literal is pure ASCII — add one em dash to the prompt above
  # and every plan containing a non-ASCII byte raises Encoding::CompatibilityError. Assembling the
  # payload in binary removes that trap instead of depending on the prompt staying ASCII forever.
  def stdin_for
    return "".b unless @mode == "plan"

    payload = +"".b
    payload << PLAN_CRITIQUE_PROMPT.b << "\n".b << File.binread(@input) << "\n----- END PLAN -----\n".b
    payload
  end

  # Resolves the CLI the way a shell would: a path-ish argument is taken literally, a bare name is
  # searched on PATH. Returning nil (rather than letting spawn raise ENOENT) keeps `not_found` a
  # classification instead of an exception.
  def resolve_bin
    if @codex_bin.to_s.include?(File::SEPARATOR)
      return @codex_bin if executable_file?(@codex_bin)

      return nil
    end

    ENV.fetch("PATH", "").split(File::PATH_SEPARATOR).each do |dir|
      next if dir.empty?

      candidate = File.join(dir, @codex_bin)
      return candidate if executable_file?(candidate)
    end
    nil
  end

  def executable_file?(path) = File.file?(path) && File.executable?(path)

  # Runs `argv` with `stdin_data` on its stdin under a wall-clock cap, and returns
  # { status: :ok | :exit_nonzero | :timeout | :drain_timeout | :spawn_failed, exit_code:, stdout:, stderr: }.
  #
  # `pgroup: true` puts the child in its own process group so a timeout can signal the WHOLE group with
  # one kill. Killing just the child would leave its grandchildren (a CLI's own workers) orphaned and
  # still running — which is why this cannot be a Timeout.timeout wrapper around a capture helper.
  # Output is drained on threads so a chatty child cannot deadlock against a full pipe buffer, and
  # stdin is FED on a thread for the mirror-image reason: a plan payload larger than the pipe buffer
  # (~16KB on macOS, ~64KB on Linux) blocks in `write` until the child drains it, and a CLI that never
  # reads stdin would hang the summon forever — before the deadline is even being watched.
  def run_child(argv, stdin_data, timeout)
    in_r, in_w = IO.pipe
    out_r, out_w = IO.pipe
    err_r, err_w = IO.pipe

    begin
      pid = Process.spawn(*argv, in: in_r, out: out_w, err: err_w, pgroup: true)
    rescue SystemCallError => e
      # The CLI resolved a moment ago but is not executable now (deleted, permissions changed, bad
      # interpreter). Letting spawn raise would print a Ruby backtrace instead of a classification.
      return { status: :spawn_failed, exit_code: nil, stdout: "".b, stderr: e.message.to_s.b }
    end
    [in_r, out_w, err_w].each(&:close)

    out_thread = Thread.new { out_r.binmode; out_r.read }
    err_thread = Thread.new { err_r.binmode; err_r.read }
    in_thread = Thread.new { feed_stdin(in_w, stdin_data) }

    exited, status = wait_with_timeout(pid, timeout)
    unless exited
      kill_group(pid)
      [in_thread, out_thread, err_thread].each(&:kill)
      return { status: :timeout, exit_code: nil, stdout: "".b, stderr: "".b }
    end

    in_thread.kill unless in_thread.join(DRAIN_TIMEOUT)
    stdout, stdout_drained = drain(out_thread)
    stderr, = drain(err_thread)
    # `success?`, not `exitstatus.zero?`: a child killed by a signal reports a nil exitstatus, and
    # `nil.to_i.zero?` would classify that abnormal death as a clean, empty review.
    code = status.respond_to?(:exitstatus) ? status.exitstatus : nil
    ok = status.respond_to?(:success?) && status.success?
    # A stdout drain that timed out is NOT an empty review: the reader was still blocked on a pipe a
    # surviving grandchild holds open, so whatever the CLI wrote is lost, not absent. Reporting that as
    # `empty_output` would blame a CLI that did its job.
    if ok && !stdout_drained
      # Something in the child's group outlived it holding the pipe — the same orphan the timeout path
      # kills, arriving by a different door. Signal the group so the summon does not leave it running.
      terminate_group(pid)
      return { status: :drain_timeout, exit_code: code, stdout: "".b, stderr: stderr }
    end


    { status: ok ? :ok : :exit_nonzero, exit_code: code, stdout: stdout, stderr: stderr }
  ensure
    [in_r, in_w, out_r, out_w, err_r, err_w].each { |io| io.close unless io.nil? || io.closed? }
  end

  def feed_stdin(io, data)
    io.binmode
    io.write(data)
  rescue Errno::EPIPE, IOError
    # The child exited (or never read stdin) before we finished writing; its exit status is what matters.
    nil
  ensure
    io.close unless io.closed?
  end

  def wait_with_timeout(pid, timeout)
    deadline = monotonic + timeout.to_f
    loop do
      return [true, $?] if Process.waitpid(pid, Process::WNOHANG)
      return final_poll(pid) if monotonic >= deadline

      sleep POLL_INTERVAL
    end
  rescue Errno::ECHILD
    [true, nil]
  end

  # One last look after the deadline, FINAL_POLL_GRACE later. The loop above can cross the deadline in
  # the very instant a child that has already written its whole review is exiting; concluding `timeout`
  # there would kill it and throw the review away for a few hundredths of a second.
  def final_poll(pid)
    sleep FINAL_POLL_GRACE
    return [true, $?] if Process.waitpid(pid, Process::WNOHANG)

    [false, nil]
  rescue Errno::ECHILD
    [true, nil]
  end

  def kill_group(pid)
    Process.kill("-TERM", pid)
    grace = monotonic + TERM_GRACE
    until monotonic >= grace
      return if Process.waitpid(pid, Process::WNOHANG)

      sleep POLL_INTERVAL
    end
    Process.kill("-KILL", pid)
    Process.waitpid(pid)
  rescue Errno::ESRCH, Errno::ECHILD
    nil
  end

  # Returns [bytes, drained?]. `drained?` is false when the reader thread missed DRAIN_TIMEOUT — the
  # caller needs to tell "the CLI said nothing" from "we could not hear what the CLI said".
  # Signals the child's process group without waiting on it — the leader is already reaped here, so
  # there is nothing left to reap; only its survivors need telling.
  def terminate_group(pid)
    Process.kill("-TERM", pid)
  rescue Errno::ESRCH, Errno::EPERM
    nil
  end

  def drain(thread)
    return (thread.kill; ["".b, false]) unless thread.join(DRAIN_TIMEOUT)

    [thread.value.to_s.b, true]
  rescue IOError, SystemCallError
    # The pipe was torn down under the reader; partial output is not worth crashing the run over.
    ["".b, true]
  end

  def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

  # --- output ----------------------------------------------------------------

  def failed(classification, *details)
    puts "summon_reviewer: FAILED (#{classification})"
    details.compact.reject(&:empty?).each { |d| puts "  - #{d}" }
    1
  end

  def usage_error(message)
    warn "summon_reviewer: usage error - #{message}"
    warn USAGE
    1
  end

  def write_error(message)
    warn "summon_reviewer: cannot write output - #{message}"
    1
  end

  # Emptiness is decided on BYTES, so a runner on a non-UTF-8 locale can never raise while classifying.
  def blank?(bytes) = bytes.to_s.b.strip.empty?

  # A child killed by a signal has no exit code — say so rather than printing "exited ".
  def exit_reason(code)
    code.nil? ? "the Codex CLI terminated abnormally (killed by a signal)" : "the Codex CLI exited #{code}"
  end

  # The last non-empty line of a CLI's stderr — where a CLI puts the reason it failed — rendered
  # ASCII-safe and bounded for a status line.
  def detail(stderr)
    line = readable(stderr).split(/\r?\n/).map(&:strip).reject(&:empty?).last
    return nil if line.nil?

    ascii(line)
  end

  # A UTF-8 view of raw subprocess bytes that is always safe to regex/split, whatever the runner's
  # locale: bytes are re-tagged as UTF-8 and any invalid sequence is replaced rather than raised on.
  def readable(bytes)
    text = bytes.to_s.dup.force_encoding(Encoding::UTF_8)
    return text if text.valid_encoding?

    text.encode(Encoding::UTF_8, invalid: :replace, undef: :replace, replace: "?")
  end

  # ASCII-only rendering for anything bound for stdout/stderr (rules/scripting.md, ADR 0011): a Host App
  # or CI runner on a non-UTF-8 locale raises `invalid byte sequence` the moment it matches our output.
  def ascii(text)
    flat = text.to_s.dup.force_encoding(Encoding::BINARY).gsub(/[^\x20-\x7E]/n, "?")
    flat = "#{flat[0, DETAIL_MAX]}..." if flat.length > DETAIL_MAX
    flat.force_encoding(Encoding::UTF_8)
  end
end

if $PROGRAM_NAME == __FILE__
  options = {
    mode: nil, input: nil, base: SummonReviewer::DEFAULT_BASE, out: nil,
    codex_bin: SummonReviewer::DEFAULT_CODEX_BIN, timeout: SummonReviewer::DEFAULT_TIMEOUT,
    ac: SummonReviewer::DEFAULT_AC, min_bytes: SummonReviewer::DEFAULT_MIN_BYTES
  }

  parser = OptionParser.new do |opts|
    opts.banner = SummonReviewer::USAGE
    opts.on("--mode MODE", "plan (critique --input) or work (review --base)") { |v| options[:mode] = v }
    opts.on("--input FILE", "plan mode: the plan text to critique") { |v| options[:input] = v }
    opts.on("--base BRANCH", "work mode: branch to review against (default: #{SummonReviewer::DEFAULT_BASE})") { |v| options[:base] = v }
    opts.on("--out FILE", "where to write the review body (raw bytes)") { |v| options[:out] = v }
    opts.on("--codex-bin PATH", "Codex CLI to summon (default: #{SummonReviewer::DEFAULT_CODEX_BIN})") { |v| options[:codex_bin] = v }
    opts.on("--timeout SECONDS", Float, "wall-clock cap (default: #{SummonReviewer::DEFAULT_TIMEOUT})") { |v| options[:timeout] = v }
    opts.on("--ac NAME", "acting agent (default: #{SummonReviewer::DEFAULT_AC})") { |v| options[:ac] = v }
    opts.on("--min-bytes N", Integer,
            "substance floor on the review body, 0 disables (default: #{SummonReviewer::DEFAULT_MIN_BYTES})") do |v|
      options[:min_bytes] = v
    end
  end

  begin
    parser.parse!(ARGV)
  rescue OptionParser::ParseError => e
    # OptionParser raises on an unknown flag or a bad --timeout; an uncaught raise would print a Ruby
    # backtrace, which is not a usable error message for a caller.
    warn "summon_reviewer: usage error - #{e.message}"
    warn SummonReviewer::USAGE
    exit 1
  end

  exit SummonReviewer.new(**options).run
end
