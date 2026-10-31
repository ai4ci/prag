---
class: index
title: prag Design & Architecture Index
---

# prag Design & Architecture Index

Overview of architectural decisions, features, and engineering tasks for `prag` (**Pragmatic RAG**).

## Indexes
- [Architecture Decision Records](ADRS.md) · [Features](FEATURES.md) · [Tasks](TASKS.md) · [Issues](ISSUES.md)

## Architectural Resources & Specifications
- [Storage Schema & Database Architecture](resources/storage-schema.md)
- [CLI & HTTP/SSE MCP Interface Specification](resources/cli-and-mcp-interface.md)
- [Environment Variables, Configuration, and Storage Paths](resources/env-and-storage-paths.md)

## Features Summary

<!-- loom view: feature_list -->

- [Air-Gapped Local Runtime and Hardware Acceleration](features/air-gapped-runtime.md)
- [Non-Blocking Background Worker Ingestion Queue](features/background-worker-queue.md)
- [Dual Interface (Short-Lived CLI and Native HTTP/SSE MCP Endpoint)](features/dual-interfaces.md)
- [Git Branch Awareness and State Continuity](features/git-branch-awareness.md)
- [Multi-Format Code and Document Parsing](features/multi-format-parsing.md)
- [Unified Allow/Deny URI Grants and Database-Backed Project Discovery](features/project-registry-and-status.md)
- [Syntax-Aware Structural Code Chunking and Whitespace Normalization](features/syntax-aware-chunking.md)
- [Test Harness, Environment Isolation, and Fixture Corpus](features/test-harness-and-fixtures.md)
- [Layout-Preserving Document Chunking](features/layout-preserving-chunking.md)
- [Non-Local Content and Web URI Ingestion (Firecrawl)](features/web-and-nonlocal-content.md)
- [Multi-Project Multi-Tenant Isolation](features/workspace-isolation.md)
<!-- loom view: end -->
