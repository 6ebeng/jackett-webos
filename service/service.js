/*
 * Jackett control service for webOS.
 *
 * This is a thin Luna-bus wrapper around jackett-run.sh, which does the heavy
 * lifting (architecture detection, download, extraction, process supervision).
 * Long-running actions (start / install / update) are launched detached and the
 * front-end polls "status" to follow progress, so Luna calls never block.
 *
 * Written in ES5 for compatibility with the older Node runtimes shipped on
 * various webOS versions.
 */
/* eslint-disable */
var Service = require('webos-service');
var path = require('path');
var fs = require('fs');
var os = require('os');
var child = require('child_process');

var SERVICE_ID = 'com.jackett.app.service';
var PORT = 9117;
var SCRIPT = path.join(__dirname, 'jackett-run.sh');

// Firmware + webOS version are read once from the nyx os_info file and cached
// (they never change at runtime). null = not read yet.
var deviceInfoCache = null;

// Don't stay resident. Instead of holding an activity open forever, use the
// library's built-in idle timer: the UI polls every ~2s so the service stays
// alive and responsive while the app is open, then exits ~10s after the app
// closes - so there's nothing resident to kill at install/reinstall time. Long
// running work (download/start) already detaches via setsid, so it keeps running
// after the service exits and the UI picks progress back up on the next poll.
var service = new Service(SERVICE_ID, null, { idleTimer: 10 });

// Make sure the control script is executable after install.
try {
	fs.chmodSync(SCRIPT, parseInt('0755', 8));
} catch (e) {
	/* ignore */
}

function runScript(args, timeoutMs, cb) {
	child.execFile('sh', [SCRIPT].concat(args), { timeout: timeoutMs || 0, maxBuffer: 4 * 1024 * 1024 }, function (err, stdout, stderr) {
		cb(err, String(stdout || ''), String(stderr || ''));
	});
}

function accessUrls() {
	var urls = [];
	try {
		var ifaces = os.networkInterfaces();
		Object.keys(ifaces).forEach(function (name) {
			(ifaces[name] || []).forEach(function (i) {
				var v4 = i.family === 'IPv4' || i.family === 4;
				if (v4 && !i.internal && i.address && i.address.indexOf('169.254.') !== 0) {
					urls.push('http://' + i.address + ':' + PORT);
				}
			});
		});
	} catch (e) {
		/* ignore */
	}
	return urls;
}

function readStatus(cb) {
	runScript(['status'], 15000, function (err, stdout) {
		var data = { running: false, installed: false, state: 'unknown', port: PORT };
		var lines = stdout.trim().split('\n');
		var last = lines.length ? lines[lines.length - 1] : '';
		try {
			data = JSON.parse(last);
		} catch (e) {
			/* keep default */
		}
		data.accessUrls = accessUrls();
		// Read the configured API key from ServerConfig.json
		try {
			var base = data.dataDir || '/media/developer/Jackett';
			var cfg = fs.readFileSync(path.join(base, 'data', 'ServerConfig.json'), 'utf8');
			var cfgObj = JSON.parse(cfg); var m = [null, cfgObj.APIKey];
			data.apiKey = m ? m[1] : '';
		} catch (e) {
			data.apiKey = '';
		}
		// The control script already reports "autostart"/"canAutostart" in its
		// status JSON (it knows the correct init.d path and runs elevated), so we
		// trust those values here rather than re-probing from the jailed Node
		// context, which cannot reliably see /var/lib/webosbrew.
		if (typeof data.autostart === 'undefined') data.autostart = false;
		// Firmware (webos_manufacturing_version) + webOS version (webos_release),
		// read once from the nyx os_info file and cached.
		if (deviceInfoCache === null) {
			deviceInfoCache = { firmware: '', webosVersion: '' };
			try {
				var oi = JSON.parse(fs.readFileSync('/var/run/nyx/os_info.json', 'utf8'));
				deviceInfoCache.firmware = oi.webos_manufacturing_version || '';
				deviceInfoCache.webosVersion = oi.webos_release || '';
			} catch (e) {
				/* not a TV / file missing */
			}
		}
		data.firmware = deviceInfoCache.firmware;
		data.webosVersion = deviceInfoCache.webosVersion;
		data.returnValue = true;
		cb(data);
	});
}

