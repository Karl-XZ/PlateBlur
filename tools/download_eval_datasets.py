#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
import zipfile
from pathlib import Path

from huggingface_hub import hf_hub_download, snapshot_download


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download public evaluation datasets used by PlateBlur.")
    parser.add_argument(
        "--root",
        default="/Users/applemima111/Desktop/car/eval_data",
        help="Root directory where datasets should be stored.",
    )
    return parser.parse_args()


def download_keremberke(root: Path) -> None:
    dataset_root = root / "keremberke"
    dataset_root.mkdir(parents=True, exist_ok=True)
    zip_path = Path(
        hf_hub_download(
            repo_id="keremberke/license-plate-object-detection",
            filename="data/test.zip",
            repo_type="dataset",
            local_dir=str(dataset_root),
        )
    )
    target_dir = dataset_root / "test"
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(target_dir)
    print(f"Prepared Keremberke test set at {target_dir}")


def download_country_crops(root: Path) -> None:
    for repo_id, local_name in [
        ("UniDataPro/germany-license-plate-dataset", "unidatapro_germany"),
        ("UniDataPro/netherlands-license-plate-dataset", "unidatapro_netherlands"),
    ]:
        local_dir = root / local_name
        snapshot_download(repo_id=repo_id, repo_type="dataset", local_dir=str(local_dir))
        print(f"Prepared {repo_id} at {local_dir}")


def main() -> None:
    args = parse_args()
    root = Path(args.root)
    root.mkdir(parents=True, exist_ok=True)
    download_keremberke(root)
    download_country_crops(root)


if __name__ == "__main__":
    main()
