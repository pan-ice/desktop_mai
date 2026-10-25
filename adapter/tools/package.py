"""仅打包明确列出的公开文件，避免把 config.toml / 环境凭证带入 ZIP。"""

from pathlib import Path
import sys
import tomllib
from zipfile import ZIP_DEFLATED, ZipFile


def package(destination: Path) -> Path:
    root = Path(__file__).resolve().parents[1]
    version = tomllib.loads((root / "pyproject.toml").read_text("utf-8"))["project"]["version"]
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / f"MaiBot-Desktop-Message-Adapter-{version}.zip"
    files = [root / name for name in ["README.md", "LICENSE", "pyproject.toml", "uv.lock", "requirements.txt", "config.example.toml", ".gitignore"]]
    for directory in ["desktop_adapter", "tests", "tools"]:
        files.extend(sorted((root / directory).glob("*.py")))
    # 先确认清单完整；缺锁文件等情况不生成不完整的发行包。
    for path in files:
        if not path.is_file():
            raise FileNotFoundError(f"缺少打包文件 {path.name}")
    with ZipFile(archive, "w", ZIP_DEFLATED) as output:
        for path in files:
            if path.name == "README.md":
                output.writestr("README.md", path.read_text("utf-8").replace("../docs/", "docs/"))
            else:
                output.write(path, path.relative_to(root).as_posix())
        # README 中的协议核对链接在独立包中也有对应文件。
        note = root / "docs/adapter-protocol-reference.md"
        if not note.is_file():
            note = root.parent / "docs/adapter-protocol-reference.md"
        output.write(note, "docs/adapter-protocol-reference.md")
    return archive


if __name__ == "__main__":
    print(package(Path(sys.argv[1]).resolve()))
