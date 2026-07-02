#!/bin/sh
#
# Prowlarr control script for webOS (POSIX sh / busybox compatible).
#
# Subcommands: install | start | stop | restart | update | status | logs |
#              datadir | latest | versions | select-version |
#              enable-autostart | disable-autostart
#
# It auto-detects a writable + exec-capable data directory, downloads the
# matching self-contained Prowlarr build from GitHub on first run, writes a
# minimal config.xml (bind to all interfaces, port 9696) and supervises the
# process via a pid file.
#
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
PORT=9696
REPO="Prowlarr/Prowlarr"
API_URL="https://api.github.com/repos/$REPO/releases/latest"
RELEASES_URL="https://api.github.com/repos/$REPO/releases?per_page=100"
UA="prowlarr-webos"
AUTOSTART_SRC="$SCRIPT_DIR/prowlarr-autostart"
AUTOSTART_DST="/var/lib/webosbrew/init.d/prowlarr"

# Locate the app's icon so toast notifications can show the Prowlarr logo. Prefer
# the white-background notification tile (icon-notify.png) so the logo stands out
# on the dark webOS toast; fall back to the standard app icon.
APP_ICON=""
for _ic in \
    "$SCRIPT_DIR/../../applications/com.prowlarr.app/icon-notify.png" \
    /media/developer/apps/usr/palm/applications/com.prowlarr.app/icon-notify.png \
    /media/cryptofs/apps/usr/palm/applications/com.prowlarr.app/icon-notify.png \
    "$SCRIPT_DIR/../../applications/com.prowlarr.app/icon.png" \
    /media/developer/apps/usr/palm/applications/com.prowlarr.app/icon.png \
    /media/cryptofs/apps/usr/palm/applications/com.prowlarr.app/icon.png; do
    if [ -f "$_ic" ]; then APP_ICON="$_ic"; break; fi
done

# --------------------------------------------------------------------------
# Pick a data directory that is both writable and allows execution.
# Falls back through several candidates so it works on retail, dev and rooted
# firmwares. Override with the PROWLARR_DATA environment variable.
# --------------------------------------------------------------------------
pick_datadir() {
    if [ -n "${PROWLARR_DATA:-}" ]; then
        if mkdir -p "$PROWLARR_DATA" 2>/dev/null; then echo "$PROWLARR_DATA"; return 0; fi
    fi
    # Prefer a data dir on the SAME media partition the app was installed to, so
    # the config/database live beside the app whether it came from the Content
    # Store (/media/cryptofs/apps/...) or a Homebrew/Developer install
    # (/media/developer/apps/...). SCRIPT_DIR is .../apps/usr/palm/services/... so
    # the leading /media/<root> is the install partition.
    _root=$(printf '%s' "$SCRIPT_DIR" | sed -n 's,^\(/media/[^/]*\)/apps/.*,\1,p')
    for d in ${_root:+"$_root/prowlarr"} /media/developer/prowlarr /media/cryptofs/prowlarr /home/root/prowlarr /media/internal/.prowlarr /tmp/prowlarr; do
        # Fast path: a dir validated on an earlier run keeps an .exec_ok marker.
        # Exec-capability is a static mount property, so while the marker (and the
        # dir) still exist and the dir is writable we skip the write/chmod/exec
        # probe entirely. Without this every status poll (every 2s) would create,
        # chmod and run a probe file - needless disk churn on the TV.
        if [ -f "$d/.exec_ok" ] && [ -w "$d" ]; then echo "$d"; return 0; fi
        mkdir -p "$d" 2>/dev/null || continue
        if ( echo x >"$d/.w" ) 2>/dev/null; then
            printf '#!/bin/sh\nexit 0\n' >"$d/.x" 2>/dev/null
            chmod +x "$d/.x" 2>/dev/null
            if "$d/.x" 2>/dev/null; then
                rm -f "$d/.w" "$d/.x" 2>/dev/null
                : >"$d/.exec_ok" 2>/dev/null
                echo "$d"; return 0
            fi
        fi
        rm -f "$d/.w" "$d/.x" 2>/dev/null
    done
    echo /tmp/prowlarr
}

