# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 2.x | ✅ |
| < 2.0 | ❌ |

## Reporting a Vulnerability

Please report security issues privately via [GitHub Security
Advisories](https://github.com/ifapmzadu6/llm-json-extract/security/advisories/new).

Do not file a public issue for security reports. I aim to acknowledge new
reports within a few days.

## Scope

This library parses untrusted text. The intended threat model is:

- **In scope** — denial of service via crafted input (catastrophic regex
  backtracking, excessive memory), incorrect parse results that mislead
  callers, prototype pollution risks, or any path that lets an attacker
  controlling the LLM output influence the calling program beyond the parsed
  value.
- **Out of scope** — the LLM itself returning malicious content; downstream
  misuse of the parsed value (e.g. passing it to `eval`).
