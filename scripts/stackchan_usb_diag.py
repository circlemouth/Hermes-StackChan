#!/usr/bin/env python3
"""Local ESP32-S3 USB Serial/JTAG diagnostics. No third-party dependencies."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import select
import stat
import sys
import termios
import time

COMMANDS = ("status", "reboot-to-launcher", "open setup", "open hermes", "sd prompt", "sd read",
            "listen start", "listen stop")
DEVICE_STATES = ("unavailable", "unknown", "starting", "wifi_configuring", "idle", "connecting",
                 "listening", "speaking", "upgrading", "activating", "audio_testing", "fatal_error")
PREFIX = b"SC_DIAG_REPLY "
MAX_REPLY_LINE = 4096


def encode_command(command):
    if command not in COMMANDS:
        raise ValueError("unsupported command")
    line = ("SC_DIAG " + command + "\n").encode("ascii")
    if len(line) - 1 > 128:
        raise ValueError("command too long")
    return line


def parse_reply(line, command):
    """Ignore console logs entirely; accept only matching protocol JSON."""
    marker = line.find(PREFIX)
    if marker < 0 or len(line) > MAX_REPLY_LINE:
        return None
    try:
        reply = json.loads(line[marker + len(PREFIX):])
    except (ValueError, UnicodeDecodeError):
        return None
    if (command not in COMMANDS or not isinstance(reply, dict) or
            type(reply.get("protocol_version")) is not int or reply["protocol_version"] != 1):
        return None
    if reply.get("command") != command or type(reply.get("ok")) is not bool:
        return None
    if reply.get("state") not in ("Launcher", "Hermes"):
        return None
    if command in ("listen start", "listen stop"):
        # These controls print static acceptance/refusal only, never arbitrary text
        # or status metadata. An ACK is not proof of an audio state transition.
        if set(reply) != {"protocol_version", "command", "ok", "result", "state"}:
            return None
        if reply["ok"]:
            expected = "listen_start_requested" if command == "listen start" else "listen_stop_requested"
            if reply["result"] != expected or reply["state"] != "Hermes":
                return None
        else:
            if reply["result"] not in ("requires_hermes", "runtime_not_ready", "listen_busy", "queue_full"):
                return None
            if reply["result"] == "requires_hermes" and reply["state"] != "Launcher":
                return None
            if reply["result"] in ("runtime_not_ready", "listen_busy") and reply["state"] != "Hermes":
                return None
    # Do not allow unrelated fields from console/device data to become logs.
    allowed = {"protocol_version", "command", "ok", "result", "state", "app_version",
               "free_heap", "task_stack_low_water_bytes", "network", "sd_confirmation_active", "boot", "device_state"}
    if set(reply) - allowed:
        return None
    if "device_state" in reply:
        if command != "status" or reply["device_state"] not in DEVICE_STATES:
            return None
        if reply["state"] == "Launcher" and reply["device_state"] != "unavailable":
            return None
    if "task_stack_low_water_bytes" in reply:
        stacks = reply["task_stack_low_water_bytes"]
        # Never forward arbitrary nested names/text from device console data.
        if (command != "status" or not isinstance(stacks, dict) or
                set(stacks) - {"app_main", "sc_diag_usb"}):
            return None
        if any(type(value) is not int or not 0 <= value <= 1024 * 1024
               for value in stacks.values()):
            return None
    if "boot" in reply:
        boot = reply["boot"]
        required = {"elf_sha256_prefix", "reset_reason", "uptime_ms", "reply_core"}
        optional = {"running_partition", "app_offset", "ota_state"}
        if not isinstance(boot, dict) or not required <= set(boot) or set(boot) - required - optional:
            return None
        prefix = boot["elf_sha256_prefix"]
        if not isinstance(prefix, str) or len(prefix) != 16 or any(c not in "0123456789abcdef" for c in prefix):
            return None
        for key, low, high in (("reset_reason", 0, 127), ("uptime_ms", 0, 2**53 - 1), ("reply_core", 0, 1)):
            if type(boot[key]) is not int or not low <= boot[key] <= high:
                return None
        if ("running_partition" in boot) != ("app_offset" in boot):
            return None
        if "running_partition" in boot:
            labels = {"factory", *(f"ota_{i}" for i in range(16))}
            if not isinstance(boot["running_partition"], str) or boot["running_partition"] not in labels:
                return None
            offset = boot["app_offset"]
            if type(offset) is not int or not 0 <= offset < 0x1000000 or offset % 4096:
                return None
        if "ota_state" in boot:
            if "running_partition" not in boot or type(boot["ota_state"]) is not int or boot["ota_state"] not in (-1, 0, 1, 2, 3, 4):
                return None
    network = reply.get("network")
    if network is not None:
        if not isinstance(network, dict) or set(network) != {"connected", "scheme", "host"}:
            return None
        if type(network["connected"]) is not bool or network["scheme"] not in ("", "ws", "wss"):
            return None
        host = network["host"]
        if not isinstance(host, str) or len(host) > 128 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:-" for c in host):
            return None
    return reply


class ReplyReader:
    """Bound memory even for endless untrusted log lines."""
    def __init__(self):
        self.buffer = bytearray()
        self.discard = False

    def feed(self, data, command):
        replies = []
        for byte in data:
            if byte == 10:
                if not self.discard:
                    reply = parse_reply(bytes(self.buffer).rstrip(b"\r"), command)
                    if reply is not None:
                        replies.append(reply)
                self.buffer.clear()
                self.discard = False
            elif not self.discard:
                if len(self.buffer) < MAX_REPLY_LINE:
                    self.buffer.append(byte)
                else:
                    self.buffer.clear()
                    self.discard = True
        return replies


def verify_usb_jtag(path):
    """Reject network endpoints, UART adapters, pseudo-terminals and arbitrary files."""
    resolved = Path(path).resolve(strict=True)
    if not resolved.name.startswith("ttyACM") or resolved.parent != Path("/dev"):
        raise ValueError("use the ESP32-S3 USB Serial/JTAG ttyACM device or its by-id link")
    if not stat.S_ISCHR(resolved.stat().st_mode):
        raise ValueError("not a character device")
    device = (Path("/sys/class/tty") / resolved.name / "device").resolve(strict=True)
    for parent in (device, *device.parents):
        vendor, product = parent / "idVendor", parent / "idProduct"
        if vendor.exists() and product.exists():
            if vendor.read_text().strip().lower() == "303a" and product.read_text().strip().lower() == "1001":
                return resolved
            break
    raise ValueError("not the Espressif USB Serial/JTAG device (303a:1001)")


@contextlib.contextmanager
def usb_port(path):
    resolved = verify_usb_jtag(path)
    fd = os.open(resolved, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    original = None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.ioctl(fd, termios.TIOCEXCL)
        original = termios.tcgetattr(fd)
        attrs = termios.tcgetattr(fd)
        attrs[0] = attrs[1] = attrs[3] = 0
        attrs[2] &= ~(termios.CSIZE | termios.PARENB | termios.CSTOPB | termios.HUPCL | getattr(termios, "CRTSCTS", 0))
        attrs[2] |= termios.CS8 | termios.CLOCAL | termios.CREAD
        attrs[4] = attrs[5] = termios.B115200
        attrs[6][termios.VMIN] = 0
        attrs[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        # No DTR/RTS ioctl, bootloader reset sequence, BREAK, or monitor subprocess.
        yield fd
    finally:
        try:
            if original is not None:
                # Retain HUPCL off on close: restoring it could drop DTR and reset hardware.
                original[2] &= ~termios.HUPCL
                try:
                    termios.tcsetattr(fd, termios.TCSANOW, original)
                except (OSError, termios.error):
                    pass  # Device can disappear during an explicitly requested reboot.
        finally:
            os.close(fd)


def request(fd, command, timeout):
    deadline = time.monotonic() + timeout
    payload = encode_command(command)
    # A single exclusive host owner is required. Discard old replies before a new request.
    termios.tcflush(fd, termios.TCIFLUSH)
    while payload:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([], [fd], [], remaining)[1]:
            raise TimeoutError("USB write timed out")
        try:
            payload = payload[os.write(fd, payload):]
        except BlockingIOError:
            continue
    reader = ReplyReader()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise TimeoutError("no matching diagnostic reply; action outcome unknown, do not blindly retry controls")
        try:
            data = os.read(fd, 1024)
        except BlockingIOError:
            continue
        if not data:
            raise OSError("USB disconnected before acknowledgement; action outcome unknown")
        replies = reader.feed(data, command)
        if replies:
            return replies[0]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="ESP USB Serial/JTAG /dev/ttyACM… or /dev/serial/by-id/…")
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("command", choices=COMMANDS, help="quote commands containing spaces")
    args = parser.parse_args(argv)
    if not 0.1 <= args.timeout <= 30:
        parser.error("timeout must be between 0.1 and 30 seconds")
    try:
        with usb_port(args.port) as fd:
            reply = request(fd, args.command, args.timeout)
        print(json.dumps(reply, ensure_ascii=True, separators=(",", ":")))
        return 0 if reply["ok"] else 2
    except (OSError, termios.error, ValueError, TimeoutError):
        # Never echo raw device data, paths, request bytes or exception detail.
        print(json.dumps({"ok": False, "result": "usb_diagnostic_failed_outcome_unknown"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