DATA_DIR=$(pick_datadir)
APP_DIR="$DATA_DIR/app"
DATA_SUB="$DATA_DIR/data"
LOG="$DATA_DIR/prowlarr.log"
PIDFILE="$DATA_DIR/prowlarr.pid"
STATEFILE="$DATA_DIR/state"
BGPIDFILE="$DATA_DIR/bg.pid"
VERFILE="$DATA_DIR/version"
BIN="$APP_DIR/Prowlarr"
TGZ="$DATA_DIR/prowlarr.tar.gz"
PART="$DATA_DIR/prowlarr.tar.gz.part"
TOTALFILE="$DATA_DIR/total"
ARCHFILE="$DATA_DIR/arch"
LATESTFILE="$DATA_DIR/latest"
VERSIONSFILE="$DATA_DIR/versions"
WANTVERFILE="$DATA_DIR/.want_version"
mkdir -p "$DATA_DIR" "$DATA_SUB" "$DATA_DIR/tmp" 2>/dev/null

set_state() { echo "$1" >"$STATEFILE" 2>/dev/null; }

# Show a webOS toast with the Prowlarr logo (when the icon path is known).
notify() {
    _msg="$1"
    if [ -n "$APP_ICON" ]; then
        luna-send -n 1 -f luna://com.webos.notification/createToast \
            "{\"message\":\"$_msg\",\"iconUrl\":\"$APP_ICON\"}" >/dev/null 2>&1
    else
        luna-send -n 1 -f luna://com.webos.notification/createToast \
            "{\"message\":\"$_msg\"}" >/dev/null 2>&1
    fi
}

autostart_enabled() { [ -f "$AUTOSTART_DST" ]; }

# Persistent autostart is provided by the Homebrew Channel startup-script dir,
# which only exists on a ROOTED TV. On a non-rooted (Developer Mode only) TV
# that directory does not exist and cannot be created. Detect a rooted TV by
# the EXISTENCE of the Homebrew Channel dir rather than by write permission:
# the status query runs in the jailed (non-root) service context and cannot
# write to the root-owned init.d dir, even though autostart works once the
# app is installed elevated (rootRequired) via the Homebrew Channel.
can_autostart() {
    _d=$(dirname "$AUTOSTART_DST")
    # Fast path: already writable (elevated/root service context).
    if { [ -d "$_d" ] || mkdir -p "$_d" 2>/dev/null; } && [ -w "$_d" ]; then
        return 0
    fi
    # The status query runs in the jailed (non-root) service context, which
    # cannot see /var/lib/webosbrew - so on a rooted TV where the service has not
    # yet been elevated the button would wrongly grey out. The Homebrew Channel
    # service sits alongside ours under the SAME apps root and IS visible from the
    # jail, so treat its presence as the rooted-TV signal (autostart persists
    # once the app runs elevated via rootRequired).
    [ -d "$SCRIPT_DIR/../org.webosbrew.hbchannel.service" ] && return 0
    [ -d "$SCRIPT_DIR/../../applications/org.webosbrew.hbchannel" ] && return 0
    [ -d /var/lib/webosbrew/init.d ] || [ -d /var/lib/webosbrew ]
}

enable_autostart() {
    mkdir -p "$(dirname "$AUTOSTART_DST")" 2>/dev/null
    if [ -f "$AUTOSTART_SRC" ]; then
        cp "$AUTOSTART_SRC" "$AUTOSTART_DST" 2>/dev/null && chmod +x "$AUTOSTART_DST" 2>/dev/null
    fi
    autostart_enabled
}

disable_autostart() {
    rm -f "$AUTOSTART_DST" 2>/dev/null
    ! autostart_enabled
}

