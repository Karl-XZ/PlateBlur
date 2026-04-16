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


def extract_subset(zip_path: Path, subset_name: str, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True, exist_ok=True)

    prefix = f"{subset_name}/"
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            if not member.filename.startswith(prefix) or member.is_dir():
                continue
            relative_path = Path(member.filename[len(prefix) :])
            target_path = destination / relative_path
            target_path.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, target_path.open("wb") as output:
                shutil.copyfileobj(source, output)


def download_pp4av_switzerland(root: Path) -> None:
    dataset_root = root / "pp4av"
    dataset_root.mkdir(parents=True, exist_ok=True)

    images_zip = Path(
        hf_hub_download(
            repo_id="khaclinh/pp4av",
            filename="data/images.zip",
            repo_type="dataset",
            local_dir=str(dataset_root),
        )
    )
    annotations_zip = Path(
        hf_hub_download(
            repo_id="khaclinh/pp4av",
            filename="data/annotations.zip",
            repo_type="dataset",
            local_dir=str(dataset_root),
        )
    )

    swiss_root = root / "pp4av_switzerland"
    extract_subset(images_zip, "switzerland", swiss_root / "images")
    extract_subset(annotations_zip, "switzerland", swiss_root / "labels")
    print(f"Prepared PP4AV Switzerland subset at {swiss_root}")


def main() -> None:
    args = parse_args()
    root = Path(args.root)
    root.mkdir(parents=True, exist_ok=True)
    download_keremberke(root)
    download_country_crops(root)
    download_pp4av_switzerland(root)


if __name__ == "__main__":
    main()
