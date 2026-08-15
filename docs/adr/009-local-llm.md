# ADR-009: Local LLM (WebLLM) as optional adapter

## Context
On-device AI must not block the notes app; engines will change.

## Decision
`AiProvider` + feature flag + WebGPU gate. Default engine: WebLLM. Embeddings: local hash provider (swap-ready). Agent: thin JSON tool loop without external agent SDK. Results that mutate notes go through `PersistenceFacade`.

## Consequences
CI uses harness mocks; real model downloads are user-consent only. RAG/agent refuse when retrieval coverage is weak.
