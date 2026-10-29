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

| uri | title |
| --- | --- |
| feature://air-gapped-runtime.md | Air-Gapped Local Runtime and Hardware Acceleration |
| feature://background-worker-queue.md | Non-Blocking Background Worker Ingestion Queue |
| feature://dual-interfaces.md | Dual Interface (Short-Lived CLI and Native HTTP/SSE MCP Endpoint) |
| feature://git-branch-awareness.md | Git Branch Awareness and State Continuity |
| feature://multi-format-parsing.md | Multi-Format Code and Document Parsing |
| feature://project-registry-and-status.md | Unified Allow/Deny URI Grants and Database-Backed Project Discovery |
| feature://syntax-aware-chunking.md | Syntax-Aware Structural Code Chunking and Whitespace Normalization |
| feature://test-harness-and-fixtures.md | Test Harness, Environment Isolation, and Fixture Corpus |
| feature://layout-preserving-chunking.md | Layout-Preserving Document Chunking |
| feature://web-and-nonlocal-content.md | Non-Local Content and Web URI Ingestion (Firecrawl) |
| feature://workspace-isolation.md | Multi-Project Multi-Tenant Isolation |
<!-- loom view: end -->
