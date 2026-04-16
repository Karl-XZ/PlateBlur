#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path
from typing import Dict, List, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evaluate_plate_detector as epd


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze why PP4AV Switzerland performs poorly for the bundled detector.")
    parser.add_argument(
        "--model",
        default="/Users/applemima111/Desktop/car/models/koushim/best.mlpackage",
        help="Path to the Core ML package to analyze.",
    )
    parser.add_argument(
        "--swiss-images",
        default="/Users/applemima111/Desktop/car/eval_data/pp4av_switzerland/images",
        help="Directory containing PP4AV Switzerland images.",
    )
    parser.add_argument(
        "--swiss-labels",
        default="/Users/applemima111/Desktop/car/eval_data/pp4av_switzerland/labels",
        help="Directory containing PP4AV Switzerland YOLO labels.",
    )
    parser.add_argument(
        "--reference-coco",
        default="/Users/applemima111/Desktop/car/eval_data/keremberke/test/_annotations.coco.json",
        help="Reference COCO annotation file used for comparison.",
    )
    parser.add_argument(
        "--default-threshold",
        type=float,
        default=0.25,
        help="Default confidence threshold used by the app.",
    )
    parser.add_argument(
        "--iou-threshold",
        type=float,
        default=0.45,
        help="IoU threshold used during prediction/NMS.",
    )
    parser.add_argument(
        "--report-json",
        default="/Users/applemima111/Desktop/car/PlateBlur/swiss_failure_analysis.json",
        help="Where to save the machine-readable analysis payload.",
    )
    parser.add_argument(
        "--report-md",
        default="/Users/applemima111/Desktop/car/PlateBlur/SWISS_FAILURE_ANALYSIS.md",
        help="Where to save the markdown analysis report.",
    )
    return parser.parse_args()


def safe_quantile(sorted_values: Sequence[float], fraction: float) -> float:
    index = min(len(sorted_values) - 1, int(len(sorted_values) * fraction))
    return sorted_values[index]


def dataset_distribution_from_coco(annotation_path: Path) -> Dict[str, float]:
    payload = json.loads(annotation_path.read_text(encoding="utf-8"))
    images = {item["id"]: item for item in payload["images"]}

    areas = []
    widths = []
    heights = []
    centers_y = []
    widths_640 = []
    heights_640 = []

    for annotation in payload["annotations"]:
        image = images[annotation["image_id"]]
        width_ratio = annotation["bbox"][2] / image["width"]
        height_ratio = annotation["bbox"][3] / image["height"]
        area_ratio = (annotation["bbox"][2] * annotation["bbox"][3]) / (image["width"] * image["height"])
        center_y = (annotation["bbox"][1] + annotation["bbox"][3] / 2.0) / image["height"]

        widths.append(width_ratio)
        heights.append(height_ratio)
        areas.append(area_ratio)
        centers_y.append(center_y)
        widths_640.append(width_ratio * 640.0)
        heights_640.append(height_ratio * 640.0)

    areas_sorted = sorted(areas)
    widths_640_sorted = sorted(widths_640)
    heights_640_sorted = sorted(heights_640)

    return {
        "count": len(areas),
        "area_mean": statistics.mean(areas),
        "area_median": statistics.median(areas),
        "area_p90": safe_quantile(areas_sorted, 0.9),
        "width_median_ratio": statistics.median(widths),
        "height_median_ratio": statistics.median(heights),
        "center_y_median": statistics.median(centers_y),
        "width_median_640": statistics.median(widths_640),
        "height_median_640": statistics.median(heights_640),
        "pct_width_lt_16_640": sum(1 for value in widths_640 if value < 16) / len(widths_640),
        "pct_width_lt_12_640": sum(1 for value in widths_640 if value < 12) / len(widths_640),
        "pct_height_lt_8_640": sum(1 for value in heights_640 if value < 8) / len(heights_640),
    }


