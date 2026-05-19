# PLAN_ADDENDUM.md — Release Agent

> This document extends PLAN.md. Read PLAN.md first.
> Add everything here on top of what is already being built.
> Do not replace existing behaviour — only extend it.

---

## Context: Why This Addendum Exists

After posting about the release pain problem publicly, one key insight came back
consistently:

> "Commits are for developers, release notes are for users."

The current plan generates a technical `CHANGELOG.md` — correct for developers and
git history. But there is a second audience: product owners, customers, teammates
in non-engineering roles who need to understand what changed without reading PR numbers
and commit types.

No existing release tool generates both. This addendum adds a **dual-output** to
the `/approve` flow: a technical changelog AND a plain-language release summary.

---

## 1. New Type: `ReleaseSummary`

Add this to `packages/shared/src/types.ts`:

```typescript
export interface ReleaseSummary {
    version: string;
    date: string; // Formatted: "May 18, 2026"
    headline: string; // One sentence: what is the most important thing in this release
    body: string; // 2–4 sentences in plain language, no PR numbers, no commit types
    highlights: string[]; // 2–5 bullet points, plain English, user-facing language
    rawMarkdown: string; // Full formatted Markdown block, ready to paste anywhere
}
```

---

## 2. Update `ReleaseReport` Type

In `packages/shared/src/types.ts`, add one field to the existing `ReleaseReport`
interface:

```typescript
export interface ReleaseReport {
    // ... all existing fields remain unchanged ...
    summaryPreview: ReleaseSummary; // ADD THIS — plain-language preview shown in report comment
}
```

---

## 3. Update `ReleasePlan` Type

In `packages/shared/src/types.ts`, add one field to the existing `ReleasePlan`
interface:

```typescript
export interface ReleasePlan {
    // ... all existing fields remain unchanged ...
    releaseSummary: ReleaseSummary; // ADD THIS — carried through to action for posting
}
```

---

## 4. Update AI Report Generator

File: `apps/bot/src/services/report-generator.ts`

The AI already produces `reasoning` and `changelogPreview`. Extend the prompt
and response schema to also produce the release summary in the same call.
One AI call generates all three — no extra cost.

### Updated Response Schema

```typescript
// The zod schema validating the AI JSON response
const aiResponseSchema = z.object({
    reasoning: z.string(),
    changelogPreview: z.string(),
    releaseSummary: z.object({
        // NEW
        headline: z.string(),
        body: z.string(),
        highlights: z.array(z.string()).min(1).max(5),
    }),
});
```

### Updated Prompt Addition

Append this to the existing user prompt in `buildPrompt()`:

```
3. Write a plain-language release summary for a non-technical audience (product owners,
   customers, stakeholders). Rules:
   - No PR numbers, no commit types (no "feat:", no "#342")
   - No technical jargon unless unavoidable
   - One headline sentence: the single most important thing in this release
   - A body of 2–4 sentences describing what changed and why users care
   - 2–5 highlight bullet points in plain English

   Example of good output:
   {
     "headline": "You can now log in with Google and export your data to CSV.",
     "body": "This release focuses on two things users have been asking for: a faster
              login option and a way to get their data out. We also fixed a login issue
              that was affecting some users on mobile.",
     "highlights": [
       "Sign in with Google — no password required",
       "Export any table to CSV from the dashboard",
       "Fixed login bug on mobile Safari"
     ]
   }
```

### Fallback (AI unavailable)

If the AI call fails, generate a minimal `ReleaseSummary` deterministically:

```typescript
function buildFallbackSummary(prs: ParsedPR[], nextVersion: string): ReleaseSummary {
    const featPRs = prs.filter((pr) => pr.suggestedBump === 'minor');
    const fixPRs = prs.filter((pr) => pr.commits.some((c) => c.type === 'fix'));

    const highlights = [
        ...featPRs.slice(0, 3).map((pr) => pr.title),
        ...fixPRs.slice(0, 2).map((pr) => pr.title),
    ].slice(0, 5);

    const date = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

    const rawMarkdown = buildSummaryMarkdown({
        version: nextVersion,
        date,
        headline: '',
        body: '',
        highlights,
        rawMarkdown: '',
    });

    return {
        version: nextVersion,
        date,
        headline: `${nextVersion} includes ${prs.length} update${prs.length !== 1 ? 's' : ''}.`,
        body: 'See the changelog for full details.',
        highlights,
        rawMarkdown,
    };
}
```

