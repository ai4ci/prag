---
class: index
title: prag Design & Architecture Index
---

# prag Design & Architecture Index

Overview of architectural decisions, features, and engineering tasks for `prag` (**Pragmatic RAG**).

## Feature Progress

### Completed

<!-- loom view: completed_feature_list -->

_(no results)_
<!-- loom view: completed_feature_list end -->

### In progress

<!-- loom view: in_progress_feature_list -->

- [Air-Gapped Local Runtime and Hardware Acceleration](features/air-gapped-runtime.md)
- [Non-Blocking Background Worker Ingestion Queue](features/background-worker-queue.md)
- [Dual Interface (Short-Lived CLI and Native HTTP/SSE MCP Endpoint)](features/dual-interfaces.md)
- [Git Branch Awareness and State Continuity](features/git-branch-awareness.md)
- [Multi-Format Code and Document Parsing](features/multi-format-parsing.md)
- [Unified Allow/Deny URI Grants and Database-Backed Project Discovery](features/project-registry-and-status.md)
- [Syntax-Aware Structural Code Chunking and Whitespace Normalization](features/syntax-aware-chunking.md)
- [Test Harness, Environment Isolation, and Fixture Corpus](features/test-harness-and-fixtures.md)
- [Multi-Project Multi-Tenant Isolation](features/workspace-isolation.md)
<!-- loom view: in_progress_feature_list end -->

### Accepted — implementation not started

<!-- loom view: accepted_feature_list -->

- [Layout-Preserving Document Chunking](features/layout-preserving-chunking.md)
- [Non-Local Content and Web URI Ingestion (Firecrawl)](features/web-and-nonlocal-content.md)
<!-- loom view: accepted_feature_list end -->

### Draft

<!-- loom view: draft_feature_list -->

_(no results)_
<!-- loom view: draft_feature_list end -->

# Open Issues

<!-- loom view: issue_list -->

- [LanceDB schema evolution relies on drop-and-reindex](issues/lancedb-schema-migration-strategy.md)
- [No budget or alert for chunks_pool disk usage growth](issues/chunk-pool-disk-usage-growth.md)
- [Per-caller permission grants for search results](issues/search-result-permission-grants.md)
<!-- loom view: issue_list end -->

## ADR summary

<!-- loom view: adr_list -->

- [Storage Engine Selection (LanceDB Core Matrix)](adrs/ADR-001.md)
- [Content-Addressable Storage (CAS) for Git Branch Proliferation](adrs/ADR-002.md)
- [Selection of Parsing Frameworks (Tree-sitter and LiteParse)](adrs/ADR-003.md)
- [In-Database Local Content Retention](adrs/ADR-004.md)
- [Dual Component Architecture via Local Port (Background Daemon and Client Wrappers)](adrs/ADR-005.md)
- [Local Polyglot Embedding Model Selection](adrs/ADR-006.md)
- [Hybrid Search via Dense Vector and BM25 Full-Text Search with Reciprocal Rank Fusion](adrs/ADR-007.md)
- [Unified Freshness Leases (validUntil) for Local Ingestion Cooldown and Remote Web TTLs](adrs/ADR-008.md)
- [Unified Allow/Deny URI Grants Rule Set and Database-Backed Project Discovery](adrs/ADR-009.md)
- [AST-Based Whitespace Normalization for Chunk Hashing (Preserving Comments)](adrs/ADR-010.md)
- [Native HTTP/SSE MCP Server Endpoint Built Directly into Background Daemon](adrs/ADR-011.md)
- [Air-Gap Scope Clarification (Self-Hosted by Default, Not Zero-Network)](adrs/ADR-012.md)
- [Shared-Secret Authentication for the Loopback HTTP/MCP Endpoint](adrs/ADR-013.md)
- [Vectorised Units - Sliding-Window Vectorisation of Oversized Chunks](adrs/ADR-014.md)
- [Pinned Embedding Model with Full Rebuild on Re-Embed](adrs/ADR-015.md)
- [Loud Daemon Identity and API-Version Mismatch, No Automatic Port Fallback](adrs/ADR-016.md)
- [Manual Non-Eager Garbage Collection for chunks_pool via CLI and MCP](adrs/ADR-017.md)
- [Split Search into search_local and search_all Across CLI and MCP](adrs/ADR-018.md)
- [Hermetic Test Environment - Single Root Override, Ephemeral Port, Injectable Embedder](adrs/ADR-019.md)
- [Toolchain - Bun Workspaces with tsc, Pending a Native-Addon Spike](adrs/ADR-020.md)
- [Ingestion Concurrency - Workers Parse, Main Thread Embeds and Writes](adrs/ADR-021.md)
- [Unified Error Envelope, HTTP Status Mapping and CLI Exit Codes](adrs/ADR-022.md)
- [Ingestion Limits via Discovery Filters and Watch Admission Control](adrs/ADR-023.md)
<!-- loom view: adr_list end -->

## Roadmap (Open tasks)

<!-- loom view: task_list -->

- [Implement branch_mapping table schema and branch pruning lifecycle](tasks/branch-mapping-and-pruning.md)
- [Implement the unified error envelope, status mapping and exit codes](tasks/error-contract.md)
- [Spike native addon support under Bun (LanceDB, ONNX, Tree-sitter)](tasks/toolchain-spike-native-addons.md)
- [Implement hardware acceleration provider selection and air-gap enforcement](tasks/air-gap-hardware-provider.md)
- [Build Tree-sitter and LiteParse parser routing in @prag/daemon](tasks/daemon-parser-router.md)
- [Implement pinned embedding model detection and prag reembed rebuild](tasks/embedding-model-migration.md)
- [Implement LiteParse layout-preserving PDF/DOCX to Markdown pipeline](tasks/liteparse-document-pipeline.md)
- [Implement Firecrawl-backed web ingestion with self-hosted endpoint support](tasks/web-ingestion-pipeline.md)
- [Enforce project-scoped query and storage isolation across workspaces](tasks/workspace-isolation-enforcement.md)
<!-- loom view: task_list end -->
