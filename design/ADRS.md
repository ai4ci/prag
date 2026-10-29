---
class: index
title: Architecture Decision Records Index
---

# Architecture Decision Records

<!-- loom view: adr_list -->

| uri | title |
| --- | --- |
| adr://ADR-001.md | Storage Engine Selection (LanceDB Core Matrix) |
| adr://ADR-002.md | Content-Addressable Storage (CAS) for Git Branch Proliferation |
| adr://ADR-003.md | Selection of Parsing Frameworks (Tree-sitter and LiteParse) |
| adr://ADR-004.md | In-Database Local Content Retention |
| adr://ADR-005.md | Dual Component Architecture via Local Port (Background Daemon and Client Wrappers) |
| adr://ADR-006.md | Local Polyglot Embedding Model Selection |
| adr://ADR-007.md | Hybrid Search via Dense Vector and BM25 Full-Text Search with Reciprocal Rank Fusion |
| adr://ADR-008.md | Unified Freshness Leases (validUntil) for Local Ingestion Cooldown and Remote Web TTLs |
| adr://ADR-009.md | Unified Allow/Deny URI Grants Rule Set and Database-Backed Project Discovery |
| adr://ADR-010.md | AST-Based Whitespace Normalization for Chunk Hashing (Preserving Comments) |
| adr://ADR-011.md | Native HTTP/SSE MCP Server Endpoint Built Directly into Background Daemon |
| adr://ADR-012.md | Air-Gap Scope Clarification (Self-Hosted by Default, Not Zero-Network) |
| adr://ADR-013.md | Shared-Secret Authentication for the Loopback HTTP/MCP Endpoint |
| adr://ADR-014.md | Vectorised Units - Sliding-Window Vectorisation of Oversized Chunks |
| adr://ADR-015.md | Pinned Embedding Model with Full Rebuild on Re-Embed |
| adr://ADR-016.md | Loud Daemon Identity and API-Version Mismatch, No Automatic Port Fallback |
| adr://ADR-017.md | Manual Non-Eager Garbage Collection for chunks_pool via CLI and MCP |
| adr://ADR-018.md | Split Search into search_local and search_all Across CLI and MCP |
| adr://ADR-019.md | Hermetic Test Environment - Single Root Override, Ephemeral Port, Injectable Embedder |
| adr://ADR-020.md | Toolchain - Bun Workspaces with tsc, Pending a Native-Addon Spike |
| adr://ADR-021.md | Ingestion Concurrency - Workers Parse, Main Thread Embeds and Writes |
| adr://ADR-022.md | Unified Error Envelope, HTTP Status Mapping and CLI Exit Codes |
| adr://ADR-023.md | Ingestion Limits via Discovery Filters and Watch Admission Control |
<!-- loom view: end -->
