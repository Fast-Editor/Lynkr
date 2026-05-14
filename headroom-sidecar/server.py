"""
Headroom Sidecar Server (v0.20+ compatible)

FastAPI service that wraps the upstream `headroom` package's one-function
`compress()` API. Lynkr's Node client calls these REST endpoints; the sidecar
translates them into upstream library calls. Keeping the wire format stable
means Lynkr's `src/headroom/client.js` does not need a major rewrite even
though the upstream library's internals (Kompress-base, IntelligentContextManager,
Rust hot path, etc.) have changed substantially since v0.5.

Routes preserved:
- GET  /health
- GET  /metrics
- POST /compress
- POST /ccr/retrieve

Routes removed (no callers in Lynkr):
- POST /ccr/track
- POST /ccr/analyze
- POST /compress/llmlingua
"""

import hashlib
import json
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from config import config

logging.basicConfig(
    level=getattr(logging, config.log_level.upper()),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("headroom-sidecar")

app = FastAPI(
    title="Headroom Sidecar",
    description="Context compression service for LLM requests",
    version="2.0.0",
)

# Try to import upstream headroom v0.20+ public API. If unavailable
# (package missing or pinned to an older version that doesn't expose
# the one-function API), fall back to a basic byte-level compressor
# so the sidecar still serves traffic.
HEADROOM_AVAILABLE = False
HEADROOM_VERSION = "unknown"
_compress_fn = None
_CompressConfig = None

try:
    from headroom import compress as _compress_fn
    from headroom import CompressConfig as _CompressConfig

    try:
        from headroom import __version__ as HEADROOM_VERSION
    except ImportError:
        HEADROOM_VERSION = "v0.20+"

    HEADROOM_AVAILABLE = True
    logger.info(
        "Loaded upstream headroom %s with one-function compress() API",
        HEADROOM_VERSION,
    )
except ImportError as e:
    logger.warning(
        "Upstream headroom package not available (%s). Falling back to basic compression.",
        e,
    )

# CCR store — in-memory cache so the model can retrieve the original
# bytes for any chunk that was compressed away. Kept here (rather than
# delegating to upstream's retrieve API) because Lynkr's client uses
# its own hash convention.
ccr_store: Dict[str, Dict[str, Any]] = {}

# Metrics
metrics: Dict[str, Any] = {
    "requests_total": 0,
    "compressions_applied": 0,
    "compressions_skipped": 0,
    "errors": 0,
    "ccr_stores": 0,
    "ccr_retrievals": 0,
    "total_tokens_before": 0,
    "total_tokens_after": 0,
    "start_time": datetime.utcnow().isoformat(),
}


# ---------- Request / Response models ----------


class CompressRequest(BaseModel):
    messages: List[Dict[str, Any]]
    tools: Optional[List[Dict[str, Any]]] = None
    model: Optional[str] = "claude-sonnet-4-5-20250929"
    model_limit: Optional[int] = 200000
    mode: Optional[str] = None
    token_budget: Optional[int] = None
    query_context: Optional[str] = None
    preserve_recent_turns: Optional[int] = None
    target_ratio: Optional[float] = None


class CompressResponse(BaseModel):
    messages: List[Dict[str, Any]]
    tools: Optional[List[Dict[str, Any]]] = None
    compressed: bool
    stats: Dict[str, Any]


class CCRRetrieveRequest(BaseModel):
    hash: str
    query: Optional[str] = None
    max_results: Optional[int] = 20


class CCRRetrieveResponse(BaseModel):
    success: bool
    content: Optional[Any] = None
    items_retrieved: int = 0
    was_search: bool = False
    error: Optional[str] = None


# ---------- Helpers ----------


def estimate_tokens(data: Any) -> int:
    """Estimate token count (rough approximation: ~4 chars per token)."""
    text = json.dumps(data) if not isinstance(data, str) else data
    return len(text) // 4


def generate_hash(content: Any) -> str:
    """Generate hash for CCR storage."""
    text = json.dumps(content, sort_keys=True)
    return hashlib.sha256(text.encode()).hexdigest()[:12]


def cleanup_expired_ccr() -> None:
    now = time.time()
    expired = [k for k, v in ccr_store.items() if now - v["timestamp"] > config.ccr_ttl]
    for key in expired:
        del ccr_store[key]


def _build_compress_config(req: CompressRequest):
    """Translate Lynkr's request fields into a CompressConfig instance.

    Hardcodes Headroom v0.20's strongest settings:
      - Kompress-base ML compression: enabled (default model)
      - ICM (IntelligentContextManager): enabled by default in upstream
      - SmartCrusher + CacheAligner: enabled by default in upstream
      - protect_recent=4 (don't touch the active conversation)
      - protect_analysis_context=True (preserve code under analyze/review)
      - compress_system_messages=True (system prompts get compressed)
      - compress_user_messages=False (skip user messages — coding-agent default)
      - target_ratio=None (let the model decide ~85% compression)

    Lynkr's `preserve_recent_turns` and `target_ratio` request fields can
    still override per-request when explicitly set.
    """
    if _CompressConfig is None:
        return None

    cfg_kwargs: Dict[str, Any] = {
        # Best defaults — keep all heavyweight transforms on
        "compress_user_messages": False,
        "compress_system_messages": True,
        "protect_recent": 4,
        "protect_analysis_context": True,
        "min_tokens_to_compress": max(config.smart_crusher_min_tokens, 250),
        # kompress_model=None means upstream default (chopratejas/kompress-base)
        # which is the strongest text compressor. Do NOT set "disabled".
        "kompress_model": None,
    }

    # Per-request overrides
    if req.preserve_recent_turns is not None:
        cfg_kwargs["protect_recent"] = req.preserve_recent_turns
    if req.target_ratio is not None:
        cfg_kwargs["target_ratio"] = req.target_ratio

    return _CompressConfig(**cfg_kwargs)


def _basic_compress(messages: List[Dict], tools: Optional[List]) -> Dict[str, Any]:
    """Fallback compressor when upstream headroom is unavailable.

    Stores any tool_result longer than 2000 chars in the CCR store and
    replaces it with a short reference. Mirrors the behaviour of the
    pre-v0.20 sidecar so existing clients still get *some* compression.
    """
    tokens_before = estimate_tokens(messages)
    compressed_messages: List[Dict[str, Any]] = []

    for msg in messages:
        compressed_msg = msg.copy()
        if msg.get("role") == "user" and isinstance(msg.get("content"), list):
            new_content = []
            for block in msg["content"]:
                if block.get("type") == "tool_result":
                    content = block.get("content", "")
                    if isinstance(content, str) and len(content) > 2000:
                        hash_key = generate_hash(content)
                        ccr_store[hash_key] = {
                            "content": content,
                            "timestamp": time.time(),
                            "tool_name": block.get("tool_use_id", "unknown"),
                        }
                        metrics["ccr_stores"] += 1
                        block = block.copy()
                        block["content"] = (
                            f"[CCR:{hash_key}] Content compressed ({len(content)} chars). "
                            f"Use ccr_retrieve to access full content."
                        )
                new_content.append(block)
            compressed_msg["content"] = new_content
        compressed_messages.append(compressed_msg)

    tokens_after = estimate_tokens(compressed_messages)
    return {
        "messages": compressed_messages,
        "tools": tools,
        "compressed": tokens_after < tokens_before,
        "stats": {
            "tokens_before": tokens_before,
            "tokens_after": tokens_after,
            "tokens_saved": tokens_before - tokens_after,
            "savings_percent": round((1 - tokens_after / tokens_before) * 100, 1)
            if tokens_before > 0
            else 0,
            "transforms_applied": ["basic_ccr"] if tokens_after < tokens_before else [],
            "latency_ms": 0,
        },
    }


# ---------- Routes ----------


@app.get("/health")
async def health_check():
    cleanup_expired_ccr()
    return {
        "status": "healthy",
        "headroom_loaded": HEADROOM_AVAILABLE,
        "headroom_version": HEADROOM_VERSION,
        "ccr_enabled": config.ccr_enabled,
        # Field kept for backwards compatibility with Lynkr's client.
        # In v0.20 LLMLingua-as-a-knob has been folded into CompressConfig
        # via `kompress_model="disabled"`. We surface the same flag here.
        "llmlingua_enabled": config.llmlingua_enabled,
        "entries_cached": len(ccr_store),
        "config": config.to_dict(),
    }


@app.get("/metrics")
async def get_metrics():
    return {
        **metrics,
        "average_compression_ratio": (
            round(metrics["total_tokens_after"] / metrics["total_tokens_before"], 3)
            if metrics["total_tokens_before"] > 0
            else 1.0
        ),
        "ccr_entries": len(ccr_store),
        "uptime_seconds": (
            datetime.utcnow() - datetime.fromisoformat(metrics["start_time"])
        ).total_seconds(),
    }


@app.post("/compress", response_model=CompressResponse)
async def compress_messages(request: CompressRequest):
    start_time = time.time()
    metrics["requests_total"] += 1

    try:
        tokens_before = estimate_tokens(request.messages)
        metrics["total_tokens_before"] += tokens_before

        if tokens_before < config.smart_crusher_min_tokens:
            metrics["compressions_skipped"] += 1
            return CompressResponse(
                messages=request.messages,
                tools=request.tools,
                compressed=False,
                stats={
                    "skipped": True,
                    "reason": f"Below threshold ({tokens_before} < {config.smart_crusher_min_tokens})",
                    "tokens_before": tokens_before,
                    "tokens_after": tokens_before,
                    "tokens_saved": 0,
                    "savings_percent": 0,
                    "transforms_applied": [],
                    "latency_ms": round((time.time() - start_time) * 1000, 1),
                },
            )

        # Preferred path: delegate to upstream headroom.compress()
        if HEADROOM_AVAILABLE and _compress_fn is not None:
            try:
                result = _compress_fn(
                    request.messages,
                    model=request.model or "claude-sonnet-4-5-20250929",
                    model_limit=request.model_limit or 200000,
                    config=_build_compress_config(request),
                )

                # CompressResult fields: messages, tokens_before, tokens_after,
                # tokens_saved, compression_ratio, transforms_applied
                compressed_messages = getattr(result, "messages", request.messages)
                upstream_before = getattr(result, "tokens_before", tokens_before)
                upstream_after = getattr(result, "tokens_after", None)
                if upstream_after is None:
                    upstream_after = estimate_tokens(compressed_messages)

                metrics["total_tokens_after"] += upstream_after
                metrics["compressions_applied"] += 1

                transforms = getattr(result, "transforms_applied", []) or []
                # transforms_applied may contain strings or objects with .name
                transforms_named = [
                    t if isinstance(t, str) else getattr(t, "name", str(t))
                    for t in transforms
                ]

                return CompressResponse(
                    messages=compressed_messages,
                    tools=request.tools,
                    compressed=upstream_after < upstream_before,
                    stats={
                        "tokens_before": upstream_before,
                        "tokens_after": upstream_after,
                        "tokens_saved": upstream_before - upstream_after,
                        "savings_percent": round(
                            (1 - upstream_after / upstream_before) * 100, 1
                        )
                        if upstream_before > 0
                        else 0,
                        "compression_ratio": getattr(result, "compression_ratio", 0.0),
                        "transforms_applied": transforms_named,
                        "latency_ms": round((time.time() - start_time) * 1000, 1),
                        "headroom_version": HEADROOM_VERSION,
                    },
                )
            except Exception as e:
                logger.warning(
                    "headroom.compress() failed, falling back to basic: %s", e
                )

        # Fallback path: byte-level CCR-style compression
        result = _basic_compress(request.messages, request.tools)
        metrics["total_tokens_after"] += result["stats"]["tokens_after"]
        if result["compressed"]:
            metrics["compressions_applied"] += 1
        else:
            metrics["compressions_skipped"] += 1

        result["stats"]["latency_ms"] = round((time.time() - start_time) * 1000, 1)
        return CompressResponse(**result)

    except Exception as e:
        metrics["errors"] += 1
        logger.error("Compression error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ccr/retrieve", response_model=CCRRetrieveResponse)
async def ccr_retrieve(request: CCRRetrieveRequest):
    cleanup_expired_ccr()

    if request.hash not in ccr_store:
        return CCRRetrieveResponse(
            success=False,
            error=f"Hash {request.hash} not found or expired",
        )

    entry = ccr_store[request.hash]
    content = entry["content"]
    metrics["ccr_retrievals"] += 1

    if request.query:
        if isinstance(content, list):
            filtered = [
                item
                for item in content
                if request.query.lower() in json.dumps(item).lower()
            ][: request.max_results]
            return CCRRetrieveResponse(
                success=True,
                content=filtered,
                items_retrieved=len(filtered),
                was_search=True,
            )
        if isinstance(content, str):
            if request.query.lower() in content.lower():
                return CCRRetrieveResponse(
                    success=True,
                    content=content,
                    items_retrieved=1,
                    was_search=True,
                )
            return CCRRetrieveResponse(
                success=False,
                error="Query not found in content",
            )

    return CCRRetrieveResponse(
        success=True,
        content=content,
        items_retrieved=1 if not isinstance(content, list) else len(content),
        was_search=False,
    )


# ---------- Entrypoint ----------


if __name__ == "__main__":
    logger.info("Starting Headroom sidecar on %s:%d", config.host, config.port)
    logger.info("Headroom available: %s (version: %s)", HEADROOM_AVAILABLE, HEADROOM_VERSION)
    uvicorn.run(app, host=config.host, port=config.port, log_level=config.log_level)
