#!/usr/bin/env python3
"""
Export RouteLLM BERT router to ONNX format for use in Lynkr's ML routing.

One-time script. Run once to generate the ONNX model + tokenizer files.

Usage:
    pip install routellm transformers torch onnx onnxruntime
    python scripts/export-routellm-bert.py

Output:
    models/router/routellm-bert.onnx     (~110MB)
    models/router/tokenizer.json         (~700KB)
"""

import os
import sys
import shutil
import torch
from pathlib import Path

def main():
    try:
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
    except ImportError:
        print("Error: Install dependencies first:")
        print("  pip install routellm transformers torch onnx onnxruntime")
        sys.exit(1)

    output_dir = Path(__file__).parent.parent / "models" / "router"
    output_dir.mkdir(parents=True, exist_ok=True)

    checkpoint = "routellm/bert"
    print(f"[1/4] Downloading BERT router from HuggingFace: {checkpoint}")

    model = AutoModelForSequenceClassification.from_pretrained(checkpoint, num_labels=3)
    tokenizer = AutoTokenizer.from_pretrained(checkpoint)

    model.eval()

    print("[2/4] Preparing dummy input for ONNX export...")
    dummy_text = "Write a Python function to sort a list"
    inputs = tokenizer(
        dummy_text,
        return_tensors="pt",
        padding="max_length",
        truncation=True,
        max_length=512,
    )

    input_ids = inputs["input_ids"]
    attention_mask = inputs["attention_mask"]

    onnx_path = output_dir / "routellm-bert.onnx"
    print(f"[3/4] Exporting to ONNX: {onnx_path}")

    torch.onnx.export(
        model,
        (input_ids, attention_mask),
        str(onnx_path),
        export_params=True,
        opset_version=14,
        do_constant_folding=True,
        input_names=["input_ids", "attention_mask"],
        output_names=["logits"],
        dynamic_axes={
            "input_ids": {0: "batch_size", 1: "sequence_length"},
            "attention_mask": {0: "batch_size", 1: "sequence_length"},
            "logits": {0: "batch_size"},
        },
    )

    print("[4/4] Saving tokenizer...")
    tokenizer.save_pretrained(str(output_dir))

    # Verify export
    onnx_size = onnx_path.stat().st_size / (1024 * 1024)
    print(f"\nExport complete:")
    print(f"  Model:     {onnx_path} ({onnx_size:.1f} MB)")
    print(f"  Tokenizer: {output_dir}/tokenizer.json")
    print(f"\nTo use in Lynkr, set:")
    print(f"  ROUTING_STRATEGY=hybrid")
    print(f"  ML_ROUTER_MODEL=./models/router/routellm-bert.onnx")

    # Quick validation
    try:
        import onnxruntime as ort
        sess = ort.InferenceSession(str(onnx_path))
        import numpy as np
        result = sess.run(
            None,
            {
                "input_ids": input_ids.numpy().astype(np.int64),
                "attention_mask": attention_mask.numpy().astype(np.int64),
            },
        )
        logits = result[0]
        probs = torch.nn.functional.softmax(torch.tensor(logits), dim=-1)
        print(f"\nValidation passed! Sample output: {probs.tolist()}")
    except ImportError:
        print("\n(Skipping validation — install onnxruntime to verify)")


if __name__ == "__main__":
    main()
