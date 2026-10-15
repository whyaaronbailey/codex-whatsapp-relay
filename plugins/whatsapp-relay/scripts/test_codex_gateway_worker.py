"""Portable offline contract tests; no installed gateway, desktop or model needed."""
import contextlib
import base64
import copy
import hashlib
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("codex-gateway-worker.py"))
w = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(w)
THREAD = "11111111-1111-4111-8111-111111111111"
NEW_THREAD = "22222222-2222-4222-8222-222222222222"
REQUEST = "wa-v1-offline-001"


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


class GatewayError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)

    def to_dict(self):
        return {"code": self.code, "message": self.message}


class RpcError(Exception):
    def __init__(self, code):
        self.code = code


class Core:
    UNCERTAIN_STATES = {"delivery_uncertain_no_retry", "subscription_uncertain_requires_review", "settings_mismatch"}
    GatewayError = GatewayError
    _transport = types.SimpleNamespace(atomic_json=atomic_json, RpcError=RpcError)

    def __init__(self):
        self.send_calls, self.collect_calls, self.destinations = [], [], []
        self.created_send_calls = []
        self.receipt = {"request_id": REQUEST, "state": "response_completed", "attempted": True,
            "accepted": True, "persisted": True, "reply_complete": True, "turn_id": "turn-one",
            "completion_status": "completed", "replies": [{"phase": "final_answer", "text": "ACK " + REQUEST + "\nDone."}]}

    FileLock = staticmethod(lambda *_: contextlib.nullcontext())
    fingerprint = staticmethod(lambda value: hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest())
    definitive_rpc_rejection = staticmethod(lambda error: error.code in (-32700, -32600, -32601, -32602))

    @staticmethod
    def public_text(value):
        if not isinstance(value, str) or not value.strip() or len(value) > 32000:
            raise GatewayError("invalid_message", "Message must be nonempty and bounded.")

    safe_label = staticmethod(lambda value, _field: Core.public_text(value))

    def Gateway(self, ledger_dir, destinations, admit_transport, rpc_factory):
        self.destinations.append(copy.deepcopy(destinations))
        owner = self

        class Gateway:
            def send_created(self, *args, rpc, creation_response, creation_proof, **kwargs):
                assert rpc._gateway_creation_response is creation_response
                assert not getattr(rpc, "_gateway_first_turn_used", False)
                rpc._gateway_first_turn_used = True
                owner.created_send_calls.append({"threadId": args[2], "rpc": rpc})
                return self.send(*args, **kwargs)

            def send(self, request_id, host, thread_id, message, sender, **kwargs):
                destination = next(d for d in destinations if d["host"] == host and d["thread_id"] == thread_id)
                if "allowed_senders" in destination and sender["id"] not in destination["allowed_senders"]:
                    raise GatewayError("sender_not_allowed", "Sender is not authorized.")
                if "allowed_workflows" in destination and kwargs["workflow"] not in destination["allowed_workflows"]:
                    raise GatewayError("workflow_not_allowed", "Workflow is not authorized.")
                owner.send_calls.append({"id": request_id, "threadId": thread_id, "message": message,
                    "sender": copy.deepcopy(sender), "destination": copy.deepcopy(destination), **kwargs})
                receipt = copy.deepcopy(owner.receipt)
                receipt.update({"request_id": request_id, "sender": sender, "workflow": kwargs["workflow"],
                                "destination": destination})
                atomic_json(Path(ledger_dir) / (request_id + ".json"), receipt)
                return receipt

            def collect(self, request_id, timeout=0, on_event=None):
                owner.collect_calls.append((request_id, timeout))
                return copy.deepcopy(owner.receipt)

        return Gateway()


class Runtime:
    class RuntimeAdmissionError(Exception):
        pass

    def __init__(self, binding):
        self.binding = binding
        self.kwargs = []
        self.fail = False

    def verify_binding(self, manifest, snapshot, **kwargs):
        self.kwargs.append(kwargs)
        if self.fail:
            raise self.RuntimeAdmissionError("private diagnostic")
        return {"verified": True, "host": manifest["host"], "endpoint": manifest["endpoint"], "runtime_id": "runtime-one"}


class Backend:
    def __init__(self):
        self.calls = []
        self.closed = 0
        self.threads = {THREAD: {"id": THREAD, "name": "Existing task", "cwd": "C:\\Work\\project",
            "updatedAt": 123, "status": {"type": "idle"}}}
        self.pages = {None: {"data": list(self.threads.values())}}
        self.lose_create = False
        self.reject_create = None
        self.lose_name = False
        self.wrong_permissions = False

    def factory(self, endpoint):
        self.calls.append(("connect", endpoint))
        owner = self

        class Rpc:
            def initialize(self):
                owner.calls.append(("initialize", {}))

            def close(self):
                owner.closed += 1

            def request(self, method, params):
                owner.calls.append((method, copy.deepcopy(params)))
                if method == "thread/list":
                    return copy.deepcopy(owner.pages[params.get("cursor")])
                if method == "thread/read":
                    return {"thread": copy.deepcopy(owner.threads[params["threadId"]])}
                if method == "thread/start":
                    if owner.reject_create is not None:
                        raise RpcError(owner.reject_create)
                    owner.threads[NEW_THREAD] = {"id": NEW_THREAD, "name": None, "cwd": params["cwd"], "status": {"type": "idle"}}
                    if owner.lose_create:
                        raise OSError("secret provider detail")
                    sandbox = {"read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess"}[params["sandbox"]]
                    return {"thread": copy.deepcopy(owner.threads[NEW_THREAD]), "cwd": params["cwd"],
                        "model": params.get("model", "configured-model"), "reasoningEffort": "medium",
                        "approvalPolicy": params["approvalPolicy"],
                        "sandbox": {"type": "dangerFullAccess" if owner.wrong_permissions else sandbox}}
                if method == "thread/name/set":
                    owner.threads[params["threadId"]]["name"] = params["name"]
                    if owner.lose_name:
                        raise TimeoutError("secret provider detail")
                    return {}
                raise AssertionError("Unexpected RPC: " + method)

        return Rpc()


