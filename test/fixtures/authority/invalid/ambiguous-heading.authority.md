---
format: nimicoding.authority/v1
id: rule.ambiguous
kind: rule
owner: team.checkout
lifecycle: active
modality: must
scope:
  - api.checkout
relations: []
---
# Ambiguous rule

## Statement

A request carries a session.

## Condition

Always.

## Failure

Reject the request.

## Failure

Duplicate sections are ambiguous.
