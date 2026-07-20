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
#   insufficient_output — exit 0 with output too short to be a review (a "nothing to do" line, or a
#                         preamble and nothing else), so a CLI that starts and immediately gives up
#                         cannot pass as a review.
#   drain_timeout       — the review finished but its stdout could not be read to EOF (a grandchild
#                         still holds the pipe open), so the body is not accepted as the review. The
#                         bytes that DID arrive are reported (see `drain_loss_detail`) rather than
#                         silently dropped. Distinct from `empty_output`: the CLI was not silent, we
#                         could not hear all of what it said.
# Usage errors and an unwritable --out are NOT classifications: they go to stderr and exit 1. Callers
# must therefore branch on the EXIT STATUS (any non-zero = summon failed, fall back to the secondary
# Reviewer), using the classification only to explain which failure it was.
#
# --out is CLEARED before the CLI is spawned, INCLUDING on the usage-error paths. The path is reused
# across summons, so a failed run must not leave a previous run's review sitting there to be mistaken
# for this one's: no body file means no review, on every failure path. The final write is ATOMIC
# (temp file in the same directory, then rename), so a write that dies part way leaves no truncated
# review behind either, and a concurrent reader never sees a half-written body.
#
# --input and --out may NOT name the same file (compared on resolved paths, so `./p.md`, `p.md` and a
# symlink to either collide): the clear above would destroy the plan before it is read. That is a
# usage error, and it is refused BEFORE anything is cleared.
#
# Every CLI invocation is pinned to the Codex sandbox mode `read-only`, so the Reviewer cannot write
# to the repository it is reviewing whatever the local Codex config or profile allows.
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

  # Bound on letting a killed reader thread unwind before its buffer is read. The reader appends as
  # bytes arrive, so the buffer must not be read while a `Thread#kill` is still in flight.
  KILL_JOIN_TIMEOUT = 0.5

  # Bytes per read from a child's stdout/stderr. Read incrementally rather than in one blocking `read`
  # so that hitting DRAIN_TIMEOUT costs only what had NOT yet arrived, never what had.
  READ_CHUNK = 65_536

  # After the wall-clock deadline passes, wait this long and poll waitpid ONE more time before
  # concluding `timeout`. The poll loop can cross the deadline in the instant a child that has already
  # finished its review is exiting; declaring a timeout there would discard a complete review and burn
  # the gate. This NARROWS that race, it does not close it: a child that exits within FINAL_POLL_GRACE
  # of the deadline is kept, one that exits later is still killed. One second is invisible against a
  # 900-second cap, and the failure it guards (throwing away a finished review) is far worse than the
  # failure it costs (one extra second before declaring a timeout that was real).
  FINAL_POLL_GRACE = 1.0

  # Minimum bytes of stdout that can plausibly BE a review. MEASURED against the real CLI on this
  # branch: `codex review --base main` returned exit 0 with 3032 bytes after 8m26s, and its stdout
  # carried NO preamble or banner — the output began directly with review prose. So the floor is not
  # sized against a banner (there is none to size against); it exists because exit 0 with a near-empty
  # stdout is indistinguishable from a review unless something checks. What it catches is the short
  # bail — "No changes to review." and its kin, tens of bytes — and any future release that prints a
  # preamble and nothing else. 200 is kept against that 3032-byte measurement: a real review clears it
  # by 15x, and the plan-critique prompt below demands quoted findings plus a verdict, which cannot fit
  # in 200 bytes. The one real tradeoff left: a genuinely terse review ("LGTM, no findings", ~58 bytes)
  # is refused. That is the safe direction to fail — a refused terse review degrades to the flagged
  # fallback, which is MORE review, whereas an accepted one-line bail passes the gate with none at all.
  # Deliberately a BYTE floor, not a content heuristic — pattern-matching output would break on every
  # CLI release and could not be tested honestly. `--min-bytes 0` disables the floor for a caller that
  # wants the old behavior.
  DEFAULT_MIN_BYTES = 200

  # A detail line is context for a human, not a payload: one line, bounded, so a CLI that dumps a
  # thousand lines of trace cannot flood the caller's status output. It bounds DETAIL LINES only —
  # never a path or an identifier, which must be rendered whole to be usable (see `ascii` vs `bounded`).
  DETAIL_MAX = 200

  # Every long flag the option parser below defines, ALL of which take a value. Used only by
  # `recover_path_options` to walk a rejected command line the way OptionParser would have.
  # KEEP IN SYNC with the `opts.on` block at the bottom of this file — a flag missing from this list
  # only makes the recovery more conservative (its value is re-examined as if it were a flag), never
  # more destructive, so drift degrades toward doing nothing rather than toward deleting the wrong file.
  VALUE_FLAGS = %w[--mode --input --base --out --codex-bin --timeout --ac --min-bytes].freeze

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
    # Checked FIRST, ahead of everything below that clears --out. When --out and --input name the
    # same file, clearing the destination DELETES the plan this run was asked to critique — and the
    # loss is silent, because the clear is precisely what makes the later read find nothing.
    alias_problem = out_aliases_input
    return usage_error(alias_problem) if alias_problem

    problem = usage_problem
    # Only meaningful once --out is known to be present and well-formed, so it is skipped when
    # usage validation already has something to say.
    write_problem = problem ? nil : out_path_problem

    # Clear the destination before ANY failure return, INCLUDING a usage error. --out is reused
    # across summons, so a non-zero exit that leaves the previous run's review sitting there is the
    # stale-body failure this clear exists to prevent — and a malformed command is the LIKELIEST
    # failure in practice, not an exemption from the invariant. This is safe here only because the
    # aliasing check above already refused the one case where clearing destroys an input.
    clear_problem = clear_out

    return usage_error(problem) if problem
    return write_error(write_problem) if write_problem
    return write_error(clear_problem) if clear_problem

    # Refuse before spawning anything: a self-review is a policy failure, not a CLI failure.
    return failed(:self_review, "acting agent is `#{ascii(@ac)}` - the Reviewer must be a different model") if self_review?

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
                    drain_loss_detail(review[:stdout]))
    when :exit_nonzero
      return failed(:exit_nonzero, exit_reason(review[:exit_code]), detail(review[:stderr]))
    end

    body = review[:stdout]
    substance = substance_of(body)
    return failed(:empty_output, "the Codex CLI exited 0 but produced no review text") if substance.empty?

    if substance.bytesize < @min_bytes.to_i
      return failed(:insufficient_output,
                    "the Codex CLI exited 0 but produced only #{substance.bytesize} bytes of review " \
                    "text (floor: #{@min_bytes.to_i}) - too short to be a review",
                    detail(body))
    end

    body_problem = write_body(body)
    return write_error(body_problem) if body_problem

    puts "summon_reviewer: OK - #{@mode} review, #{body.bytesize} bytes -> #{ascii(@out)}"
    0
  end

  # Clears --out after the OPTION PARSER rejected the command line, before `run` is ever reached.
  # An unrecognised flag or an unparseable --timeout is a usage error like any other and exits
  # non-zero the same way, so it must not leave the previous run's review readable at a reused
  # --out either — the invariant cannot depend on which of the two validation paths caught the
  # mistake. Subject to the SAME aliasing guard as `run`: a half-parsed command line is exactly
  # where an aliased --out/--input pair would otherwise be destroyed for nothing. OptionParser
  # consumes left to right, so --out may not have been seen at all, in which case this is a no-op.
  def clear_stale_out
    return if out_aliases_input

    clear_out
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

  # Refuses --input and --out naming the SAME file. `clear_out` deletes the destination before the
  # CLI is spawned, and `stdin_for` reads the input AFTER that — so an aliased pair silently
  # destroys the plan and then critiques nothing. Checked in EVERY mode, not just plan mode: a
  # mode-scoped check would skip a run whose --mode is itself invalid (`--mode bogus --input p
  # --out p`), and that run still reaches the clear.
  #
  # Compared on RESOLVED paths, never on the strings the caller typed: `plan.md`, `./plan.md`,
  # `../dir/plan.md` and a symlink pointing at any of them are spellings of ONE file, and a string
  # compare would wave three of the four straight through to the clear.
  def out_aliases_input
    return nil if blank?(@input) || blank?(@out)
    return nil unless resolved_path(@input) == resolved_path(@out)

    "--input and --out name the same file (#{ascii(@out)}) - refusing, because clearing --out " \
      "would destroy the input this run was given"
  end

  # The canonical path, as far as the filesystem can answer. `File.realpath` resolves symlinks but
  # RAISES on a path that does not exist — which --out usually does not, and a broken symlink never
  # does. So a missing leaf falls back to a realpath'd DIRECTORY plus the literal basename (which
  # still collapses `.`, `..` and a symlinked parent), and a missing directory to `expand_path`,
  # which at least makes both sides absolute. Each step is strictly weaker than the one before it,
  # so the comparison degrades rather than raising.
  def resolved_path(path)
    File.realpath(path)
  rescue SystemCallError
    begin
      File.join(File.realpath(File.dirname(path)), File.basename(path))
    rescue SystemCallError
      File.expand_path(path)
    end
  end

  def blank?(value) = value.nil? || value.to_s.empty?

  # Checked BEFORE the CLI is spawned: discovering the destination is unwritable after a 15-minute
  # review would throw away the review itself.
  def out_path_problem
    dir = File.dirname(@out)
    return "#{ascii(dir)} is not a directory" unless File.directory?(dir)
    return "#{ascii(@out)} exists but is not writable" if File.exist?(@out) && !File.writable?(@out)
    return "#{ascii(dir)} is not writable" unless File.writable?(dir)

    nil
  end

  # Removes anything already at --out, BEFORE the CLI is spawned. The AC reuses one --out path across
  # summons, so a run that fails after an earlier success would otherwise leave the PREVIOUS review
  # sitting there, where it reads as this run's critique — the worst possible failure for this script,
  # since a stale review looks exactly like a fresh one. "A failed summon leaves no body" has to hold
  # against a REUSED path, not just a fresh one, so the clear happens up front rather than on each of
  # the eight failure returns — and on the USAGE-error returns too, which exit non-zero like any
  # other failure and are the likeliest failure an operator actually hits.
  #
  # Guarded on a blank --out because it now runs BEFORE the usage error for a missing --out is
  # returned; `File.exist?(nil)` would raise a TypeError where a usage message belongs.
  def clear_out
    return nil if blank?(@out)

    File.delete(@out) if File.exist?(@out)
    nil
  rescue SystemCallError, IOError => e
    "#{ascii(@out)} could not be cleared (#{ascii(e.class.name)})"
  end

  # Writes the review to --out ATOMICALLY: a temp file in the SAME directory (so the rename is a
  # metadata operation on one filesystem, never a copy), then `File.rename`. Two failures close
  # here. A write that dies PART WAY — a full filesystem, an exceeded file-size limit — used to
  # leave a TRUNCATED review at --out under a non-zero exit, which is the stale-body failure again
  # wearing a different hat: a caller cannot tell a half-written critique from a whole one. And a
  # concurrent reader could observe a body mid-write. Rename makes --out go from absent to complete
  # in one step, and the partial is discarded on the failure path, so no body still means no review.
  #
  # The temp name is FIXED-LENGTH (pid, not the basename): deriving it from a long --out basename
  # would push it past NAME_MAX and fail a write that used to succeed, turning a crash-safety fix
  # into a new failure. The pid keeps two summons sharing one directory from colliding.
  def write_body(body)
    tmp = File.join(File.dirname(@out), ".summon_reviewer.#{Process.pid}.tmp")
    begin
      File.binwrite(tmp, body)
      File.rename(tmp, @out)
      nil
    rescue SystemCallError, IOError => e
      discard(tmp)
      "#{ascii(@out)} (#{ascii(e.class.name)})"
    end
  end

  # Best-effort removal of the temp file on the write failure path. Deliberately silent: a failure
  # to clean up must not mask the write failure that caused it.
  def discard(path)
    File.delete(path) if File.exist?(path)
  rescue SystemCallError, IOError
    nil
  end

  # --- invocation ------------------------------------------------------------

  # EVERY invocation is pinned to the CLI's read-only sandbox. The Reviewer must not be able to
  # write to the repository it is reviewing, and the prompt cannot enforce that — prompt wording is
  # not an enforcement boundary. Without an explicit policy both commands INHERIT whatever the local
  # `config.toml` or profile left them, and plan mode runs the GENERIC `codex exec` agent, which
  # under `workspace-write` or `danger-full-access` can edit the tree or run side-effecting commands
  # BEFORE Stage 3 has written a line.
  #
  # Two mechanisms because the two subcommands expose different ones, verified against codex-cli
  # 0.144.6 rather than assumed:
  #   - `codex exec` takes `-s/--sandbox`, enum-validated by the arg parser
  #     (`read-only | workspace-write | danger-full-access`).
  #   - `codex review` has NO `-s` flag, so it is pinned through `-c`, which the same enum validates
  #     at config load (a bad value errors with `unknown variant ... in sandbox_mode`).
  # Both forms override a profile: measured with a profile setting `danger-full-access`, the run
  # header reported `sandbox: read-only` with either flag, and `sandbox: danger-full-access` with
  # neither. A typo cannot fail open — both mechanisms reject an unknown value loudly.
  SANDBOX_MODE = "read-only"
  SANDBOX_CONFIG = %(sandbox_mode="#{SANDBOX_MODE}").freeze

  def command_for(bin)
    if @mode == "work"
      [bin, "review", "-c", SANDBOX_CONFIG, "--base", @base]
    else
      [bin, "exec", "-s", SANDBOX_MODE]
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

    out_buffer = +"".b
    err_buffer = +"".b
    out_thread = Thread.new { read_into(out_r, out_buffer) }
    err_thread = Thread.new { read_into(err_r, err_buffer) }
    in_thread = Thread.new { feed_stdin(in_w, stdin_data) }

    exited, status = wait_with_timeout(pid, timeout)
    unless exited
      kill_group(pid)
      [in_thread, out_thread, err_thread].each(&:kill)
      return { status: :timeout, exit_code: nil, stdout: "".b, stderr: "".b }
    end

    in_thread.kill unless in_thread.join(DRAIN_TIMEOUT)
    stdout, stdout_drained = drain(out_thread, out_buffer)
    stderr, = drain(err_thread, err_buffer)
    # `success?`, not `exitstatus.zero?`: a child killed by a signal reports a nil exitstatus, and
    # `nil.to_i.zero?` would classify that abnormal death as a clean, empty review.
    code = status.respond_to?(:exitstatus) ? status.exitstatus : nil
    ok = status.respond_to?(:success?) && status.success?
    # A stdout drain that timed out is NOT an empty review: the reader was still blocked on a pipe a
    # surviving grandchild holds open, so whatever the CLI wrote is lost, not absent. Reporting that as
    # `empty_output` would blame a CLI that did its job.
    if ok && !stdout_drained
      # Something in the child's group outlived it holding the pipe — the same orphan the timeout path
      # kills, arriving by a different door. Terminate the group (leader already reaped) so the summon
      # does not leave it running, and carry the bytes that DID arrive so the caller can report the
      # size of what was lost instead of pretending nothing was said.
      kill_group(pid, reap_leader: false)
      return { status: :drain_timeout, exit_code: code, stdout: stdout, stderr: stderr }
    end

    # EVERY exit path, not just the timeout and drain paths. The leader exiting with both pipes at
    # EOF proves only that the LEADER is done: a CLI that backgrounds a worker which closes its
    # inherited stdout/stderr lets both drains reach EOF and the leader exit 0, so a clean success
    # arrives here with a process still running in the group. `pgroup: true` exists to make that
    # killable, and until now nothing on this path killed it — the summon returned OK and leaked it
    # into the caller's session.
    sweep_group(pid)
    { status: ok ? :ok : :exit_nonzero, exit_code: code, stdout: stdout, stderr: stderr }
  ensure
    [in_r, in_w, out_r, out_w, err_r, err_w].each { |io| io.close unless io.nil? || io.closed? }
  end

  # Reads `io` to EOF, appending into `buffer` as the bytes arrive. Deliberately NOT a single blocking
  # `io.read`: that returns nothing at all if the thread is killed at the drain cap, so a review that
  # had already been received IN FULL would be thrown away by a grandchild holding the pipe open.
  # Appending incrementally means whatever arrived survives the cap.
  def read_into(io, buffer)
    io.binmode
    loop { buffer << io.readpartial(READ_CHUNK) }
  rescue EOFError
    nil
  rescue IOError, SystemCallError
    # The pipe was torn down under the reader; what was already buffered is still valid.
    nil
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
  # there would kill it and throw the review away over a fraction of a second.
  #
  # This NARROWS that race to FINAL_POLL_GRACE — it does not close it, and calling it closed would be
  # an overclaim. Measured on this branch: a child exiting at deadline + 0.1s is kept, one exiting at
  # deadline + 0.4s under the old quarter-second grace was still killed. The window is exactly
  # FINAL_POLL_GRACE wide and a child that lands outside it is timed out, correctly or not.
  def final_poll(pid)
    sleep FINAL_POLL_GRACE
    return [true, $?] if Process.waitpid(pid, Process::WNOHANG)

    [false, nil]
  rescue Errno::ECHILD
    [true, nil]
  end

  # Terminates the child's WHOLE process group: SIGTERM, a grace period, then SIGKILL — and it does not
  # stop early just because the LEADER exited. A descendant that ignores SIGTERM outlives its leader, so
  # reaping the leader proves nothing about the group; only an EMPTY GROUP does. Returning on the
  # leader's death alone would skip the SIGKILL escalation and leave that descendant running after the
  # summon reported a timeout — which is exactly the orphan `pgroup: true` exists to prevent.
  # `reap_leader: false` is the drain path, where the leader is already reaped and only its survivors
  # need telling.
  def kill_group(pid, reap_leader: true)
    signal_group("-TERM", pid)
    reaped = !reap_leader
    grace = monotonic + TERM_GRACE
    until monotonic >= grace
      reaped ||= reap(pid)
      return if reaped && group_gone?(pid)

      sleep POLL_INTERVAL
    end
    signal_group("-KILL", pid)
    # SIGKILL cannot be caught or ignored, so this blocking reap returns promptly and leaves no zombie.
    Process.waitpid(pid) unless reaped
  rescue Errno::ECHILD
    nil
  end

  # Terminates whatever is STILL in the child's group once the leader has been reaped. PROBED first,
  # so the overwhelmingly common case — an empty group — costs one signal-0 and adds no delay to a
  # healthy review; only a group with survivors pays the TERM/grace/KILL ladder. `reap_leader:
  # false` because the leader is already reaped by here: only its survivors need telling.
  #
  # The residual hazard is PID reuse — the reaped leader's pid could in principle name a different
  # group by the time it is signalled. That window is the same one the drain path has always had,
  # and it is bounded by how fast the OS recycles a pid through its whole space, which is not a
  # thing that happens between a `waitpid` and the next syscall.
  def sweep_group(pid)
    kill_group(pid, reap_leader: false) unless group_gone?(pid)
  end

  # Signals the process group led by `pid`. A group that is already gone (or was never ours to signal)
  # is not an error — it is the outcome the caller wanted.
  def signal_group(signal, pid)
    Process.kill(signal, pid)
    true
  rescue Errno::ESRCH, Errno::EPERM
    false
  end

  # True when NO process remains in the group. Signal 0 is a liveness probe, not a signal: it runs the
  # existence and permission checks and delivers nothing. This is the only honest way to verify a group
  # kill actually took — a reaped leader says nothing about its descendants.
  def group_gone?(pid)
    Process.kill(0, -pid)
    false
  rescue Errno::ESRCH
    true
  rescue Errno::EPERM
    false
  end

  # Reaps the leader if it has exited, without blocking. True once it is reaped (or was never ours), so
  # the caller can tell "leader still running" from "leader done, group not".
  def reap(pid)
    !Process.waitpid(pid, Process::WNOHANG).nil?
  rescue Errno::ECHILD
    true
  end

  # Returns [bytes, drained?]. `drained?` is false when the reader thread missed DRAIN_TIMEOUT — the
  # caller needs to tell "the CLI said nothing" from "we could not hear all of what the CLI said". The
  # bytes come from the shared buffer either way, so a missed cap costs only what had not yet arrived.
  def drain(thread, buffer)
    drained = !thread.join(DRAIN_TIMEOUT).nil?
    unless drained
      thread.kill
      # Let the killed reader unwind before the buffer is read: `Thread#kill` is asynchronous, and
      # reading a buffer a reader may still be appending to is a data race, not a shortcut.
      thread.join(KILL_JOIN_TIMEOUT)
    end
    [buffer.dup.b, drained]
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

  # The review text with surrounding whitespace removed, in BINARY so a runner on a non-UTF-8 locale can
  # never raise while classifying. Emptiness AND the substance floor are both decided on this, so there
  # is ONE notion of "content": measuring emptiness after a strip but the floor before it would let
  # ~200 bytes of padding plus a single token clear a floor whose entire job is to demand substance.
  def substance_of(bytes) = bytes.to_s.b.strip

  # What was actually in hand when the drain cap fired. The reader buffers incrementally, so a pipe held
  # open no longer costs the bytes that DID arrive — but they are still not accepted as the review: a
  # stream someone is holding open cannot be called finished, and a truncated critique passed off as
  # complete is worse than a flagged failure. Reporting the count keeps the loss visible, not silent.
  def drain_loss_detail(partial)
    received = partial.to_s.bytesize
    return "no review text had been received when the cap fired" if received.zero?

    "#{received} bytes of review text had been received when the cap fired - not written to --out, " \
      "because output still being held open cannot be called complete"
  end

  # A child killed by a signal has no exit code — say so rather than printing "exited ".
  def exit_reason(code)
    code.nil? ? "the Codex CLI terminated abnormally (killed by a signal)" : "the Codex CLI exited #{code}"
  end

  # The last non-empty line of a CLI's stderr — where a CLI puts the reason it failed — rendered
  # ASCII-safe and bounded for a status line.
  def detail(stderr)
    line = readable(stderr).split(/\r?\n/).map(&:strip).reject(&:empty?).last
    return nil if line.nil?

    bounded(line)
  end

  # A UTF-8 view of raw subprocess bytes that is always safe to regex/split, whatever the runner's
  # locale: bytes are re-tagged as UTF-8 and any invalid sequence is replaced rather than raised on.
  def readable(bytes)
    text = bytes.to_s.dup.force_encoding(Encoding::UTF_8)
    return text if text.valid_encoding?

    text.encode(Encoding::UTF_8, invalid: :replace, undef: :replace, replace: "?")
  end

  def ascii(text) = self.class.ascii(text)

  def bounded(text) = self.class.bounded(text)

  # ASCII-only rendering for anything bound for stdout/stderr (rules/scripting.md, ADR 0011): a Host App
  # or CI runner on a non-UTF-8 locale raises `invalid byte sequence` the moment it matches our output.
  #
  # Length is PRESERVED. DETAIL_MAX bounds detail lines (see `bounded`), never a path or an identifier:
  # truncating a 250-character `--out` would print a path the caller cannot use while the file was
  # written to the real one — a rendering cap silently becoming a correctness bug.
  #
  # A module function because the top-level option parsing needs it before any instance exists; the
  # instance delegates rather than duplicating it.
  def self.ascii(text)
    text.to_s.dup.force_encoding(Encoding::BINARY).gsub(/[^\x20-\x7E]/n, "?").force_encoding(Encoding::UTF_8)
  end

  # ASCII-rendered AND length-bounded — for a status DETAIL line, which is context for a human, not a
  # payload, so a CLI that dumps a thousand lines of trace cannot flood the caller's status output.
  def self.bounded(text)
    flat = ascii(text)
    flat.length > DETAIL_MAX ? "#{flat[0, DETAIL_MAX]}..." : flat
  end

  # Recovers `--out` and `--input` from a command line OptionParser REFUSED, so `clear_stale_out` has
  # something to work with. OptionParser consumes left to right and raises on the first bad token, so
  # `--mode work --nonsense --out reused.md` never reaches --out: the parsed options carry no
  # destination, the clear no-ops, and the previous run's review survives a non-zero exit — the exact
  # stale body the clear exists to prevent. Order of arguments must not decide whether an invariant
  # holds, so the destination is recovered by walking the ORIGINAL argv independently of the parser.
  #
  # BOTH paths are recovered, never --out alone: the aliasing guard (`out_aliases_input`) reads
  # --input, and recovering a destination without the input that might alias it would hand the clear a
  # path it must refuse to delete. Recovering the pair keeps that refusal intact on this path too.
  #
  # This walks the argv the way OptionParser does rather than grepping for the flag: every flag above
  # takes a value, so a `--flag VALUE` pair is stepped over as a unit and a `--out` sitting in VALUE
  # position (`--ac --out`) is read as the value it is, not as a destination to delete. `--` ends
  # option parsing. Where a malformed line leaves the destination genuinely ambiguous this returns
  # nothing and the clear no-ops: failing to delete a path the caller never clearly named is the safe
  # direction, deleting one they did not is not.
  def self.recover_path_options(argv)
    found = {}
    index = 0
    while index < argv.length
      token = argv[index].to_s
      break if token == "--"

      flag, separator, inline = token.partition("=")
      unless VALUE_FLAGS.include?(flag)
        index += 1
        next
      end

      value = separator.empty? ? argv[index + 1] : inline
      found[flag] = value if %w[--out --input].include?(flag) && !value.nil?
      index += separator.empty? ? 2 : 1
    end
    found
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

  # `parse!` MUTATES ARGV as it consumes it, so the original is captured before the parse rather than
  # read back from the wreckage afterwards.
  original_argv = ARGV.dup

  begin
    parser.parse!(ARGV)
  rescue OptionParser::ParseError => e
    # OptionParser raises on an unknown flag or a bad --timeout; an uncaught raise would print a Ruby
    # backtrace, which is not a usable error message for a caller. The message quotes the offending
    # ARGUMENT back, so it carries whatever bytes the caller typed — it goes through the same ASCII
    # rendering as every other message, or a non-ASCII flag puts raw bytes on stderr.
    #
    # Fill in only what the parser never reached (`||=`): anything it DID consume is authoritative,
    # so this can add a destination to clear but can never redirect the clear at a different path
    # than the parse already established.
    recovered = SummonReviewer.recover_path_options(original_argv)
    options[:out] ||= recovered["--out"]
    options[:input] ||= recovered["--input"]
    SummonReviewer.new(**options).clear_stale_out
    warn "summon_reviewer: usage error - #{SummonReviewer.bounded(e.message)}"
    warn SummonReviewer::USAGE
    exit 1
  end

  exit SummonReviewer.new(**options).run
end
