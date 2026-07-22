---
format: nimicoding.authority/v1
id: rule.checkout-session
kind: rule
owner: team.checkout
lifecycle: active
modality: must
scope:
  - api.checkout
relations:
  - type: applies_to
    target: definition.session
  - type: supersedes
    target: rule.checkout-session-v0
---
# Checkout requests require a session

## Statement

A checkout request carries a valid session.

## Condition

Always.

## Failure

Reject the request before creating an order.
