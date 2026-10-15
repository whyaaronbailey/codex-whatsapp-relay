"""Offline tests: no desktop, package cmdlet, native process inspection or backend."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name("desktop-owned-launch.py")
SPEC = importlib.util.spec_from_file_location("desktop_owned_launch", SOURCE)
launch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launch)


def proof(path):
    return {"path": str(path), "sha256": launch.sha(path)}


def process(pid, ticks, path, ppid=1):
    return {"pid": pid, "createdTicks": ticks, "path": str(path), "ppid": ppid, "name": Path(path).name}


def exact(value):
    return {key: value[key] for key in ("pid", "createdTicks", "path")}


class Clock:
    def __init__(self): self.value = 0
    def __call__(self): return self.value
    def sleep(self, seconds): self.value += seconds


class MockRuntime:
    def __init__(self, config, snapshots=None):
        self.config = config
        self.snapshots = list(snapshots or [{}])
        self.last = self.snapshots[-1]
        self.invocations = []
        self.launches = []
        self.accesses = 0
        self.loaded = []
        self.loaded_default = True
        self.listener = {config.get("oldBackend", {}).get("server", {}).get("pid", 55)}
        self.wrong_package = False
        self.no_result = False
        self.query_error = False
        self.launch_error = False

    def snapshot(self):
        if self.snapshots:
            self.last = self.snapshots.pop(0)
        return self.last

    def listener_owners(self, port): return self.listener

    def loaded_thread_count(self, backend):
        if self.query_error: raise OSError("fixture query failure")
        value = self.loaded.pop(0) if self.loaded else self.loaded_default
        return (0 if value else 1) if type(value) is bool else value

    def package_access(self, desktop):
        self.accesses += 1
        p = self.config["package"]
        return {"packageFullName": "wrong" if self.wrong_package else p["fullName"],
                "applicationUserModelId": p["familyName"] + "!" + p["appId"],
                "executeAccess": True, "accessHandleClosed": True}

    def create_desktop(self, config, manifest):
        self.launches.append(manifest["executable"])
        if self.launch_error: raise OSError("fixture ambiguous creation")
        return {"pid": 88, "createdTicks": 888, "path": config["oldDesktop"]["path"]}

    def invoke_package(self, config, request_path):
        self.invocations.append(request_path)
        if not self.no_result:
            launch.run_wrapper(request_path, self)
        return object()


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="desktop-launch-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        package = self.root / "OpenAI.Codex_1_x64__fixture" / "app"
        package.mkdir(parents=True)
        self.desktop = package / "ChatGPT.exe"
        self.desktop.write_bytes(b"synthetic desktop; never executed")
        self.old = process(10, 100, self.desktop)
        self.backend = process(55, 55, self.root / "real-cli.exe")
        self.files = {}
        for name in ("pythonw.exe", "shim.exe", "node.exe", "real-cli.exe", "bridge.mjs", "transport.py"):
            filename = self.root / name
            filename.write_bytes(("synthetic " + name).encode())
            self.files[name] = filename
        bridge_path = self.root / "shim.exe.json"
        bridge_path.write_text(json.dumps({"nodePath": str(self.files["node.exe"]), "realCliPath": str(self.files["real-cli.exe"]), "bridgePath": str(self.files["bridge.mjs"])}))
        self.manifest_path = self.root / "candidate-manifest.json"
        mapping = {"shim": self.files["shim.exe"], "bridge": self.files["node.exe"], "server": self.files["real-cli.exe"], "script": self.files["bridge.mjs"], "config": bridge_path}
        self.manifest = {"schema": "codex-desktop-owned-candidate-v1", "activated": False,
                         "executable": str(self.files["shim.exe"]), "configFile": str(bridge_path),
                         "expectedHashes": {key: launch.sha(value) for key, value in mapping.items()},
                         "files": [proof(value) for value in mapping.values()]}
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.config = {"schema": launch.SCHEMA, "computerName": "FIXTURE", "oldDesktop": exact(self.old),
                       "desktopSha256": launch.sha(self.desktop), "candidateManifest": proof(self.manifest_path),
                       "pythonw": proof(self.files["pythonw.exe"]), "source": proof(SOURCE),
                       "package": {"fullName": package.parent.name, "familyName": "OpenAI.Codex_fixture", "appId": "App"},
                       "expectedOtherFiles": [], "stateDir": str(self.root / "state"), "cwd": str(self.root),
                       "managerDisabledAcknowledged": True, "waitSeconds": 1, "pollSeconds": .05, "invocationWaitSeconds": 1}
        self.config_path = self.root / "launch-config.json"
        self.save()
        self.clock = Clock()
        self.env = patch.dict(os.environ, {"COMPUTERNAME": "FIXTURE"})
        self.env.start(); self.addCleanup(self.env.stop)

    def save(self): self.config_path.write_text(json.dumps(self.config))

    def arm(self, runtime):
        return launch.arm_and_wait(self.config, self.config_path, runtime, sleep=self.clock.sleep, clock=self.clock)

    def old_backend(self):
        self.config["oldBackend"] = {"endpoint": "ws://127.0.0.1:4501", "transportPath": str(self.files["transport.py"]),
                                     "pinnedSha256": launch.sha(self.files["transport.py"]), "server": exact(self.backend),
                                     "admissionClosedAcknowledged": True}
        self.save()

    def test_default_is_readonly_check_without_runtime(self):
        with patch.object(launch, "WindowsRuntime", side_effect=AssertionError("No process inspection on default check")), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(launch.main(["--config", str(self.config_path)]), 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "check_only")
        self.assertFalse(Path(self.config["stateDir"]).exists())

    def test_arm_requires_explicit_wait_and_matching_machine(self):
        for flags in (["--arm"], ["--wait"], ["--probe", "--arm", "--wait"]):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(launch.main(["--config", str(self.config_path), *flags]), 1)
        with self.assertRaisesRegex(launch.LaunchError, "wrong_computer"):
            launch.validate_config(self.config, computer="OTHER")
        self.assertFalse(Path(self.config["stateDir"]).exists())

    def test_changed_candidate_or_dependency_refuses_before_arming(self):
        self.files["bridge.mjs"].write_text("changed")
        with self.assertRaisesRegex(launch.LaunchError, "pin_mismatch_candidate_file"):
            self.arm(MockRuntime(self.config, [{10: self.old}]))
        self.assertFalse(Path(self.config["stateDir"]).exists())

    def test_manifest_hash_mapping_cannot_swap_pinned_files(self):
        self.manifest["expectedHashes"]["shim"] = self.manifest["expectedHashes"]["server"]
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.config["candidateManifest"] = proof(self.manifest_path)
        with self.assertRaisesRegex(launch.LaunchError, "candidate_hash_mapping_mismatch"):
            launch.validate_config(self.config)

    def test_initial_old_desktop_must_match_exact_birth_and_path(self):
        for old in ({}, {10: {**self.old, "createdTicks": 101}}, {10: {**self.old, "path": str(self.files["shim.exe"])}}):
            with self.assertRaisesRegex(launch.LaunchError, "old_desktop_not_exactly_present"):
                self.arm(MockRuntime(self.config, [old]))
        self.assertFalse(Path(self.config["stateDir"]).exists())

    def test_old_descendants_must_drain_and_new_descendants_are_tracked(self):
        tracker = launch.QuitTracker(exact(self.old))
        child = process(11, 110, self.files["real-cli.exe"], 10)
        grandchild = process(12, 120, self.files["node.exe"], 11)
        self.assertFalse(tracker.observe({10: self.old, 11: child}))
        self.assertFalse(tracker.observe({10: self.old, 11: child, 12: grandchild}))
        self.assertFalse(tracker.observe({12: grandchild}))
        self.assertTrue(tracker.observe({}))

    def test_new_desktop_and_pid_reuse_fail_closed(self):
        for replacement in (process(20, 200, self.desktop), {**self.old, "createdTicks": 200}):
            tracker = launch.QuitTracker(exact(self.old)); tracker.observe({10: self.old})
            with self.assertRaises(launch.LaunchError): tracker.observe({replacement["pid"]: replacement})

    def test_provably_newer_unrelated_pid_incarnation_retires_old_identity(self):
        tracker = launch.QuitTracker(exact(self.old)); tracker.observe({10: self.old})
        replacement = process(10, 200, self.files["node.exe"])
        self.assertTrue(tracker.observe({10: replacement}))
        launch.final_process_gate(self.config, list(tracker.tracked.values()), {10: replacement})
        with self.assertRaisesRegex(launch.LaunchError, "retired_identity_reappeared"):
            tracker.observe({10: self.old})

    def test_unreadable_pid_replacement_remains_ambiguous(self):
        tracker = launch.QuitTracker(exact(self.old)); tracker.observe({10: self.old})
        with self.assertRaisesRegex(launch.LaunchError, "tracked_process_replaced_or_unreadable"):
            tracker.observe({10: {"pid": 10, "ppid": 1, "name": "other.exe"}})

    def test_child_discovered_after_parent_exit_is_ambiguous(self):
        tracker = launch.QuitTracker(exact(self.old)); tracker.observe({10: self.old})
        with self.assertRaisesRegex(launch.LaunchError, "unobserved_descendant"):
            tracker.observe({11: process(11, 110, self.files["node.exe"], 10)})

    def test_live_manager_or_missing_ack_cannot_arm(self):
        self.config["managerDisabledAcknowledged"] = False
        with self.assertRaisesRegex(launch.LaunchError, "manager_disable_acknowledgment"):
            self.arm(MockRuntime(self.config, [{10: self.old}]))
        self.config["managerDisabledAcknowledged"] = True
        manager = process(90, 90, self.files["pythonw.exe"])
        self.config["oldManager"] = exact(manager); self.save()
        with self.assertRaisesRegex(launch.LaunchError, "old_manager_still_present"):
            self.arm(MockRuntime(self.config, [{10: self.old, 90: manager}]))
        self.assertFalse(Path(self.config["stateDir"]).exists())

    def test_normal_quit_launches_once_and_rearm_cannot_repeat(self):
        runtime = MockRuntime(self.config, [{10: self.old}, {10: self.old}, {}, {}, {}, {}])
        result = self.arm(runtime)
        self.assertEqual(result["status"], "success")
        self.assertEqual(len(runtime.invocations), 1); self.assertEqual(len(runtime.launches), 1)
        runtime.snapshots = [{10: self.old}]
        with self.assertRaisesRegex(launch.LaunchError, "already_armed_no_retry"):
            self.arm(runtime)
        self.assertEqual(len(runtime.launches), 1)
        with self.assertRaisesRegex(launch.LaunchError, "wrapper_already_completed"):
            launch.run_wrapper(runtime.invocations[0], runtime)

    def test_wait_timeout_is_durable_and_no_launch(self):
        runtime = MockRuntime(self.config, [{10: self.old}])
        with self.assertRaisesRegex(launch.LaunchError, "wait_deadline_no_launch"):
            self.arm(runtime)
        self.assertEqual(runtime.launches, [])
        self.assertTrue((Path(self.config["stateDir"]) / "wait-outcome.json").exists())

    def test_new_desktop_in_wrapper_race_blocks_launch(self):
        runtime = MockRuntime(self.config, [{10: self.old}, {}, {}, {20: process(20, 200, self.desktop)}])
        with self.assertRaisesRegex(launch.LaunchError, "package_wrapper_refused"):
            self.arm(runtime)
        self.assertEqual(len(runtime.invocations), 1); self.assertEqual(runtime.launches, [])

    def test_probe_proves_package_access_without_desktop_operation(self):
        runtime = MockRuntime(self.config)
        result = launch.invoke_once(self.config, self.config_path, "probe", [], runtime, sleep=self.clock.sleep, clock=self.clock)
        self.assertEqual(result["status"], "success")
        self.assertFalse(result["applicationExecuted"]); self.assertFalse(result["launchReserved"])
        self.assertEqual(runtime.accesses, 1); self.assertEqual(runtime.launches, [])
        self.assertFalse((Path(self.config["stateDir"]) / "arm-reservation.json").exists())

    def test_wrong_package_context_refuses_before_desktop_reservation(self):
        runtime = MockRuntime(self.config, [{10: self.old}, {}, {}, {}]); runtime.wrong_package = True
        with self.assertRaisesRegex(launch.LaunchError, "package_wrapper_refused"):
            self.arm(runtime)
        self.assertEqual(runtime.launches, [])
        self.assertFalse(runtime.invocations[0].with_name("desktop-launch-reservation.json").exists())

    def test_cmdlet_timeout_is_uncertain_and_never_reinvoked(self):
        runtime = MockRuntime(self.config, [{10: self.old}, {}, {}]); runtime.no_result = True
        with self.assertRaises(launch.LaunchError) as caught: self.arm(runtime)
        self.assertTrue(caught.exception.uncertain)
        self.assertEqual(caught.exception.code, "package_result_timeout_uncertain")
        runtime.snapshots = [{10: self.old}]
        with self.assertRaises(launch.LaunchError): self.arm(runtime)
        self.assertEqual(len(runtime.invocations), 1)

    def test_creation_exception_remains_reserved_and_uncertain(self):
        runtime = MockRuntime(self.config, [{10: self.old}, {}, {}, {}, {}]); runtime.launch_error = True
        with self.assertRaises(launch.LaunchError) as caught: self.arm(runtime)
        self.assertTrue(caught.exception.uncertain)
        self.assertEqual(len(runtime.launches), 1)
        self.assertTrue(runtime.invocations[0].with_name("desktop-launch-reservation.json").exists())

    def test_old_backend_is_gated_after_quit_and_busy_threads_wait(self):
        self.old_backend()
        alive = {10: self.old, 55: self.backend}; drained = {55: self.backend}
        runtime = MockRuntime(self.config, [alive, alive, drained]); runtime.loaded = [False, True, True]
        result = self.arm(runtime)
        self.assertEqual(result["status"], "success")
        self.assertEqual(runtime.loaded, []); self.assertEqual(len(runtime.launches), 1)

    def test_backend_busy_in_wrapper_race_does_not_launch(self):
        self.old_backend()
        runtime = MockRuntime(self.config, [{10: self.old, 55: self.backend}, {55: self.backend}])
        runtime.loaded = [True, False]
        with self.assertRaisesRegex(launch.LaunchError, "package_wrapper_refused"):
            self.arm(runtime)
        self.assertEqual(runtime.launches, [])

    def test_backend_wait_has_separate_long_deadline_and_durable_count(self):
        self.old_backend()
        self.config["oldBackendWaitSeconds"] = 2700
        self.config["pollSeconds"] = 30
        self.config["waitSeconds"] = 1
        self.save()
        runtime = MockRuntime(self.config, [{10: self.old, 55: self.backend}, {55: self.backend}])
        runtime.loaded = [7, 7, 0, 0]
        statuses = []
        original = self.clock.sleep
        def inspect_sleep(seconds):
            status = Path(self.config["stateDir"]) / "wait-status.json"
            if status.exists(): statuses.append(launch.load(status))
            original(seconds)
        result = launch.arm_and_wait(self.config, self.config_path, runtime, sleep=inspect_sleep, clock=self.clock)
        self.assertEqual(result["status"], "success")
        self.assertGreater(self.clock.value, self.config["waitSeconds"])
        self.assertEqual([item["remainingLoadedThreads"] for item in statuses], [7, 7])
        self.assertTrue(all(item["state"] == "waiting_for_old_backend_idle" for item in statuses))

    def test_nonempty_old_backend_times_out_without_package_invocation(self):
        self.old_backend(); self.config["oldBackendWaitSeconds"] = 2700; self.config["pollSeconds"] = 30; self.save()
        runtime = MockRuntime(self.config, [{10: self.old, 55: self.backend}, {55: self.backend}])
        runtime.loaded_default = False
        with self.assertRaisesRegex(launch.LaunchError, "old_backend_idle_deadline_no_launch"):
            self.arm(runtime)
        self.assertEqual(runtime.invocations, []); self.assertEqual(runtime.launches, [])
        self.assertEqual(launch.load(Path(self.config["stateDir"]) / "wait-status.json")["state"], "blocked")

    def test_backend_listener_replacement_and_query_failures_block(self):
        self.old_backend()
        for problem in ("pid", "listener", "query"):
            with self.subTest(problem=problem):
                runtime = MockRuntime(self.config, [{55: self.backend}])
                if problem == "pid": runtime.snapshots = [{55: {**self.backend, "createdTicks": 999}}]
                if problem == "listener": runtime.listener = {99}
                if problem == "query": runtime.query_error = True
                with self.assertRaises(launch.LaunchError): launch.old_backend_empty(self.config, runtime)
                self.assertEqual(runtime.launches, [])

    def test_desktop_child_environment_only_changes_three_public_overrides(self):
        captured = {}
        class FakeProcess:
            pid = 123; _handle = 456
        def spawn(args, **kwargs): captured.update(args=args, **kwargs); return FakeProcess()
        runtime = object.__new__(launch.WindowsRuntime)
        with patch.object(launch.subprocess, "Popen", side_effect=spawn), patch.object(launch.subprocess, "CREATE_NO_WINDOW", 0, create=True), patch.object(runtime, "_handle_identity", return_value={"createdTicks": 789, "path": str(self.desktop)}), patch.dict(os.environ, {"CODEX_APP_SERVER_WS_URL": "fixture", "CODEX_APP_SERVER_FORCE_CLI": "fixture", "CODEX_CLI_PATH": "old", "OPAQUE_FIXTURE": "keep"}):
            runtime.create_desktop(self.config, self.manifest)
        self.assertNotIn("CODEX_APP_SERVER_WS_URL", captured["env"])
        self.assertNotIn("CODEX_APP_SERVER_FORCE_CLI", captured["env"])
        self.assertEqual(captured["env"]["CODEX_CLI_PATH"], self.manifest["executable"])
        self.assertEqual(captured["env"]["OPAQUE_FIXTURE"], "keep")
        self.assertFalse(captured["shell"])


if __name__ == "__main__":
    unittest.main()
