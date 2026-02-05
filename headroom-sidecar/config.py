"""
Headroom Sidecar Configuration
Loads settings from environment variables
"""

import os
from typing import Optional


def str_to_bool(value: str) -> bool:
    """Convert string to boolean"""
    return value.lower() in ("true", "1", "yes", "on")


class HeadroomConfig:
    """Configuration for Headroom sidecar"""

    def __init__(self):
        # Server settings
        self.host = os.environ.get("HEADROOM_HOST", "0.0.0.0")
        self.port = int(os.environ.get("HEADROOM_PORT", "8787"))
        self.log_level = os.environ.get("HEADROOM_LOG_LEVEL", "info")

        # Operating mode
        self.mode = os.environ.get("HEADROOM_MODE", "optimize")
        self.provider = os.environ.get("HEADROOM_PROVIDER", "anthropic")

        # Smart Crusher settings
        self.smart_crusher_enabled = str_to_bool(
            os.environ.get("HEADROOM_SMART_CRUSHER", "true")
        )
        self.smart_crusher_min_tokens = int(
            os.environ.get("HEADROOM_SMART_CRUSHER_MIN_TOKENS", "200")
        )
        self.smart_crusher_max_items = int(
            os.environ.get("HEADROOM_SMART_CRUSHER_MAX_ITEMS", "15")
        )

        # Tool Crusher settings
        self.tool_crusher_enabled = str_to_bool(
            os.environ.get("HEADROOM_TOOL_CRUSHER", "true")
        )

        # Cache Aligner settings
        self.cache_aligner_enabled = str_to_bool(
            os.environ.get("HEADROOM_CACHE_ALIGNER", "true")
        )

        # Rolling Window settings
        self.rolling_window_enabled = str_to_bool(
            os.environ.get("HEADROOM_ROLLING_WINDOW", "true")
        )
        self.keep_turns = int(os.environ.get("HEADROOM_KEEP_TURNS", "3"))

        # CCR settings
        self.ccr_enabled = str_to_bool(os.environ.get("HEADROOM_CCR", "true"))
        self.ccr_ttl = int(os.environ.get("HEADROOM_CCR_TTL", "300"))

        # LLMLingua settings
        self.llmlingua_enabled = str_to_bool(
            os.environ.get("HEADROOM_LLMLINGUA", "false")
        )
        self.llmlingua_device = os.environ.get("HEADROOM_LLMLINGUA_DEVICE", "auto")

    def to_dict(self) -> dict:
        """Return configuration as dictionary"""
        return {
            "host": self.host,
            "port": self.port,
            "log_level": self.log_level,
            "mode": self.mode,
            "provider": self.provider,
            "smart_crusher": {
                "enabled": self.smart_crusher_enabled,
                "min_tokens": self.smart_crusher_min_tokens,
                "max_items": self.smart_crusher_max_items,
            },
            "tool_crusher": {"enabled": self.tool_crusher_enabled},
            "cache_aligner": {"enabled": self.cache_aligner_enabled},
            "rolling_window": {
                "enabled": self.rolling_window_enabled,
                "keep_turns": self.keep_turns,
            },
            "ccr": {"enabled": self.ccr_enabled, "ttl": self.ccr_ttl},
            "llmlingua": {
                "enabled": self.llmlingua_enabled,
                "device": self.llmlingua_device,
            },
        }


# Global config instance
config = HeadroomConfig()
