---
name: inline-content
title: Inline content
description: A listing whose summary is too short while its other fields are in range.
use_case: Shows the summary length fault on its own.
service_url: https://api.example.com
openapi:
  content: |
    {
      "openapi": "3.0.0",
      "info": { "title": "Format fail", "version": "1" },
      "paths": { "/paid": { "get": { "summary": "Pays a fee", "responses": { "402": { "description": "Payment required" } } } } }
    }
---

A listing that carries its OpenAPI document inline.