# Launch a long-running subcommand in its OWN session so it survives webOS
# tearing down the (short-lived) JS service after the Luna call returns.
spawn_bg() {
    if command -v setsid >/dev/null 2>&1; then
        setsid sh "$0" "$1" </dev/null >>"$LOG" 2>&1 &
    else
        nohup sh "$0" "$1" </dev/null >>"$LOG" 2>&1 &
    fi
}

detect_arch() {
    m=$(uname -m 2>/dev/null)
    case "$m" in
        x86_64|amd64)         echo "x64"; return 0 ;;
        armv7l|armv6l|armhf)  echo "arm"; return 0 ;;
    esac
    # aarch64 (or unknown): LG webOS reports a 64-bit kernel but typically runs a
    # 32-bit ARM userspace (image name "lib32-..."). Decide by the ELF class of a
    # real userspace binary (5th byte of the ELF header: 01 = 32-bit, 02 = 64-bit)
    # and only choose arm64 when the 64-bit dynamic loader actually exists.
    cls=$(od -An -tx1 -N5 /bin/sh 2>/dev/null | tr -d ' \n' | cut -c9-10)
    if [ "$cls" = "02" ] && { [ -e /lib/ld-linux-aarch64.so.1 ] || [ -e /lib64/ld-linux-aarch64.so.1 ]; }; then
        echo "arm64"
    else
        echo "arm"
    fi
}

# download <url> <dest>  -> tries curl, then wget, then the Node fallback.
# Timeouts abort only on a stalled connection (not on a slow-but-progressing
# large download), so a flaky network can never wedge us on "downloading".
download() {
    _u="$1"; _d="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fL --connect-timeout 30 --speed-limit 1024 --speed-time 60 \
             --retry 3 --retry-delay 3 -A "$UA" -o "$_d" "$_u" && return 0
    fi
    if command -v wget >/dev/null 2>&1; then
        wget -q -T 60 -O "$_d" "$_u" && return 0
    fi
    if command -v node >/dev/null 2>&1; then
        node "$SCRIPT_DIR/download.js" "$_u" "$_d" && return 0
    fi
    return 1
}

# fetch_apk <url> <file>: download an Alpine .apk (a gzip tarball) via download()
# and extract it into the current directory. Returns non-zero on any failure so
# the caller can stop with a clear error state instead of half-installing.
fetch_apk() {
    _url="$1"; _f="$2"
    download "$_url" "$_f" || return 1
    tar -xzf "$_f" 2>/dev/null || return 1
    rm -f "$_f" 2>/dev/null
    return 0
}

# Fetch the latest release tag from GitHub and cache it. Returns the cached
# value immediately if checked within the last hour, so polling stays cheap.
do_latest() {
    if [ -f "$LATESTFILE" ]; then
        _age=$(( $(date +%s) - $(date -r "$LATESTFILE" +%s 2>/dev/null || echo 0) ))
        if [ "$_age" -lt 3600 ]; then cat "$LATESTFILE"; return 0; fi
    fi
    _j="$DATA_DIR/release-check.json"
    if download "$API_URL" "$_j"; then
        _v=$(grep -o '"tag_name"[ ]*:[ ]*"[^"]*"' "$_j" | head -n1 | sed 's/.*"\([^"]*\)"$/\1/')
        rm -f "$_j" 2>/dev/null
        if [ -n "$_v" ]; then echo "$_v" >"$LATESTFILE"; echo "$_v"; return 0; fi
    fi
    cat "$LATESTFILE" 2>/dev/null
}

