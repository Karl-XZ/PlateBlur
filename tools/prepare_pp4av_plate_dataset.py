#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import random
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

from PIL import Image


ROAD_SCENE_SUBSETS = [
    "paris",
    "netherlands_day",
    "netherlands_night",
    "strasbourg",
    "stuttgart",
    "zurich",
    "switzerland",
]


@dataclass(frozen=True)
class TileWindow:
    x: int
    y: int
    width: int
    height: int

    @property
    def key(self) -> str:
        return f"x{self.x}_y{self.y}_w{self.width}_h{self.height}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare a PP4AV road-scene license plate training dataset with tiled crops and a Swiss holdout split."
    )
    parser.add_argument(
        "--images-zip",
        default="/Users/applemima111/Desktop/car/eval_data/pp4av/data/images.zip",
        help="Path to PP4AV images.zip.",
    )
    parser.add_argument(
        "--annotations-zip",
        default="/Users/applemima111/Desktop/car/eval_data/pp4av/data/annotations.zip",
        help="Path to PP4AV annotations.zip.",
    )
    parser.add_argument(
        "--output-dir",
        default="/Users/applemima111/Desktop/car/train_data/pp4av_tiled_plate_dataset",
        help="Output directory for the YOLO dataset and Swiss holdout split.",
    )
    parser.add_argument(
        "--tile-size",
        type=int,
        default=640,
        help="Sliding-window tile size in source-image pixels.",
    )
    parser.add_argument(
        "--tile-overlap",
        type=float,
        default=0.4,
        help="Sliding-window overlap ratio.",
    )
    parser.add_argument(
        "--swiss-train-fraction",
        type=float,
        default=0.6,
        help="Contiguous train fraction for the Switzerland subset.",
    )
    parser.add_argument(
        "--swiss-val-fraction",
        type=float,
        default=0.2,
        help="Contiguous val fraction for the Switzerland subset. The remainder becomes holdout test.",
    )
    parser.add_argument(
        "--non-swiss-val-fraction",
        type=float,
        default=0.1,
        help="Fraction of each non-Swiss road-scene subset used for validation.",
    )
    parser.add_argument(
        "--negative-tile-ratio",
        type=float,
        default=0.35,
        help="Maximum number of negative tiles kept per split, relative to positive tiles from the same image.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for deterministic negative-tile sampling.",
    )
    return parser.parse_args()


def sliding_positions(length: int, window: int, overlap: float) -> List[int]:
    if length <= window:
        return [0]

    stride = max(1, int(round(window * (1.0 - overlap))))
    positions = list(range(0, length - window + 1, stride))
    tail = length - window
    if positions[-1] != tail:
        positions.append(tail)
    return positions


def iter_tile_windows(width: int, height: int, tile_size: int, overlap: float) -> Iterable[TileWindow]:
    xs = sliding_positions(width, tile_size, overlap)
    ys = sliding_positions(height, tile_size, overlap)

    for y in ys:
        for x in xs:
            yield TileWindow(
                x=x,
                y=y,
                width=min(tile_size, width - x),
                height=min(tile_size, height - y),
            )


def parse_plate_boxes(label_text: str, width: int, height: int) -> List[Tuple[float, float, float, float]]:
    boxes: List[Tuple[float, float, float, float]] = []
    for line in label_text.splitlines():
        parts = line.strip().split()
        if len(parts) < 5:
            continue
        class_id = int(float(parts[0]))
        if class_id != 1:
            continue

        center_x, center_y, box_width, box_height = map(float, parts[1:5])
        x1 = (center_x - box_width / 2.0) * width
        y1 = (center_y - box_height / 2.0) * height
        x2 = (center_x + box_width / 2.0) * width
        y2 = (center_y + box_height / 2.0) * height
        boxes.append((x1, y1, x2, y2))
    return boxes


