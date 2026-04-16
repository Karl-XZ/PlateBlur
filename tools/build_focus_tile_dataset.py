#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path
from typing import Iterable, List


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a smaller hard-linked YOLO tile dataset from an existing tiled dataset, filtered by filename prefixes."
    )
    parser.add_argument(
        "--source",
        default="/Users/applemima111/Desktop/car/train_data/pp4av_tiled_plate_dataset/yolo_tiles",
        help="Source tiled YOLO dataset root.",
    )
    parser.add_argument(
        "--output",
        default="/Users/applemima111/Desktop/car/train_data/pp4av_focus_de_ch_tiles",
        help="Destination dataset root.",
    )
    parser.add_argument(
        "--prefixes",
        nargs="+",
        default=["switzerland", "zurich", "stuttgart", "strasbourg"],
        help="Filename prefixes to keep.",
    )
    return parser.parse_args()


def iter_matching_files(directory: Path, prefixes: List[str]) -> Iterable[Path]:
    for path in sorted(directory.iterdir()):
        if not path.is_file():
            continue
        if any(path.name.startswith(f"{prefix}-") for prefix in prefixes):
            yield path


def hardlink(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    os.link(source, destination)


def write_yaml(output_root: Path) -> None:
    (output_root / "plate_dataset.yaml").write_text(
        "\n".join(
            [
                f"path: {output_root}",
                "train: images/train",
                "val: images/val",
                "names:",
                "  0: license_plate",
                "",
            ]
        ),
        encoding="utf-8",
    )


def main() -> None:
    args = parse_args()
    source_root = Path(args.source)
    output_root = Path(args.output)

    shutil.rmtree(output_root, ignore_errors=True)
    for split in ["train", "val"]:
        (output_root / "images" / split).mkdir(parents=True, exist_ok=True)
        (output_root / "labels" / split).mkdir(parents=True, exist_ok=True)

        for image_path in iter_matching_files(source_root / "images" / split, args.prefixes):
            hardlink(image_path, output_root / "images" / split / image_path.name)

        for label_path in iter_matching_files(source_root / "labels" / split, args.prefixes):
            hardlink(label_path, output_root / "labels" / split / label_path.name)

    write_yaml(output_root)
    train_count = sum(1 for _ in (output_root / "images" / "train").iterdir())
    val_count = sum(1 for _ in (output_root / "images" / "val").iterdir())
    print(f"train={train_count}")
    print(f"val={val_count}")


if __name__ == "__main__":
    main()
