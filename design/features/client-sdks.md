---
class: feature
id: client-sdks.md
title: Programmatic Client SDKs for TypeScript and Java
status: draft
priority: medium
area: interface
---
## Overview
Provide language-native clients so other applications can use a running local Prag daemon without invoking the CLI or depending on Prag's internal database, parser, or embedding packages. This is a proposal for discussion; package names, API coverage, and document-ingestion behavior are not settled.

## Use Cases

### TypeScript tools, including Loom
A TypeScript application such as Loom can use Prag's local daemon to semantically search the project it is working in. If the project is Prag itself, this becomes intentional dogfooding: Loom asks Prag to index and search Prag's code and design documents. This is acceptable provided indexing remains explicitly opted in, queries are project-scoped, and search activity does not itself create an ingestion loop.

The repository already has a typed `DaemonClient`, exported from `packages/cli/src/index.ts`; however, `@prag/cli` is currently private and the client is coupled to CLI configuration and lifecycle concerns. A supported SDK may extract or reuse that code behind a stable public package rather than expose the CLI package as-is.

### Java applications and research documents
A Java application can use a Maven SDK to search and manage a local Prag daemon. One target corpus includes local PDFs plus abstracts obtained by the host application from bibliographic APIs.

PDF extraction belongs to Prag's existing parsing plans ([multi-format parsing](multi-format-parsing.md) and [layout-preserving chunking](layout-preserving-chunking.md)). How an application supplies bibliographic abstracts is unresolved: it could materialize normalized Markdown/text files in a watched project, or Prag could add a generic document-ingestion API that accepts text and source metadata. The SDK should not imply built-in connectors to specific bibliographic services unless that is separately chosen.

## Proposed Boundary
- TypeScript and Java SDKs are clients of the same versioned local HTTP API; they do not implement indexing, storage, parsing, or embeddings independently.
- The SDKs provide typed operations for health/API compatibility, scoped search, and the project/grant/synchronization controls that are supported by the daemon.
- A library client connects to an explicitly configured or discovered daemon. Automatic daemon startup should be opt-in rather than a surprising default for applications.
- Authentication reuses Prag's local bearer-token mechanism. SDKs do not collect or persist credentials for third-party bibliographic services.
- Project registration/grants remain explicit. Loom's Prag integration must request only its active project's scope; indexing the Prag repository is a valid, intentional configuration, not an implicit global search.

## Fit With Existing Plans
This feature adds client packages and a stable programmatic interface; it does not replace the CLI or MCP endpoint. It depends on completing the project and branch scoping already specified in [dual interfaces](dual-interfaces.md) and [workspace isolation](workspace-isolation.md), because SDK convenience must not turn a project-local query into a cross-project query.

PDF parsing is already planned in the ingestion features. Bibliographic abstract ingestion is adjacent to, but not provided by, the current [web and non-local content](web-and-nonlocal-content.md) feature, which describes crawling pages and refreshing them by TTL rather than accepting caller-supplied records.

## Open Design Questions
- Should abstract ingestion use watched Markdown/text files, or should the daemon expose an `ingest document` API with stable source IDs, metadata, update, and delete semantics?
- Should both SDKs expose only search and status initially, or also grants, project registration, sync, and daemon lifecycle operations?
- Should daemon discovery/configuration be standardized for both languages, or should Java require an explicit base URL and token unless configured by the host application?
- What public package coordinates and minimum supported TypeScript/Java runtimes are required?
- Should Loom integration live in Loom as an optional adapter/sample, rather than as a Prag dependency?
