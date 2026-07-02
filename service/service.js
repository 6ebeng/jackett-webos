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
var Service = require('webos-service');
var path = require('path');
var fs = require('fs');
var os = require('os');
var child = require('child_process');

var SERVICE_ID = 'com.prowlarr.app.service';
var PORT = 9696;
var SCRIPT = path.join(__dirname, 'prowlarr-run.sh');

var service = new Service(SERVICE_ID);

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

function runDetached(args) {
	try {
		var p = child.spawn('sh', [SCRIPT].concat(args), { detached: true, stdio: 'ignore' });
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
		// Read the configured API key from config.xml
		try {
			var base = data.dataDir || '/media/developer/prowlarr';
			var cfg = fs.readFileSync(path.join(base, 'data', 'config.xml'), 'utf8');
			var m = cfg.match(/<ApiKey>([^<]*)<\/ApiKey>/);
			data.apiKey = m ? m[1] : '';
		} catch (e) {
			data.apiKey = '';
		}
		// Check if the autostart init script exists
		try {
			data.autostart = fs.existsSync('/var/lib/webosbrew/init.d/prowlarr');
		} catch (e) {
			data.autostart = false;
		}
		data.returnValue = true;
		cb(data);
	});
}

service.register('status', function (message) {
	readStatus(function (data) {
		message.respond(data);
	});
});

// Fire-and-forget actions: launch the detached script run and acknowledge at
// once. The front-end follows progress by polling "status".
function registerDetached(method, scriptArg, ackKey) {
	service.register(method, function (message) {
		runDetached([scriptArg]);
		var res = { returnValue: true };
		res[ackKey] = true;
		message.respond(res);
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

// List the Prowlarr releases available upstream (newest first) so the UI can
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

// Install a specific Prowlarr release (manual downgrade / version pin). The
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

// Keep the service resident. webOS shuts a JS service down as soon as it holds
// no active "activity" - the launcher logs "no active activities, exiting" and
// the process can die before (or between) Luna calls are delivered. Holding one
// activity open from startup keeps the service alive and responsive so the TV UI
// can reliably call status/start/stop and poll download progress.
function keepAlive() {
	try {
		service.activityManager.create('prowlarr-keepalive', function (activity) {
			// Intentionally never completed -> the service stays alive.
		});
	} catch (e) {
		// If activity creation is unavailable, fall back to a no-op timer so the
		// Node event loop at least stays alive within a single launch.
		setInterval(function () {}, 60000);
	}
}
keepAlive();
