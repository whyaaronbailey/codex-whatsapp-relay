"""JSONL adapter for an independently installed, verified Codex desktop gateway.

This file does not bundle the gateway, launch an app-server, open private IPC,
answer approvals, or change an existing thread's settings. gatewayRoot selects
the user's existing gateway_core.py, gateway_runtime.py and vm-test/rpc_probe.py.
Only standard-library Python is required. One process handles one request.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import importlib.util
import json
import ntpath
import os
from pathlib import Path
import re
import sys
import threading
import time


MAX_INPUT = 1024 * 1024
REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{4,95}\Z")


class WorkerError(Exception):
    def __init__(self, code, message, *, prompt_submitted=False, uncertain=False, **details):
        super().__init__(message)
        self.error = {"code": code, "message": message, "retryable": False,
                      "deliveryUncertain": uncertain, **details}
        if prompt_submitted is not None:
            self.error["promptSubmitted"] = prompt_submitted


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        raise WorkerError("invalid_config", "A configured gateway JSON file is unavailable or invalid.") from None


def absolute_path(value, name):
    if not isinstance(value, str) or not value or not Path(value).is_absolute():
        raise WorkerError("invalid_config", name + " must be an absolute host-local path.")
    return value


def canonical_workspace(value):
    if not isinstance(value, str) or not value or "\x00" in value:
        raise WorkerError("invalid_workspace", "An exact absolute workspace is required.")
    if ntpath.splitdrive(value)[0]:
        if not ntpath.isabs(value) or value.startswith("\\\\"):
            raise WorkerError("invalid_workspace", "The workspace must be an absolute local path.")
        return ntpath.normcase(ntpath.normpath(value))
    if not os.path.isabs(value):
        raise WorkerError("invalid_workspace", "The workspace must be absolute.")
    return os.path.normpath(value)


def beneath(workspace, root):
    path, parent = canonical_workspace(workspace), canonical_workspace(root)
    module = ntpath if ntpath.splitdrive(path)[0] else os.path
    try:
        return module.commonpath([path, parent]) == parent
    except ValueError:
        return False


def load_module(root, filename, name):
    path = Path(root) / filename
    if not path.is_file():
        raise WorkerError("gateway_not_installed", "The configured external gateway is missing a required module.")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_config(value):
    if not isinstance(value, dict):
        raise WorkerError("invalid_config", "Gateway configuration must be an object.")
    config = dict(value)
    for key in ("gatewayRoot", "bindingManifest", "ledgerDir"):
        absolute_path(config.get(key), key)
    if "transportTokenFile" in config:
        absolute_path(config["transportTokenFile"], "transportTokenFile")
    for key in ("allowSelectedSessions", "allowCreateSessions"):
        if key in config and type(config[key]) is not bool:
            raise WorkerError("invalid_config", key + " must be boolean.")
    roots = config.get("allowedWorkspaceRoots", [])
    if not isinstance(roots, list):
        raise WorkerError("invalid_config", "allowedWorkspaceRoots must be an array.")
    for root in roots:
        canonical_workspace(root)
    sender = config.get("sender")
    if (not isinstance(sender, dict) or sender.get("kind") != "whatsapp" or
            not isinstance(sender.get("id"), str) or not sender["id"].strip() or
            set(sender) - {"kind", "id", "host", "title"}):
        raise WorkerError("invalid_config", "A configured WhatsApp sender principal is required; other providers cannot be impersonated.")
    config.setdefault("workflow", "whatsapp-user-message")
    config.setdefault("host", "local")
    if not all(isinstance(config[k], str) and config[k].strip() for k in ("workflow", "host")):
        raise WorkerError("invalid_config", "host and workflow must be nonempty strings.")
    if "destinationsFile" in config:
        if "destinations" in config:
            raise WorkerError("invalid_config", "Use destinations or destinationsFile, not both.")
        destinations = read_json(absolute_path(config["destinationsFile"], "destinationsFile"))
        # Existing gateway configurations may hold additional unrelated settings.
        config["destinations"] = destinations.get("destinations") if isinstance(destinations, dict) else destinations
    config.setdefault("destinations", [])
    if not isinstance(config["destinations"], list):
        raise WorkerError("invalid_config", "destinations must be an array.")
    config.setdefault("observationTimeoutSeconds", 3600)
    timeout = config["observationTimeoutSeconds"]
    if type(timeout) not in (int, float) or not 0 <= timeout <= 86400:
        raise WorkerError("invalid_config", "observationTimeoutSeconds must be between 0 and 86400.")
    return config


def read_transport_token(config):
    path = config.get("transportTokenFile")
    if path is None:
        return None
    try:
        with Path(path).open("rb") as stream:
            raw = stream.read(68)
    except OSError:
        raise WorkerError("transport_token_unavailable", "The private transport token file could not be read; no connection opened.") from None
    if re.fullmatch(rb"[A-Za-z0-9_-]{64}(?:\r?\n)?", raw) is None:
        raise WorkerError("invalid_transport_token", "The private transport token must contain exactly 64 base64url characters and an optional final newline; value suppressed.")
    return raw[:64].decode("ascii")


class CancellableRpc:
    """Cooperative observer cancellation; close and receipt cleanup remain usable."""
    def __init__(self, rpc, adapter):
        object.__setattr__(self, "_rpc", rpc)
        object.__setattr__(self, "_adapter", adapter)

    def __getattr__(self, key):
        return getattr(self._rpc, key)

    def __setattr__(self, key, value):
        setattr(self._rpc, key, value)

    def initialize(self):
        self._adapter.check_cancelled()
        return self._rpc.initialize()

    def request(self, method, params, *args, **kwargs):
        self._adapter.check_cancelled()
        if method in ("thread/start", "thread/name/set", "thread/resume", "turn/start", "turn/steer"):
            self._adapter.mutation_attempted = True
        if method == "thread/start":
            self._adapter.creation_attempted = True
        if method in ("turn/start", "turn/steer"):
            self._adapter.prompt_attempted = True
        # Let the core record a returned mutation response before checking again.
        response = self._rpc.request(method, params, *args, **kwargs)
        if method == "thread/start":
            # In-memory identity proves the first-turn handoff came from this
            # connection's successful creation, never caller JSON or a journal.
            object.__setattr__(self, "_gateway_creation_response", response)
        return response

    def pump(self, timeout):
        self._adapter.check_cancelled()
        return self._rpc.pump(min(timeout, 2))

    def close(self):
        return self._rpc.close()


class Adapter:
    def __init__(self, config, *, core=None, runtime=None, binding=None, rpc_factory=None, cancel_event=None):
        self.cancel_event = cancel_event
        self.mutation_attempted = self.creation_attempted = self.prompt_attempted = False
        self.config = validate_config(config)
        transport_token = read_transport_token(self.config)
        root = self.config["gatewayRoot"]
        self.core = core or load_module(root, "gateway_core.py", "_whatsapp_gateway_core")
        self.runtime = runtime or load_module(root, "gateway_runtime.py", "_whatsapp_gateway_runtime")
        if binding is None:
            kwargs = {}
            if "expectedComputer" in self.config:
                kwargs["expected_computer"] = self.config["expectedComputer"]
            if self.config["host"] != "local":
                kwargs["expected_host"] = self.config["host"]
            try:
                binding = self.runtime.WindowsRuntimeBinding(self.config["bindingManifest"], **kwargs)
            except TypeError:
                raise WorkerError("gateway_runtime_upgrade_required", "The installed runtime verifier does not support an explicitly configured computer or host.") from None
            except self.runtime.RuntimeAdmissionError:
                raise WorkerError("owner_admission_failed", "The configured desktop/runtime binding is invalid for this computer.") from None
        self.binding = binding
        self.endpoint = binding.manifest["endpoint"]
        self.host = self.config["host"]
        if binding.manifest.get("host") != self.host:
            raise WorkerError("identity_mismatch", "Configured host differs from the runtime binding manifest.")
        def default_factory(endpoint):
            # Keep the original call shape for existing unauthenticated local
            # transports. The secret is never part of config, RPC or receipts.
            kwargs = {} if transport_token is None else {"bearer_token": transport_token}
            try:
                websocket = self.core._transport.WebSocket(endpoint, **kwargs)
            except TypeError:
                raise WorkerError("gateway_transport_upgrade_required", "The configured gateway transport does not support this authentication option; details suppressed.") from None
            return self.core._transport.Rpc(websocket)

        factory = rpc_factory or default_factory
        self.rpc_factory = lambda endpoint: CancellableRpc(factory(endpoint), self)
        self.destinations = self.config["destinations"]
        for destination in self.destinations:
            if destination.get("host") != self.host or destination.get("endpoint") != self.endpoint:
                raise WorkerError("identity_mismatch", "Every destination must use this host's verified runtime endpoint.")
        self.gateway(self.destinations)  # Validate explicit allowlists without connecting.

    def check_cancelled(self):
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise WorkerError("observer_cancelled", "Gateway observation stopped. The desktop session was not interrupted; reconcile the saved request before resending.",
                prompt_submitted=None if self.prompt_attempted else False, uncertain=self.mutation_attempted)

    def admit(self, destination):
        self.check_cancelled()
        proof = self.binding.verify(destination["thread_id"])
        if proof.get("host") != self.host or proof.get("endpoint") != self.endpoint:
            raise WorkerError("owner_admission_failed", "Runtime ownership proof differs from the configured host.")
        return proof

    def gateway(self, destinations):
        return self.core.Gateway(self.config["ledgerDir"], destinations, self.admit, rpc_factory=self.rpc_factory)

    def runtime_proof(self):
        self.check_cancelled()
        # No invented conversation ID: discovery admits the server itself.
        kwargs = {"computer": self.binding.computer}
        if "expectedComputer" in self.config:
            kwargs["expected_computer"] = self.config["expectedComputer"]
        if self.host != "local":
            kwargs["expected_host"] = self.host
        try:
            proof = self.runtime.verify_binding(self.binding.manifest,
                self.binding.snapshot_provider(self.binding.manifest), **kwargs)
        except self.runtime.RuntimeAdmissionError:
            raise WorkerError("owner_admission_failed", "A fresh ownership check could not verify the configured desktop and gateway backend.") from None
        if proof.get("verified") is not True or proof.get("host") != self.host or proof.get("endpoint") != self.endpoint:
            raise WorkerError("owner_admission_failed", "Runtime ownership proof does not match the selected host.")
        return proof

    def connect(self):
        proof = self.runtime_proof()
        rpc = self.rpc_factory(self.endpoint)
        try:
            rpc.initialize()
        except Exception:
            rpc.close()
            raise WorkerError("transport_unavailable", "The verified backend could not be reached; no prompt was sent.") from None
        return rpc, proof

    def workspace_allowed(self, workspace):
        canonical_workspace(workspace)
        roots = self.config.get("allowedWorkspaceRoots", [])
        return not roots or any(beneath(workspace, root) for root in roots)

    def require_workspace(self, workspace):
        if not self.workspace_allowed(workspace):
            raise WorkerError("workspace_not_allowed", "Selected workspace is outside the configured gateway roots.")

    def list_sessions(self, params):
        workspace = params.get("workspace")
        scope = params.get("scope", "workspace" if workspace else "all")
        if scope == "host":
            scope = "all"
        if scope not in ("all", "workspace"):
            raise WorkerError("invalid_request", "Session scope must be all or workspace.")
        if scope == "workspace":
            self.require_workspace(workspace)
        limit = params.get("limit", 2000)
        if type(limit) is not int or not 1 <= limit <= 10000:
            raise WorkerError("invalid_request", "Session limit must be between 1 and 10000.")
        rpc, _ = self.connect()
        try:
            result, cursor, seen, ids = [], None, set(), set()
            for _ in range(100):
                request = {"limit": 100, "archived": False, "useStateDbOnly": True}
                if cursor:
                    request["cursor"] = cursor
                page = rpc.request("thread/list", request)
                if not isinstance(page.get("data"), list):
                    raise WorkerError("invalid_history", "Backend returned an invalid session list.")
                for thread in page["data"]:
                    thread_id, cwd = thread.get("id"), thread.get("cwd")
                    if not isinstance(thread_id, str) or not thread_id or not isinstance(cwd, str) or not cwd:
                        continue
                    if thread_id in ids:
                        continue
                    ids.add(thread_id)
                    if not self.workspace_allowed(cwd):
                        continue
                    if scope == "workspace" and canonical_workspace(cwd) != canonical_workspace(workspace):
                        continue
                    explicit = next((d for d in self.destinations if d["thread_id"] == thread_id), None)
                    eligible = bool(explicit or self.config.get("allowSelectedSessions"))
                    result.append({key: thread.get(key) for key in ("id", "name", "cwd", "updatedAt", "status")})
                    result[-1]["gatewayEligible"] = eligible
                    if len(result) >= limit:
                        return result
                cursor = page.get("nextCursor")
                if not cursor:
                    return result
                if cursor in seen:
                    raise WorkerError("invalid_history", "Backend repeated a session-list cursor.")
                seen.add(cursor)
            raise WorkerError("inspection_bound_exceeded", "Session discovery exceeded its pagination bound.")
        finally:
            rpc.close()

    def request_id(self, params):
        request_id = params.get("requestId")
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
            raise WorkerError("invalid_request_id", "A stable requestId of 5-96 safe characters is required.")
        return request_id

    def selected_destination(self, params):
        thread_id, workspace = params.get("threadId"), params.get("workspace")
        if not isinstance(thread_id, str) or not thread_id:
            raise WorkerError("invalid_request", "An exact existing threadId is required.")
        self.require_workspace(workspace)
        explicit = next((d for d in self.destinations if d["thread_id"] == thread_id), None)
        if explicit:
            if canonical_workspace(explicit["cwd"]) != canonical_workspace(workspace):
                raise WorkerError("identity_mismatch", "Selected workspace differs from the configured exact session.")
            return explicit
        if not self.config.get("allowSelectedSessions"):
            raise WorkerError("destination_not_allowed", "This session is not allowlisted and selected-session access is disabled.")
        request_id = self.request_id(params)
        bindings = Path(self.config["ledgerDir"]) / "selected-sessions"
        path = bindings / (request_id + ".json")
        with self.core.FileLock(bindings, request_id):
            if path.exists():
                saved = read_json(path)
                destination = saved["destination"]
                if (destination.get("thread_id") != thread_id or destination.get("host") != self.host or
                        destination.get("endpoint") != self.endpoint or
                        canonical_workspace(destination.get("cwd")) != canonical_workspace(workspace) or
                        saved.get("sender") != self.config["sender"] or saved.get("workflow") != self.config["workflow"]):
                    raise WorkerError("request_id_collision", "This request ID is already bound to a different exact destination or principal.")
                return destination
            rpc, _ = self.connect()
            try:
                thread = rpc.request("thread/read", {"threadId": thread_id, "includeTurns": False})["thread"]
            finally:
                rpc.close()
            if thread.get("id") != thread_id or canonical_workspace(thread.get("cwd")) != canonical_workspace(workspace):
                raise WorkerError("identity_mismatch", "The live session ID or workspace differs from the selection.")
            if not isinstance(thread.get("name"), str) or not thread["name"].strip():
                raise WorkerError("session_name_required", "Name this existing session in Codex before using the gateway; its exact identity must be verifiable.")
            destination = {"host": self.host, "thread_id": thread_id, "title": thread["name"],
                "cwd": thread["cwd"], "endpoint": self.endpoint,
                "allowed_senders": [self.config["sender"]["id"]], "allowed_workflows": [self.config["workflow"]]}
            baseline = self.config.get("settingsBaselines", {}).get(thread_id)
            if baseline is not None:
                destination["settings_baseline"] = baseline
            self.gateway([destination])
            self.core._transport.atomic_json(path, {"destination": destination,
                "sender": self.config["sender"], "workflow": self.config["workflow"]})
            return destination

    def send_prompt(self, params, emit, *, destination=None, _creation=None):
        request_id = self.request_id(params)
        prompt = params.get("prompt")
        self.core.public_text(prompt)
        destination = destination or self.selected_destination(params)
        gateway = self.gateway([destination])
        emitted_turn = None

        def event(value):
            nonlocal emitted_turn
            turn_id = value.get("turn_id")
            if turn_id and turn_id != emitted_turn:
                emitted_turn = turn_id
                emit({"type": "turnStarted", "threadId": destination["thread_id"], "turnId": turn_id})
            if value.get("type") == "turn_completed":
                emit({"type": "turnCompleted", "threadId": destination["thread_id"], "turnId": turn_id,
                      "status": value.get("status")})

        deadline = time.monotonic() + self.config["observationTimeoutSeconds"]
        send = gateway.send
        handoff = {}
        if _creation is not None:
            send = getattr(gateway, "send_created", None)
            if not callable(send):
                raise WorkerError("first_turn_unsupported", "The installed gateway core does not support verified first-turn handoff.")
            rpc, response, proof = _creation
            handoff = {"rpc": rpc, "creation_response": response, "creation_proof": proof}
        receipt = send(request_id, self.host, destination["thread_id"], prompt,
            self.config["sender"], workflow=self.config["workflow"],
            timeout=min(5, max(0, deadline - time.monotonic())), on_event=event, **handoff)
        while True:
            if receipt.get("turn_id") and receipt["turn_id"] != emitted_turn:
                event({"turn_id": receipt["turn_id"]})
            if receipt.get("reply_complete"):
                replies = [r["text"] for r in receipt.get("replies", []) if r.get("phase") == "final_answer"]
                text = "\n\n".join(replies)
                text = re.sub(r"(?m)^[ \t]*ACK " + re.escape(request_id) + r"(?=$|[\s.,:;!?])[.,:;!?]?[ \t]*\n?", "", text).strip()
                return {"threadId": destination["thread_id"], "turnId": receipt.get("turn_id"),
                        "requestId": request_id, "replyText": text, "state": receipt["state"]}
            self.raise_receipt_error(receipt)
            self.check_cancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise WorkerError("reply_pending", "The prompt was delivered, but its final reply is still pending. Reconcile the saved request ID; do not resend it with a new ID.",
                    prompt_submitted=bool(receipt.get("attempted")), requestId=request_id, stage=receipt["state"])
            receipt = gateway.collect(request_id, timeout=min(5, remaining), on_event=event)

    def create_session(self, params, emit):
        # This marker is advisory for read-only status. It never authorizes a retry.
        request_id = self.request_id(params)
        path = Path(self.config["ledgerDir"]) / "created-sessions" / (request_id + ".json")
        # Keep a separate worker lock through first delivery, not just creation.
        # A competing status/retry must never label another live worker finished.
        with self.core.FileLock(path.parent, "worker-" + request_id):
            try:
                # The first turn uses this exact creation connection. Keep its
                # subscription alive through observation and any later handoff.
                with ExitStack() as creation_connections:
                    return self._create_session(params, emit, creation_connections)
            finally:
                if path.is_file():
                    journal = read_json(path)
                    journal["workerFinished"] = True
                    # A receipt, if present, is the authority for prompt outcome.
                    journal["promptAttemptedByWorker"] = self.prompt_attempted
                    self.core._transport.atomic_json(path, journal)

    def _create_session(self, params, emit, creation_connections):
        self.check_cancelled()
        if not self.config.get("allowCreateSessions"):
            raise WorkerError("creation_not_allowed", "New native sessions are disabled in this gateway's trusted configuration.")
        request_id = self.request_id(params)
        self.core.public_text(params.get("prompt"))
        workspace = params.get("workspace")
        self.require_workspace(workspace)
        permission = params.get("permissionLevel", "workspace-write")
        policies = {"read-only": ("never", "readOnly"),
                    "workspace-write": ("on-request", "workspaceWrite"),
                    "danger-full-access": ("never", "dangerFullAccess")}
        if permission not in policies:
            raise WorkerError("invalid_permissions", "New sessions require an explicit supported Codex permission level.")
        name = params.get("threadName") or ("WhatsApp " + request_id[:48])
        self.core.safe_label(name, "threadName")
        model = params.get("model")
        if model is not None:
            self.core.safe_label(model, "model")
        identity = {"requestId": request_id, "workspace": workspace, "name": name, "model": model,
                    "permissionLevel": permission, "prompt": params["prompt"], "host": self.host,
                    "sender": self.config["sender"], "workflow": self.config["workflow"]}
        digest = self.core.fingerprint(identity)
        directory = Path(self.config["ledgerDir"]) / "created-sessions"
        path = directory / (request_id + ".json")
        creation = None
        with self.core.FileLock(directory, request_id):
            if path.exists():
                journal = read_json(path)
                if journal.get("requestSha256") != digest:
                    raise WorkerError("request_id_collision", "This new-session request ID is already bound to different content or settings.")
                if journal.get("state") != "created":
                    raise WorkerError("creation_requires_review", "An earlier new-session attempt needs review. The gateway will not create a duplicate or submit a prompt.",
                        uncertain=journal.get("state") != "rejected", requestId=request_id, stage=journal.get("state"))
                destination = journal["destination"]
                if destination.get("endpoint") != self.endpoint:
                    raise WorkerError("destination_config_changed", "The created session belongs to a different recorded gateway endpoint.")
                journal["workerFinished"] = False
                self.core._transport.atomic_json(path, journal)
            else:
                if (Path(self.config["ledgerDir"]) / (request_id + ".json")).exists():
                    raise WorkerError("request_id_collision", "This request ID already has a delivery receipt; no new session will be created.")
                if not callable(getattr(self.gateway([]), "send_created", None)):
                    raise WorkerError("first_turn_unsupported", "Install a gateway core with verified first-turn handoff before creating new sessions.")
                rpc, proof = self.connect()
                creation_connections.callback(rpc.close)
                journal = {"schema": "codex-whatsapp-creation-v1", "requestId": request_id,
                           "requestSha256": digest, "state": "creation_attempted_outcome_uncertain",
                           "runtimeId": proof["runtime_id"], "promptSubmitted": False, "workerFinished": False}
                start_params = {"cwd": workspace, "sandbox": permission,
                                "approvalPolicy": policies[permission][0], "experimentalRawEvents": False}
                if model is not None:
                    start_params["model"] = model
                # Persist before the mutation. A missing response must never cause another creation.
                self.core._transport.atomic_json(path, journal)
                try:
                    response = rpc.request("thread/start", start_params)
                except WorkerError:
                    if not self.creation_attempted:
                        journal["state"] = "cancelled_before_creation"
                        self.core._transport.atomic_json(path, journal)
                    raise
                except self.core._transport.RpcError as exc:
                    if self.core.definitive_rpc_rejection(exc):
                        journal["state"] = "rejected"
                        self.core._transport.atomic_json(path, journal)
                    raise WorkerError("creation_rejected" if journal["state"] == "rejected" else "creation_uncertain",
                        "The backend did not confirm new-session creation. Inspect the creation journal before trying again.",
                        uncertain=journal["state"] != "rejected", requestId=request_id, stage=journal["state"]) from None
                except Exception:
                    raise WorkerError("creation_uncertain", "The new-session response was lost. Do not retry with a new request ID; a session may already exist.",
                        uncertain=True, requestId=request_id, stage=journal["state"]) from None
                thread = response.get("thread", {})
                journal["threadId"] = thread.get("id")
                journal["state"] = "created_unverified"
                self.core._transport.atomic_json(path, journal)
                if (not isinstance(thread.get("id"), str) or not thread["id"] or
                        canonical_workspace(thread.get("cwd")) != canonical_workspace(workspace) or
                        canonical_workspace(response.get("cwd")) != canonical_workspace(workspace) or
                        response.get("approvalPolicy") != policies[permission][0] or
                        response.get("sandbox", {}).get("type") != policies[permission][1] or
                        (model is not None and response.get("model") != model)):
                    raise WorkerError("new_session_settings_mismatch", "The new session's returned identity or permissions differ from the request. No prompt was sent.",
                        requestId=request_id, stage=journal["state"])
                # Only this newly returned session may be named. Never rename a selected existing task.
                journal["state"] = "naming_attempted_outcome_uncertain"
                self.core._transport.atomic_json(path, journal)
                try:
                    rpc.request("thread/name/set", {"threadId": thread["id"], "name": name})
                    current = rpc.request("thread/read", {"threadId": thread["id"], "includeTurns": False})["thread"]
                except Exception:
                    raise WorkerError("creation_naming_uncertain", "The new session exists, but its name could not be verified. No prompt was sent; inspect the creation journal.",
                        uncertain=True, requestId=request_id, stage=journal["state"]) from None
                if (current.get("id"), current.get("name"), current.get("cwd")) != (thread["id"], name, thread["cwd"]):
                    raise WorkerError("identity_mismatch", "The newly created session changed before delivery. No prompt was sent.", requestId=request_id)
                destination = {"host": self.host, "thread_id": thread["id"], "title": name,
                    "cwd": thread["cwd"], "endpoint": self.endpoint,
                    "allowed_senders": [self.config["sender"]["id"]], "allowed_workflows": [self.config["workflow"]]}
                # A baseline records what this creation returned; it never widens a later policy.
                effort = response.get("reasoningEffort")
                if effort is not None:
                    destination["settings_baseline"] = {"threadId": thread["id"], "settings": {
                        "model": response.get("model"), "effort": effort, "cwd": thread["cwd"],
                        "approvalPolicy": response["approvalPolicy"], "sandboxType": permission}}
                self.gateway([destination])
                journal.update({"state": "created", "destination": destination})
                self.core._transport.atomic_json(path, journal)
                creation = (rpc, response, proof)
        self.check_cancelled()
        return self.send_prompt({**params, "threadId": destination["thread_id"]}, emit,
                                destination=destination, _creation=creation)

    def raise_receipt_error(self, receipt):
        state = receipt.get("state", "unknown")
        attempted = bool(receipt.get("attempted"))
        details = {"requestId": receipt["request_id"], "stage": state}
        if receipt.get("requires_desktop_attention") or receipt.get("server_requests"):
            raise WorkerError("desktop_attention_required", "Codex requires attention in its desktop app. The gateway does not answer approval or user-input requests.",
                prompt_submitted=attempted, **details)
        if receipt.get("completion_status") in ("failed", "interrupted"):
            raise WorkerError("turn_" + receipt["completion_status"], "The destination turn did not complete successfully.", prompt_submitted=attempted, **details)
        if receipt.get("completion_status") == "completed":
            raise WorkerError("reply_not_correlated", "Codex completed without a verified correlated final reply. Inspect the saved request; do not resend it.", prompt_submitted=attempted, **details)
        if receipt.get("stream_error") or receipt.get("reconciliation_error"):
            raise WorkerError("observation_failed", "Reply observation was interrupted. Reconcile the saved request; the destination has not been stopped.",
                prompt_submitted=attempted, uncertain=not bool(receipt.get("persisted")), **details)
        if state in self.core.UNCERTAIN_STATES or not receipt.get("persisted") or receipt.get("collection_error"):
            error = receipt.get("error") or receipt.get("collection_error") or {}
            raise WorkerError(error.get("code", "delivery_unresolved"), error.get("message", "Delivery could not be confirmed. Reconcile the saved request before any new send."),
                prompt_submitted=attempted if not (state == "rejected") else False,
                uncertain=state in self.core.UNCERTAIN_STATES or (attempted and not receipt.get("persisted") and state != "rejected"), **details)

    def reconcile_request(self, params):
        """Read-only reconciliation: never subscribe, resume, start, steer or create."""
        request_id = self.request_id(params)
        receipt_path = Path(self.config["ledgerDir"]) / (request_id + ".json")
        if not receipt_path.is_file():
            creation_path = Path(self.config["ledgerDir"]) / "created-sessions" / (request_id + ".json")
            if creation_path.is_file():
                creation = read_json(creation_path)
                in_progress = creation.get("workerFinished") is not True
                result = {"requestId": request_id, "threadId": creation.get("threadId"),
                          "state": creation.get("state"), "inProgress": in_progress,
                          "deliveryUncertain": in_progress or creation.get("promptAttemptedByWorker") is True or creation.get("state") not in ("created", "rejected", "cancelled_before_creation"),
                          "completed": False, "replyText": "", "readOnly": True}
                if not in_progress and creation.get("promptAttemptedByWorker") is False:
                    result["promptSubmitted"] = False
                return result
            raise WorkerError("request_not_found", "No durable delivery or creation receipt exists for this request ID.")
        saved = read_json(receipt_path)
        identity = saved.get("destination", {})
        if (saved.get("sender") != self.config["sender"] or saved.get("workflow") != self.config["workflow"] or
                identity.get("host") != self.host or identity.get("endpoint") != self.endpoint):
            raise WorkerError("identity_mismatch", "The saved request belongs to another principal or host binding.")
        self.require_workspace(identity.get("cwd"))
        if params.get("threadId") is not None and params["threadId"] != identity.get("thread_id"):
            raise WorkerError("identity_mismatch", "Selected thread differs from the saved request.")
        if params.get("workspace") is not None and canonical_workspace(params["workspace"]) != canonical_workspace(identity["cwd"]):
            raise WorkerError("identity_mismatch", "Selected workspace differs from the saved request.")
        destination = next((d for d in self.destinations if d["thread_id"] == identity["thread_id"]), None)
        if destination is None:
            binding_path = Path(self.config["ledgerDir"]) / "selected-sessions" / (request_id + ".json")
            creation_path = Path(self.config["ledgerDir"]) / "created-sessions" / (request_id + ".json")
            record = read_json(binding_path if binding_path.is_file() else creation_path)
            destination = record.get("destination")
        if not isinstance(destination, dict) or destination.get("thread_id") != identity.get("thread_id"):
            raise WorkerError("identity_mismatch", "The original exact session binding is unavailable.")
        receipt = self.gateway([destination]).collect(request_id, timeout=0)
        replies = [r["text"] for r in receipt.get("replies", []) if r.get("phase") == "final_answer"]
        reply = "\n\n".join(replies) if receipt.get("reply_complete") else ""
        reply = re.sub(r"(?m)^[ \t]*ACK " + re.escape(request_id) + r"(?=$|[\s.,:;!?])[.,:;!?]?[ \t]*\n?", "", reply).strip()
        return {"requestId": request_id, "threadId": identity["thread_id"], "turnId": receipt.get("turn_id"),
                "state": "reply_complete" if receipt.get("reply_complete") else receipt["state"],
                "gatewayState": receipt["state"], "accepted": bool(receipt.get("accepted")),
                "persisted": bool(receipt.get("persisted")), "completed": bool(receipt.get("reply_complete")),
                "promptSubmitted": bool(receipt.get("attempted")) and receipt["state"] != "rejected",
                "replyText": reply, "requiresDesktopAttention": bool(receipt.get("requires_desktop_attention")),
                "deliveryUncertain": receipt["state"] in self.core.UNCERTAIN_STATES,
                "collectionError": receipt.get("collection_error") or receipt.get("reconciliation_error"), "readOnly": True}

    def dispatch(self, method, params, emit):
        if not isinstance(params, dict):
            raise WorkerError("invalid_request", "Request params must be an object.")
        if method == "list_sessions":
            return self.list_sessions(params)
        if method == "send_prompt":
            return self.send_prompt(params, emit)
        if method == "create_session":
            return self.create_session(params, emit)
        if method == "reconcile_request":
            return self.reconcile_request(params)
        if method == "status":
            if params.get("requestId") is not None:
                return self.reconcile_request(params)
            proof = self.runtime_proof()
            return {"ownerVerified": True, "runtimeId": proof["runtime_id"], "host": self.host,
                    "allowSelectedSessions": bool(self.config.get("allowSelectedSessions"))}
        raise WorkerError("unsupported_method", "The gateway worker does not support this operation.")


class JsonlOutput:
    def __init__(self, stream, request_id, cancel_event=None):
        self.stream, self.request_id = stream, request_id
        self.cancel_event = cancel_event
        self.lock = threading.Lock()
        self.stopped = threading.Event()

    def write(self, message):
        with self.lock:
            try:
                self.stream.write(json.dumps({"id": self.request_id, **message}, ensure_ascii=False) + "\n")
                self.stream.flush()
            except (BrokenPipeError, OSError):
                if self.cancel_event is not None:
                    self.cancel_event.set()
                raise

    def heartbeat(self):
        while not self.stopped.wait(10):
            try:
                self.write({"type": "heartbeat"})
            except (BrokenPipeError, OSError):
                self.stopped.set()


def read_request(stream):
    """Read the first line without a buffered-reader lock held at shutdown."""
    try:
        descriptor = stream.fileno()
    except (AttributeError, OSError):
        return stream.readline(MAX_INPUT + 1), None, b""
    data = b""
    while b"\n" not in data:
        chunk = os.read(descriptor, min(4096, MAX_INPUT + 1 - len(data)))
        if not chunk:
            break
        data += chunk
        if len(data) > MAX_INPUT:
            raise WorkerError("invalid_request", "Gateway request exceeds its input limit.")
    line, separator, remainder = data.partition(b"\n")
    return line.decode("utf-8"), descriptor, remainder if separator else b""


def watch_disconnect(descriptor, remainder, cancelled):
    """EOF or any explicit cancel control stops only this observer's work."""
    data = remainder
    try:
        while not cancelled.is_set():
            if data:
                # The protocol has one request. Further input is cancellation;
                # never interpret it as another model prompt or operation.
                cancelled.set()
                return
            data = os.read(descriptor, 4096)
            if not data:
                cancelled.set()
                return
    except OSError:
        cancelled.set()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    cancelled = threading.Event()
    output, worker, request, dispatched = JsonlOutput(sys.stdout, None, cancelled), None, None, False
    try:
        line, descriptor, remainder = read_request(sys.stdin)
        if len(line.encode("utf-8")) > MAX_INPUT:
            raise WorkerError("invalid_request", "Gateway request exceeds its input limit.")
        request = json.loads(line)
        if not isinstance(request, dict) or set(request) - {"id", "method", "params"} or "id" not in request:
            raise WorkerError("invalid_request", "Expected one JSONL request with id, method and params.")
        output.request_id = request["id"]
        if request.get("method") in ("send_prompt", "create_session") and descriptor is not None:
            threading.Thread(target=watch_disconnect, args=(descriptor, remainder, cancelled), daemon=True).start()
        worker = threading.Thread(target=output.heartbeat, daemon=True)
        worker.start()
        adapter = Adapter(read_json(args.config), cancel_event=cancelled)
        dispatched = request.get("method") in ("send_prompt", "create_session")
        result = adapter.dispatch(request.get("method"), request.get("params", {}),
            lambda event: output.write({"type": "event", "event": event}))
        output.stopped.set()
        if worker:
            worker.join()
        output.write({"type": "result", "result": result})
        return 0
    except WorkerError as exc:
        error = exc.error
    except Exception as exc:
        # Never leak provider bodies, prompts, credentials or host-local paths.
        error = {"code": "gateway_operation_failed", "message": "Gateway operation failed. Inspect the saved request before any resend.",
                 "retryable": False, "deliveryUncertain": dispatched}
        if not dispatched:
            error["promptSubmitted"] = False
        if hasattr(exc, "to_dict"):
            error.update(exc.to_dict())
    output.stopped.set()
    if worker:
        worker.join()
    if isinstance(request, dict) and isinstance(request.get("params"), dict):
        error.setdefault("requestId", request["params"].get("requestId"))
    try:
        output.write({"type": "error", "error": error})
    except (BrokenPipeError, OSError):
        pass  # Cleanup is complete; a disconnected parent cannot receive output.
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
