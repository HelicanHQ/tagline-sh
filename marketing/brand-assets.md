# Brand assets — Marketplace submission

Checklist for the GitHub Apps Marketplace listing submission (W5 in [v0.2 plan](../docs/PLAN.md) — week 4–6 post-launch). All assets ship from this directory and must be produced before the Marketplace listing can be submitted.

This file specifies **what** to make and **what each piece should communicate**. Production (Figma, Photoshop, Sketch — anything that exports lossless PNG at the required dimensions) is left to whoever produces them.

## File layout

```
marketing/
├── brand-assets.md                  ← this file
├── logo/
│   ├── tagline-mark.svg             ← master, vector
│   ├── tagline-mark-200x200.png     ← Marketplace listing avatar
│   ├── tagline-mark-512x512.png     ← higher-density retina avatar
│   └── tagline-mark-dark.svg        ← optional, for dark backgrounds
├── feature-card/
│   ├── feature-card-1248x640.png    ← Marketplace listing hero
│   └── feature-card.figma           ← optional source file
└── screenshots/
    ├── 01-release-issue.png         ← bot opens the release-tracking issue
    ├── 02-release-report.png        ← /release-report renders the report
    ├── 03-release-pr.png            ← /approve opens the release PR
    └── 04-release-shipped.png       ← Phase B comment with "Ready to share"
```

## 1. Logo (`logo/`)

### Required deliverables

- `tagline-mark.svg` — vector master at any size. Exports below derive from this.
- `tagline-mark-200x200.png` — required by GitHub Marketplace for the App listing avatar.
- `tagline-mark-512x512.png` — same mark, higher density. GitHub uses this for retina and certain integration surfaces.

### Optional but recommended

- `tagline-mark-dark.svg` — variant for dark-background placements (README badge, dark social cards).
- A monochrome variant for embed-in-text contexts (Slack favicon, browser tab icon).

### Visual brief

- **Concept:** a tag (the price-tag shape, hinting at "release tag" + "tagline") combined with a generative or AI-suggestive element (a sparkle, a small `>` cursor, or an arrow indicating motion from "tag" to "narrative").
- **Tone:** developer-tool serious, not playful-startup. Closer to GitHub's own iconography than to a SaaS branding deck.
- **Constraints:** must be legible at 32×32 (browser favicon) and at 16×16 (issue-comment avatar). Avoid fine detail that disappears at small sizes.
- **Colour:** primary brand colour TBD. Default to a single colour mark on transparent background; the colour can be applied via CSS in different contexts.
- **Safe area:** keep the meaningful glyph within 80% of the canvas so GitHub's circular mask doesn't clip it.

## 2. Feature card (`feature-card/`)

### Required deliverable

- `feature-card-1248x640.png` — GitHub Marketplace listing hero image. **Exact dimensions required**; GitHub will reject other sizes.

### Visual brief

- **Composition:** logo on the left, tagline ("GitHub-native release-management agent") large, a small visual element showing the release-tracking issue → release PR → release published flow.
- **Text:** must be legible when the card is rendered at 624×320 (Marketplace lists half-size). One short headline; nothing critical in body text smaller than 18pt at full size.
- **Background:** a single flat colour or a subtle gradient. Avoid photographic or busy backgrounds — they don't survive resize.
- **Branding:** include the Tagline wordmark or the logo plus "Tagline" set in the brand typeface. The card must read as Tagline at a glance.

## 3. Screenshots (`screenshots/`)

Marketplace requires **3+ screenshots** showing the App in real use. We'll produce four, in order, to tell the end-to-end story:

### `01-release-issue.png` — bot opens the release-tracking issue

- **Subject:** the bot-managed issue titled `🚀 Release pending — N changes since vX.Y.Z`, with the `tagline:release-pending` label visible.
- **What it shows:** the auto-generated body listing recent merged PRs, the quick-reference of slash commands, and the hidden marker (which is invisible but the body's structure should be readable).
- **Production note:** capture in light theme. Crop tightly so the issue body fills the frame; trim the GitHub left-nav.

### `02-release-report.png` — `/release-report` renders the report

- **Subject:** the bot's reply to `/release-report` showing the suggested bump (e.g. `Suggested bump: minor`), the AI-reasoned narrative paragraph, the per-PR breakdown, and the "Ready to share" plain-language summary block.
- **What it shows:** Tagline's defensible moat — the dual-audience narrative + reasoning that no peer tool produces.
- **Production note:** pick a real example with mixed `feat:` / `fix:` / `chore:` PRs so the bump rationale is visible.

### `03-release-pr.png` — `/approve` opens the release PR

- **Subject:** the auto-opened release PR titled `Release vX.Y.Z`, on the `release/vX.Y.Z` branch, with the rendered CHANGELOG section visible.
- **What it shows:** the action runs under the user's CI; the writes (commit, branch, PR) appear under the user's account, not the bot's. Highlight the "[skip ci]" suffix on the release commit.
- **Production note:** the test repo's release PR is the cleanest source — use one without manual edits.

### `04-release-shipped.png` — Phase B completion comment

- **Subject:** the bot's comment on the release-tracking issue announcing `Released vX.Y.Z 🎉` with the GitHub Release URL and the copy-pasteable plain-language summary block, plus the issue being closed.
- **What it shows:** closing the loop — the release-tracking issue is the canonical venue for the whole release cycle, from "PRs are landing" to "we just shipped".
- **Production note:** the issue should visibly be closed (greyed-out timeline icon, `Closed` label). Show the "Ready to share" block in full because it's the artifact maintainers will copy into Slack.

## Submission-time bundle

Once produced, the Marketplace submission needs these specific files:

1. `logo/tagline-mark-200x200.png`
2. `feature-card/feature-card-1248x640.png`
3. `screenshots/01-release-issue.png`
4. `screenshots/02-release-report.png`
5. `screenshots/03-release-pr.png`
6. `screenshots/04-release-shipped.png`

Plus the **Privacy URL** (→ [`docs/legal/privacy.md`](../docs/legal/privacy.md), published at `tagline.sh/privacy`) and the **Support URL** (→ [`docs/legal/support.md`](../docs/legal/support.md), published at `tagline.sh/support`).

## What we are deliberately not producing

- **Marketing copy beyond the README.** The README's hero paragraph is the canonical positioning; the Marketplace short description repeats it. Avoid drift between the two by sourcing from the README.
- **Animated GIFs or product demos.** Marketplace doesn't support video on the listing surface, and animated assets bloat the repo. Defer to a Loom or YouTube link from the README if needed later.
- **Social-card images** (Twitter/LinkedIn). Out of scope for v0.2 launch; can be added under `marketing/social/` later without disturbing the Marketplace bundle.
