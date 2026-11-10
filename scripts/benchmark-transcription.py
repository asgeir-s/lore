#!/usr/bin/env python3
"""Compare local models on identical recording excerpts using Lore's real pipeline.

Manifest: [{"name":"meeting-a", "path":"/audio.wav", "start_seconds":330,
            "duration_seconds":120, "reference":"optional-human-transcript.txt"}]
References must be human checked; existing machine transcripts are not ground truth.
"""
import argparse
import csv
import json
from pathlib import Path
import re
import subprocess
import time


def tokens(text):
    text = re.sub(r"^\[\d+:\d+\]\s*", "", text, flags=re.MULTILINE)
    return re.findall(r"\w+", text.casefold())


def word_error_rate(reference, hypothesis):
    expected, actual = tokens(reference), tokens(hypothesis)
    if not expected:
        raise ValueError("Reference transcript has no words")
    row = list(range(len(actual) + 1))
    for i, word in enumerate(expected, 1):
        following = [i]
        for j, candidate in enumerate(actual, 1):
            following.append(min(following[-1] + 1, row[j] + 1,
                                 row[j - 1] + (word != candidate)))
        row = following
    return row[-1] / len(expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--model", action="append", required=True, type=Path)
    parser.add_argument("--binary", type=Path,
                        default=Path("src-tauri/target/debug/lore-transcribe"))
    parser.add_argument("--language", choices=("auto", "no", "en"), default="no")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    models = [model.resolve(strict=True) for model in args.model]
    manifest = args.manifest.resolve(strict=True)
    clips = json.loads(manifest.read_text())
    if not isinstance(clips, list) or not clips:
        raise ValueError("Manifest must be a nonempty list")
    # A fresh directory prevents cached timings from appearing to be new inference.
    args.output.mkdir(parents=True, exist_ok=False)
    report = []
    names = set()
    for clip in clips:
        name = clip["name"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or name in names:
            raise ValueError("Clip names must be unique and contain letters, numbers, _ or -")
        names.add(name)
        start, duration = float(clip.get("start_seconds", 0)), float(clip["duration_seconds"])
        if start < 0 or duration <= 0:
            raise ValueError("Clip start must be nonnegative and duration positive")
        source = (manifest.parent / clip["path"]).resolve(strict=True)
        for model_index, model in enumerate(models):
            run = args.output / name / f"{model_index}-{model.stem}"
            run.mkdir(parents=True)
            audio = run / "audio.wav"
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(start),
                            "-t", str(duration), "-i", str(source), "-ar", "16000", "-ac", "1",
                            "-c:a", "pcm_s16le", str(audio)], check=True)
            began = time.monotonic()
            print(f"Comparing {name}: {model.name}", flush=True)
            with (run / "transcript.txt").open("w") as stdout, (run / "pipeline.log").open("w") as stderr:
                result = subprocess.run([str(binary), str(audio), str(model), args.language],
                                        stdout=stdout, stderr=stderr)
            elapsed = time.monotonic() - began
            text = (run / "transcript.txt").read_text()
            checkpoints = list((run / ".transcription/audio").glob("*/checkpoint.json"))
            checkpoint = json.loads(checkpoints[0].read_text()) if len(checkpoints) == 1 else {}
            logs = (run / "pipeline.log").read_text()
            reference_path = clip.get("reference")
            reference = ((manifest.parent / reference_path).read_text()
                         if reference_path else None)
            row = dict(clip=name, model=model.name, language=args.language,
                       start_seconds=start, duration_seconds=duration,
                       elapsed_seconds=round(elapsed, 2),
                       complete=result.returncode == 0 and checkpoint.get("complete", False),
                       words=len(tokens(text)),
                       retries=len(re.findall(r"^Retrying ", logs, re.MULTILINE)),
                       problems=checkpoint.get("problems", []),
                       word_error_rate=(word_error_rate(reference, text)
                                        if reference is not None and result.returncode == 0 else None))
            report.append(row)
            (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps({k: v for k, v in row.items() if k != "problems"}), flush=True)
    fields = [key for key in report[0] if key != "problems"]
    with (args.output / "report.csv").open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(report)
    print("Coverage checks do not establish word accuracy. WER is reported only with supplied human references.")
    return 0 if all(row["complete"] for row in report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
