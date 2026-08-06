---
commit: cf3468f728e4e7683bd639c94e53287591fe0620
date: 2026-08-06
checksums:
  - path: skills/assess/SKILL.md
    sha256: 6d4f1670354f027aba3506cf30c082278c12ff62f7384e794f93c05aefe72ccb
  - path: skills/devise/SKILL.md
    sha256: 85bfc4bffdbec899a07baca6661b18f6e10e2d48f60c5a1e9f9cfa416cd4b7e4
  - path: skills/implement/SKILL.md
    sha256: 580a7b0ba3cb1b9dcecc14689b3feb2ddd2648af5a8b48cb1d0683de5b671f88
  - path: skills/verify/SKILL.md
    sha256: 6b65dd4754c44dbe6c4fa4cac4439704516921228090e3f3cf7e85b10225374c
  - path: skills/deliver/SKILL.md
    sha256: eeb656848a03d53fe50acf2560b59f22ce1c1e26679eeb8ad9dd4fecbcf68b48
  - path: skills/distill/SKILL.md
    sha256: de8d5c69b9800bd5d3bc7a8244e2b09ff25168de550d541fc2aeec09cde2f28e
  - path: .githooks/guard-protected-branch
    sha256: 4bf66f4e2b58888e5a5f6a6cbc0d3dcdad0350d82d4f5aa150c55a9084e3daf9
  - path: .githooks/pre-commit
    sha256: de2d71a841cf8baa5ea6cd21652164d81c36eda2e1f720475e22149a9692463b
  - path: .githooks/pre-push
    sha256: de2d71a841cf8baa5ea6cd21652164d81c36eda2e1f720475e22149a9692463b
  - path: .github/ISSUE_TEMPLATE/bug.yml
    sha256: 00d59d888d2c595142674896ceec56723a05aa770e5b23e56bbc40d43cdbbdf2
  - path: .github/ISSUE_TEMPLATE/chore.yml
    sha256: ee59aa8d6f4ce0f9bd24c624ab80344f2b77f6f80a0418375e32afa888baba1f
  - path: .github/ISSUE_TEMPLATE/config.yml
    sha256: 1f103c6a9dd07cd13a9a6f17ace6b813f47747eb9cb7e00488cb2073caaf91bb
  - path: .github/ISSUE_TEMPLATE/epic.yml
    sha256: 4b174eb88bb811a619464208635297a6449241582a488fd97e7894a2523192b5
  - path: .github/ISSUE_TEMPLATE/spike.yml
    sha256: 794b1b0effea57d97eebb60439733d508a551dfdaa3e76946dace23034323dc9
  - path: .github/ISSUE_TEMPLATE/task.yml
    sha256: b976f82296b95243e6d5945332ff3ebed5b510127d9d42de21018912e5051ef8
  - path: AGENTS.md
    sha256: df6059cb14dc43be3916ec69d3f7543746b88662a1bbf3ace787ff92ea79454d
---

# Vendoring receipt

The deuce commit this repository vendored, the date, and a checksum per contract file —
written by the sync, never by hand, and re-written by every sync that merges
([Chapter 5](https://github.com/wrburgess/deuce/blob/main/sds/05-distribution.md) →
*The vendoring receipt*). A checksum mismatch against a contract file is drift: visible,
never forbidden, reported on every sync pull request.
