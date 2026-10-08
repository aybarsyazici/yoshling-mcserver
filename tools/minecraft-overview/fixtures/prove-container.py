"""Explicit local Docker proof using newly generated synthetic saved worlds only."""
import argparse
import hashlib
import json
import pathlib
import struct
import subprocess
import sys
import tempfile
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--image", default="yoshling-minecraft-overview:proof")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    docker = ["docker", "--context", args.docker_context]

    def run(*arguments, timeout=30):
        return subprocess.check_output([*docker, *arguments], text=True, timeout=timeout).strip()

    endpoint = json.loads(run("context", "inspect", args.docker_context))[0]["Endpoints"]["docker"]["Host"]
    if not endpoint.startswith("unix://"):
        raise ValueError("This fixture proof requires an explicitly selected local Docker socket")
    if args.output.exists():
        raise ValueError("Proof output already exists; choose a new path")
    args.output.mkdir(parents=True, mode=0o700)
    image_id = run("image", "inspect", "--format", "{{.Id}}", args.image)
    reports = []
    with tempfile.TemporaryDirectory(prefix="yoshling-overview-synthetic-") as temporary:
        for version, layout in [("26.1.2", "namespaced"), ("1.21.1", "legacy")]:
            source = pathlib.Path(temporary) / ("input-" + version)
            subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("create-world.py")),
                            "--output", str(source), "--version", version, "--layout", layout], check=True)
            # Publicly readable synthetic content lets a capability-free UID0 worker read it.
            for file in [source, *source.rglob("*")]:
                file.chmod(0o755 if file.is_dir() else 0o644)
            token = uuid.uuid4().hex
            container, volume = "yoshling-overview-proof-" + token, "yoshling-overview-proof-output-" + token
            run("volume", "create", volume)
            try:
                shell = ("node /opt/overview/run.mjs; outcome=$?; "
                         "printf 'MEMORY_PEAK='; cat /sys/fs/cgroup/memory.peak; "
                         "printf 'SCRATCH_KIB='; du -sk /tmp/overview | cut -f1; "
                         "stat -c 'MODE=%a UID=%u GID=%g NAME=%n' /output /output/overview.png /output/receipt.json; "
                         "exit $outcome")
                run("create", "--name", container, "--memory", "1536m", "--memory-swap", "1536m", "--cpus", "1",
                    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                    "--tmpfs", "/tmp:size=268435456,mode=1777", "--mount", "type=bind,src=" + str(source) + ",dst=/input,readonly",
                    "--mount", "type=volume,src=" + volume + ",dst=/output", "--entrypoint", "/bin/sh", args.image, "-c", shell)
                policy = json.loads(run("inspect", "--format", "{{json .HostConfig}}", container))
                assert policy["Memory"] == policy["MemorySwap"] == 1610612736
                assert policy["NanoCpus"] == 1000000000 and policy["NetworkMode"] == "none"
                assert policy["ReadonlyRootfs"] and policy["CapDrop"] == ["ALL"]
                assert policy["Tmpfs"] == {"/tmp": "size=268435456,mode=1777"}
                mounts = json.loads(run("inspect", "--format", "{{json .Mounts}}", container))
                assert sorted((m["Destination"], m["RW"]) for m in mounts) == [("/input", False), ("/output", True)]
                started = time.monotonic()
                log = run("start", "--attach", container, timeout=150)
                elapsed = round(time.monotonic() - started, 3)
                state = json.loads(run("inspect", "--format", "{{json .State}}", container))
                assert state["ExitCode"] == 0 and state["OOMKilled"] is False
                result = args.output / version
                result.mkdir(mode=0o700)
                run("cp", container + ":/output/.", str(result))
                (result / "worker.log").write_text(log + "\n")
                receipt = json.loads((result / "receipt.json").read_text())
                manifest = json.loads((source / "manifest.json").read_text())
                png = (result / "overview.png").read_bytes()
                assert png[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack(">II", png[16:24]) == (1280, 800)
                assert receipt["sourceSha256"] == manifest["source"]["sha256"]
                assert receipt["image"]["bytes"] == len(png) and receipt["image"]["sha256"] == hashlib.sha256(png).hexdigest()
                for file in manifest["files"]:
                    assert hashlib.sha256((source / "world" / file["path"]).read_bytes()).hexdigest() == file["sha256"]
                assert "MODE=700 UID=0 GID=0 NAME=/output" in log
                assert "MODE=600 UID=0 GID=0 NAME=/output/overview.png" in log
                assert "MODE=600 UID=0 GID=0 NAME=/output/receipt.json" in log
                peak = int(next(line.split("=", 1)[1] for line in log.splitlines() if line.startswith("MEMORY_PEAK=")))
                scratch = int(next(line.split("=", 1)[1] for line in log.splitlines() if line.startswith("SCRATCH_KIB=")))
                report = {"version": version, "layout": layout, "imageId": image_id, "seconds": elapsed,
                          "memoryPeakBytes": peak, "scratchKiB": scratch, "policyVerified": True, "receipt": receipt}
                (result / "proof.json").write_text(json.dumps(report, indent=2) + "\n")
                reports.append(report)
                print(json.dumps(report), flush=True)
            finally:
                # Names were freshly created above; this never selects existing/game containers.
                subprocess.run([*docker, "rm", "--force", container], check=False, stdout=subprocess.DEVNULL)
                subprocess.run([*docker, "volume", "rm", volume], check=True, stdout=subprocess.DEVNULL)
    (args.output / "proof.json").write_text(json.dumps(reports, indent=2) + "\n")


if __name__ == "__main__":
    main()
