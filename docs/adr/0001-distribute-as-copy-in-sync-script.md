# Distribute the Config Bundle as a copy-in sync script, not a submodule or gem

**Status:** accepted

The Config Bundle is vendored into a Host App by **copying files in** (via a sync script / template generator), giving the Host App full ownership of the resulting files. We deliberately reject git submodules (annoying; symlink/ownership friction the moment a Host App customizes a bundle-owned file) and a tracked Ruby gem (drift between gem version and copied dotfiles; gems don't naturally own repo-root config surfaces).

We also decided **not** to build automatic upstream update tracking: every Host App applies its own Customization on top of the Generic Baseline, so a "one true upstream version" has little value. Updating is a re-run of the sync followed by a manual merge.

## Consequences

- Adapters must be **real files at expected paths**, not symlinks — the four AI tools read plain files, and copied symlinks are fragile across host layouts. (Feeds the adapter-strategy decision.)
- A Ruby-gem wrapper for versioned distribution can be layered on later without changing the file layout, if greenfield seeding or version pinning becomes a real need.