service.register('status', function (message) {
	readStatus(function (data) {
		message.respond(data);
	});
});

// Fire-and-forget actions: the script itself backgrounds the real work (spawn_bg
// / setsid) and returns at once. We run it with runScript (execFile) rather than
// a bare detached spawn so the JS service stays alive until the background job
// has fully detached into its own session — otherwise webOS can tear the service
// down the instant we respond and kill the child before it survives on its own
// (which made Start/Restart/Update fire intermittently).
function registerDetached(method, scriptArg, ackKey) {
	service.register(method, function (message) {
		runScript([scriptArg], 20000, function () {
			var res = { returnValue: true };
			res[ackKey] = true;
			message.respond(res);
		});
	});
}

registerDetached('start', 'start', 'started');
registerDetached('install', 'install', 'installing');
registerDetached('update', 'update', 'updating');
registerDetached('restart', 'restart', 'restarting');

service.register('stop', function (message) {
	runScript(['stop'], 30000, function () {
		message.respond({ returnValue: true, stopped: true });
	});
});

service.register('getLogs', function (message) {
	var lines = (message.payload && message.payload.lines) || 200;
	runScript(['logs', String(lines)], 15000, function (err, stdout) {
		message.respond({ returnValue: true, log: stdout });
	});
});

service.register('checkUpdate', function (message) {
	runScript(['latest'], 20000, function (err, stdout) {
		var latest = String(stdout || '').trim();
		readStatus(function (data) {
			var installed = data.version || '';
			var avail = !!(latest && installed && latest !== installed);
			message.respond({ returnValue: true, installed: installed, latest: latest, updateAvailable: avail });
		});
	});
});

// List the Jackett releases available upstream (newest first) so the UI can
// offer a manual version picker for downgrades / compatibility fixes. Each line
// from the control script is "<tag>|<prerelease>"; we parse it into objects so
// the UI can flag pre-release and latest-stable builds.
service.register('listVersions', function (message) {
	runScript(['versions'], 30000, function (err, stdout) {
		var versions = String(stdout || '')
			.split('\n')
			.map(function (v) {
				return v.replace(/^\s+|\s+$/g, '');
			})
			.filter(function (v) {
				return v.length > 0;
			})
			.map(function (line) {
				var parts = line.split('|');
				return { tag: parts[0], prerelease: parts[1] === 'true' };
			});
		message.respond({ returnValue: true, versions: versions });
	});
});

// Install a specific Jackett release (manual downgrade / version pin). The
// control script self-backgrounds the download+restart, so we ack immediately
// and the front-end follows progress by polling "status".
service.register('selectVersion', function (message) {
	var version = (message.payload && message.payload.version) || '';
	if (!version) {
		message.respond({ returnValue: false, errorText: 'version is required' });
		return;
	}
	runScript(['select-version', String(version)], 15000, function () {
		message.respond({ returnValue: true, selecting: true, version: String(version) });
	});
});

// Called by the autostart hook (luna://.../autostart) at boot.
registerDetached('autostart', 'start', 'started');

service.register('enableAutostart', function (message) {
	runScript(['enable-autostart'], 15000, function () {
		message.respond({ returnValue: true, autostart: true });
	});
});

service.register('disableAutostart', function (message) {
	runScript(['disable-autostart'], 15000, function () {
		message.respond({ returnValue: true, autostart: false });
	});
});

// De-register the Luna name explicitly on every exit path. webOS's socket-close
// name-release detection is unreliable, so a dying service can leave its name
// held on ls-hubd - which blocks/confuses a reinstall (the webOS Dev Manager
// stops the old service first) and can keep a stale jailed instance around. By
// calling unregister() on the bus handle(s) we free the name immediately. Works
// for both security models: ACG exposes a single `handle`, the legacy model
// exposes `privateHandle` + `publicHandle`.
function deregister() {
	var handles = [service.handle, service.privateHandle, service.publicHandle];
	for (var i = 0; i < handles.length; i++) {
		var h = handles[i];
		if (h && typeof h.unregister === 'function') {
			try {
				h.unregister();
			} catch (e) {
				/* ignore */
			}
		}
	}
}

process.on('exit', deregister);
process.on('SIGTERM', function () {
	deregister();
	process.exit(0);
});
process.on('SIGINT', function () {
	deregister();
	process.exit(0);
});