---

## 5. Build `rawMarkdown` from Summary Fields

Add a helper function in `apps/bot/src/utils/comments.ts`:

```typescript
export function buildSummaryMarkdown(summary: ReleaseSummary): string {
    return [
        `## What's new in v${summary.version} · ${summary.date}`,
        '',
        summary.headline,
        '',
        summary.body,
        '',
        summary.highlights.map((h) => `- ${h}`).join('\n'),
    ].join('\n');
}
```

The `rawMarkdown` field is what the engineering lead copies and pastes into Slack,
Beamer, email, or any product changelog tool. It requires zero editing.

---

## 6. Update Report Comment Template

In `apps/bot/src/utils/comments.ts`, extend the existing report comment
(currently ends with the `/approve` command list).

Add a new collapsible section **above** the command list:

```markdown
<details>
<summary>Plain-language summary (for Slack / product changelog)</summary>

## What's new in v1.5.0 · May 18, 2026

You can now log in with Google and export your data to CSV.

This release focuses on two things users have been asking for: a faster login
option and a way to get their data out. We also fixed a login issue that was
affecting some users on mobile.

- Sign in with Google — no password required
- Export any table to CSV from the dashboard
- Fixed login bug on mobile Safari

</details>
```

This section is collapsed by default so it does not crowd the technical report.
The engineering lead expands it when they need to communicate the release externally.

---

## 7. Update Release Execution — Post Summary After Release

File: `apps/action/src/steps/github-release.ts`

When creating the GitHub release (Step 7 in the existing plan), use the
`releaseSummary.rawMarkdown` as the **top section** of the release body,
followed by the technical `changelogContent`.

```typescript
const releaseBody = [
    releasePlan.releaseSummary.rawMarkdown,
    '',
    '---',
    '',
    releasePlan.changelogContent,
].join('\n');
```

This means the GitHub release page shows the plain-language summary first
(readable by anyone browsing releases) and the full technical changelog below it
(for developers who need the detail).

---

## 8. Update Completion Comment

File: `apps/action/src/steps/open-pr.ts` (or wherever the completion comment is posted)

After the release completes, the bot posts a completion comment to the release issue.
Extend this comment to include the plain-language summary so the lead can copy it
immediately without opening the GitHub release page:

```markdown
Release `v1.5.0` is live.

**GitHub release:** https://github.com/owner/repo/releases/tag/v1.5.0
**Changelog PR:** https://github.com/owner/repo/pull/89

---

**Ready to share:**

## What's new in v1.5.0 · May 18, 2026

You can now log in with Google and export your data to CSV.

- Sign in with Google — no password required
- Export any table to CSV from the dashboard
- Fixed login bug on mobile Safari
```

---

## 9. No Changes Required To

- The monorepo logic (summary is always at the repo level, not per-package)
- The slash command interface (`/approve` syntax unchanged)
- The Action `action.yml` inputs (the summary travels inside `release_plan` JSON)
- The stateless architecture
- The `CHANGELOG.md` format (technical changelog is unchanged)

---

## Summary of Files to Touch

| File                                        | Change                                                              |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `packages/shared/src/types.ts`              | Add `ReleaseSummary` type; extend `ReleaseReport` and `ReleasePlan` |
| `apps/bot/src/services/report-generator.ts` | Extend AI prompt + response schema; add fallback generator          |
| `apps/bot/src/utils/comments.ts`            | Add `buildSummaryMarkdown()`; extend report comment template        |
| `apps/action/src/steps/github-release.ts`   | Use summary as top section of GitHub release body                   |
| `apps/action/src/release-executor.ts`       | Pass `releaseSummary` through to completion comment                 |
