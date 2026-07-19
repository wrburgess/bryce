# Offseason Sleep: post-World Series to the earliest watched opening day, weekly heartbeat

While at least one Player is In Season, the Digest is daily — including empty off-days (proof of
life, per ADR 0030). From the end of the World Series the system enters **Offseason Sleep**:
Refresh pauses (no API calls against frozen leagues) and the Digest drops to a weekly heartbeat
("alive; N players watched; games resume ~{next opening day}"), so system health stays observable
within a week at a seventh of the noise. The sleep ends at the **earliest opening day among watched
levels**: NCAA opening day (mid-February) if any NCAA Player is on the watch list, otherwise MLB
Opening Day — daily cadence resumes automatically, with only the newly In Season Players
participating until the other levels start. **Spring-training games are deliberately excluded** —
the Stats API carries them and ADR 0030's capture-everything rule would otherwise ingest them, but
the HC's boundary is real seasons: no spring Stat Lines, and spring training never wakes the
pipeline; do not "fix" this by widening the season. MCP and the REST API stay live through the
sleep — history remains queryable; only the pipeline sleeps.
