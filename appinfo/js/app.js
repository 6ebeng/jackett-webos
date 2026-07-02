(function () {
	'use strict';

	var SERVICE = 'com.prowlarr.app.service';
	var POLL_MS = 2000;
	var LOG_LINES = 300;

	function $(id) {
		return document.getElementById(id);
	}

	var pollTimer = null;
	var updateTimer = null;
	var firstUrl = null;
	var logsVisible = false;
	var wasRunning = false;
	var autostartOn = true;
	var autostartAvailable = true;
	var pickerOpen = false;
	var currentVersion = '';

	function msg(text) {
		$('msg').innerHTML = text || '';
	}

	function escapeHtml(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	// Toggle a button's greyed-out/disabled visual state. Disabled buttons keep
	// keyboard focus (so remote navigation still works) but ignore activation.
	function setBtnDisabled(btn, disabled) {
		if (!btn) return;
		if (disabled) {
			if (btn.className.indexOf('disabled') === -1) btn.className += ' disabled';
		} else {
			btn.className = btn.className.replace(/\s*disabled/g, '');
		}
	}

	function svc(method, params, ok, fail, overrideService) {
		if (typeof window.lunaCall !== 'function' || typeof window.PalmServiceBridge === 'undefined') {
			msg('Not running on a webOS TV &mdash; service calls are unavailable in this preview.');
			if (fail) fail({});
			return;
		}
		window.lunaCall(overrideService || SERVICE, method, params || {}, {
			onSuccess: ok || function () {},
			onFailure:
				fail ||
				function (e) {
					msg('Error: ' + ((e && (e.errorText || e.errorMessage)) || 'service call failed'));
				},
		});
	}

	function setBadge(running, state) {
		var b = $('badge');
		state = state || '';
		if (running) {
			b.textContent = 'Running';
			b.className = 'badge running';
		} else if (state.indexOf('error') === 0) {
			b.textContent = 'Error';
			b.className = 'badge error';
		} else if (state === 'downloading' || state === 'extracting' || state === 'starting') {
			b.textContent = state.charAt(0).toUpperCase() + state.slice(1) + '…';
			b.className = 'badge busy';
		} else {
			b.textContent = 'Stopped';
			b.className = 'badge stopped';
		}
	}

	function fmtMB(b) {
		var mb = b / 1048576;
		return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
	}

	function render(s) {
		s = s || {};
		setBadge(s.running, s.state);

		var stateText = s.state || (s.running ? 'running' : 'stopped');
		var dl = +s.downloadedBytes || 0;
		var tot = +s.totalBytes || 0;
		if (s.state === 'downloading') {
			if (tot > 0) {
				var pct = Math.max(0, Math.min(100, Math.round((dl / tot) * 100)));
				stateText = 'downloading ' + fmtMB(dl) + ' / ' + fmtMB(tot) + ' (' + pct + '%)';
			} else if (dl > 0) {
				stateText = 'downloading ' + fmtMB(dl) + '…';
			} else {
				stateText = 'downloading… (contacting GitHub)';
			}
		}
		$('state').textContent = stateText;
		$('version').textContent = s.version || '—';
		currentVersion = s.version || '';
		$('arch').textContent = s.arch || '—';
		$('datadir').textContent = s.dataDir || '—';
		$('apikey').textContent = s.apiKey || '—';
		// Autostart status. Persistent autostart is provided by the Homebrew
		// Channel startup dir, which only exists on a ROOTED TV. Keep the button
		// enabled on rooted TVs; grey it out on non-rooted (Developer Mode only)
		// TVs where it cannot persist. Default to enabled if the field is absent
		// (older service builds) so behaviour is unchanged there.
		autostartOn = !!s.autostart;
		autostartAvailable = s.canAutostart !== false;
		if (autostartAvailable) {
			$('autostart').textContent = autostartOn ? 'Enabled' : 'Disabled';
			$('btnAutostart').textContent = 'Autostart: ' + (autostartOn ? 'On' : 'Off');
			setBtnDisabled($('btnAutostart'), false);
		} else {
			$('autostart').textContent = 'Unavailable (needs rooted TV)';
			$('btnAutostart').textContent = 'Autostart: N/A';
			setBtnDisabled($('btnAutostart'), true);
		}
		var urls = s.accessUrls || [];
		firstUrl = urls.length ? urls[0] : null;
		$('urls').textContent = urls.length ? urls.join('    ') : 'http://<tv-ip>:' + (s.port || 9696);

		if (s.state && s.state.indexOf('error') === 0) {
			msg('Failed: ' + s.state + ' — open <b>Logs</b> for details, then press <b>Start</b> to retry.');
		} else if (s.running) {
			msg('Running. Manage Prowlarr from any device at the Access URL above.');
		}
	}

	// Refresh the live log view while polling, preserving the user's scroll
	// position unless they are already pinned to the bottom (tail-follow).
	function refreshLogsLive() {
		var w = $('logwrap');
		var atBottom = w.scrollHeight - w.clientHeight <= w.scrollTop + 20;
		svc('getLogs', { lines: LOG_LINES }, function (r) {
			$('logs').textContent = r.log;
			if (atBottom || w.scrollTop === 0) w.scrollTop = w.scrollHeight;
		});
	}

	function poll() {
		svc(
			'status',
			{},
			function (s) {
				render(s);
				if (logsVisible) refreshLogsLive();
			},
			function () {},
		);
	}

	function startPolling() {
		poll();
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(poll, POLL_MS);
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	// webOS keeps a web app resident in the background after Home is pressed, and
	// its WebView does NOT throttle timers the way desktop browsers do. Left as-is
	// we would keep forking a fresh `prowlarr-run.sh status` (plus a log fetch) on
	// the TV every POLL_MS forever - a steady CPU/IO drain that stops the system
	// app-launcher from suspending us cleanly and makes the NEXT app the user opens
	// hang on launch. So suspend every background timer while hidden and resume
	// (with an immediate refresh) when the app is shown again.
	function isHidden() {
		return !!(document.hidden || document.webkitHidden || document.visibilityState === 'hidden');
	}

	function onForeground() {
		if (!pollTimer) startPolling();
		if (!updateTimer) {
			checkUpdate();
			updateTimer = setInterval(checkUpdate, 30 * 60 * 1000);
		}
	}

	function onBackground() {
		stopPolling();
		if (updateTimer) {
			clearInterval(updateTimer);
			updateTimer = null;
		}
	}

	// Bring the app window back to the foreground. With handlesRelaunch:false the
	// platform foregrounds us automatically, so this is normally a no-op - but it
	// also rescues any webOS build that delivers webOSRelaunch and then expects the
	// app to foreground ITSELF via PalmSystem.activate() (otherwise tapping the
	// tile while we are backgrounded does nothing).
	function activateApp() {
		try {
			if (window.PalmSystem && typeof window.PalmSystem.activate === 'function') {
				window.PalmSystem.activate();
			}
		} catch (e) {
			/* ignore */
		}
	}

	function onRelaunch() {
		activateApp();
		onForeground();
	}

	function setupVisibility() {
		function onVisibilityChange() {
			if (isHidden()) onBackground();
			else onForeground();
		}
		document.addEventListener('visibilitychange', onVisibilityChange, false);
		document.addEventListener('webkitvisibilitychange', onVisibilityChange, false);
		// webOS fires this when the tile is selected again while the app is still
		// resident in the background; make sure we come back to the foreground.
		document.addEventListener('webOSRelaunch', onRelaunch, false);
		// Belt-and-suspenders for older webOS WebViews that emit window focus/blur
		// (or pageshow/pagehide) but not the Page Visibility events.
		window.addEventListener('focus', onForeground, false);
		window.addEventListener('blur', onBackground, false);
		window.addEventListener('pageshow', onForeground, false);
		window.addEventListener('pagehide', onBackground, false);
	}

	function checkUpdate() {
		svc('checkUpdate', {}, function (r) {
			var avail = r && r.updateAvailable;
			$('updatebadge').className = 'pill' + (avail ? '' : ' hidden');
			$('btnUpdate').className = 'btn' + (avail ? ' attention' : '');
			if (avail) {
				$('btnUpdate').textContent = 'Update to ' + r.latest;
				$('updatebadge').textContent = 'Update available (' + r.latest + ')';
				msg('A new Prowlarr version (<b>' + r.latest + '</b>) is available. Press <b>Update</b> to install.');
			} else {
				$('btnUpdate').textContent = 'Update server';
			}
		});
	}

	function toggleLogs() {
		logsVisible = !logsVisible;
		$('logwrap').className = 'card' + (logsVisible ? '' : ' hidden');
		if (logsVisible) {
			$('logs').textContent = 'Loading…';
			svc('getLogs', { lines: LOG_LINES }, function (r) {
				$('logs').textContent = r && r.log ? r.log : '(log is empty)';
			});
		}
	}

	// --- Manual version picker (downgrade / compatibility) --------------------

	// The focusable elements inside the picker, in navigation order: the version
	// buttons first, then Cancel.
	function pickerItems() {
		var list = Array.prototype.slice.call(document.querySelectorAll('#vlist .vitem'));
		var cancel = $('btnVCancel');
		if (cancel) list.push(cancel);
		return list;
	}

	function renderVersions(versions) {
		var box = $('vlist');
		if (!versions || !versions.length) {
			box.innerHTML = '<div class="vempty">No releases found. Check the network connection and try again.</div>';
			return;
		}
		var latest = versions[0];
		var html = '';
		var i, v, note;
		for (i = 0; i < versions.length; i++) {
			v = versions[i];
			note = '';
			if (v === currentVersion) note = '<span class="tag-note current-note">Installed</span>';
			else if (v === latest) note = '<span class="tag-note">Latest</span>';
			html +=
				'<button class="vitem' +
				(v === currentVersion ? ' current' : '') +
				'" data-tag="' +
				escapeHtml(v) +
				'">' +
				escapeHtml(v) +
				note +
				'</button>';
		}
		box.innerHTML = html;
		var items = Array.prototype.slice.call(box.querySelectorAll('.vitem'));
		for (i = 0; i < items.length; i++) {
			(function (btn) {
				btn.onclick = function () {
					chooseVersion(btn.getAttribute('data-tag'));
				};
			})(items[i]);
		}
		if (items.length) items[0].focus();
	}

	function openVersionPicker() {
		pickerOpen = true;
		$('vpicker').className = 'overlay';
		$('vlist').innerHTML = 'Loading…';
		$('btnVCancel').focus();
		svc(
			'listVersions',
			{},
			function (r) {
				if (!pickerOpen) return;
				renderVersions(r && r.versions ? r.versions : []);
			},
			function () {
				if (!pickerOpen) return;
				$('vlist').innerHTML = '<div class="vempty">Could not load versions. Try again.</div>';
			},
		);
	}

	function closeVersionPicker() {
		pickerOpen = false;
		$('vpicker').className = 'overlay hidden';
		var sv = $('btnSelectVersion');
		if (sv) sv.focus();
	}

	function chooseVersion(tag) {
		if (!tag) return;
		if (tag === currentVersion) {
			msg('Prowlarr <b>' + escapeHtml(tag) + '</b> is already installed.');
			return;
		}
		msg('Installing Prowlarr <b>' + escapeHtml(tag) + '</b>… this downloads ~95&nbsp;MB and can take a minute.');
		svc('selectVersion', { version: tag }, poll);
		closeVersionPicker();
		setTimeout(checkUpdate, 60000);
	}

	function wire() {
		$('btnStart').onclick = function () {
			msg('Starting… first launch downloads Prowlarr (~95&nbsp;MB), this can take a minute.');
			svc('start', {}, poll);
		};
		$('btnStop').onclick = function () {
			msg('Stopping…');
			svc('stop', {}, poll);
		};
		$('btnRestart').onclick = function () {
			msg('Restarting…');
			svc('restart', {}, poll);
		};
		$('btnUpdate').onclick = function () {
			msg('Updating to the latest Prowlarr release…');
			svc('update', {}, poll);
			setTimeout(checkUpdate, 60000);
		};
		$('btnAutostart').onclick = function () {
			if (!autostartAvailable) {
				msg('Autostart needs a rooted TV with the Homebrew Channel. On a non-rooted TV, open the app manually after each reboot.');
				return;
			}
			if (autostartOn) {
				msg('Disabling autostart…');
				svc('disableAutostart', {}, poll);
			} else {
				msg('Enabling autostart…');
				svc('enableAutostart', {}, poll);
			}
		};
		$('btnLogs').onclick = toggleLogs;
		$('btnSelectVersion').onclick = openVersionPicker;
		$('btnVCancel').onclick = closeVersionPicker;
		$('btnOpen').onclick = function () {
			if (!firstUrl) {
				msg('No network address yet — start the server first.');
				return;
			}
			// Open the heavy Prowlarr web UI in the native browser rather than
			// replacing this app's view (which can exceed the TV app memory
			// limit and crash on some models). Different webOS versions accept
			// the URL under different param names, so send them all. If the
			// browser launch fails for any reason, fall back to navigating
			// in-app so the button always works on old and new firmwares.
			window.lunaCall(
				'com.webos.applicationManager',
				'launch',
				{ id: 'com.webos.app.browser', params: { target: firstUrl, url: firstUrl }, target: firstUrl },
				{
					onFailure: function () {
						window.location.href = firstUrl;
					}
				}
			);
		};
	}

	function setupNav() {
		var btns = Array.prototype.slice.call(document.querySelectorAll('.actions .btn'));
		var idx = 0;
		if (btns.length) btns[0].focus();

		document.addEventListener('keydown', function (e) {
			var k = e.keyCode;

			// While the version picker is open it owns navigation: up/down move
			// through the release list, back/esc close it.
			if (pickerOpen) {
				var items = pickerItems();
				var cur = document.activeElement;
				var ci = -1;
				for (var i = 0; i < items.length; i++) {
					if (items[i] === cur) {
						ci = i;
						break;
					}
				}
				if (k === 38) {
					ci = ci <= 0 ? items.length - 1 : ci - 1;
					if (items[ci]) items[ci].focus();
					e.preventDefault();
				} else if (k === 40) {
					ci = ci < 0 || ci >= items.length - 1 ? 0 : ci + 1;
					if (items[ci]) items[ci].focus();
					e.preventDefault();
				} else if (k === 461 || k === 27 || k === 8) {
					closeVersionPicker();
					e.preventDefault();
				}
				return;
			}

			if (k === 37) {
				idx = (idx + btns.length - 1) % btns.length;
				btns[idx].focus();
				e.preventDefault();
			} // left
			else if (k === 39) {
				idx = (idx + 1) % btns.length;
				btns[idx].focus();
				e.preventDefault();
			} // right
			else if (k === 461 || k === 27) {
				if (logsVisible) {
					toggleLogs();
					e.preventDefault();
				}
			} // back
		});
	}

	window.addEventListener('load', function () {
		wire();
		setupNav();
		setupVisibility();
		startPolling();
		checkUpdate();
		updateTimer = setInterval(checkUpdate, 30 * 60 * 1000);

		var xhr = new XMLHttpRequest();
		xhr.open('GET', 'appinfo.json', true);
		xhr.onload = function () {
			if (xhr.status === 200) {
				try {
					var info = JSON.parse(xhr.responseText);
					if (info.version) $('appversion').textContent = info.version;
				} catch (e) {}
			}
		};
		xhr.send();
	});
})();

