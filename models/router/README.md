# ML Router Model Files

This directory stores the ONNX model and tokenizer files for ML-based routing.

## Setup

1. Install Python dependencies (one-time):
   ```bash
   pip install routellm transformers torch onnx onnxruntime
   ```

2. Run the export script:
   ```bash
   python scripts/export-routellm-bert.py
   ```

3. This creates:
   - `routellm-bert.onnx` (~110MB) — BERT classifier model
   - `tokenizer.json` (~700KB) — Tokenizer config

4. Configure Lynkr:
   ```bash
   ROUTING_STRATEGY=hybrid
   ML_ROUTER_MODEL=./models/router/routellm-bert.onnx
   ```

## How It Works

The BERT router is trained on 1M+ human preference votes from LMSB Chatbot Arena.
It classifies prompts into 3 classes (strong model wins, tie, weak model wins) to
predict whether a complex or simple model is needed.

Lynkr maps this to its 4-tier system: SIMPLE, MEDIUM, COMPLEX, REASONING.

## Files

These files are NOT committed to git (too large). Each user runs the export script once.
