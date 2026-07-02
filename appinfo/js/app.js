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
	var fastPollTimer = null;
	var fastPollUntil = 0;
	var firstUrl = null;
	var logsVisible = false;
	var wasRunning = false;
	var autostartOn = true;
	var autostartAvailable = true;
	var pickerOpen = false;
	var currentVersion = '';
	var updateAvailable = false;
	var lastStatus = {};
	// Action feedback: which button was pressed and a short lock window during
	// which the action buttons stay in a "loading" state, giving instant tap
	// feedback before the first status poll arrives. After the lock expires the
	// buttons follow the real server state, so nothing can get stuck greyed.
	var pendingBtnId = null;
	var clickLockUntil = 0;

	// Update the left-footer status tip. Null-safe in case the element is absent.
	function msg(text) {
		var el = $('msg');
		if (el) el.innerHTML = text || '';
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

	function addClass(btn, c) {
		if (btn && btn.className.indexOf(c) === -1) btn.className += ' ' + c;
	}

	function removeClass(btn, c) {
		if (btn) btn.className = btn.className.replace(new RegExp('\\s*' + c, 'g'), '');
	}

	function isDisabled(btn) {
		return !!btn && btn.className.indexOf('disabled') !== -1;
	}

	// Transitional server states where an action is already under way and the
	// action buttons must stay locked/greyed until it resolves.
	function isBusyState(st) {
		st = st || '';
		return st === 'downloading' || st === 'extracting' || st === 'fetching-deps' || st === 'starting' || st === 'stopping' || st === 'restarting';
	}

	// Drive the enabled/disabled + loading state of every action button from the
	// latest status, so e.g. Start greys out while running and Update greys out
	// when there is nothing to update.
	function updateButtons(s) {
		s = s || lastStatus || {};
		var running = !!s.running;
		// "locked" is a short window right after a tap so the pressed button shows
		// loading instantly. Once it expires the buttons follow the real server
		// state (running + transitional busy states), so nothing stays greyed if
		// an action silently fails to change anything.
		var locked = Date.now() < clickLockUntil;
		// Release the lock early once the pressed action has visibly taken effect,
		// so e.g. Stop greys out the moment the server is actually down instead of
		// staying in the loading state for the rest of the window. Start/Stop are
		// unambiguous (the server only toggles up/down), so this is always safe.
		if (locked && pendingBtnId === 'btnStop' && !running) locked = false;
		if (locked && pendingBtnId === 'btnStart' && running) locked = false;
		if (!locked) clickLockUntil = 0;
		var busy = isBusyState(s.state) || locked;
		if (!busy) pendingBtnId = null;

		setBtnDisabled($('btnStart'), running || busy);
		setBtnDisabled($('btnStop'), !running || busy);
		setBtnDisabled($('btnRestart'), !running || busy);
		setBtnDisabled($('btnSelectVersion'), busy);
		setBtnDisabled($('btnOpen'), !running);
		setBtnDisabled($('btnUpdate'), !updateAvailable || busy);
		setBtnDisabled($('btnAutostart'), !autostartAvailable || busy);

		// Highlight Update only when there is genuinely an update to apply.
		if (updateAvailable && !busy) addClass($('btnUpdate'), 'attention');
		else removeClass($('btnUpdate'), 'attention');

		// Pulse the pressed button while its action is in flight.
		var ids = ['btnStart', 'btnStop', 'btnRestart', 'btnUpdate', 'btnAutostart', 'btnSelectVersion'];
		for (var i = 0; i < ids.length; i++) removeClass($(ids[i]), 'loading');
		if (busy && pendingBtnId) addClass($(pendingBtnId), 'loading');
	}

	// Record the pressed button and open a short feedback window so the tap gives
	// instant loading feedback before the first status poll arrives.
	function beginAction(btnId, message) {
		pendingBtnId = btnId;
		clickLockUntil = Date.now() + 10000; // 10s bridge until a transitional state shows
		if (message) msg(message);
		updateButtons(lastStatus);
		startFastPoll();
	}

	// Poll rapidly while an action is in flight so the loading feedback ends the
	// moment the server actually toggles (start/stop), AND so the download progress
	// text keeps updating smoothly for the whole install (a version download is
	// ~95 MB / up to a minute+, far longer than the initial feedback window).
	// Stops once the action has settled and the server is no longer busy, or after
	// a generous safety cap.
	function startFastPoll() {
		fastPollUntil = Date.now() + 300000; // 5 min safety cap (covers a slow download)
		if (fastPollTimer) return;
		fastPollTimer = setInterval(function () {
			var busy = pendingBtnId || isBusyState(lastStatus && lastStatus.state);
			if (!busy || Date.now() > fastPollUntil) {
				clearInterval(fastPollTimer);
				fastPollTimer = null;
				return;
			}
			poll();
		}, 700);
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
		} else if (isBusyState(state)) {
			var labels = {
				downloading: 'Downloading',
				extracting: 'Extracting',
				'fetching-deps': 'Fetching deps',
				starting: 'Starting',
				stopping: 'Stopping',
				restarting: 'Restarting',
			};
			b.textContent = (labels[state] || 'Working') + '…';
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
		lastStatus = s;
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
		} else {
			$('autostart').textContent = 'Unavailable (needs rooted TV)';
			$('btnAutostart').textContent = 'Autostart: N/A';
		}
		var urls = s.accessUrls || [];
		firstUrl = urls.length ? urls[0] : null;
		$('urls').textContent = urls.length ? urls.join('    ') : 'http://<tv-ip>:' + (s.port || 9696);

		// Install/launch states are long-running (the ~95 MB download alone can
		// take a minute), so surface the live progress in the footer tip too.
		// Without this the footer keeps a stale line and the install looks stuck.
		var st = s.state || '';
		var installing = st === 'downloading' || st === 'extracting' || st === 'fetching-deps' || st === 'starting';
		if (st.indexOf('error') === 0) {
			msg('Failed: ' + st + ' — open <b>Logs</b> for details, then press <b>Start</b> to retry.');
		} else if (st === 'stopping') {
			msg('Stopping Prowlarr…');
		} else if (st === 'restarting') {
			msg('Restarting Prowlarr…');
		} else if (installing && !s.running) {
			msg('Installing Prowlarr… please wait, this can take a minute.');
		} else if (s.running) {
			msg('Running. Manage Prowlarr from any device at the Access URL above.');
		} else {
			msg('Press <b>Start</b> to launch Prowlarr.');
		}

		updateButtons(s);
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
		if (fastPollTimer) {
			clearInterval(fastPollTimer);
			fastPollTimer = null;
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
			updateAvailable = !!avail;
			$('updatebadge').className = 'pill' + (avail ? '' : ' hidden');
			if (avail) {
				$('btnUpdate').textContent = 'Update to ' + r.latest;
				$('updatebadge').textContent = 'Update available (' + r.latest + ')';
				msg('A new Prowlarr version (<b>' + r.latest + '</b>) is available. Press <b>Update</b> to install.');
			} else {
				$('btnUpdate').textContent = 'Update server';
			}
			updateButtons(lastStatus);
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
		// Normalise: the service returns {tag, prerelease} objects, but tolerate a
		// plain-string list from an older service build (treated as stable).
		var list = [];
		var i, item, tag, pre;
		for (i = 0; i < versions.length; i++) {
			item = versions[i];
			if (item && typeof item === 'object') list.push({ tag: item.tag, prerelease: !!item.prerelease });
			else list.push({ tag: item, prerelease: false });
		}
		// The "Latest" chip belongs on the newest STABLE release (matches GitHub's
		// /releases/latest), not merely the first entry - which is often a develop
		// pre-release.
		var latestStable = '';
		for (i = 0; i < list.length; i++) {
			if (!list[i].prerelease) {
				latestStable = list[i].tag;
				break;
			}
		}
		var html = '';
		for (i = 0; i < list.length; i++) {
			tag = list[i].tag;
			pre = list[i].prerelease;
			var chips = '';
			if (tag === currentVersion) chips += '<span class="tag-note current-note">Installed</span>';
			if (tag === latestStable) chips += '<span class="tag-note latest-note">Latest</span>';
			if (pre) chips += '<span class="tag-note pre-note">Pre-release</span>';
			html +=
				'<button class="vitem' +
				(tag === currentVersion ? ' current' : '') +
				'" data-tag="' +
				escapeHtml(tag) +
				'">' +
				'<span class="vitem-tag">' +
				escapeHtml(tag) +
				'</span>' +
				chips +
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
		beginAction('btnSelectVersion', 'Installing Prowlarr <b>' + escapeHtml(tag) + '</b>… this downloads ~95&nbsp;MB and can take a minute.');
		svc('selectVersion', { version: tag }, poll);
		closeVersionPicker();
		setTimeout(checkUpdate, 60000);
	}

	function wire() {
		$('btnStart').onclick = function () {
			if (isDisabled($('btnStart'))) return;
			beginAction('btnStart', 'Starting… first launch downloads Prowlarr (~95&nbsp;MB), this can take a minute.');
			svc('start', {}, poll);
		};
		$('btnStop').onclick = function () {
			if (isDisabled($('btnStop'))) return;
			beginAction('btnStop', 'Stopping…');
			svc('stop', {}, poll);
		};
		$('btnRestart').onclick = function () {
			if (isDisabled($('btnRestart'))) return;
			beginAction('btnRestart', 'Restarting…');
			svc('restart', {}, poll);
		};
		$('btnUpdate').onclick = function () {
			if (isDisabled($('btnUpdate'))) return;
			beginAction('btnUpdate', 'Updating to the latest Prowlarr release…');
			svc('update', {}, poll);
			setTimeout(checkUpdate, 60000);
		};
		$('btnAutostart').onclick = function () {
			if (isDisabled($('btnAutostart'))) return;
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
		$('btnSelectVersion').onclick = function () {
			if (isDisabled($('btnSelectVersion'))) return;
			openVersionPicker();
		};
		$('btnVCancel').onclick = closeVersionPicker;
		$('btnOpen').onclick = function () {
			if (isDisabled($('btnOpen'))) return;
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
					},
				},
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
