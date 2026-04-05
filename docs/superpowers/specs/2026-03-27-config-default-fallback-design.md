# Config Default Fallback Design

## Goal

Make config loading fail open when no valid config is available, so the plugin
always has a usable minimum runtime configuration without throwing during
startup.

The minimum effective config is:

```json
{
  "graphiti": {
    "endpoint": "http://localhost:8000/mcp"
  },
  "redis": {
    "endpoint": "redis://localhost:6379"
  }
}
```

## Why This Change

Current behavior treats some config discovery and validation problems as fatal.
That is too strict for the plugin's architecture because both backends already
have canonical localhost defaults and the plugin is expected to degrade
gracefully when optional configuration is absent or incomplete.

The new behavior should make startup resilient while still surfacing operator
actionability through OpenCode's warning channel instead of hard failures or raw
logger warnings.

## Required Behavior

### No Config Found

- If `cosmiconfig` discovery finds no project or home config, treat that as a
  normal empty config.
- Resolve the final config from built-in defaults without throwing or warning.

### Discovery Failures

- If `cosmiconfig` initialization fails, treat it the same as config-not-found.
- If `cosmiconfig` search fails, treat it the same as config-not-found.
- Discovery init/search failures short-circuit directly to default resolution;
  they do not continue into legacy fallback loading. This preserves the current
  exception-based control flow rather than adding a new fallback branch.
- Do not throw and do not emit the current logger warning in these cases.

### Legacy File Failures

- If discovery returns no config and the legacy fallback file cannot be loaded,
  do not throw.
- Emit an OpenCode warning notification describing that the legacy config was
  ignored and defaults were used.
- Continue with default/inferred config resolution.

### Malformed Config Files

- If a discovered config file or legacy config file contains malformed endpoint
  values or otherwise invalid config values, do not throw.
- Errors currently surfaced as `config-invalid` become recoverable for config
  loading and should follow this warning-and-fallback path.
- When one config source produces a `config-invalid` error, treat that entire
  source as unreadable rather than partially recovering individual fields from
  it. In practice, the existing exception flow already supports this model by
  discarding the entire source on the first invalid field.
- This includes the top-level legacy `endpoint` alias as well as nested endpoint
  fields.
- Emit an OpenCode warning notification describing that invalid config was
  ignored.
- Continue with default/inferred config resolution.

### Endpoint Inference

- If both endpoints are absent, use the localhost defaults exactly.
- If only `graphiti.endpoint` is defined, infer `redis.endpoint` from the same
  host using the Redis scheme and default Redis port.
- If only `redis.endpoint` is defined, infer `graphiti.endpoint` from the same
  host using the HTTP scheme, default Graphiti port, and `/mcp` path.
- Inference should preserve the configured host while normalizing the target
  service's canonical scheme/port/path.
- The inferred Graphiti path is always `/mcp`; non-default Graphiti paths
  require an explicit `graphiti.endpoint`.
- Scheme inference always uses the target service's canonical default scheme:
  `http` for Graphiti and `redis` for Redis, regardless of whether the source
  endpoint used `https` or `rediss`. Operators that need TLS on both services
  must configure both endpoints explicitly.
- Host transfer uses the parsed URL's `hostname` value, so IPv6 literals are
  supported. Only the hostname is copied; the inferred sibling always uses the
  target service's canonical default port.

Examples:

- `graphiti.endpoint = "http://graphiti.internal:9000/custom"` implies
  `redis.endpoint = "redis://graphiti.internal:6379"`
- `redis.endpoint = "rediss://cache.internal:6380"` implies
  `graphiti.endpoint = "http://cache.internal:8000/mcp"`

The source endpoint's own explicit scheme and port remain valid for that source
field; only the inferred sibling endpoint is normalized to its service default.

### Partial Nested Config

- Nested `graphiti` and `redis` config remain canonical.
- Existing precedence rules stay intact: nested values win over legacy top-level
  graphiti aliases.
- Inference runs after normalization and precedence resolution, so a single
  canonical endpoint can seed the missing sibling endpoint.

## Warning Delivery

- Replace direct throw-or-log behavior for recoverable malformed/legacy config
  problems with OpenCode warning notifications via the existing warning service.
- Warning delivery should use a neutral plugin warning helper that shares the
  same structured notification path already used for Graphiti availability
  issues.
- Discovery-not-found and discovery-init/search failures should remain silent.
- Legacy load failures and malformed config files warn; silent fallback is only
  for config-not-found and discovery init/search failures themselves.

## Implementation Shape

### `src/config.ts`

- Keep `DEFAULT_CONFIG` as the canonical baseline for all numeric and endpoint
  defaults.
- Separate "recoverable config problem" handling from truly unrecoverable
  programmer/runtime failures.
- Change config loading so discovery init/search failures return `null` config
  instead of raising warnings.
- Add `config-invalid` to the recoverable config error path.
- Change config file normalization so malformed file contents can be reported
  and ignored without aborting `loadConfig()`.
- Add endpoint sibling inference after canonical raw config selection and before
  final resolved config output.

### Warning Integration

- Reuse the existing structured warning path, but rename or wrap
  `notifyGraphitiAvailabilityIssue()` behind a neutral helper before using it
  for config warnings.
- Warning messages should be specific enough to identify whether the ignored
  source was discovered config or legacy config.
- Warning payloads should redact sensitive endpoint user info consistently with
  existing config validation behavior.

## Validation Plan

Add or update tests in `src/config.test.ts` to cover:

- no config found returns localhost defaults
- discovery init failure returns defaults without throwing
- discovery search failure returns defaults without throwing
- malformed discovered config triggers warning and falls back instead of
  throwing
- malformed legacy config triggers warning and falls back instead of throwing
- legacy file load failure triggers warning and falls back instead of throwing
- config with one valid and one invalid endpoint in the same source discards the
  entire source rather than partially recovering fields
- graphiti-only config infers redis host/scheme/port
- redis-only config infers graphiti host/scheme/port/path
- both endpoints explicitly provided bypass inference and remain as configured
- discovery init/search failure skips legacy fallback and goes straight to
  defaults without warning
- discovery returns no config and successful legacy fallback still uses the
  legacy-derived config
- nested endpoint precedence still wins before inference
- invalid explicit endpoint schemes are treated as ignored malformed config with
  warning, not fatal exceptions
- `rediss://` source config still infers the documented canonical Graphiti
  scheme behavior
- IPv6 endpoint hosts infer the sibling endpoint from the same hostname

## Non-Goals

- Do not change the documented canonical config shape.
- Do not reintroduce removed top-level Redis aliases.
- Do not make Graphiti or Redis availability a startup-time hard requirement.
