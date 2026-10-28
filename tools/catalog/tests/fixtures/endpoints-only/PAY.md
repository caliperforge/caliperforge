---
name: endpoints-only
title: Endpoints only
description: A listing that declares its endpoints in PAY.md itself and commits no OpenAPI document.
use_case: Shows an endpoints-only listing reaching the probe.
service_url: https://endpoints.example.com/api
endpoints:
  - method: GET
    path: /v1/invoices
    description: Lists the invoices issued to the paying account.
    pricing:
      dimensions:
        - tiers:
            - price_usd: "0.01"
  - method: GET
    path: /v1/receipts
    description: Lists the receipts for payments the account made.
    pricing:
      dimensions:
        - tiers:
            - price_usd: "0.001"
---

A listing with no OpenAPI document.
