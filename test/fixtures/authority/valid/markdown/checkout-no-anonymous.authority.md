---
format: nimicoding.authority/v1
id: rule.checkout-no-anonymous
kind: rule
owner: team.checkout
lifecycle: active
modality: must_not
scope:
  - api.checkout
relations:
  - type: applies_to
    target: definition.session
---
# Anonymous checkout is prohibited

## Statement

Checkout creates an order without a valid session.

## Condition

Always.

## Failure

Reject the request before creating an order.
