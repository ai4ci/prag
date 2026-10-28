---
class: index
title: prag Design & Architecture Index
view:
  class: feature
  orderBy: priority DESC
---

# prag Design & Architecture Index

Overview of architectural decisions, features, and engineering tasks for `prag` (**Pragmatic RAG**).

## Architectural Resources & Specifications
- [Storage Schema & Database Architecture](resources/storage-schema.md)
- [CLI & Stdio MCP Interface Specification](resources/cli-and-mcp-interface.md)
- [Environment Variables, Configuration, and Storage Paths](resources/env-and-storage-paths.md)

## Features Summary

<!-- loom:links start -->
- [Air-Gapped Local Runtime and Hardware Acceleration](features/air-gapped-runtime.md)
- [Non-Blocking Background Worker Ingestion Queue](features/background-worker-queue.md)
- [Dual Interface (Short-Lived CLI and Native HTTP/SSE MCP Endpoint)](features/dual-interfaces.md)
- [Git Branch Awareness and State Continuity](features/git-branch-awareness.md)
- [Multi-Format Code and Document Parsing](features/multi-format-parsing.md)
- [Unified Allow/Deny URI Grants and Database-Backed Project Discovery](features/project-registry-and-status.md)
- [Syntax-Aware Structural Code Chunking and Whitespace Normalization](features/syntax-aware-chunking.md)
- [Layout-Preserving Document Chunking](features/layout-preserving-chunking.md)
- [Non-Local Content and Web URI Ingestion (Firecrawl)](features/web-and-nonlocal-content.md)
- [Multi-Project Multi-Tenant Isolation](features/workspace-isolation.md)
<!-- loom:links end -->