# List the available releases from GitHub (newest first), one per line as
# "<tag>|<prerelease>" (e.g. "v2.5.0.5422|true"), so the UI can offer a manual
# version picker and flag pre-release / latest builds. GitHub returns fields in
# a fixed order (tag_name before prerelease) so the Nth tag pairs with the Nth
# prerelease flag. Cached for an hour to keep repeated opens of the picker cheap.
do_versions() {
    if [ -f "$VERSIONSFILE" ] && grep -q '|' "$VERSIONSFILE" 2>/dev/null; then
        _age=$(( $(date +%s) - $(date -r "$VERSIONSFILE" +%s 2>/dev/null || echo 0) ))
        if [ "$_age" -lt 3600 ]; then cat "$VERSIONSFILE"; return 0; fi
    fi
    _j="$DATA_DIR/releases.json"
    if download "$RELEASES_URL" "$_j"; then
        _tags=$(grep -o '"tag_name"[ ]*:[ ]*"[^"]*"' "$_j" | sed 's/.*"\([^"]*\)"$/\1/')
        _pres=$(grep -o '"prerelease"[ ]*:[ ]*[a-z]*' "$_j" | sed 's/.*:[ ]*//')
        rm -f "$_j" 2>/dev/null
        if [ -n "$_tags" ]; then
            printf '%s\n' "$_tags" >"$DATA_DIR/.vt"
            printf '%s\n' "$_pres" >"$DATA_DIR/.vp"
            awk 'NR==FNR{t[FNR]=$0;next}{print t[FNR] "|" $0}' "$DATA_DIR/.vt" "$DATA_DIR/.vp" >"$VERSIONSFILE"
            rm -f "$DATA_DIR/.vt" "$DATA_DIR/.vp" 2>/dev/null
            cat "$VERSIONSFILE"
            return 0
        fi
    fi
    cat "$VERSIONSFILE" 2>/dev/null
}

is_running() {
    if command -v pgrep >/dev/null 2>&1; then
        _p=$(pgrep -f "$BIN" 2>/dev/null | head -n1)
        if [ -n "$_p" ]; then
            echo "$_p" > "$PIDFILE"
            return 0
        fi
        return 1
    fi
    # Fallback to pure PID file logic
    [ -f "$PIDFILE" ] || return 1
    _p=$(cat "$PIDFILE" 2>/dev/null)
    [ -n "$_p" ] || return 1
    kill -0 "$_p" 2>/dev/null
}

write_config() {
    cfg="$DATA_SUB/config.xml"
    if [ -f "$cfg" ]; then
        # Ensure API key is fixed at 1 on existing installs
        if grep -q "<ApiKey>" "$cfg"; then
            sed -i 's#<ApiKey>[^<]*</ApiKey>#<ApiKey>1</ApiKey>#' "$cfg"
        else
            sed -i 's#</Config>#  <ApiKey>1</ApiKey>\n</Config>#' "$cfg"
        fi
        return 0
    fi
    cat >"$cfg" <<EOF
<Config>
  <BindAddress>*</BindAddress>
  <Port>$PORT</Port>
  <UrlBase></UrlBase>
  <ApiKey>1</ApiKey>
  <EnableSsl>False</EnableSsl>
  <LaunchBrowser>False</LaunchBrowser>
  <AnalyticsEnabled>False</AnalyticsEnabled>
  <Branch>master</Branch>
  <UpdateMechanism>BuiltIn</UpdateMechanism>
  <InstanceName>Prowlarr (webOS)</InstanceName>
</Config>
EOF
}