def clip_box_to_tile(
    box: Tuple[float, float, float, float],
    tile: TileWindow,
) -> Tuple[float, float, float, float] | None:
    x1, y1, x2, y2 = box
    inter_x1 = max(x1, tile.x)
    inter_y1 = max(y1, tile.y)
    inter_x2 = min(x2, tile.x + tile.width)
    inter_y2 = min(y2, tile.y + tile.height)

    inter_w = inter_x2 - inter_x1
    inter_h = inter_y2 - inter_y1
    if inter_w <= 2 or inter_h <= 2:
        return None

    original_area = max((x2 - x1) * (y2 - y1), 1.0)
    visible_area = inter_w * inter_h
    center_x = (x1 + x2) / 2.0
    center_y = (y1 + y2) / 2.0
    center_inside = tile.x <= center_x <= tile.x + tile.width and tile.y <= center_y <= tile.y + tile.height

    if visible_area / original_area < 0.45 and not center_inside:
        return None

    local_x1 = inter_x1 - tile.x
    local_y1 = inter_y1 - tile.y
    local_x2 = inter_x2 - tile.x
    local_y2 = inter_y2 - tile.y
    return (local_x1, local_y1, local_x2, local_y2)


def yolo_line(box: Tuple[float, float, float, float], width: int, height: int, class_id: int = 0) -> str:
    x1, y1, x2, y2 = box
    box_width = max(x2 - x1, 1.0)
    box_height = max(y2 - y1, 1.0)
    center_x = x1 + box_width / 2.0
    center_y = y1 + box_height / 2.0
    return "{} {:.6f} {:.6f} {:.6f} {:.6f}".format(
        class_id,
        center_x / width,
        center_y / height,
        box_width / width,
        box_height / height,
    )


def contiguous_splits(items: Sequence[str], fractions: Tuple[float, float]) -> Dict[str, List[str]]:
    train_fraction, val_fraction = fractions
    total = len(items)
    train_end = int(math.floor(total * train_fraction))
    val_end = int(math.floor(total * (train_fraction + val_fraction)))
    return {
        "train": list(items[:train_end]),
        "val": list(items[train_end:val_end]),
        "test": list(items[val_end:]),
    }


