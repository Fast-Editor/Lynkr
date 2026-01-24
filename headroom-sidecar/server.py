"""
Headroom Sidecar Server
FastAPI application providing context compression via HTTP API
"""

import logging
import time
import hashlib
import json
from typing import Any, Dict, List, Optional
from datetime import datetime

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import uvicorn

from config import config

# Setup logging
logging.basicConfig(
    level=getattr(logging, config.log_level.upper()),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("headroom-sidecar")

# Initialize FastAPI app
app = FastAPI(
    title="Headroom Sidecar",
    description="Context compression service for LLM requests",
    version="1.0.0",
)

# Try to import headroom, fallback to basic compression if not available
try:
    from headroom import (
        TransformPipeline,
        SmartCrusher,
        SmartCrusherConfig,
        ToolCrusher,
        ToolCrusherConfig,
        RollingWindow,
        RollingWindowConfig,
        AnthropicProvider,
        OpenAIProvider,
    )
    import warnings
    warnings.filterwarnings("ignore", message=".*tiktoken approximation.*")

    # Create transforms based on config
    transforms = []

    if config.smart_crusher_enabled:
        transforms.append(SmartCrusher(SmartCrusherConfig(
            enabled=True,
            min_tokens_to_crush=config.smart_crusher_min_tokens,
            max_items_after_crush=config.smart_crusher_max_items,
        )))
        logger.info("SmartCrusher enabled")

    if config.tool_crusher_enabled:
        transforms.append(ToolCrusher(ToolCrusherConfig(
            enabled=True,
        )))
        logger.info("ToolCrusher enabled")

    if config.rolling_window_enabled:
        transforms.append(RollingWindow(RollingWindowConfig(
            enabled=True,
            keep_last_turns=config.keep_turns,
        )))
        logger.info("RollingWindow enabled")

    # Create provider based on config
    if config.provider == "openai":
        headroom_provider = OpenAIProvider()
    else:
        headroom_provider = AnthropicProvider()

    headroom_pipeline = TransformPipeline(transforms=transforms, provider=headroom_provider) if transforms else None
    HEADROOM_AVAILABLE = headroom_pipeline is not None
    logger.info(f"Headroom SDK loaded successfully with {len(transforms)} transforms (provider: {config.provider})")
except ImportError as e:
    logger.warning(f"Headroom SDK not available: {e}. Using basic compression.")
    headroom_pipeline = None
    HEADROOM_AVAILABLE = False

# CCR Store (in-memory with TTL)
ccr_store: Dict[str, Dict[str, Any]] = {}

# Metrics
metrics = {
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


# Request/Response models
class CompressRequest(BaseModel):
    messages: List[Dict[str, Any]]
    tools: Optional[List[Dict[str, Any]]] = None
    model: Optional[str] = "claude-3-5-sonnet-20241022"
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


def estimate_tokens(data: Any) -> int:
    """Estimate token count (rough approximation: ~4 chars per token)"""
    text = json.dumps(data) if not isinstance(data, str) else data
    return len(text) // 4


def generate_hash(content: Any) -> str:
    """Generate hash for CCR storage"""
    text = json.dumps(content, sort_keys=True)
    return hashlib.sha256(text.encode()).hexdigest()[:12]


def cleanup_expired_ccr():
    """Remove expired CCR entries"""
    now = time.time()
    expired = [k for k, v in ccr_store.items() if now - v["timestamp"] > config.ccr_ttl]
    for key in expired:
        del ccr_store[key]


def basic_compress(messages: List[Dict], tools: Optional[List] = None) -> Dict:
    """Basic compression when Headroom SDK is not available"""
    tokens_before = estimate_tokens(messages)
    compressed_messages = []

    for msg in messages:
        compressed_msg = msg.copy()

        # Compress large tool results
        if msg.get("role") == "user" and isinstance(msg.get("content"), list):
            new_content = []
            for block in msg["content"]:
                if block.get("type") == "tool_result":
                    content = block.get("content", "")
                    if isinstance(content, str) and len(content) > 2000:
                        # Store in CCR and replace with reference
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
            "savings_percent": round(
                (1 - tokens_after / tokens_before) * 100, 1
            ) if tokens_before > 0 else 0,
            "transforms_applied": ["basic_ccr"] if tokens_after < tokens_before else [],
            "latency_ms": 0,
        },
    }


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    cleanup_expired_ccr()
    return {
        "status": "healthy",
        "headroom_loaded": HEADROOM_AVAILABLE,
        "ccr_enabled": config.ccr_enabled,
        "llmlingua_enabled": config.llmlingua_enabled,
        "entries_cached": len(ccr_store),
        "config": config.to_dict(),
    }


