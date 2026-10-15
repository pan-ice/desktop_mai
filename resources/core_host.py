"""通过独立控制管道托管 MaiBot，父进程退出时通知其受控关闭。"""

from pathlib import Path

import ctypes
import os
import runpy
import signal
import sys
import threading


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    if not (root / "bot.py").is_file():
        raise RuntimeError("MaiBot 目录缺少 bot.py")

    # 保存专用控制管道，不把它留给内核交互终端消费。
    control = os.fdopen(os.dup(sys.stdin.fileno()), "r", encoding="utf-8")
    sys.stdin = open(os.devnull, "r", encoding="utf-8")
    os.dup2(sys.stdin.fileno(), 0)
    if os.name == "nt":
        # Runner 需要控制台进程组转发 CTRL_BREAK；分配后立即隐藏窗口。
        kernel32 = ctypes.windll.kernel32
        kernel32.AllocConsole()
        window = kernel32.GetConsoleWindow()
        if window:
            ctypes.windll.user32.ShowWindow(window, 0)

    def watch_parent() -> None:
        for line in control:
            if line.strip() == "STOP":
                break
        signal.raise_signal(signal.SIGBREAK if os.name == "nt" else signal.SIGTERM)

    threading.Thread(target=watch_parent, name="mai-parent-control", daemon=True).start()
    os.chdir(root)
    sys.path.insert(0, str(root))
    sys.argv = [str(root / "bot.py")]
    runpy.run_path(str(root / "bot.py"), run_name="__main__")


if __name__ == "__main__":
    main()
