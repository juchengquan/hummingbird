# AG-UI 1.0 JSON Schema — vendored

`1.0/schema.json` is a byte-for-byte copy of the AG-UI protocol's
published 1.0 schema. **Do not edit it.** To move to a newer version,
vendor the new file beside it (`1.1/schema.json`, …), update this page,
and point the contract's `$ref`s at it in the same PR.

| | |
|---|---|
| Published at | <https://ag-ui.com/spec/1.0/schema.json> (301 → <https://docs.ag-ui.com/spec/1.0/schema.json>) — the URL in the file's own `$id` |
| Repository path | [`docs/spec/1.0/schema.json`](https://github.com/ag-ui-protocol/ag-ui/blob/c19baf7aa9423ebaf7ee5f5e8a6cb3379bab974d/docs/spec/1.0/schema.json) in `github.com/ag-ui-protocol/ag-ui` |
| Fetched from tag | `release/2026-11-17` → commit `c19baf7aa9423ebaf7ee5f5e8a6cb3379bab974d` |
| Last commit touching the file | `fdbca490dc90fd8fbce2b342df79383bd70559af` (2026-09-17, "feat(spec): freeze the draft as 1.0") |
| SHA-256 | `4b5c93226838a0e72d88e6c5df20633c686c49fcb75d9be2815c6cbf9e48e71a` |
| Fetched | 2026-11-21; identical to the copy served at the published URL that day |
| Dialect | JSON Schema draft 2020-12 |

The SHA-256 is asserted by `packages/contract/tests/agui-schema.test.ts`,
so an accidental edit fails `bun run test`.

## Shape

The root validates one AG-UI **event** (`$ref: #/$defs/Event`, a
`type`-discriminated union). Every other definition is addressable two
ways — by JSON pointer (`schema.json#/$defs/RunAgentInput`) or by anchor
(`schema.json#RunAgentInput`). The contract uses JSON pointers: they
are what the OpenAPI tooling (Redocly, openapi-typescript,
datamodel-code-generator) resolves reliably.

Objects are closed (`unevaluatedProperties: false`). Per the AG-UI
"Schema files" page, that strictness is for authoring and tests; a
runtime receiver must instead tolerate and strip unknown material. So
the conformance suite may validate a backend's events against this
schema, but the frontend's receive path must not.

## Re-fetching

```bash
curl -sSL https://ag-ui.com/spec/1.0/schema.json | shasum -a 256
# must print the SHA-256 above; if not, 1.0 changed upstream — investigate
# before touching the vendored copy.
```