def dataset_distribution_from_yolo(images_dir: Path, labels_dir: Path) -> Dict[str, float]:
    areas = []
    widths = []
    heights = []
    centers_y = []
    widths_640 = []
    heights_640 = []
    image_count = 0
    images_with_gt = 0
    plates_per_image: List[int] = []

    for image_path in sorted(images_dir.iterdir()):
        if image_path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            continue
        image_count += 1
        label_path = labels_dir / f"{image_path.stem}.txt"
        plate_count = 0
        if label_path.exists():
            for line in label_path.read_text(encoding="utf-8").splitlines():
                parts = line.strip().split()
                if len(parts) < 5 or int(float(parts[0])) != 1:
                    continue
                _, center_x, center_y, width, height = parts[:5]
                width = float(width)
                height = float(height)
                center_y = float(center_y)
                areas.append(width * height)
                widths.append(width)
                heights.append(height)
                centers_y.append(center_y)
                widths_640.append(width * 640.0)
                heights_640.append(height * 640.0)
                plate_count += 1
        if plate_count > 0:
            images_with_gt += 1
        plates_per_image.append(plate_count)

    areas_sorted = sorted(areas)

    return {
        "image_count": image_count,
        "images_with_gt": images_with_gt,
        "plates_per_image_mean": statistics.mean(plates_per_image),
        "count": len(areas),
        "area_mean": statistics.mean(areas),
        "area_median": statistics.median(areas),
        "area_p90": safe_quantile(areas_sorted, 0.9),
        "width_median_ratio": statistics.median(widths),
        "height_median_ratio": statistics.median(heights),
        "center_y_median": statistics.median(centers_y),
        "width_median_640": statistics.median(widths_640),
        "height_median_640": statistics.median(heights_640),
        "pct_width_lt_16_640": sum(1 for value in widths_640 if value < 16) / len(widths_640),
        "pct_width_lt_12_640": sum(1 for value in widths_640 if value < 12) / len(widths_640),
        "pct_height_lt_8_640": sum(1 for value in heights_640 if value < 8) / len(heights_640),
    }


def threshold_sweep(coco, model, images_dir: Path, iou_threshold: float) -> List[Dict[str, float]]:
    results = []
    for threshold in [0.01, 0.03, 0.05, 0.10, 0.25]:
        image_ids, _predictions, per_image_predictions, _latencies = epd.coco_results(
            coco=coco,
            model=model,
            confidence_threshold=threshold,
            iou_threshold=iou_threshold,
            limit=0,
            image_path_for=lambda image_info: images_dir / image_info["file_name"],
        )
        summary = epd.compute_detection_f1(coco, image_ids, per_image_predictions)
        results.append(
            {
                "threshold": threshold,
                "prediction_count": sum(len(items) for items in per_image_predictions.values()),
                "precision_iou50": summary["precision_iou50"],
                "recall_iou50": summary["recall_iou50"],
                "f1_iou50": summary["f1_iou50"],
            }
        )
    return results