# do_install [version]  -> installs the latest release, or a specific release
# tag when a version is given (manual downgrade / compatibility pick). A pinned
# version is fetched from the per-tag release endpoint, which has the same JSON
# shape as "latest", so the asset/size extraction below is shared.
do_install() {
    arch=$(detect_arch)
    _want="${1:-}"
    set_state "downloading"
    json="$DATA_DIR/release.json"
    rm -f "$PART" "$TOTALFILE" 2>/dev/null
    if [ -n "$_want" ]; then
        _api="https://api.github.com/repos/$REPO/releases/tags/$_want"
    else
        _api="$API_URL"
    fi
    if ! download "$_api" "$json"; then set_state "error:api"; return 1; fi

    # webOS runs a 32-bit ARM (armhf) userspace even on aarch64 kernels, so we
    # use the musl 32-bit ARM build and ship the matching Alpine libs below.
    url=$(grep -o '"https://[^"]*linux-musl-core-arm.tar.gz"' "$json" | head -n1 | tr -d '"')
    ver=$(grep -o '"tag_name"[ ]*:[ ]*"[^"]*"' "$json" | head -n1 | sed 's/.*"\([^"]*\)"$/\1/')
    if [ -z "$url" ]; then set_state "error:asset"; return 1; fi

    # Best-effort total download size (for the progress bar); ignored if missing.
    # The release JSON is minified, so isolate the substring up to this asset's
    # download URL and take the last "size" before it.
    prefix=$(grep -o '.*linux-musl-core-arm.tar.gz' "$json" 2>/dev/null)
    total=$(printf '%s' "$prefix" | grep -o '"size"[ ]*:[ ]*[0-9][0-9]*' | tail -n1 | grep -o '[0-9][0-9]*' | tail -n1)
    [ -n "$total" ] && echo "$total" >"$TOTALFILE"

    # Download to a .part file so do_status can report live byte progress.
    if ! download "$url" "$PART"; then set_state "error:download"; return 1; fi
    mv "$PART" "$TGZ" 2>/dev/null

    set_state "extracting"
    rm -rf "$APP_DIR.tmp"; mkdir -p "$APP_DIR.tmp"
    if ! ( gzip -dc "$TGZ" 2>/dev/null | tar -xf - -C "$APP_DIR.tmp" ) 2>/dev/null; then
        if ! tar -xzf "$TGZ" -C "$APP_DIR.tmp" 2>/dev/null; then set_state "error:extract"; return 1; fi
    fi
    # The downloaded tarball is no longer needed once extracted - delete it right
    # away to reclaim the ~90 MB before we fetch the runtime libraries.
    rm -f "$TGZ" "$PART" 2>/dev/null

    rm -rf "$APP_DIR"
    if [ -d "$APP_DIR.tmp/Prowlarr" ]; then
        mv "$APP_DIR.tmp/Prowlarr" "$APP_DIR"
    else
        mv "$APP_DIR.tmp" "$APP_DIR"
    fi
    rm -rf "$APP_DIR.tmp"
    
    # Fetch the Alpine musl runtime libraries the self-contained .NET build links
    # against, plus the musl loader. Go through download() (curl/wget/node with
    # timeouts) and fail fast with a clear state on any error, so a flaky mirror
    # surfaces as error:deps instead of a binary that only breaks later at launch.
    set_state "fetching-deps"
    cd "$APP_DIR" 2>/dev/null || { set_state "error:chdir"; return 1; }
    ALPINE_BASE="https://dl-cdn.alpinelinux.org/alpine/v3.20/main/armv7"
    fetch_apk "$ALPINE_BASE/musl-1.2.5-r3.apk" musl.apk || { set_state "error:deps"; return 1; }
    if [ ! -f lib/ld-musl-armhf.so.1 ] || ! mv lib/ld-musl-armhf.so.1 ./ld-musl.so; then
        set_state "error:deps"; return 1
    fi
    fetch_apk "$ALPINE_BASE/libstdc++-13.2.1_git20240309-r1.apk" libstdc.apk || { set_state "error:deps"; return 1; }
    fetch_apk "$ALPINE_BASE/libgcc-13.2.1_git20240309-r1.apk"    libgcc.apk   || { set_state "error:deps"; return 1; }
    fetch_apk "$ALPINE_BASE/libssl3-3.3.7-r0.apk"               libssl.apk    || { set_state "error:deps"; return 1; }
    fetch_apk "$ALPINE_BASE/libcrypto3-3.3.7-r0.apk"            libcrypto.apk || { set_state "error:deps"; return 1; }
    rm -f ./*.apk 2>/dev/null

    chmod +x "$BIN" "./ld-musl.so" 2>/dev/null
    if [ ! -x "$BIN" ] || [ ! -e ./ld-musl.so ]; then set_state "error:binmissing"; return 1; fi
    [ -n "$ver" ] && echo "$ver" >"$VERFILE"
    echo "$arch" >"$ARCHFILE"
    # Sweep every remaining download artefact so only the extracted app is kept:
    # the release metadata JSON and any partial/leftover archive in the data dir.
    rm -f "$json" "$PART" "$TGZ" "$DATA_DIR"/*.apk 2>/dev/null
    set_state "stopped"
    return 0
}

do_start() {
    if is_running; then set_state "running"; return 0; fi
    # Reinstall if missing or if the previously installed arch no longer matches
    # (e.g. an earlier build downloaded the wrong arm64 binary).
    want=$(detect_arch)
    have=$(cat "$ARCHFILE" 2>/dev/null)
    if [ ! -x "$BIN" ] || [ "$want" != "$have" ]; then do_install || return 1; fi
    write_config
    set_state "starting"
    cd "$APP_DIR" 2>/dev/null || { set_state "error:chdir"; return 1; }
    nohup env -i \
        DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
        DOTNET_CLI_TELEMETRY_OPTOUT=1 \
        DOTNET_gcServer=0 \
        COMPlus_gcServer=0 \
        PATH=/usr/bin:/bin \
        TMPDIR="$DATA_DIR/tmp" HOME="$DATA_DIR" XDG_CONFIG_HOME="$DATA_DIR" \
        LD_LIBRARY_PATH="$APP_DIR/usr/lib:$APP_DIR/lib" \
        "$APP_DIR/ld-musl.so" "$BIN" -nobrowser -data="$DATA_SUB" >>"$LOG" 2>&1 &
    
    # Wait for the program to bind (can take a few seconds on slow TVs)
    i=0
    while [ $i -lt 15 ]; do
        sleep 1
        if is_running; then
            set_state "running"
            _ver=$(cat "$VERFILE" 2>/dev/null)
            if [ -n "$_ver" ]; then
                notify "Prowlarr $_ver is running"
            else
                notify "Prowlarr is running"
            fi
            return 0
        fi
        i=$((i + 1))
    done
    
    set_state "error:launch"
    return 1
}

# Kill the running Prowlarr process (no state changes) and wait for the port to
# be released. Shared by do_stop and _restart so restart can show a distinct
# "restarting" state instead of momentarily reporting "stopping".
_kill_proc() {
    if [ -f "$PIDFILE" ]; then
        _p=$(cat "$PIDFILE" 2>/dev/null)
        if [ -n "$_p" ]; then
            kill "$_p" 2>/dev/null
            i=0
            while kill -0 "$_p" 2>/dev/null; do
                i=$((i + 1)); [ "$i" -ge 10 ] && break
                sleep 1
            done
            kill -9 "$_p" 2>/dev/null
        fi
        rm -f "$PIDFILE"
    fi
    if command -v pkill >/dev/null 2>&1; then pkill -f "$BIN" 2>/dev/null; fi
    # Wait until the binary is fully gone so the port (9696) is released before
    # any subsequent start, otherwise restart hits "address already in use".
    i=0
    while is_running; do
        pkill -9 -f "$BIN" 2>/dev/null
        i=$((i + 1)); [ "$i" -ge 10 ] && break
        sleep 1
    done
    # Brief grace period for the TCP socket to flush out of TIME_WAIT.
    sleep 1
}

do_stop() {
    # Only advertise "stopping" when there is actually something to stop, so a
    # stop issued against an already-stopped server doesn't flash a busy badge.
    if is_running || [ -f "$PIDFILE" ]; then set_state "stopping"; fi
    _kill_proc
    set_state "stopped"
    return 0
}

do_status() {
    if is_running; then r=true; else r=false; fi
    if [ -x "$BIN" ]; then ins=true; else ins=false; fi
    st=$(cat "$STATEFILE" 2>/dev/null); [ -z "$st" ] && st="idle"
    # Reconcile a stale state file: if the process is gone but the last recorded
    # state still says "running", report it as stopped so the UI doesn't show a
    # stopped server with a "running" state (which confused the action buttons).
    if [ "$r" = "false" ] && [ "$st" = "running" ]; then st="stopped"; fi
    # Reconcile stale TRANSITIONAL states. A background install/start/stop can be
    # killed mid-flight (e.g. the TV drops to standby during a version download),
    # leaving the state file stuck on "downloading"/"starting"/etc forever. If the
    # worker process that owns the transition is no longer alive, fall back to a
    # settled state so the badge stops showing "Downloading…" indefinitely.
    case "$st" in
        downloading | extracting | fetching-deps | starting | stopping | restarting)
            if [ "$r" = "true" ]; then
                st="running"
            else
                _bg=$(cat "$BGPIDFILE" 2>/dev/null)
                if [ -z "$_bg" ] || ! kill -0 "$_bg" 2>/dev/null; then
                    st="stopped"
                fi
            fi
            ;;
    esac
    ver=$(cat "$VERFILE" 2>/dev/null)
    arch=$(detect_arch)

    dlb=0
    if [ -f "$PART" ]; then dlb=$(wc -c <"$PART" 2>/dev/null | tr -d ' '); fi
    if [ "${dlb:-0}" = "0" ] && [ -f "$TGZ" ]; then dlb=$(wc -c <"$TGZ" 2>/dev/null | tr -d ' '); fi
    [ -z "$dlb" ] && dlb=0
    tot=0
    if [ -f "$TOTALFILE" ]; then tot=$(cat "$TOTALFILE" 2>/dev/null | tr -d ' '); fi
    [ -z "$tot" ] && tot=0

    if autostart_enabled; then as=true; else as=false; fi
    if can_autostart; then ca=true; else ca=false; fi
    printf '{"running":%s,"installed":%s,"state":"%s","version":"%s","arch":"%s","port":%s,"downloadedBytes":%s,"totalBytes":%s,"dataDir":"%s","autostart":%s,"canAutostart":%s}\n' \
        "$r" "$ins" "$st" "$ver" "$arch" "$PORT" "$dlb" "$tot" "$DATA_DIR" "$as" "$ca"
}

case "${1:-}" in
    start)    spawn_bg _start ;;
    install)  spawn_bg _install ;;
    update)   spawn_bg _update ;;
    restart)  spawn_bg _restart ;;
    stop)     do_stop ;;
    status)   do_status ;;
    logs)     tail -n "${2:-200}" "$LOG" 2>/dev/null ;;
    datadir)  echo "$DATA_DIR" ;;
    latest)   do_latest ;;
    versions) do_versions ;;
    select-version) echo "${2:-}" >"$WANTVERFILE" 2>/dev/null; spawn_bg _install_version ;;
    enable-autostart)  enable_autostart && echo "enabled" || echo "failed" ;;
    disable-autostart) disable_autostart && echo "disabled" || echo "failed" ;;
    _start)   echo $$ >"$BGPIDFILE" 2>/dev/null; do_start ;;
    _install) echo $$ >"$BGPIDFILE" 2>/dev/null; do_install ;;
    _restart) echo $$ >"$BGPIDFILE" 2>/dev/null; set_state "restarting"; _kill_proc; do_start ;;
    _update)  echo $$ >"$BGPIDFILE" 2>/dev/null; do_stop; do_install && do_start ;;
    _install_version) echo $$ >"$BGPIDFILE" 2>/dev/null; do_stop; do_install "$(cat "$WANTVERFILE" 2>/dev/null)" && do_start ;;
    *) echo "usage: $0 {install|start|stop|restart|update|status|logs|datadir|latest|versions|select-version|enable-autostart|disable-autostart}"; exit 1 ;;
esac





