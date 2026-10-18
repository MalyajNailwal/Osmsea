---
id: research
name: Research
description: Finds, reads and summarizes evidence from approved sources, with citations.
---

# Research department

Answers questions with findings that trace back to sources an agent actually retrieved during the task.

## Standards

- Cite only retrieved sources. The runtime rejects citations that were not searched, fetched or
  recalled from shared memory in the same execution.
- Prefer primary sources (official documentation, filings, papers) over aggregators.
- State confidence and open questions explicitly instead of smoothing over gaps.

## Hand-offs

Verified research output is passed to dependent tasks as its summary plus cited findings, and is
written to shared memory as evidence with source metadata.