def detailed_failure_breakdown(coco, model, images_dir: Path, threshold: float, iou_threshold: float) -> Dict[str, object]:
    _image_ids, _predictions, per_image_predictions, _latencies = epd.coco_results(
        coco=coco,
        model=model,
        confidence_threshold=threshold,
        iou_threshold=iou_threshold,
        limit=0,
        image_path_for=lambda image_info: images_dir / image_info["file_name"],
    )

    per_gt_records = []
    image_level = {
        "images_with_gt": 0,
        "images_with_any_hit": 0,
        "images_with_all_hits": 0,
        "images_full_miss": 0,
        "images_with_no_predictions": 0,
        "images_with_predictions_but_no_hits": 0,
    }

    for image_info in coco.dataset["images"]:
        annotations = [annotation for annotation in coco.dataset["annotations"] if annotation["image_id"] == image_info["id"]]
        if not annotations:
            continue

        image_level["images_with_gt"] += 1
        predictions = sorted(per_image_predictions.get(image_info["id"], []), key=lambda item: item.score, reverse=True)
        used_prediction_indices = set()
        matched_count = 0

        for annotation in annotations:
            bbox = annotation["bbox"]
            best_iou = 0.0
            best_score = 0.0
            best_prediction_index = None

            for prediction_index, prediction in enumerate(predictions):
                if prediction_index in used_prediction_indices:
                    continue
                overlap = epd.iou_xywh(prediction.bbox_xywh, bbox)
                if overlap > best_iou:
                    best_iou = overlap
                    best_score = prediction.score
                    best_prediction_index = prediction_index

            matched = best_prediction_index is not None and best_iou >= 0.5
            if matched:
                used_prediction_indices.add(best_prediction_index)
                matched_count += 1

            per_gt_records.append(
                {
                    "image": image_info["file_name"],
                    "area_ratio": (bbox[2] * bbox[3]) / (image_info["width"] * image_info["height"]),
                    "width_px": bbox[2],
                    "height_px": bbox[3],
                    "width_640": (bbox[2] / image_info["width"]) * 640.0,
                    "height_640": (bbox[3] / image_info["height"]) * 640.0,
                    "center_y": (bbox[1] + bbox[3] / 2.0) / image_info["height"],
                    "best_iou": best_iou,
                    "best_score": best_score,
                    "matched": matched,
                }
            )

        if not predictions:
            image_level["images_with_no_predictions"] += 1

        if matched_count == 0:
            image_level["images_full_miss"] += 1
            if predictions:
                image_level["images_with_predictions_but_no_hits"] += 1
        else:
            image_level["images_with_any_hit"] += 1
            if matched_count == len(annotations):
                image_level["images_with_all_hits"] += 1

    records_sorted = sorted(per_gt_records, key=lambda item: item["area_ratio"])
    bin_1 = records_sorted[len(records_sorted) // 3]["area_ratio"]
    bin_2 = records_sorted[(2 * len(records_sorted)) // 3]["area_ratio"]

    size_bins = []
    for name, lower, upper in [
        ("smallest_third", 0.0, bin_1),
        ("middle_third", bin_1, bin_2),
        ("largest_third", bin_2, float("inf")),
    ]:
        subset = [
            record for record in per_gt_records
            if record["area_ratio"] >= lower and (record["area_ratio"] < upper or upper == float("inf"))
        ]
        size_bins.append(
            {
                "name": name,
                "count": len(subset),
                "recall_iou50": sum(1 for record in subset if record["matched"]) / len(subset),
                "median_width_px": statistics.median(record["width_px"] for record in subset),
                "median_height_px": statistics.median(record["height_px"] for record in subset),
                "median_width_640": statistics.median(record["width_640"] for record in subset),
                "median_height_640": statistics.median(record["height_640"] for record in subset),
            }
        )

    matched_records = [record for record in per_gt_records if record["matched"]]
    missed_records = [record for record in per_gt_records if not record["matched"]]

    largest_missed = sorted(missed_records, key=lambda item: item["area_ratio"], reverse=True)[:10]
    successful_examples = sorted(matched_records, key=lambda item: item["area_ratio"], reverse=True)[:10]

    iou_bins = {
        "exact_zero": sum(1 for record in per_gt_records if record["best_iou"] == 0),
        "overlap_0_0.1": sum(1 for record in per_gt_records if 0 < record["best_iou"] < 0.1),
        "overlap_0.1_0.3": sum(1 for record in per_gt_records if 0.1 <= record["best_iou"] < 0.3),
        "overlap_0.3_0.5": sum(1 for record in per_gt_records if 0.3 <= record["best_iou"] < 0.5),
        "matched_iou_ge_0.5": sum(1 for record in per_gt_records if record["best_iou"] >= 0.5),
    }

    return {
        "image_level": image_level,
        "size_bins": size_bins,
        "matched_summary": {
            "count": len(matched_records),
            "median_area_ratio": statistics.median(record["area_ratio"] for record in matched_records),
            "median_width_px": statistics.median(record["width_px"] for record in matched_records),
            "median_height_px": statistics.median(record["height_px"] for record in matched_records),
            "median_center_y": statistics.median(record["center_y"] for record in matched_records),
        },
        "missed_summary": {
            "count": len(missed_records),
            "median_area_ratio": statistics.median(record["area_ratio"] for record in missed_records),
            "median_width_px": statistics.median(record["width_px"] for record in missed_records),
            "median_height_px": statistics.median(record["height_px"] for record in missed_records),
            "median_center_y": statistics.median(record["center_y"] for record in missed_records),
        },
        "iou_bins": iou_bins,
        "largest_missed_examples": largest_missed,
        "largest_successful_examples": successful_examples,
    }


def build_markdown(payload: Dict[str, object]) -> str:
    ref = payload["reference_distribution"]
    swiss = payload["swiss_distribution"]
    sweep = payload["threshold_sweep"]
    breakdown = payload["default_threshold_breakdown"]

    lines = [
        "# Switzerland Failure Analysis",
        "",
        "## Main Finding",
        "",
        "The detector is collapsing on PP4AV Switzerland primarily because the plates are dramatically smaller in-frame than the plates in the reference benchmark. The dominant failure mode is no detection at all, not slightly misaligned boxes.",
        "",
        "## Domain Shift vs Reference Benchmark",
        "",
        f"- Reference median plate area ratio: `{ref['area_median']:.6f}`",
        f"- Switzerland median plate area ratio: `{swiss['area_median']:.6f}`",
        f"- Area shrink factor at the median: `{ref['area_median'] / swiss['area_median']:.1f}x`",
        f"- Reference median plate size at 640 input: `{ref['width_median_640']:.1f} x {ref['height_median_640']:.1f}` px",
        f"- Switzerland median plate size at 640 input: `{swiss['width_median_640']:.1f} x {swiss['height_median_640']:.1f}` px",
        f"- Switzerland plates below 16 px width at model input: `{swiss['pct_width_lt_16_640']:.1%}`",
        f"- Switzerland plates below 8 px height at model input: `{swiss['pct_height_lt_8_640']:.1%}`",
        f"- Reference plates below 16 px width at model input: `{ref['pct_width_lt_16_640']:.1%}`",
        f"- Reference plates below 8 px height at model input: `{ref['pct_height_lt_8_640']:.1%}`",
        "",
        "## Image-Level Failure Pattern",
        "",
        f"- Images with Swiss plates: `{breakdown['image_level']['images_with_gt']}`",
        f"- Images with any correct hit: `{breakdown['image_level']['images_with_any_hit']}`",
        f"- Images with all plates correctly hit: `{breakdown['image_level']['images_with_all_hits']}`",
        f"- Full-miss images: `{breakdown['image_level']['images_full_miss']}`",
        f"- Images with no predictions at all: `{breakdown['image_level']['images_with_no_predictions']}`",
        f"- Images with predictions but no correct hit: `{breakdown['image_level']['images_with_predictions_but_no_hits']}`",
        "",
        "## Threshold Sweep",
        "",
        "Lowering the confidence threshold helps a bit, but not nearly enough. This means the main problem is detector visibility/scale, not just filtering.",
        "",
    ]

    for row in sweep:
        lines.append(
            f"- Threshold `{row['threshold']:.2f}`: predictions `{row['prediction_count']}`, precision `{row['precision_iou50']:.4f}`, recall `{row['recall_iou50']:.4f}`, F1 `{row['f1_iou50']:.4f}`"
        )

    lines.extend(
        [
            "",
            "## Size-Bin Recall at App Threshold",
            "",
        ]
    )

    for size_bin in breakdown["size_bins"]:
        lines.append(
            f"- {size_bin['name']}: recall `{size_bin['recall_iou50']:.4f}`, median size `{size_bin['median_width_px']:.1f} x {size_bin['median_height_px']:.1f}` px"
        )

    lines.extend(
        [
            "",
            "## What The Detector Actually Does",
            "",
            f"- Matched plates median size: `{breakdown['matched_summary']['median_width_px']:.1f} x {breakdown['matched_summary']['median_height_px']:.1f}` px",
            f"- Missed plates median size: `{breakdown['missed_summary']['median_width_px']:.1f} x {breakdown['missed_summary']['median_height_px']:.1f}` px",
            f"- Matched plates median center Y: `{breakdown['matched_summary']['median_center_y']:.3f}`",
            f"- Missed plates median center Y: `{breakdown['missed_summary']['median_center_y']:.3f}`",
            f"- Ground-truth plates with zero overlap to any kept prediction: `{breakdown['iou_bins']['exact_zero']}`",
            f"- Ground-truth plates with partial overlap 0.3-0.5: `{breakdown['iou_bins']['overlap_0.3_0.5']}`",
            "",
            "## Interpretation",
            "",
            "- The detector is not mostly drawing boxes in the wrong place. It is usually drawing no useful box at all.",
            "- Lower frame position is not the main issue. The successful plates are actually slightly lower in the frame than the missed plates.",
            "- The dominant issue is scale: the Swiss plates are mostly tiny at the model's 640 input resolution, and the model appears to have been trained on much larger plate presentations.",
            "- Because recall remains poor even at threshold 0.01, post-processing tweaks alone will not fix this. The model needs more small-object supervision or a higher-resolution detection path.",
            "",
            "## Largest Missed Examples",
            "",
        ]
    )

    for record in breakdown["largest_missed_examples"][:5]:
        lines.append(
            f"- `{record['image']}`: `{record['width_px']:.1f} x {record['height_px']:.1f}` px, best IoU `{record['best_iou']:.3f}`, best score `{record['best_score']:.3f}`"
        )

    return "\n".join(lines).strip() + "\n"


def main() -> None:
    args = parse_args()
    model = epd.load_model(Path(args.model))
    swiss_images = Path(args.swiss_images)
    swiss_labels = Path(args.swiss_labels)
    coco = epd.build_coco_from_yolo_subset(swiss_images, swiss_labels)

    payload = {
        "reference_distribution": dataset_distribution_from_coco(Path(args.reference_coco)),
        "swiss_distribution": dataset_distribution_from_yolo(swiss_images, swiss_labels),
        "threshold_sweep": threshold_sweep(coco, model, swiss_images, args.iou_threshold),
        "default_threshold_breakdown": detailed_failure_breakdown(
            coco=coco,
            model=model,
            images_dir=swiss_images,
            threshold=args.default_threshold,
            iou_threshold=args.iou_threshold,
        ),
    }

    report_json = Path(args.report_json)
    report_md = Path(args.report_md)
    report_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    report_md.write_text(build_markdown(payload), encoding="utf-8")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
