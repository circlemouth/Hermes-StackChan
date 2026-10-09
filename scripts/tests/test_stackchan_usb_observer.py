import contextlib
import importlib
import io
import json
from pathlib import Path
import sys
import termios
import unittest
from unittest import mock

SCRIPTS = str(Path(__file__).resolve().parents[1])
sys.path.insert(0, SCRIPTS)
try:
    obs = importlib.import_module('stackchan_usb_observer')
finally:
    sys.path.remove(SCRIPTS)


def reply(command='status', **extra):
    return {'protocol_version': 1, 'command': command, 'ok': True,
            'result': 'status', 'state': 'Launcher', 'device_state': 'unavailable', **extra}


def wire(body):
    return obs.PREFIX + json.dumps(body).encode() + b'\r\n'


def hook(name):
    return b'***ERROR*** A stack overflow in task ' + name + b' has been detected.\r\n'


class Transport:
    """Pure fake USB and clock: no ports, sleeping, subprocesses or services."""
    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.now = 0.0

    def select(self, readers, writers, errors, timeout):
        if self.chunks:
            return ([7], [], [])
        self.now += timeout
        return ([], [], [])

    def read(self, fd, size):
        assert fd == 7 and size == 8192
        return self.chunks.pop(0)

    @contextlib.contextmanager
    def patched(self):
        with mock.patch.object(obs.os, 'read', side_effect=self.read), \
             mock.patch.object(obs.os, 'write', side_effect=lambda fd, data: len(data)) as writes, \
             mock.patch.object(obs.select, 'select', side_effect=self.select), \
             mock.patch.object(obs.time, 'monotonic', side_effect=lambda: self.now), \
             mock.patch.object(termios, 'tcflush', side_effect=AssertionError('input flush forbidden')):
            yield writes


class EvidenceTests(unittest.TestCase):
    def test_exact_hook_bytewise_all_static_task_identities(self):
        for stored, alias in obs.TASK_ALIASES.items():
            evidence = obs.PanicEvidence()
            for byte in hook(stored):
                evidence.feed(bytes([byte]))
            self.assertEqual(evidence.snapshot(), {'markers': {'stack_overflow': 1}, 'overflow_tasks': {alias: 1}})
            self.assertTrue(evidence.panicked)

    def test_unknown_names_only_escape_as_static_unknown(self):
        evidence = obs.PanicEvidence()
        for name in (b'PRIVATE_TASK', b'main\x00PRIVATE', '非公開名'.encode(), b'audio_communication'):
            evidence.feed(hook(name))
        self.assertEqual(evidence.snapshot(), {'markers': {'stack_overflow': 4}, 'overflow_tasks': {'unknown': 4}})
        self.assertNotIn('PRIVATE', json.dumps(evidence.snapshot()))

    def test_malformed_hook_is_not_task_evidence(self):
        evidence = obs.PanicEvidence()
        for raw in (b'log prefix ' + hook(b'main'), hook(b'main').replace(b'***ERROR***', b'ERROR'),
                    hook(b'main').replace(b'detected.', b'detected!'), hook(b'')):
            evidence.feed(raw)
        self.assertFalse(evidence.panicked)

    def test_static_markers_and_no_arbitrary_log_output(self):
        evidence = obs.PanicEvidence()
        evidence.feed(b'PRIVATE LOG\nassert failed: PRIVATE\nGuru Meditation Error: PRIVATE\n'
                      b'abort() was called at PRIVATE\nDebug exception reason: Stack canary watchpoint triggered (PRIVATE)\n'
                      b'CORRUPT HEAP: PRIVATE\n0x1234: vApplicationStackOverflowHook at PRIVATE\n')
        self.assertEqual(evidence.snapshot()['markers'], dict.fromkeys(
            ('assert', 'guru_meditation', 'abort', 'stack_canary', 'heap_corruption', 'stack_overflow_hook'), 1))
        self.assertNotIn('PRIVATE', json.dumps(evidence.snapshot()))

    def test_protocol_strings_do_not_become_panic_evidence(self):
        evidence = obs.PanicEvidence()
        evidence.feed(wire(reply(app_version='Stack canary watchpoint triggered vApplicationStackOverflowHook')))
        self.assertFalse(evidence.panicked)

    def test_oversized_lines_discard_and_recover_with_bounded_memory(self):
        evidence = obs.PanicEvidence()
        evidence.feed(b'x' * 100000)
        self.assertLessEqual(len(evidence._buffer), obs.MAX_LOG_LINE)
        evidence.feed(hook(b'main'))  # still part of the discarded line
        self.assertFalse(evidence.panicked)
        evidence.feed(hook(b'main'))
        self.assertEqual(evidence.snapshot()['overflow_tasks'], {'app_main': 1})

    def test_finish_partial_complete_hook_once_and_snapshot_is_copied(self):
        evidence = obs.PanicEvidence()
        evidence.feed(hook(b'main').rstrip(b'\r\n'))
        evidence.finish()
        evidence.finish()
        result = evidence.snapshot()
        result['overflow_tasks']['app_main'] = 9
        self.assertEqual(evidence.snapshot()['overflow_tasks'], {'app_main': 1})

    def test_counters_saturate(self):
        evidence = obs.PanicEvidence()
        evidence._markers['stack_overflow'] = obs.MAX_COUNT
        evidence._tasks['app_main'] = obs.MAX_COUNT
        evidence.feed(hook(b'main'))
        self.assertEqual(evidence.snapshot(), {'markers': {'stack_overflow': obs.MAX_COUNT},
                                             'overflow_tasks': {'app_main': obs.MAX_COUNT}})


