/*
 * Prowlarr control service for webOS.
 *
 * This is a thin Luna-bus wrapper around prowlarr-run.sh, which does the heavy
 * lifting (architecture detection, download, extraction, process supervision).
 * Long-running actions (start / install / update) are launched detached and the
 * front-end polls "status" to follow progress, so Luna calls never block.
 *
 * Written in ES5 for compatibility with the older Node runtimes shipped on
 * various webOS versions.
 */
/* eslint-disable */
var Service = require("webos-service");
var path = require("path");
var fs = require("fs");
var os = require("os");
var child = require("child_process");

var SERVICE_ID = "com.prowlarr.app.service";
var PORT = 9696;
var SCRIPT = path.join(__dirname, "prowlarr-run.sh");

var service = new Service(SERVICE_ID);

// Make sure the control script is executable after install.
try { fs.chmodSync(SCRIPT, parseInt("0755", 8)); } catch (e) { /* ignore */ }

function runScript(args, timeoutMs, cb) {
  child.execFile(
    "sh",
    [SCRIPT].concat(args),
    { timeout: timeoutMs || 0, maxBuffer: 4 * 1024 * 1024 },
    function (err, stdout, stderr) {
      cb(err, String(stdout || ""), String(stderr || ""));
    }
  );
}

function runDetached(args) {
  try {
    var p = child.spawn("sh", [SCRIPT].concat(args), { detached: true, stdio: "ignore" });
    p.unref();
    return true;
  } catch (e) {
    return false;
  }
}

function accessUrls() {
  var urls = [];
  try {
    var ifaces = os.networkInterfaces();
    Object.keys(ifaces).forEach(function (name) {
      (ifaces[name] || []).forEach(function (i) {
        var v4 = i.family === "IPv4" || i.family === 4;
        if (v4 && !i.internal && i.address && i.address.indexOf("169.254.") !== 0) {
          urls.push("http://" + i.address + ":" + PORT);
        }
      });
    });
  } catch (e) { /* ignore */ }
  return urls;
}

function readStatus(cb) {
  runScript(["status"], 15000, function (err, stdout) {
    var data = { running: false, installed: false, state: "unknown", port: PORT };
    var lines = stdout.trim().split("\n");
    var last = lines.length ? lines[lines.length - 1] : "";
    try { data = JSON.parse(last); } catch (e) { /* keep default */ }
    data.accessUrls = accessUrls();
    // Check if the autostart init script exists
    try {
      data.autostart = fs.existsSync("/var/lib/webosbrew/init.d/prowlarr");
    } catch (e) {
      data.autostart = false;
    }
    data.returnValue = true;
    cb(data);
  });
}

service.register("status", function (message) {
  readStatus(function (data) { message.respond(data); });
});

service.register("start", function (message) {
  runDetached(["start"]);
  message.respond({ returnValue: true, started: true });
});

service.register("install", function (message) {
  runDetached(["install"]);
  message.respond({ returnValue: true, installing: true });
});

service.register("update", function (message) {
  runDetached(["update"]);
  message.respond({ returnValue: true, updating: true });
});

service.register("restart", function (message) {
  runDetached(["restart"]);
  message.respond({ returnValue: true, restarting: true });
});

service.register("stop", function (message) {
  runScript(["stop"], 30000, function () {
    message.respond({ returnValue: true, stopped: true });
  });
});

service.register("getLogs", function (message) {
  var lines = (message.payload && message.payload.lines) || 200;
  runScript(["logs", String(lines)], 15000, function (err, stdout) {
    message.respond({ returnValue: true, log: stdout });
  });
});

// Called by the autostart hook (luna://.../autostart) at boot.
service.register("autostart", function (message) {
  runDetached(["start"]);
  message.respond({ returnValue: true, started: true });
});

// Keep the service resident. webOS shuts a JS service down as soon as it holds
// no active "activity" - the launcher logs "no active activities, exiting" and
// the process can die before (or between) Luna calls are delivered. Holding one
// activity open from startup keeps the service alive and responsive so the TV UI
// can reliably call status/start/stop and poll download progress.
function keepAlive() {
  try {
    service.activityManager.create("prowlarr-keepalive", function (activity) {
      // Intentionally never completed -> the service stays alive.
    });
  } catch (e) {
    // If activity creation is unavailable, fall back to a no-op timer so the
    // Node event loop at least stays alive within a single launch.
    setInterval(function () {}, 60000);
  }
}
keepAlive();
