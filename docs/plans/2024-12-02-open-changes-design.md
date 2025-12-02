# Design: `ger open-changes` Command

**Date:** 2024-12-02
**Status:** Approved

## Overview

Add a new command `ger open-changes` that lists all open changes for the current git project with reviewer information.

## Requirements

1. Show all open changes for the current project (detected from git remote)
2. Support `--limit N` flag (default: 20)
3. Display reviewer information inline (compact format)
4. Support output formats: pretty (default), `--json`, `--xml`

## Command Interface

```
ger open-changes [options]

Options:
  --limit, -n <number>   Maximum changes to return (default: 20)
  --json                 Output as JSON
  --xml                  Output as XML
  --help                 Show help
```

## Project Detection

Extract project name from git remote origin URL:
- `ssh://gerrit.example.com/my-project` → `my-project`
- `https://gerrit.example.com/a/my-project` → `my-project`

Use existing git remote parsing logic if available, or implement new utility.

## Gerrit Query

```
project:<detected-project> status:open
```

With options: `DETAILED_LABELS`, `DETAILED_ACCOUNTS` to get reviewer information.

## Output Format

### Pretty (default)

```
Open Changes (5)

✓  ↑  12345  Fix authentication bug
      CR: +2 Alice, +1 Bob  V: +1 Jenkins
      by Carol • NEW

✗     12344  Add caching layer
      CR: -2 Dave  V: +1 Jenkins
      by Eve • NEW

↑     12343  Refactor database queries
      CR: +1 Frank  V: ⏳
      by Grace • NEW
```

**Elements:**
- Status indicators on left (✓ ✗ ↑ ↓) - matches `mine` command style
- Change number + subject on first line
- Reviewer votes on second line: `CR: <votes>  V: <votes>`
- Owner + status on third line - matches `incoming` command style
- `⏳` indicates no votes yet

### JSON

```json
{
  "project": "my-project",
  "count": 5,
  "changes": [
    {
      "number": 12345,
      "subject": "Fix authentication bug",
      "status": "NEW",
      "owner": "Carol",
      "reviewers": {
        "Code-Review": [
          { "name": "Alice", "value": 2 },
          { "name": "Bob", "value": 1 }
        ],
        "Verified": [
          { "name": "Jenkins", "value": 1 }
        ]
      }
    }
  ]
}
```

### XML

```xml
<?xml version="1.0" encoding="UTF-8"?>
<open_changes project="my-project" count="5">
  <change>
    <number>12345</number>
    <subject><![CDATA[Fix authentication bug]]></subject>
    <status>NEW</status>
    <owner>Carol</owner>
    <reviewers>
      <label name="Code-Review">
        <vote name="Alice" value="+2"/>
        <vote name="Bob" value="+1"/>
      </label>
      <label name="Verified">
        <vote name="Jenkins" value="+1"/>
      </label>
    </reviewers>
  </change>
</open_changes>
```

## Implementation Approach

**Copy pattern from `incoming.ts`, refactor shared logic later.**

### Files to Create/Modify

1. **`src/cli/commands/open-changes.ts`** - New command implementation
2. **`src/cli/index.ts`** - Register the new command
3. **`tests/open-changes.test.ts`** - Unit and integration tests

### Key Functions

```typescript
// Detect project from git remote
const detectProject = (): Effect.Effect<string, Error>

// Format reviewer votes for display
const formatReviewerVotes = (labels: Labels): string
// e.g., "CR: +2 Alice, +1 Bob  V: +1 Jenkins"

// Main command
export const openChangesCommand = (options: OpenChangesOptions): Effect.Effect<...>
```

## Testing Requirements

Per CLAUDE.md:
- Unit tests for `detectProject` and `formatReviewerVotes`
- Integration tests with MSW mocking Gerrit API responses
- Cover: happy path, no changes found, network errors, invalid project

## Future Refactoring (out of scope)

- Extract `groupChangesByProject` to shared utils
- Create shared XML/JSON renderers
- Consolidate status indicator logic
