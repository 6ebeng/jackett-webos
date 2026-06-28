(function () {
  "use strict";

  var SERVICE = "com.prowlarr.app.service";
  var POLL_MS = 2000;

  function $(id) { return document.getElementById(id); }

  var pollTimer = null;
  var firstUrl = null;
  var logsVisible = false;
  var wasRunning = false;

  function msg(text) { $("msg").innerHTML = text || ""; }

  function svc(method, params, ok, fail, overrideService) {
    if (typeof window.lunaCall !== "function" || typeof window.PalmServiceBridge === "undefined") {
      msg("Not running on a webOS TV &mdash; service calls are unavailable in this preview.");
      if (fail) fail({});
      return;
    }
    window.lunaCall(overrideService || SERVICE, method, params || {}, {
      onSuccess: ok || function () {},
      onFailure: fail || function (e) { msg("Error: " + (e && (e.errorText || e.errorMessage) || "service call failed")); }
    });
  }

  function setBadge(running, state) {
    var b = $("badge");
    state = state || "";
    if (running) {
      b.textContent = "Running";
      b.className = "badge running";
    } else if (state.indexOf("error") === 0) {
      b.textContent = "Error";
      b.className = "badge error";
    } else if (state === "downloading" || state === "extracting" || state === "starting") {
      b.textContent = state.charAt(0).toUpperCase() + state.slice(1) + "…";
      b.className = "badge busy";
    } else {
      b.textContent = "Stopped";
      b.className = "badge stopped";
    }
  }

  function fmtMB(b) {
    var mb = b / 1048576;
    return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + " MB";
  }

  function render(s) {
    s = s || {};
    setBadge(s.running, s.state);

    var stateText = s.state || (s.running ? "running" : "stopped");
    var dl = (+s.downloadedBytes) || 0;
    var tot = (+s.totalBytes) || 0;
    if (s.state === "downloading") {
      if (tot > 0) {
        var pct = Math.max(0, Math.min(100, Math.round((dl / tot) * 100)));
        stateText = "downloading " + fmtMB(dl) + " / " + fmtMB(tot) + " (" + pct + "%)";
      } else if (dl > 0) {
        stateText = "downloading " + fmtMB(dl) + "…";
      } else {
        stateText = "downloading… (contacting GitHub)";
      }
    }
    $("state").textContent = stateText;
    $("version").textContent = s.version || "—";
    $("arch").textContent = s.arch || "—";
    $("datadir").textContent = s.dataDir || "—";    
    // Autostart status
    $("autostart").textContent = s.autostart ? "Enabled" : "Disabled";
    var urls = s.accessUrls || [];
    firstUrl = urls.length ? urls[0] : null;
    $("urls").textContent = urls.length ? urls.join("    ") : ("http://<tv-ip>:" + (s.port || 9696));

    if (s.running && !wasRunning) {
      wasRunning = true;
      svc("createToast", { message: "Prowlarr is now running!" }, null, null, "com.webos.notification");
    } else if (!s.running) {
      wasRunning = false;
    }

    if (s.state && s.state.indexOf("error") === 0) {
      msg("Failed: " + s.state + " — open <b>Logs</b> for details, then press <b>Start</b> to retry.");
    } else if (s.running) {
      msg("Running. Manage Prowlarr from any device at the Access URL above.");
    }
  }

  function poll() {
    svc("status", {}, render, function () {});
  }

  function startPolling() {
    poll();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_MS);
  }

  function toggleLogs() {
    logsVisible = !logsVisible;
    $("logwrap").className = "card" + (logsVisible ? "" : " hidden");
    if (logsVisible) {
      $("logs").textContent = "Loading…";
      svc("getLogs", { lines: 300 }, function (r) {
        $("logs").textContent = (r && r.log) ? r.log : "(log is empty)";
      });
    }
  }

  function wire() {
    $("btnStart").onclick = function () {
      msg("Starting… first launch downloads Prowlarr (~95&nbsp;MB), this can take a minute.");
      svc("start", {}, poll);
    };
    $("btnStop").onclick = function () { msg("Stopping…"); svc("stop", {}, poll); };
    $("btnRestart").onclick = function () { msg("Restarting…"); svc("restart", {}, poll); };
    $("btnUpdate").onclick = function () { msg("Updating to the latest Prowlarr release…"); svc("update", {}, poll); };
    $("btnLogs").onclick = toggleLogs;
    $("btnOpen").onclick = function () {
      if (firstUrl) { window.location.href = firstUrl; }
      else { msg("No network address yet — start the server first."); }
    };
  }

  function setupNav() {
    var btns = Array.prototype.slice.call(document.querySelectorAll(".btn"));
    var idx = 0;
    if (btns.length) btns[0].focus();

    document.addEventListener("keydown", function (e) {
      var k = e.keyCode;
      if (k === 37) { idx = (idx + btns.length - 1) % btns.length; btns[idx].focus(); e.preventDefault(); }       // left
      else if (k === 39) { idx = (idx + 1) % btns.length; btns[idx].focus(); e.preventDefault(); }                // right
      else if (k === 461 || k === 27) { if (logsVisible) { toggleLogs(); e.preventDefault(); } }                  // back
    });
  }

  window.addEventListener("load", function () {
    wire();
    setupNav();
    startPolling();
  });
})();