class HandshakeSocket:
    """In-memory HTTP upgrade; never opens a network connection."""
    def __init__(self, response=None):
        self.response = response
        self.sent = []
        self.closed = False

    def sendall(self, data):
        self.sent.append(data)

    def recv(self, _limit):
        if self.response is not None:
            return self.response
        headers = dict(line.split(": ", 1) for line in self.sent[0].decode("ascii").split("\r\n")[1:] if ": " in line)
        accept = base64.b64encode(hashlib.sha1((headers["Sec-WebSocket-Key"] +
            "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest())
        return b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n"

    def close(self):
        self.closed = True


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {"gatewayRoot": str(self.root), "bindingManifest": str(self.root / "manifest.json"),
            "ledgerDir": str(self.root / "ledger"), "sender": {"kind": "whatsapp", "id": "whatsapp-owner"},
            "workflow": "whatsapp-user-message", "allowSelectedSessions": True,
            "allowedWorkspaceRoots": ["C:\\Work"], "observationTimeoutSeconds": 0}
        self.binding = types.SimpleNamespace(manifest={"host": "local", "endpoint": "ws://127.0.0.1:4500"},
            computer="OFFLINE-PC", snapshot_provider=lambda _: {})
        self.core, self.backend, self.events = Core(), Backend(), []
        self.runtime = Runtime(self.binding)
        self.params = {"requestId": REQUEST, "threadId": THREAD, "workspace": "C:\\Work\\project", "prompt": "Do this."}

    def adapter(self):
        return w.Adapter(self.config, core=self.core, runtime=self.runtime,
                         binding=self.binding, rpc_factory=self.backend.factory)

    def assert_error(self, code, function):
        with self.assertRaises(w.WorkerError) as caught:
            function()
        self.assertEqual(caught.exception.error["code"], code)
        return caught.exception.error

    def test_discovery_is_read_only_paginated_and_workspace_bounded(self):
        extra = {"id": "other", "name": "Other", "cwd": "C:\\Outside", "updatedAt": 1}
        self.backend.pages[None]["nextCursor"] = "page2"
        self.backend.pages["page2"] = {"data": [extra]}
        result = self.adapter().list_sessions({"scope": "all"})
        self.assertEqual([t["id"] for t in result], [THREAD])
        self.assertTrue(result[0]["gatewayEligible"])
        self.assertEqual([m for m, _ in self.backend.calls if m.startswith("thread/")], ["thread/list", "thread/list"])
        self.assertFalse(self.core.send_calls)

    def test_discovery_does_not_silently_treat_empty_workspace_as_all(self):
        self.assert_error("invalid_workspace", lambda: self.adapter().list_sessions({"scope": "workspace"}))
        self.assertFalse(self.backend.calls)

    def test_native_host_scope_lists_other_workspaces(self):
        self.backend.pages[None]["data"].append({"id": "second", "name": "Second", "cwd": "C:\\Work\\second"})
        result = self.adapter().list_sessions({"scope": "host", "workspace": "C:\\Work\\project"})
        self.assertEqual([item["id"] for item in result], [THREAD, "second"])

    def test_repeated_cursor_fails_instead_of_infinite_list(self):
        self.backend.pages = {None: {"data": [], "nextCursor": "again"}, "again": {"data": [], "nextCursor": "again"}}
        self.assert_error("invalid_history", lambda: self.adapter().list_sessions({"scope": "all"}))

    def test_failed_owner_admission_does_not_connect(self):
        self.runtime.fail = True
        self.assert_error("owner_admission_failed", lambda: self.adapter().list_sessions({}))
        self.assertFalse(self.backend.calls)

    def test_missing_or_invalid_transport_token_refuses_before_connect(self):
        path = self.root / "private-token"
        self.config["transportTokenFile"] = str(path)
        self.assert_error("transport_token_unavailable", self.adapter)
        for token in (b"a" * 63, b"a" * 65, b"a" * 64 + b"\r\nInjected: yes", b"a" * 64 + b"\n\n", b"a" * 10000):
            with self.subTest(length=len(token)):
                path.write_bytes(token)
                error = self.assert_error("invalid_transport_token", self.adapter)
                self.assertNotIn("a" * 63, json.dumps(error))
        self.assertFalse(self.backend.calls)
        self.assertFalse(self.core.send_calls)

    def test_transport_token_file_must_be_absolute(self):
        self.config["transportTokenFile"] = "relative-token"
        self.assert_error("invalid_config", self.adapter)
        self.assertFalse(self.backend.calls)

    def test_transport_auth_is_header_only_and_no_auth_call_shape_is_preserved(self):
        token = "aA0_-" * 12 + "abcd"
        path = self.root / "private-token"
        endpoint = self.binding.manifest["endpoint"]
        for suffix in (None, b"", b"\n", b"\r\n"):
            with self.subTest(suffix=suffix):
                if suffix is None:
                    self.config.pop("transportTokenFile", None)
                else:
                    path.write_bytes(token.encode("ascii") + suffix)
                    self.config["transportTokenFile"] = str(path)
                websocket = object()
                with patch.object(self.core._transport, "WebSocket", return_value=websocket, create=True) as connect, \
                     patch.object(self.core._transport, "Rpc", return_value=self.backend.factory(endpoint), create=True) as rpc:
                    adapter = w.Adapter(self.config, core=self.core, runtime=self.runtime, binding=self.binding)
                    adapter.rpc_factory(endpoint).close()
                    connect.assert_called_once_with(endpoint, **({} if suffix is None else {"bearer_token": token}))
                    rpc.assert_called_once_with(websocket)
                    self.assertNotIn(token, json.dumps(adapter.config))

    def test_vm_proof_uses_configured_real_computer_and_host(self):
        self.config.update(host="vm", expectedComputer="TEST-VM")
        self.binding.manifest["host"] = "vm"
        self.binding.computer = "TEST-VM"
        self.adapter().list_sessions({})
        self.assertEqual(self.runtime.kwargs[0], {"computer": "TEST-VM", "expected_computer": "TEST-VM", "expected_host": "vm"})

    def test_selected_thread_wrong_workspace_cannot_send(self):
        self.params["workspace"] = "C:\\Work\\different"
        self.assert_error("identity_mismatch", lambda: self.adapter().send_prompt(self.params, self.events.append))
        self.assertFalse(self.core.send_calls)

    def test_workspace_root_uses_path_boundary(self):
        self.params["workspace"] = "C:\\Workshop\\project"
        self.assert_error("workspace_not_allowed", lambda: self.adapter().send_prompt(self.params, self.events.append))

    def test_selected_identity_is_durable_and_settings_overrides_are_ignored(self):
        result = self.adapter().send_prompt({**self.params, "model": "must-not-apply", "permissionLevel": "danger-full-access"}, self.events.append)
        self.assertEqual(result["replyText"], "Done.")
        call = self.core.send_calls[0]
        self.assertEqual(call["threadId"], THREAD)
        self.assertEqual(call["sender"]["kind"], "whatsapp")
        self.assertNotIn("model", call)
        self.assertNotIn("permissionLevel", call)
        self.assertNotIn("settings_baseline", call["destination"])
        binding = json.loads((self.root / "ledger" / "selected-sessions" / (REQUEST + ".json")).read_text())
        self.assertEqual(binding["destination"]["title"], "Existing task")
        self.assertEqual(self.events[0], {"type": "turnStarted", "threadId": THREAD, "turnId": "turn-one"})

    def test_explicit_target_restrictions_win_over_selected_session_opt_in(self):
        self.config["destinations"] = [{"host": "local", "endpoint": self.binding.manifest["endpoint"],
            "thread_id": THREAD, "title": "Existing task", "cwd": self.params["workspace"], "allowed_senders": ["other-provider"]}]
        with self.assertRaises(GatewayError) as caught:
            self.adapter().send_prompt(self.params, self.events.append)
        self.assertEqual(caught.exception.code, "sender_not_allowed")
        self.assertFalse(self.core.send_calls)

    def test_disabled_selected_session_policy_blocks_before_read(self):
        self.config["allowSelectedSessions"] = False
        self.assert_error("destination_not_allowed", lambda: self.adapter().send_prompt(self.params, self.events.append))
        self.assertFalse(self.backend.calls)

    def test_non_whatsapp_principal_cannot_impersonate_existing_oc_caller(self):
        self.config["sender"]["kind"] = "opencode"
        self.assert_error("invalid_config", self.adapter)

    def test_uncertain_delivery_is_never_retried_by_worker(self):
        self.core.receipt.update(state="delivery_uncertain_no_retry", accepted=False, persisted=False,
                                 reply_complete=False, completion_status=None)
        error = self.assert_error("delivery_unresolved", lambda: self.adapter().send_prompt(self.params, self.events.append))
        self.assertTrue(error["deliveryUncertain"])
        self.assertFalse(error["retryable"])
        self.assertEqual(len(self.core.send_calls), 1)
        self.assertFalse(self.core.collect_calls)

    def test_pending_reply_is_not_reported_as_completed(self):
        self.core.receipt.update(state="persisted_awaiting_reply", reply_complete=False, completion_status="inProgress")
        error = self.assert_error("reply_pending", lambda: self.adapter().send_prompt(self.params, self.events.append))
        self.assertTrue(error["promptSubmitted"])
        self.assertFalse(error["deliveryUncertain"])

    def test_approval_requires_desktop_without_answering_it(self):
        self.core.receipt.update(reply_complete=False, completion_status="inProgress", requires_desktop_attention=True)
        self.assert_error("desktop_attention_required", lambda: self.adapter().send_prompt(self.params, self.events.append))
        self.assertFalse(any("approval" in method for method, _ in self.backend.calls))

    def test_new_session_requires_opt_in(self):
        self.assert_error("creation_not_allowed", lambda: self.adapter().create_session(self.params, self.events.append))
        self.assertFalse(self.backend.calls)

    def test_new_session_settings_apply_only_to_created_id(self):
        self.config["allowCreateSessions"] = True
        result = self.adapter().create_session({**self.params, "threadName": "Phone task", "permissionLevel": "read-only", "model": "chosen-model"}, self.events.append)
        self.assertEqual(result["threadId"], NEW_THREAD)
        self.assertEqual(self.backend.threads[THREAD]["name"], "Existing task")
        start = next(p for m, p in self.backend.calls if m == "thread/start")
        self.assertEqual(start["sandbox"], "read-only")
        self.assertEqual(start["approvalPolicy"], "never")
        self.assertEqual(start["model"], "chosen-model")
        self.assertEqual(self.core.send_calls[0]["destination"]["settings_baseline"]["settings"]["sandboxType"], "read-only")

    def test_new_creation_retry_reuses_known_id(self):
        self.config["allowCreateSessions"] = True
        adapter = self.adapter()
        adapter.create_session(self.params, self.events.append)
        adapter.create_session(self.params, self.events.append)
        self.assertEqual(sum(method == "thread/start" for method, _ in self.backend.calls), 1)
        self.assertEqual({c["threadId"] for c in self.core.send_calls}, {NEW_THREAD})
        self.assertEqual(len(self.core.created_send_calls), 1)

    def test_creation_with_existing_delivery_receipt_cannot_create_or_use_handoff(self):
        self.config["allowCreateSessions"] = True
        atomic_json(self.root / "ledger" / (REQUEST + ".json"), {"request_id": REQUEST})
        self.assert_error("request_id_collision", lambda: self.adapter().create_session(self.params, self.events.append))
        self.assertFalse(self.backend.calls)
        self.assertFalse(self.core.created_send_calls)

    def test_core_without_first_turn_support_refuses_before_creation(self):
        self.config["allowCreateSessions"] = True
        with patch.object(self.core, "Gateway", return_value=types.SimpleNamespace(send=lambda *_: None)):
            self.assert_error("first_turn_unsupported", lambda: self.adapter().create_session(self.params, self.events.append))
        self.assertFalse(self.backend.calls)

    def test_creation_connection_stays_open_until_first_delivery_completes(self):
        self.config["allowCreateSessions"] = True
        adapter = self.adapter()
        send = adapter.send_prompt

        def observe_send(*args, **kwargs):
            self.assertEqual(self.backend.closed, 0)
            journal = w.read_json(self.root / "ledger" / "created-sessions" / (REQUEST + ".json"))
            self.assertEqual(journal["state"], "created")
            self.assertFalse(journal["workerFinished"])
            result = send(*args, **kwargs)
            self.assertEqual(self.backend.closed, 0)
            return result

        with patch.object(adapter, "send_prompt", side_effect=observe_send):
            result = adapter.create_session(self.params, self.events.append)
        self.assertEqual(result["replyText"], "Done.")
        self.assertEqual(self.backend.closed, 1)
        journal = w.read_json(self.root / "ledger" / "created-sessions" / (REQUEST + ".json"))
        self.assertTrue(journal["workerFinished"])

    def test_creation_connection_closes_after_uncertain_first_delivery(self):
        self.config["allowCreateSessions"] = True
        self.core.receipt.update(state="delivery_uncertain_no_retry", accepted=False,
                                 persisted=False, reply_complete=False, completion_status=None)
        adapter = self.adapter()
        send = adapter.send_prompt

        def observe_send(*args, **kwargs):
            self.assertEqual(self.backend.closed, 0)
            return send(*args, **kwargs)

        with patch.object(adapter, "send_prompt", side_effect=observe_send):
            error = self.assert_error("delivery_unresolved", lambda: adapter.create_session(self.params, self.events.append))
        self.assertTrue(error["deliveryUncertain"])
        self.assertTrue(error["promptSubmitted"])
        self.assertEqual(self.backend.closed, 1)
        receipt = w.read_json(self.root / "ledger" / (REQUEST + ".json"))
        self.assertEqual(receipt["state"], "delivery_uncertain_no_retry")
        self.assertTrue(receipt["attempted"])
        journal = w.read_json(self.root / "ledger" / "created-sessions" / (REQUEST + ".json"))
        self.assertEqual(journal["threadId"], NEW_THREAD)
        self.assertTrue(journal["workerFinished"])

    def test_creation_journal_write_failure_closes_connection_without_start(self):
        self.config["allowCreateSessions"] = True
        with patch.object(self.core._transport, "atomic_json", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                self.adapter().create_session(self.params, self.events.append)
        self.assertEqual(self.backend.closed, 1)
        self.assertFalse(any(method == "thread/start" for method, _ in self.backend.calls))
        self.assertFalse(self.core.send_calls)

    def test_lost_creation_response_is_durable_and_never_duplicates(self):
        self.config["allowCreateSessions"] = True
        self.backend.lose_create = True
        adapter = self.adapter()
        error = self.assert_error("creation_uncertain", lambda: adapter.create_session(self.params, self.events.append))
        self.assertTrue(error["deliveryUncertain"])
        self.assertFalse(error["promptSubmitted"])
        self.assert_error("creation_requires_review", lambda: adapter.create_session(self.params, self.events.append))
        self.assertEqual(sum(method == "thread/start" for method, _ in self.backend.calls), 1)
        self.assertFalse(self.core.send_calls)
        self.assertEqual(self.backend.closed, 1)

    def test_new_settings_mismatch_never_submits_prompt(self):
        self.config["allowCreateSessions"] = True
        self.backend.wrong_permissions = True
        self.assert_error("new_session_settings_mismatch", lambda: self.adapter().create_session(self.params, self.events.append))
        self.assertFalse(self.core.send_calls)
        self.assertEqual(self.backend.closed, 1)

    def test_lost_name_response_never_submits_prompt_or_recreates(self):
        self.config["allowCreateSessions"] = True
        self.backend.lose_name = True
        adapter = self.adapter()
        self.assert_error("creation_naming_uncertain", lambda: adapter.create_session(self.params, self.events.append))
        self.assert_error("creation_requires_review", lambda: adapter.create_session(self.params, self.events.append))
        self.assertFalse(self.core.send_calls)

    def test_creation_request_id_cannot_be_reused_for_other_content(self):
        self.config["allowCreateSessions"] = True
        adapter = self.adapter()
        adapter.create_session(self.params, self.events.append)
        self.assert_error("request_id_collision", lambda: adapter.create_session({**self.params, "prompt": "Different"}, self.events.append))
        self.assertEqual(sum(method == "thread/start" for method, _ in self.backend.calls), 1)

    def test_status_reconciles_read_only_and_returns_complete_reply(self):
        adapter = self.adapter()
        adapter.send_prompt(self.params, self.events.append)
        result = adapter.dispatch("status", {"requestId": REQUEST}, self.events.append)
        self.assertEqual(self.core.collect_calls, [(REQUEST, 0)])
        self.assertEqual(len(self.core.send_calls), 1)
        self.assertEqual(result["state"], "reply_complete")
        self.assertEqual(result["replyText"], "Done.")
        self.assertTrue(result["completed"])
        self.assertTrue(result["readOnly"])

    def test_status_exposes_uncertain_creation_without_rpc(self):
        self.config["allowCreateSessions"] = True
        self.backend.lose_create = True
        adapter = self.adapter()
        self.assert_error("creation_uncertain", lambda: adapter.create_session(self.params, self.events.append))
        calls = len(self.backend.calls)
        result = adapter.dispatch("status", {"requestId": REQUEST}, self.events.append)
        self.assertTrue(result["deliveryUncertain"])
        self.assertFalse(result["promptSubmitted"])
        self.assertEqual(len(self.backend.calls), calls)

    def test_status_rejects_different_selected_thread(self):
        adapter = self.adapter()
        adapter.send_prompt(self.params, self.events.append)
        self.assert_error("identity_mismatch", lambda: adapter.reconcile_request({"requestId": REQUEST, "threadId": NEW_THREAD}))
        self.assertFalse(self.core.collect_calls)

    def test_created_journal_never_claims_no_send_while_worker_may_be_active(self):
        atomic_json(self.root / "ledger" / "created-sessions" / (REQUEST + ".json"),
                    {"state": "created", "threadId": NEW_THREAD, "promptSubmitted": False, "workerFinished": False})
        result = self.adapter().dispatch("status", {"requestId": REQUEST}, self.events.append)
        self.assertTrue(result["inProgress"])
        self.assertTrue(result["deliveryUncertain"])
        self.assertNotIn("promptSubmitted", result)

    def test_cancel_before_send_never_connects(self):
        cancelled = threading.Event()
        cancelled.set()
        adapter = self.adapter()
        adapter.cancel_event = cancelled
        error = self.assert_error("observer_cancelled", lambda: adapter.send_prompt(self.params, self.events.append))
        self.assertFalse(error["promptSubmitted"])
        self.assertFalse(error["deliveryUncertain"])
        self.assertFalse(self.backend.calls)

    def test_raw_stdin_eof_cancels_without_buffered_reader_shutdown(self):
        reader, writer = os.pipe()
        cancelled = threading.Event()
        with os.fdopen(reader, "r", encoding="utf-8") as stream:
            os.write(writer, b'{"id":1,"method":"send_prompt","params":{}}\n')
            line, descriptor, remainder = w.read_request(stream)
            self.assertEqual(json.loads(line)["id"], 1)
            watcher = threading.Thread(target=w.watch_disconnect, args=(descriptor, remainder, cancelled))
            watcher.start()
            os.close(writer)
            watcher.join(2)
            self.assertFalse(watcher.is_alive())
        self.assertTrue(cancelled.is_set())

    def test_buffered_cancel_control_is_not_lost_after_first_request(self):
        reader, writer = os.pipe()
        cancelled = threading.Event()
        with os.fdopen(reader, "r", encoding="utf-8") as stream:
            os.write(writer, b'{"id":1}\n{"type":"cancel"}\n')
            os.close(writer)
            _line, descriptor, remainder = w.read_request(stream)
            w.watch_disconnect(descriptor, remainder, cancelled)
        self.assertTrue(cancelled.is_set())

    def test_jsonl_main_returns_structured_errors_without_private_details(self):
        incoming, outgoing = io.StringIO(json.dumps({"id": 1, "method": "list_sessions", "params": {}}) + "\n"), io.StringIO()
        with patch.object(w.sys, "stdin", incoming), patch.object(w.sys, "stdout", outgoing), patch.object(w, "read_json", side_effect=OSError("password=PRIVATE")):
            code = w.main(["--config", str(self.root / "config.json")])
        response = json.loads(outgoing.getvalue())
        self.assertEqual(code, 1)
        self.assertEqual(response["id"], 1)
        self.assertFalse(response["error"]["promptSubmitted"])
        self.assertNotIn("PRIVATE", outgoing.getvalue())

    def test_jsonl_heartbeat_is_plain_code_and_correlated(self):
        stream = io.StringIO()
        output = w.JsonlOutput(stream, 7)
        with patch.object(output.stopped, "wait", side_effect=[False, True]):
            output.heartbeat()
        self.assertEqual(json.loads(stream.getvalue()), {"id": 7, "type": "heartbeat"})


@unittest.skipUnless(os.environ.get("CODEX_GATEWAY_TEST_ROOT"), "optional installed-core offline integration")
class InstalledCoreTests(unittest.TestCase):
    """Opt-in tests reuse the existing gateway's fake backend, never its runtime."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        gateway_root = os.environ["CODEX_GATEWAY_TEST_ROOT"]
        self.core = w.load_module(gateway_root, "gateway_core.py", "_test_installed_core")
        with patch.dict(sys.modules, {"gateway_core": self.core}):
            fixture = w.load_module(gateway_root, "test_gateway_core.py", "_test_installed_fixture")
        self.fixture = fixture
        self.backend = fixture.Backend(self.root / "ledger")
        self.config = {"gatewayRoot": gateway_root, "bindingManifest": str(self.root / "manifest.json"),
            "ledgerDir": str(self.root / "ledger"), "sender": {"kind": "whatsapp", "id": "whatsapp-owner"},
            "workflow": "whatsapp-user-message", "allowSelectedSessions": True, "observationTimeoutSeconds": 0.2}
        self.binding = types.SimpleNamespace(manifest={"host": "local", "endpoint": fixture.DEST["endpoint"]},
            computer="OFFLINE-PC", snapshot_provider=lambda _: {})
        self.binding.verify = lambda thread_id: {"verified": True, "verified_utc": self.core.now(),
            "runtime_id": "runtime-one", "host": "local", "thread_id": thread_id, "endpoint": fixture.DEST["endpoint"]}
        self.adapter = w.Adapter(self.config, core=self.core, runtime=Runtime(self.binding),
                                 binding=self.binding, rpc_factory=self.backend.factory)
        self.params = {"requestId": REQUEST, "threadId": fixture.DEST["thread_id"], "workspace": fixture.DEST["cwd"], "prompt": "Reply harmlessly."}

    def require_bearer_transport(self):
        if "bearer_token" not in inspect.signature(self.core._transport.WebSocket).parameters:
            self.skipTest("installed transport does not yet support bearer authentication")
        return self.core._transport

    def test_websocket_bearer_and_unauthenticated_upgrade_headers(self):
        transport = self.require_bearer_transport()
        for token in (None, "A" * 64):
            with self.subTest(authenticated=token is not None):
                socket = HandshakeSocket()
                with patch.object(transport.socket, "create_connection", return_value=socket):
                    websocket = transport.WebSocket("ws://127.0.0.1:4500", bearer_token=token)
                    request = socket.sent[0].decode("ascii")
                    self.assertEqual(request.count("Authorization:"), int(token is not None))
                    if token is not None:
                        self.assertIn("\r\nAuthorization: Bearer " + token + "\r\n", request)
                    websocket.close()
                    self.assertTrue(socket.closed)

    def test_websocket_invalid_bearer_refuses_before_socket_without_value(self):
        transport = self.require_bearer_transport()
        for token in ("", "A" * 63, "A" * 65, "A" * 64 + "\r\nInjected: yes", "A" * 63 + "=", b"A" * 64):
            with self.subTest(length=len(token)):
                with patch.object(transport.socket, "create_connection") as connect:
                    with self.assertRaises(transport.ProbeError) as caught:
                        transport.WebSocket("ws://127.0.0.1:4500", bearer_token=token)
                    connect.assert_not_called()
                    self.assertNotIn("A" * 63, str(caught.exception))

    def test_websocket_unauthorized_response_never_exposes_echoed_token(self):
        transport = self.require_bearer_transport()
        token = "B" * 64
        socket = HandshakeSocket(b"HTTP/1.1 401 Unauthorized\r\nX-Echo: " + token.encode("ascii") + b"\r\n\r\n")
        output = io.StringIO()
        with patch.object(transport.socket, "create_connection", return_value=socket), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with self.assertRaises(transport.ProbeError) as caught:
                transport.WebSocket("ws://127.0.0.1:4500", bearer_token=token)
        self.assertNotIn(token, str(caught.exception) + output.getvalue())
        self.assertTrue(socket.closed)

    def enable_new_paginated_thread(self):
        if not hasattr(self.core.Gateway, "send_created"):
            self.skipTest("installed core does not yet support creation handoff")
        self.config["allowCreateSessions"] = self.adapter.config["allowCreateSessions"] = True
        self.params.update(threadName="New phone task", permissionLevel="read-only", model="chosen-model")
        self.creation_connections = []
        self.creation_responses = []
        self.after_create = lambda: None
        self.history_always_missing = False
        base_factory = self.backend.factory
        fixture = self.fixture

        def factory(endpoint):
            rpc = base_factory(endpoint)
            rpc.closed = False
            base_request = rpc.request

            def close():
                self.assertFalse(rpc.closed, "connection closed more than once")
                rpc.closed = True

            def request(method, params):
                self.assertFalse(rpc.closed, "closed creation connection reused")
                if method == "thread/start":
                    rpc.next_id += 1
                    self.backend.calls.append((method, copy.deepcopy(params)))
                    self.creation_connections.append(rpc)
                    fixture.DEST.update(thread_id=NEW_THREAD, title=self.params["threadName"])
                    self.backend.thread.update(id=NEW_THREAD, name=None, model=params["model"],
                        historyMode="paginated", preview="", ephemeral=False, turns=[], status={"type": "idle"})
                    sandbox = {"read-only": "readOnly", "workspace-write": "workspaceWrite"}[params["sandbox"]]
                    result = {"thread": copy.deepcopy(self.backend.thread), "cwd": params["cwd"],
                        "model": params["model"], "reasoningEffort": "medium",
                        "approvalPolicy": params["approvalPolicy"], "sandbox": {"type": sandbox}}
                    self.creation_responses.append(result)
                    self.after_create()
                    return result
                if method == "thread/name/set":
                    rpc.next_id += 1
                    self.backend.calls.append((method, copy.deepcopy(params)))
                    self.backend.thread["name"] = params["name"]
                    return {}
                if (method == "thread/turns/list" or method == "thread/read" and params.get("includeTurns")):
                    if not self.backend.turns or self.history_always_missing:
                        self.backend.calls.append((method, copy.deepcopy(params)))
                        raise self.core._transport.RpcError(-32600)
                if method == "turn/start":
                    self.assertIs(rpc, self.creation_connections[0], "first turn opened a different RPC")
                    self.assertFalse(rpc.closed)
                result = base_request(method, params)
                if method == "thread/resume":
                    result["sandbox"] = {"type": "readOnly"}
                return result

            rpc.request = request
            rpc.close = close
            return rpc

        self.adapter.rpc_factory = lambda endpoint: w.CancellableRpc(factory(endpoint), self.adapter)

    def test_first_paginated_turn_uses_creation_connection_and_preserves_read_only(self):
        self.enable_new_paginated_thread()
        result = self.adapter.create_session(self.params, lambda _: None)
        self.assertEqual(result["replyText"], "Verified harmless reply.")
        mutations = [(m, p) for m, p in self.backend.calls if m in ("thread/resume", "turn/start", "turn/steer")]
        self.assertEqual([m for m, _ in mutations], ["turn/start"])
        self.assertEqual(set(mutations[0][1]), {"threadId", "input"})
        methods = [m for m, _ in self.backend.calls]
        self.assertLess(methods.index("turn/start"), methods.index("thread/turns/list"))
        receipt = w.read_json(self.root / "ledger" / (REQUEST + ".json"))
        self.assertTrue(receipt["persisted"] and receipt["reply_complete"] and receipt["no_setting_overrides"])
        self.assertEqual(receipt["subscription"]["state"], "original_creation_connection")
        self.assertEqual(self.creation_responses[0]["sandbox"], {"type": "readOnly"})
        self.assertTrue(self.creation_connections[0].closed)
        self.assertEqual(list((self.root / "ledger").rglob("*.lock")), [])

    def test_first_turn_refuses_concurrent_activity_or_unload(self):
        self.enable_new_paginated_thread()
        self.after_create = lambda: self.backend.active()
        with self.assertRaises(w.WorkerError) as caught:
            self.adapter.create_session(self.params, lambda _: None)
        self.assertEqual(caught.exception.error["code"], "created_thread_changed")
        self.assertFalse(caught.exception.error["promptSubmitted"])
        self.assertFalse(any(m in ("turn/start", "turn/steer", "thread/resume") for m, _ in self.backend.calls))
        self.assertTrue(self.creation_connections[0].closed)

    def test_first_turn_refuses_unloaded_creation_without_resuming(self):
        self.enable_new_paginated_thread()
        def unloaded():
            self.backend.loaded = False
            self.backend.thread["status"] = {"type": "notLoaded"}
        self.after_create = unloaded
        with self.assertRaises(w.WorkerError) as caught:
            self.adapter.create_session(self.params, lambda _: None)
        self.assertEqual(caught.exception.error["code"], "created_thread_changed")
        self.assertFalse(any(m in ("turn/start", "thread/resume") for m, _ in self.backend.calls))

    def test_first_turn_refuses_changed_runtime(self):
        self.enable_new_paginated_thread()
        original = self.binding.verify
        def changed():
            self.binding.verify = lambda thread_id: {**original(thread_id), "runtime_id": "different-runtime"}
        self.after_create = changed
        with self.assertRaises(w.WorkerError) as caught:
            self.adapter.create_session(self.params, lambda _: None)
        self.assertEqual(caught.exception.error["code"], "owner_admission_failed")
        self.assertFalse(any(m == "turn/start" for m, _ in self.backend.calls))

    def test_first_turn_refuses_changed_model(self):
        self.enable_new_paginated_thread()
        self.after_create = lambda: self.backend.thread.update(model="different-model")
        with self.assertRaises(w.WorkerError) as caught:
            self.adapter.create_session(self.params, lambda _: None)
        self.assertEqual(caught.exception.error["code"], "creation_settings_unverified")
        self.assertFalse(any(m == "turn/start" for m, _ in self.backend.calls))

    def test_first_turn_lost_response_reconciles_without_a_second_send(self):
        self.enable_new_paginated_thread()
        self.backend.disconnect_send = True
        with self.assertRaises(w.WorkerError) as caught:
            self.adapter.create_session(self.params, lambda _: None)
        self.assertTrue(caught.exception.error["deliveryUncertain"])
        self.assertTrue(caught.exception.error["promptSubmitted"])
        status = self.adapter.reconcile_request({"requestId": REQUEST})
        self.assertTrue(status["persisted"])
        self.assertFalse(status["completed"])
        self.assertEqual(sum(m == "turn/start" for m, _ in self.backend.calls), 1)
        self.assertTrue(self.creation_connections[0].closed)
        self.assertEqual(list((self.root / "ledger").rglob("*.lock")), [])

    def test_first_turn_completed_request_replay_does_not_create_or_send_again(self):
        self.enable_new_paginated_thread()
        first = self.adapter.create_session(self.params, lambda _: None)
        second = self.adapter.create_session(self.params, lambda _: None)
        self.assertEqual(second["replyText"], first["replyText"])
        self.assertEqual(len(self.creation_connections), 1)
        self.assertEqual(sum(m == "turn/start" for m, _ in self.backend.calls), 1)

    def test_first_turn_observer_disconnect_releases_locks_without_interrupt(self):
        self.enable_new_paginated_thread()
        cancelled = threading.Event()
        self.adapter.cancel_event = cancelled
        def cancel_when_observing():
            self.creation_connections[0].pump = lambda _timeout: cancelled.set()
        self.after_create = cancel_when_observing
        with self.assertRaises(w.WorkerError) as caught:
            self.adapter.create_session(self.params, lambda _: None)
        self.assertTrue(caught.exception.error["promptSubmitted"])
        self.assertEqual(list((self.root / "ledger").rglob("*.lock")), [])
        self.assertTrue(self.creation_connections[0].closed)
        self.assertFalse(any(m == "turn/interrupt" for m, _ in self.backend.calls))
        cancelled.clear()
        self.assertTrue(self.adapter.reconcile_request({"requestId": REQUEST})["persisted"])
        self.assertEqual(sum(m == "turn/start" for m, _ in self.backend.calls), 1)

    def test_first_turn_does_not_report_reply_without_persisted_history(self):
        self.enable_new_paginated_thread()
        self.history_always_missing = True
        with self.assertRaises(w.WorkerError) as caught:
            self.adapter.create_session(self.params, lambda _: None)
        self.assertTrue(caught.exception.error["promptSubmitted"])
        receipt = w.read_json(self.root / "ledger" / (REQUEST + ".json"))
        self.assertFalse(receipt["persisted"] or receipt["reply_complete"])
        self.assertEqual(sum(m == "turn/start" for m, _ in self.backend.calls), 1)

    def test_first_turn_handoff_rejects_copied_response_and_reuse(self):
        self.enable_new_paginated_thread()
        send = self.adapter.send_prompt
        captured = {}
        def inspect_handoff(params, emit, *, destination, _creation):
            rpc, response, proof = _creation
            gateway = self.adapter.gateway([destination])
            options = {"rpc": rpc, "creation_response": response, "creation_proof": proof,
                       "workflow": self.config["workflow"], "timeout": 0}
            args = (REQUEST, "local", NEW_THREAD, self.params["prompt"], self.config["sender"])
            with self.assertRaises(self.core.GatewayError) as copied:
                gateway.send_created(*args, **{**options, "creation_response": copy.deepcopy(response)})
            self.assertEqual(copied.exception.code, "creation_handoff_invalid")
            result = send(params, emit, destination=destination, _creation=_creation)
            with self.assertRaises(self.core.GatewayError) as reused:
                gateway.send_created(*args, **options)
            self.assertEqual(reused.exception.code, "creation_handoff_invalid")
            captured["checked"] = True
            return result
        with patch.object(self.adapter, "send_prompt", side_effect=inspect_handoff):
            self.adapter.create_session(self.params, lambda _: None)
        self.assertTrue(captured["checked"])
        self.assertEqual(sum(m == "turn/start" for m, _ in self.backend.calls), 1)

    def test_existing_missing_history_still_refuses_even_with_caller_fresh_flags(self):
        self.enable_new_paginated_thread()
        self.backend.thread["historyMode"] = "paginated"
        with self.assertRaises(w.WorkerError) as caught:
            self.adapter.send_prompt({**self.params, "fresh": True, "creation_response": {}}, lambda _: None)
        self.assertFalse(caught.exception.error["promptSubmitted"])
        self.assertEqual(caught.exception.error["code"], "rpc_rejected")
        self.assertFalse(any(m in ("thread/start", "thread/resume", "turn/start", "turn/steer") for m, _ in self.backend.calls))

    def test_real_core_idle_delivery_and_duplicate_request_reconciliation(self):
        result = self.adapter.send_prompt(self.params, lambda _: None)
        self.assertEqual(result["replyText"], "Verified harmless reply.")
        second = self.adapter.send_prompt(self.params, lambda _: None)
        self.assertEqual(second["replyText"], result["replyText"])
        starts = [p for m, p in self.backend.calls if m == "turn/start"]
        self.assertEqual(len(starts), 1)
        self.assertEqual(set(starts[0]), {"threadId", "input"})
        resumes = [p for m, p in self.backend.calls if m == "thread/resume"]
        self.assertEqual(resumes[0], {"threadId": self.params["threadId"]})

    def test_real_core_steers_observed_active_turn_without_new_turn(self):
        self.backend.active()
        result = self.adapter.send_prompt(self.params, lambda _: None)
        self.assertEqual(result["turnId"], "already-active")
        steer = [p for m, p in self.backend.calls if m == "turn/steer"]
        self.assertEqual(steer[0]["expectedTurnId"], "already-active")
        self.assertFalse(any(m == "turn/start" for m, _ in self.backend.calls))

    def test_real_core_preserves_restricted_cold_resume_refusal(self):
        self.backend.loaded = False
        self.backend.thread["status"] = {"type": "notLoaded"}
        self.adapter.config["settingsBaselines"] = {self.params["threadId"]: {"threadId": self.params["threadId"],
            "settings": {"model": "unchanged-model", "effort": "medium", "cwd": self.params["workspace"],
                         "approvalPolicy": "never", "sandboxType": "read-only"}}}
        with self.assertRaises(w.WorkerError) as caught:
            self.adapter.send_prompt(self.params, lambda _: None)
        self.assertEqual(caught.exception.error["code"], "cold_resume_permission_details_required")
        self.assertFalse(caught.exception.error["promptSubmitted"])
        self.assertFalse(any(m in ("thread/resume", "turn/start", "turn/steer") for m, _ in self.backend.calls))

    def test_real_core_read_only_recovery_after_lost_response_never_resends(self):
        self.backend.disconnect_send = True
        with self.assertRaises(w.WorkerError):
            self.adapter.send_prompt(self.params, lambda _: None)
        before = sum(m in ("thread/resume", "turn/start", "turn/steer") for m, _ in self.backend.calls)
        status = self.adapter.reconcile_request({"requestId": REQUEST})
        self.assertTrue(status["persisted"])
        self.assertFalse(status["completed"])
        self.assertEqual(before, sum(m in ("thread/resume", "turn/start", "turn/steer") for m, _ in self.backend.calls))

    def test_real_core_disconnect_releases_request_locks_without_interrupt(self):
        cancelled = threading.Event()
        self.adapter.cancel_event = cancelled

        def factory(endpoint):
            rpc = self.backend.factory(endpoint)
            # Simulate EOF arriving while a native turn is being observed.
            rpc.pump = lambda _timeout: cancelled.set()
            return w.CancellableRpc(rpc, self.adapter)

        self.adapter.rpc_factory = factory
        with self.assertRaises(w.WorkerError):
            self.adapter.send_prompt(self.params, lambda _: None)
        self.assertEqual(list((self.root / "ledger").rglob("*.lock")), [])
        self.assertEqual(sum(m == "turn/start" for m, _ in self.backend.calls), 1)
        self.assertFalse(any(m == "turn/interrupt" for m, _ in self.backend.calls))
        cancelled.clear()
        status = self.adapter.reconcile_request({"requestId": REQUEST})
        self.assertTrue(status["persisted"])
        self.assertFalse(status["completed"])
        self.assertEqual(sum(m == "turn/start" for m, _ in self.backend.calls), 1)


if __name__ == "__main__":
    unittest.main()
