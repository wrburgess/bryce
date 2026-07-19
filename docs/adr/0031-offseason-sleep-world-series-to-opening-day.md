# Offseason Sleep: post-World Series to MLB Opening Day, weekly heartbeat

While at least one Player is In Season, the Digest is daily — including empty off-days (proof of
life, per ADR 0030). From the end of the World Series to MLB Opening Day the system enters
**Offseason Sleep**: Refresh pauses (no API calls against a frozen league) and the Digest drops to
a weekly heartbeat ("alive; N players watched; games resume ~Opening Day"), so system health stays
observable within a week at a seventh of the noise. Daily cadence resumes automatically at Opening
Day. **Spring-training games are deliberately excluded** — the Stats API carries them and ADR
0030's capture-everything rule would otherwise ingest them, but the HC's boundary is the regular
season: no spring Stat Lines, no early wake; do not "fix" this by widening the season. MCP and the
REST API stay live through the sleep — history remains queryable; only the pipeline sleeps.

Open (Phase 3): NCAA's mid-February start falls inside the sleep window; whether an In Season NCAA
Player wakes the pipeline early is decided when the NCAA adapter is distilled.