@app.get("/metrics")
async def get_metrics():
    """Get compression metrics"""
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
    """Compress messages and tools"""
    start_time = time.time()
    metrics["requests_total"] += 1

    try:
        tokens_before = estimate_tokens(request.messages)
        metrics["total_tokens_before"] += tokens_before

        # Skip if below minimum tokens
        if tokens_before < config.smart_crusher_min_tokens:
            metrics["compressions_skipped"] += 1
            return CompressResponse(
                messages=request.messages,
                tools=request.tools,
                compressed=False,
                stats={
                    "skipped": True,
                    "reason": f"Below threshold ({tokens_before} < {config.smart_crusher_min_tokens})",
                },
            )

        # Use Headroom SDK if available
        if HEADROOM_AVAILABLE and headroom_pipeline:
            try:
                result = headroom_pipeline.apply(
                    request.messages,
                    model=request.model,
                    model_limit=request.model_limit,
                )

                # Extract messages from TransformResult
                if hasattr(result, 'messages'):
                    compressed_messages = result.messages
                    # transforms_applied may be strings or objects with .name
                    if hasattr(result, 'transforms_applied'):
                        transforms_applied = [t if isinstance(t, str) else getattr(t, 'name', str(t)) for t in result.transforms_applied]
                    else:
                        transforms_applied = []
                elif isinstance(result, dict):
                    compressed_messages = result.get("messages", request.messages)
                    transforms_applied = result.get("transforms", [])
                else:
                    compressed_messages = result if isinstance(result, list) else request.messages
                    transforms_applied = []

                tokens_after = estimate_tokens(compressed_messages)
                metrics["total_tokens_after"] += tokens_after
                metrics["compressions_applied"] += 1

                return CompressResponse(
                    messages=compressed_messages,
                    tools=request.tools,  # Tools not modified by current transforms
                    compressed=tokens_after < tokens_before,
                    stats={
                        "tokens_before": tokens_before,
                        "tokens_after": tokens_after,
                        "tokens_saved": tokens_before - tokens_after,
                        "savings_percent": round(
                            (1 - tokens_after / tokens_before) * 100, 1
                        ) if tokens_before > 0 else 0,
                        "transforms_applied": transforms_applied,
                        "latency_ms": round((time.time() - start_time) * 1000, 1),
                    },
                )
            except Exception as e:
                logger.warning(f"Headroom SDK error, falling back to basic: {e}")

        # Fallback to basic compression
        result = basic_compress(request.messages, request.tools)
        metrics["total_tokens_after"] += result["stats"]["tokens_after"]
        if result["compressed"]:
            metrics["compressions_applied"] += 1
        else:
            metrics["compressions_skipped"] += 1

        result["stats"]["latency_ms"] = round((time.time() - start_time) * 1000, 1)
        return CompressResponse(**result)

    except Exception as e:
        metrics["errors"] += 1
        logger.error(f"Compression error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ccr/retrieve", response_model=CCRRetrieveResponse)
async def ccr_retrieve(request: CCRRetrieveRequest):
    """Retrieve content from CCR store"""
    cleanup_expired_ccr()

    if request.hash not in ccr_store:
        return CCRRetrieveResponse(
            success=False,
            error=f"Hash {request.hash} not found or expired",
        )

    entry = ccr_store[request.hash]
    content = entry["content"]
    metrics["ccr_retrievals"] += 1

    # If query provided, search within content
    if request.query:
        if isinstance(content, list):
            # Filter list items by query
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
        elif isinstance(content, str):
            # Return content if query matches
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

    # Return full content
    return CCRRetrieveResponse(
        success=True,
        content=content,
        items_retrieved=1 if not isinstance(content, list) else len(content),
        was_search=False,
    )


@app.post("/ccr/track")
async def ccr_track(
    hash_key: str,
    turn_number: int,
    tool_name: str,
    sample: str,
):
    """Track compression for proactive expansion"""
    return {"tracked": True, "hash_key": hash_key}


@app.post("/ccr/analyze")
async def ccr_analyze(query: str, turn_number: int):
    """Analyze query for proactive CCR expansion"""
    # Simple keyword matching for expansion suggestions
    expansions = []
    for hash_key, entry in ccr_store.items():
        if query.lower() in json.dumps(entry["content"]).lower():
            expansions.append(
                {
                    "hash": hash_key,
                    "tool_name": entry.get("tool_name", "unknown"),
                    "relevance": 0.8,
                }
            )
    return {"expansions": expansions[:5]}


@app.post("/compress/llmlingua")
async def llmlingua_compress(
    text: str,
    target_ratio: float = 0.5,
    force_tokens: Optional[str] = None,
):
    """Compress text using LLMLingua (if available)"""
    if not config.llmlingua_enabled:
        raise HTTPException(status_code=400, detail="LLMLingua is not enabled")

    try:
        # Try to import and use llmlingua
        from llmlingua import PromptCompressor

        compressor = PromptCompressor(device_map=config.llmlingua_device)
        result = compressor.compress_prompt(
            text,
            rate=target_ratio,
            force_tokens=json.loads(force_tokens) if force_tokens else None,
        )
        return {
            "compressed": result["compressed_prompt"],
            "original_tokens": result.get("origin_tokens", len(text) // 4),
            "compressed_tokens": result.get("compressed_tokens", len(result["compressed_prompt"]) // 4),
            "ratio": result.get("rate", target_ratio),
        }
    except ImportError:
        raise HTTPException(
            status_code=501,
            detail="LLMLingua not installed. Add llmlingua to requirements.txt",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    logger.info(f"Starting Headroom sidecar on {config.host}:{config.port}")
    logger.info(f"Configuration: {json.dumps(config.to_dict(), indent=2)}")
    uvicorn.run(
        app,
        host=config.host,
        port=config.port,
        log_level=config.log_level,
    )
