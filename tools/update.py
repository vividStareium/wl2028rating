#!/usr/bin/env python3
"""Append one contest result to data/ratings.csv safely.

Examples:
    python tools/update.py 2026.09.16 results.txt
    python tools/update.py 2026.09.16 results.csv --allow-new

Accepted result lines:
    Jian132363 1
    yrjzs 3-佬佬菜菜带带
    Mooos,2-uwu

Only listed users are considered participants. Existing users not listed are written as -1.
A genuinely new user gets 0 for every historical contest and the supplied result for this contest.
"""

from __future__ import annotations

import argparse
import csv
import difflib
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA = ROOT / "data" / "ratings.csv"
RESULT_RE = re.compile(r"^(?:-1|0|[1-9]\d*(?:[-_:].+)?)$")
RANK_TEAM_RE = re.compile(r"^(?P<rank>[1-9]\d*)(?:[-_:](?P<team>.+))?$")
HEADER_NAMES = {"姓名", "选手", "id", "ID", "name", "username"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="向 wl2028rating 追加一场比赛结果")
    parser.add_argument("contest", help="比赛名称/日期，例如 2026.09.16")
    parser.add_argument("results", type=Path, help="结果文本或 CSV 文件")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA, help="ratings.csv 路径")
    parser.add_argument("--allow-new", action="store_true", help="允许加入疑似与旧 ID 相似的新选手")
    parser.add_argument("--no-backup", action="store_true", help="不生成 .bak 备份")
    parser.add_argument("--dry-run", action="store_true", help="只检查和显示摘要，不写文件")
    return parser.parse_args()


def split_result_line(line: str) -> tuple[str, str] | None:
    line = line.strip().lstrip("\ufeff")
    if not line or line.startswith("#"):
        return None

    if "," in line:
        row = next(csv.reader([line]))
        if len(row) < 2:
            raise ValueError(f"无法解析：{line}")
        username = row[0].strip()
        value = ",".join(row[1:]).strip()
    elif "\t" in line:
        username, value = line.split("\t", 1)
        username, value = username.strip(), value.strip()
    else:
        parts = line.split(maxsplit=1)
        if len(parts) != 2:
            raise ValueError(f"无法解析：{line}")
        username, value = parts[0].strip(), parts[1].strip()

    if username in HEADER_NAMES:
        return None
    if not username:
        raise ValueError(f"选手 ID 为空：{line}")
    if not RESULT_RE.fullmatch(value):
        raise ValueError(f"成绩格式错误：{username} -> {value}")
    return username, value


def load_results(path: Path) -> dict[str, str]:
    if not path.exists():
        raise FileNotFoundError(f"找不到结果文件：{path}")
    results: dict[str, str] = {}
    for line_no, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        try:
            parsed = split_result_line(line)
        except ValueError as exc:
            raise ValueError(f"结果文件第 {line_no} 行：{exc}") from exc
        if parsed is None:
            continue
        username, value = parsed
        if username in results:
            raise ValueError(f"结果文件中 ID 重复：{username}")
        results[username] = value
    if not results:
        raise ValueError("结果文件没有有效选手")
    return results


def load_table(path: Path) -> list[list[str]]:
    if not path.exists():
        raise FileNotFoundError(f"找不到数据文件：{path}")
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    if not rows or len(rows[0]) < 2:
        raise ValueError("ratings.csv 为空或表头无效")
    width = len(rows[0])
    for line_no, row in enumerate(rows[1:], 2):
        if len(row) != width:
            raise ValueError(f"ratings.csv 第 {line_no} 行列数为 {len(row)}，表头为 {width}；请先修复数据")
    return rows


def find_suspicious_new_users(existing: list[str], results: dict[str, str]) -> dict[str, list[str]]:
    existing_set = set(existing)
    suspicious: dict[str, list[str]] = {}
    for username in results:
        if username in existing_set:
            continue
        matches = difflib.get_close_matches(username, existing, n=3, cutoff=0.78)
        if matches:
            suspicious[username] = matches
    return suspicious


def apply_update(rows: list[list[str]], contest: str, results: dict[str, str]) -> tuple[list[list[str]], list[str]]:
    header = rows[0]
    if contest in header[1:]:
        raise ValueError(f"比赛 {contest!r} 已存在，拒绝重复追加")

    old_competitions = len(header) - 1
    updated = [header + [contest]]
    processed: set[str] = set()

    for row in rows[1:]:
        username = row[0].strip()
        value = results.get(username, "-1")
        updated.append(row + [value])
        if username in results:
            processed.add(username)

    new_users: list[str] = []
    for username, value in results.items():
        if username in processed:
            continue
        updated.append([username] + ["0"] * old_competitions + [value])
        new_users.append(username)

    return updated, new_users


def result_team_key(username: str, value: str) -> str | None:
    """Return a stable team key for one positive ranking result."""
    match = RANK_TEAM_RE.fullmatch(value)
    if not match:
        return None
    team = (match.group("team") or "").strip()
    return f"team:{team}" if team else f"solo:{username}"


def count_teams(results: dict[str, str]) -> int:
    return len({
        team_key
        for username, value in results.items()
        if (team_key := result_team_key(username, value)) is not None
    })


def write_table(path: Path, rows: list[list[str]], backup: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if backup and path.exists():
        shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
    with path.open("w", encoding="utf-8", newline="") as f:
        csv.writer(f, lineterminator="\n").writerows(rows)


def main() -> int:
    args = parse_args()
    try:
        rows = load_table(args.data)
        results = load_results(args.results)
        existing = [row[0].strip() for row in rows[1:] if row]
        suspicious = find_suspicious_new_users(existing, results)

        if suspicious and not args.allow_new:
            print("⚠️ 发现疑似拼写错误的新 ID，未写入数据：", file=sys.stderr)
            for username, matches in suspicious.items():
                print(f"  {username}  ->  可能是: {', '.join(matches)}", file=sys.stderr)
            print("确认这些确实是新选手后，可加 --allow-new。", file=sys.stderr)
            return 2

        updated, new_users = apply_update(rows, args.contest, results)
        participants = sum(1 for value in results.values() if value not in {"-1", "0"})
        teams = count_teams(results)
        winners = [name for name, value in results.items() if re.match(r"^1(?:[-_:]|$)", value)]

        print(f"比赛: {args.contest}")
        print(f"参赛人数: {participants} 人")
        print(f"参赛队伍数: {teams} 支")
        print(f"新选手: {len(new_users)} 人" + (f" ({', '.join(new_users)})" if new_users else ""))
        print(f"冠军: {', '.join(winners) if winners else '未检测到'}")
        print(f"更新后: {len(updated) - 1} 名选手 / {len(updated[0]) - 1} 场比赛")

        if args.dry_run:
            print("DRY RUN：未写入文件")
            return 0

        write_table(args.data, updated, backup=not args.no_backup)
        print(f"✅ 已更新 {args.data}")
        return 0
    except (OSError, ValueError) as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