class ContinuousTests(unittest.TestCase):
    def test_same_chunk_after_ack_keeps_hook_and_blocks_controls(self):
        transport = Transport([wire(reply()) + hook(b'audio_communica')])
        with transport.patched() as writes:
            usb = obs.ContinuousUsb(7)
            self.assertEqual(usb.request('status'), reply())
            with self.assertRaises(RuntimeError):
                usb.request('listen stop')
            self.assertEqual(writes.call_count, 1)
            self.assertEqual(usb.evidence.snapshot()['overflow_tasks'], {'audio_communica': 1})

    def test_partial_hook_survives_ack_and_continues_after_panic(self):
        raw = hook(b'audio_input')
        transport = Transport([wire(reply()) + raw[:43], raw[43:] + b'Guru Meditation Error: PRIVATE\n', hook(b'main')])
        with transport.patched() as writes:
            usb = obs.ContinuousUsb(7)
            usb.request('status')
            usb.observe(1)
            self.assertEqual(writes.call_count, 1)
            self.assertEqual(usb.evidence.snapshot()['overflow_tasks'], {'audio_input': 1, 'app_main': 1})
            self.assertEqual(usb.evidence.snapshot()['markers']['guru_meditation'], 1)

    def test_timeout_is_unknown_without_retry_but_preserves_evidence(self):
        transport = Transport([hook(b'main')])
        with transport.patched() as writes:
            usb = obs.ContinuousUsb(7)
            with self.assertRaises(TimeoutError):
                usb.request('status', 1)
            self.assertEqual(writes.call_count, 1)
            self.assertTrue(usb.evidence.panicked)

    def test_unknown_outcome_blocks_retries_but_allows_passive_evidence(self):
        transport = Transport([])
        with transport.patched() as writes:
            usb = obs.ContinuousUsb(7)
            with self.assertRaises(TimeoutError):
                usb.request('status', 1)
            with self.assertRaises(RuntimeError):
                usb.request('listen start')
            transport.chunks.append(hook(b'main'))
            usb.observe(1)
            self.assertEqual(writes.call_count, 1)
            self.assertEqual(usb.evidence.snapshot()['overflow_tasks'], {'app_main': 1})

    def test_disconnected_passive_owner_blocks_later_commands(self):
        transport = Transport([b''])
        with transport.patched() as writes:
            usb = obs.ContinuousUsb(7)
            with self.assertRaises(OSError):
                usb.observe(1)
            with self.assertRaises(RuntimeError):
                usb.request('status')
            writes.assert_not_called()

    def test_read_readiness_race_does_not_resubmit_command(self):
        transport = Transport([wire(reply())])
        original = transport.read
        reads = iter((BlockingIOError(), None))
        def raced(fd, size):
            if next(reads) is not None:
                raise BlockingIOError()
            return original(fd, size)
        with transport.patched() as writes, mock.patch.object(obs.os, 'read', side_effect=raced):
            self.assertEqual(obs.ContinuousUsb(7).request('status'), reply())
            self.assertEqual(writes.call_count, 1)

    def test_wrong_reply_ignored_and_matching_fragmented_reply_accepted(self):
        valid = wire(reply())
        transport = Transport([wire(reply(command='open hermes')), valid[:15], valid[15:]])
        with transport.patched() as writes:
            self.assertEqual(obs.ContinuousUsb(7).request('status'), reply())
            self.assertEqual(writes.call_count, 1)

    def test_eof_finishes_hook_and_never_retries(self):
        transport = Transport([hook(b'main').rstrip(b'\r\n'), b''])
        with transport.patched() as writes:
            usb = obs.ContinuousUsb(7)
            with self.assertRaises(OSError):
                usb.request('status')
            self.assertEqual(writes.call_count, 1)
            self.assertEqual(usb.evidence.snapshot()['overflow_tasks'], {'app_main': 1})

    def test_short_write_not_resubmitted(self):
        with mock.patch.object(obs.os, 'write', return_value=1) as writes:
            with self.assertRaises(OSError):
                obs.ContinuousUsb(7).request('status')
            self.assertEqual(writes.call_count, 1)

    def test_controls_and_invalid_budgets_rejected_without_io(self):
        usb = obs.ContinuousUsb(7)
        with mock.patch.object(obs.os, 'write') as writes:
            for command in ('sd read', 'sd prompt', 'open setup', 'PRIVATE'):
                with self.assertRaises(ValueError):
                    usb.request(command)
            for budget in (True, False, float('nan'), float('inf'), -1, 61, 'PRIVATE'):
                with self.assertRaises(ValueError):
                    usb.request('status', budget)
            for budget in (True, float('nan'), float('inf'), -1, 301, 'PRIVATE'):
                with self.assertRaises(ValueError):
                    usb.observe(budget)
            writes.assert_not_called()

    def test_status_summary_omits_general_text_and_host(self):
        body = reply(app_version='PRIVATE', result='PRIVATE', free_heap=True,
                     network={'connected': True, 'scheme': 'ws', 'host': 'PRIVATE'})
        self.assertEqual(obs.status_snapshot(body), {'state': 'Launcher', 'device_state': 'unavailable', 'network_connected': True})
        with self.assertRaises(ValueError):
            obs.status_snapshot(reply(ok=False))

    def test_cli_only_two_status_requests_no_state_changes(self):
        transport = Transport([wire(reply()), wire(reply())])
        with transport.patched() as writes, mock.patch.object(obs, 'usb_port', return_value=contextlib.nullcontext(7)), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(obs.main(['--port', 'mock', '--duration', '0']), 0)
            self.assertEqual(writes.call_args_list, [mock.call(7, b'SC_DIAG status\n')] * 2)
            self.assertTrue(json.loads(output.getvalue())['ok'])

    def test_cli_panic_skips_final_status_and_returns_static_evidence(self):
        transport = Transport([wire(reply()) + hook(b'main')])
        with transport.patched() as writes, mock.patch.object(obs, 'usb_port', return_value=contextlib.nullcontext(7)), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(obs.main(['--port', 'mock', '--duration', '1']), 2)
            self.assertEqual(writes.call_count, 1)
            body = json.loads(output.getvalue())
            self.assertTrue(body['controls_halted'])
            self.assertIsNone(body['final_status'])
            self.assertEqual(body['overflow_tasks'], {'app_main': 1})

    def test_cli_errors_are_static_no_raw_exception_text(self):
        with mock.patch.object(obs, 'usb_port', side_effect=OSError('PRIVATE_CREDENTIAL')), \
             contextlib.redirect_stderr(io.StringIO()) as output:
            self.assertEqual(obs.main(['--port', 'mock']), 1)
            self.assertEqual(json.loads(output.getvalue()), {'ok': False, 'result': 'usb_observation_failed_outcome_unknown'})


if __name__ == '__main__':
    unittest.main()