def split_subset(items: Sequence[str], val_fraction: float) -> Dict[str, List[str]]:
    total = len(items)
    val_count = max(1, int(round(total * val_fraction))) if total > 8 else max(1, total // 5)
    train_count = max(total - val_count, 1)
    return {
        "train": list(items[:train_count]),
        "val": list(items[train_count:]),
        "test": [],
    }


def list_subset_images(images_zip: zipfile.ZipFile, subset: str) -> List[str]:
    prefix = f"{subset}/"
    return sorted(
        name for name in images_zip.namelist()
        if name.startswith(prefix) and name.lower().endswith((".png", ".jpg", ".jpeg"))
    )


def write_yaml(dataset_yaml: Path, output_dir: Path) -> None:
    dataset_yaml.write_text(
        "\n".join(
            [
                f"path: {output_dir / 'yolo_tiles'}",
                "train: images/train",
                "val: images/val",
                "names:",
                "  0: license_plate",
                "",
            ]
        ),
        encoding="utf-8",
    )


def save_image(image: Image.Image, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, format="JPEG", quality=95)


def save_label(lines: Sequence[str], target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def main() -> None:
    args = parse_args()
    random.seed(args.seed)

    output_dir = Path(args.output_dir)
    tiles_dir = output_dir / "yolo_tiles"
    holdout_dir = output_dir / "swiss_holdout_scene"
    manifest_path = output_dir / "manifest.json"
    dataset_yaml = output_dir / "plate_dataset.yaml"

    for directory in [
        tiles_dir / "images" / "train",
        tiles_dir / "images" / "val",
        tiles_dir / "labels" / "train",
        tiles_dir / "labels" / "val",
        holdout_dir / "images",
        holdout_dir / "labels",
    ]:
        directory.mkdir(parents=True, exist_ok=True)

    manifest: Dict[str, object] = {
        "config": {
            "tile_size": args.tile_size,
            "tile_overlap": args.tile_overlap,
            "swiss_train_fraction": args.swiss_train_fraction,
            "swiss_val_fraction": args.swiss_val_fraction,
            "non_swiss_val_fraction": args.non_swiss_val_fraction,
            "negative_tile_ratio": args.negative_tile_ratio,
            "seed": args.seed,
        },
        "splits": {},
        "tile_counts": {"train": 0, "val": 0},
        "positive_tile_counts": {"train": 0, "val": 0},
        "negative_tile_counts": {"train": 0, "val": 0},
        "holdout_images": [],
    }

    with zipfile.ZipFile(args.images_zip) as images_zip, zipfile.ZipFile(args.annotations_zip) as annotations_zip:
        split_lookup: Dict[str, str] = {}

        for subset in ROAD_SCENE_SUBSETS:
            files = list_subset_images(images_zip, subset)
            relative_files = [name.split("/", 1)[1] for name in files]
            if subset == "switzerland":
                subset_splits = contiguous_splits(
                    relative_files,
                    (args.swiss_train_fraction, args.swiss_val_fraction),
                )
            else:
                subset_splits = split_subset(relative_files, args.non_swiss_val_fraction)

            manifest["splits"][subset] = subset_splits
            for split_name, split_files in subset_splits.items():
                for relative_file in split_files:
                    split_lookup[f"{subset}/{relative_file}"] = split_name

        for subset in ROAD_SCENE_SUBSETS:
            for relative_file in manifest["splits"][subset]["test"]:
                archive_name = f"{subset}/{relative_file}"
                image_bytes = images_zip.read(archive_name)
                label_name = archive_name.rsplit(".", 1)[0] + ".txt"
                label_text = annotations_zip.read(label_name).decode("utf-8") if label_name in annotations_zip.namelist() else ""

                image = Image.open(BytesIO(image_bytes)).convert("RGB")
                save_image(image, holdout_dir / "images" / f"{subset}-{Path(relative_file).stem}.jpg")

                with image:
                    width, height = image.size
                boxes = parse_plate_boxes(label_text, width, height)
                label_lines = [yolo_line(box, width, height, class_id=1) for box in boxes]
                save_label(label_lines, holdout_dir / "labels" / f"{subset}-{Path(relative_file).stem}.txt")
                manifest["holdout_images"].append(f"{subset}-{Path(relative_file).stem}.jpg")

        for archive_name, split_name in sorted(split_lookup.items()):
            if split_name == "test":
                continue

            image_bytes = images_zip.read(archive_name)
            label_name = archive_name.rsplit(".", 1)[0] + ".txt"
            label_text = annotations_zip.read(label_name).decode("utf-8") if label_name in annotations_zip.namelist() else ""

            with Image.open(BytesIO(image_bytes)) as image:
                rgb_image = image.convert("RGB")
                width, height = rgb_image.size
                boxes = parse_plate_boxes(label_text, width, height)
                positive_tiles: List[Tuple[TileWindow, List[str]]] = []
                negative_tiles: List[TileWindow] = []

                for tile in iter_tile_windows(width, height, args.tile_size, args.tile_overlap):
                    local_boxes = [clip_box_to_tile(box, tile) for box in boxes]
                    local_boxes = [box for box in local_boxes if box is not None]
                    if local_boxes:
                        label_lines = [yolo_line(box, tile.width, tile.height) for box in local_boxes]
                        positive_tiles.append((tile, label_lines))
                    else:
                        negative_tiles.append(tile)

                max_negative_tiles = 0
                if positive_tiles:
                    max_negative_tiles = int(math.ceil(len(positive_tiles) * args.negative_tile_ratio))
                elif negative_tiles:
                    max_negative_tiles = 1

                negative_tiles = random.sample(negative_tiles, min(len(negative_tiles), max_negative_tiles))

                subset = archive_name.split("/", 1)[0]
                relative_name = archive_name.split("/", 1)[1]
                stem = f"{subset}-{Path(relative_name).stem}"

                for tile, label_lines in positive_tiles:
                    tile_image = rgb_image.crop((tile.x, tile.y, tile.x + tile.width, tile.y + tile.height))
                    tile_stem = f"{stem}-{tile.key}"
                    save_image(tile_image, tiles_dir / "images" / split_name / f"{tile_stem}.jpg")
                    save_label(label_lines, tiles_dir / "labels" / split_name / f"{tile_stem}.txt")
                    manifest["tile_counts"][split_name] += 1
                    manifest["positive_tile_counts"][split_name] += 1

                for tile in negative_tiles:
                    tile_image = rgb_image.crop((tile.x, tile.y, tile.x + tile.width, tile.y + tile.height))
                    tile_stem = f"{stem}-{tile.key}"
                    save_image(tile_image, tiles_dir / "images" / split_name / f"{tile_stem}.jpg")
                    save_label([], tiles_dir / "labels" / split_name / f"{tile_stem}.txt")
                    manifest["tile_counts"][split_name] += 1
                    manifest["negative_tile_counts"][split_name] += 1

    write_yaml(dataset_yaml, output_dir)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
