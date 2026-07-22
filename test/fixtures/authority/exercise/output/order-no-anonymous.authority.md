---
format: nimicoding.authority/v1
id: rule.order-no-anonymous
kind: rule
owner: team.orders
lifecycle: active
modality: must_not
scope:
  - api.orders
relations:
  - type: applies_to
    target: definition.order
---
# Anonymous order creation is prohibited

## Statement

The orders API creates an order without a valid session.

## Condition

Always.

## Failure

Reject the request before persisting an order.
