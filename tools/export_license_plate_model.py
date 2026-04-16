#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path

from huggingface_hub import hf_hub_download
from ultralytics import YOLO


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download, export, and compile the bundled license plate detector.")
    parser.add_argument(
        "--weights-path",
        default="",
        help="Optional local YOLO weights path. When set, skip Hugging Face download and export this checkpoint instead.",
    )
    parser.add_argument(
        "--repo-id",
        default="Koushim/yolov8-license-plate-detection",
        help="Hugging Face model repo id.",
    )
    parser.add_argument(
        "--filename",
        default="best.pt",
        help="Model weight filename inside the repo.",
    )
    parser.add_argument(
        "--model-dir",
        default="/Users/applemima111/Desktop/car/models/koushim",
        help="Local directory for downloaded and exported model files.",
    )
    parser.add_argument(
        "--app-model-dir",
        default="/Users/applemima111/Desktop/car/PlateBlur/PlateBlur",
        help="PlateBlur app source directory where LicensePlateDetector.mlmodelc should be copied.",
    )
    parser.add_argument(
        "--developer-dir",
        default="/Applications/Xcode.app/Contents/Developer",
        help="Xcode developer directory used for coremlcompiler.",
    )
    parser.add_argument(
        "--imgsz",
        type=int,
        default=640,
        help="Core ML export image size.",
    )
    parser.add_argument(
        "--export-name",
        default="LicensePlateDetector",
        help="Compiled model bundle name copied into the app model directory.",
    )
    return parser.parse_args()


def compile_mlpackage(mlpackage_path: Path, output_dir: Path, developer_dir: str, export_name: str) -> Path:
    build_dir = output_dir / ".coreml-build"
    shutil.rmtree(build_dir, ignore_errors=True)
    build_dir.mkdir(parents=True, exist_ok=True)

    env = {**os.environ, "DEVELOPER_DIR": developer_dir}
    subprocess.run(
        ["xcrun", "coremlcompiler", "compile", str(mlpackage_path), str(build_dir)],
        check=True,
        env=env,
    )

    compiled = build_dir / f"{mlpackage_path.stem}.mlmodelc"
    target = output_dir / f"{export_name}.mlmodelc"
    shutil.rmtree(target, ignore_errors=True)
    shutil.move(str(compiled), str(target))
    shutil.rmtree(build_dir, ignore_errors=True)
    return target


def main() -> None:
    args = parse_args()
    model_dir = Path(args.model_dir)
    model_dir.mkdir(parents=True, exist_ok=True)

    if args.weights_path:
        weights_path = Path(args.weights_path)
    else:
        weights_path = Path(
            hf_hub_download(
                repo_id=args.repo_id,
                filename=args.filename,
                local_dir=str(model_dir),
            )
        )
    
    print(f"Downloaded weights: {weights_path}")

    model = YOLO(str(weights_path))
    mlpackage_path = Path(model.export(format="coreml", imgsz=args.imgsz, nms=True, int8=False, half=False))
    print(f"Exported Core ML package: {mlpackage_path}")

    target_dir = Path(args.app_model_dir)
    compiled_path = compile_mlpackage(mlpackage_path, target_dir, args.developer_dir, args.export_name)
    print(f"Compiled model copied to: {compiled_path}")


if __name__ == "__main__":
    main()
