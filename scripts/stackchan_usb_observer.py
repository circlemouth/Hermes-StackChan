#!/usr/bin/env python3
"""Bounded, continuous USB diagnostics; retain static panic evidence, never logs.

The CLI is passive apart from two status requests. Imported ContinuousUsb can
perform explicitly requested controls with one owner; it never retries, flushes
input, or automatically stops/restarts firmware. Ordinary listen-stop can submit
genuine captured speech through the production pipeline.
"""
import argparse
import json
import os
import re
import select
import sys
import time

from stackchan_usb_diag import PREFIX, ReplyReader, encode_command, usb_port

SAFE_COMMANDS = ("status", "open hermes", "reboot-to-launcher", "listen start", "listen stop")
MAX_LOG_LINE = 512
MAX_COUNT = 2**31 - 1
TASK_ALIASES = {
    b"main": "app_main", b"sc_diag_usb": "sc_diag_usb",
    b"audio_input": "audio_input", b"audio_output": "audio_output",
    b"opus_codec": "opus_codec", b"audio_communica": "audio_communica",
    b"audio_detection": "audio_detection", b"activation": "activation",
    b"encode_wake_wor": "encode_wake_word",  # 16-byte task-name storage truncates to 15.
}
OVERFLOW_HOOK = re.compile(
    rb"\*\*\*ERROR\*\*\* A stack overflow in task ([^\r\n]{1,64}) has been detected\."
)


class PanicEvidence:
    """Only bounded static counters escape this fragmented line parser."""
    def __init__(self):
        self._buffer = bytearray()
        self._discard = False
        self._markers = {}
        self._tasks = {}

    @property
    def panicked(self):
        return bool(self._markers)

    @staticmethod
    def _increment(counts, label):
        counts[label] = min(MAX_COUNT, counts.get(label, 0) + 1)

    def _line(self, line):
        # Do not classify protocol JSON containing panic-like field values.
        if PREFIX in line:
            return
        hook = OVERFLOW_HOOK.fullmatch(line)
        if hook:
            self._increment(self._markers, "stack_overflow")
            self._increment(self._tasks, TASK_ALIASES.get(hook[1], "unknown"))
        for label, found in (
            ("assert", line.startswith(b"assert failed:")),
            ("guru_meditation", line.startswith(b"Guru Meditation Error:")),
            ("abort", line.startswith(b"abort() was called")),
            ("stack_canary", b"Stack canary watchpoint triggered" in line),
            ("heap_corruption", line.startswith(b"CORRUPT HEAP:")),
            ("stack_overflow_hook", b"vApplicationStackOverflowHook" in line),
        ):
            if found:
                self._increment(self._markers, label)

    def feed(self, data):
        for byte in data:
            if byte == 10:
                if not self._discard:
                    self._line(bytes(self._buffer).rstrip(b"\r"))
                self._buffer.clear()
                self._discard = False
            elif not self._discard:
                if len(self._buffer) >= MAX_LOG_LINE:
                    self._buffer.clear()
                    self._discard = True
                else:
                    self._buffer.append(byte)

    def finish(self):
        if not self._discard:
            self._line(bytes(self._buffer).rstrip(b"\r"))
        self._buffer.clear()
        self._discard = False

    def snapshot(self):
        return {"markers": dict(self._markers), "overflow_tasks": dict(self._tasks)}


def status_snapshot(reply):
    """Copy only validated identity/state/numeric evidence; omit general text."""
    if reply.get("command") != "status" or reply.get("ok") is not True:
        raise ValueError("status_not_accepted")
    result = {"state": reply["state"]}
    if "device_state" in reply:
        result["device_state"] = reply["device_state"]
    heap = reply.get("free_heap")
    if type(heap) is int and 0 <= heap <= MAX_COUNT:
        result["free_heap"] = heap
    for field in ("boot", "task_stack_low_water_bytes"):
        if field in reply:
            result[field] = dict(reply[field])
    network = reply.get("network")
    if isinstance(network, dict) and type(network.get("connected")) is bool:
        result["network_connected"] = network["connected"]
    return result


class ContinuousUsb:
    """Single synchronous caller, under usb_port's exclusive ownership.

    Both parsers see the complete chunk before returning an ACK. Their partial
    lines survive requests and observation. Panic blocks subsequent commands,
    but passive observation continues to retain later hook/task evidence.
    """
    def __init__(self, fd):
        self.fd = fd
        self.evidence = PanicEvidence()
        self._replies = ReplyReader()
        self._failed = False

    def _read(self, deadline, command):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return []
        ready, _, _ = select.select([self.fd], [], [], remaining)
        if not ready:
            return []
        try:
            data = os.read(self.fd, 8192)
        except BlockingIOError:
            return []
        if not data:
            self.evidence.finish()
            raise OSError("usb_disconnected")
        self.evidence.feed(data)
        return self._replies.feed(data, command)

    def request(self, command, timeout=8.0):
        if command not in SAFE_COMMANDS:
            raise ValueError("unsupported_observed_command")
        if type(timeout) not in (int, float) or not 0 < timeout <= 60:
            raise ValueError("invalid_request_timeout")
        if self.evidence.panicked or self._failed:
            raise RuntimeError("controls_halted_panic_or_outcome_unknown")
        deadline = time.monotonic() + timeout
        wire = encode_command(command)
        try:
            # A short write has an unknown outcome; never resubmit a control.
            if os.write(self.fd, wire) != len(wire):
                raise OSError("usb_short_write_outcome_unknown")
            while time.monotonic() < deadline:
                replies = self._read(deadline, command)
                if replies:
                    return replies[0]
            raise TimeoutError("usb_reply_outcome_unknown")
        except OSError:
            self._failed = True
            raise

    def observe(self, duration):
        if type(duration) not in (int, float) or not 0 <= duration <= 300:
            raise ValueError("invalid_observation_duration")
        deadline = time.monotonic() + duration
        try:
            while time.monotonic() < deadline:
                self._read(deadline, "")
        except OSError:
            self._failed = True
            raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--duration", type=float, default=10.0, help="passive observation seconds (0..300)")
    args = parser.parse_args(argv)
    if not 0 <= args.duration <= 300:
        parser.error("duration must be within 0..300")
    observer = None
    initial = None
    final = None
    try:
        with usb_port(args.port) as fd:
            observer = ContinuousUsb(fd)
            initial = status_snapshot(observer.request("status"))
            observer.observe(args.duration)
            if not observer.evidence.panicked:
                final = status_snapshot(observer.request("status"))
        result = {"ok": True, "initial_status": initial, "final_status": final,
                  "controls_halted": observer.evidence.panicked, **observer.evidence.snapshot()}
        print(json.dumps(result, separators=(",", ":")))
        return 2 if observer.evidence.panicked else 0
    except (OSError, ValueError, TimeoutError, RuntimeError):
        result = {"ok": False, "result": "usb_observation_failed_outcome_unknown"}
        if observer is not None:
            observer.evidence.finish()
            result.update(observer.evidence.snapshot())
        print(json.dumps(result, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
