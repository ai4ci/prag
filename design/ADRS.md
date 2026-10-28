---
class: index
title: Architecture Decision Records Index
view:
  class: adr
  orderBy: uri ASC
---

# Architecture Decision Records

<!-- loom:links start -->
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
- [Sliding-Window Sub-Chunking for Oversized AST Nodes](adrs/ADR-014.md)
- [Pinned Embedding Model with Explicit Re-Embed Migration](adrs/ADR-015.md)
- [Loud Daemon Identity and Version Mismatch, No Automatic Port Fallback](adrs/ADR-016.md)
- [Manual Non-Eager Garbage Collection for chunks_pool via CLI and MCP](adrs/ADR-017.md)
- [Split Search into search_local and search_all Across CLI and MCP](adrs/ADR-018.md)
<!-- loom:links end -->
