#!/bin/sh
#
# Prowlarr control script for webOS (POSIX sh / busybox compatible).
#
# Subcommands: install | start | stop | restart | update | status | logs | datadir
#
# It auto-detects a writable + exec-capable data directory, downloads the
# matching self-contained Prowlarr build from GitHub on first run, writes a
# minimal config.xml (bind to all interfaces, port 9696) and supervises the
# process via a pid file.
#
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
PORT=9696
API_URL="https://api.github.com/repos/Prowlarr/Prowlarr/releases/latest"
UA="prowlarr-webos"
AUTOSTART_SRC="$SCRIPT_DIR/prowlarr-autostart"
AUTOSTART_DST="/var/lib/webosbrew/init.d/prowlarr"

# --------------------------------------------------------------------------
# Pick a data directory that is both writable and allows execution.
# Falls back through several candidates so it works on retail, dev and rooted
# firmwares. Override with the PROWLARR_DATA environment variable.
# --------------------------------------------------------------------------
pick_datadir() {
    if [ -n "${PROWLARR_DATA:-}" ]; then
        if mkdir -p "$PROWLARR_DATA" 2>/dev/null; then echo "$PROWLARR_DATA"; return 0; fi
    fi
    for d in /media/developer/prowlarr /home/root/prowlarr /media/internal/.prowlarr /tmp/prowlarr; do
        mkdir -p "$d" 2>/dev/null || continue
        if ( echo x >"$d/.w" ) 2>/dev/null; then
            printf '#!/bin/sh\nexit 0\n' >"$d/.x" 2>/dev/null
            chmod +x "$d/.x" 2>/dev/null
            if "$d/.x" 2>/dev/null; then
                rm -f "$d/.w" "$d/.x" 2>/dev/null
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
VERFILE="$DATA_DIR/version"
BIN="$APP_DIR/Prowlarr"
TGZ="$DATA_DIR/prowlarr.tar.gz"
PART="$DATA_DIR/prowlarr.tar.gz.part"
TOTALFILE="$DATA_DIR/total"
ARCHFILE="$DATA_DIR/arch"
LATESTFILE="$DATA_DIR/latest"
mkdir -p "$DATA_DIR" "$DATA_SUB" "$DATA_DIR/tmp" 2>/dev/null

set_state() { echo "$1" >"$STATEFILE" 2>/dev/null; }

autostart_enabled() { [ -f "$AUTOSTART_DST" ]; }

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
    [ -f "$cfg" ] && return 0
    cat >"$cfg" <<EOF
<Config>
  <BindAddress>*</BindAddress>
  <Port>$PORT</Port>
  <UrlBase></UrlBase>
  <EnableSsl>False</EnableSsl>
  <LaunchBrowser>False</LaunchBrowser>
  <AnalyticsEnabled>False</AnalyticsEnabled>
  <Branch>master</Branch>
  <UpdateMechanism>BuiltIn</UpdateMechanism>
  <InstanceName>Prowlarr (webOS)</InstanceName>
</Config>
EOF
}

do_install() {
    arch=$(detect_arch)
    set_state "downloading"
    json="$DATA_DIR/release.json"
    rm -f "$PART" "$TOTALFILE" 2>/dev/null
    if ! download "$API_URL" "$json"; then set_state "error:api"; return 1; fi

    # Switch to the arm64 build since the TV has an aarch64 kernel.
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

    rm -rf "$APP_DIR"
    if [ -d "$APP_DIR.tmp/Prowlarr" ]; then
        mv "$APP_DIR.tmp/Prowlarr" "$APP_DIR"
    else
        mv "$APP_DIR.tmp" "$APP_DIR"
    fi
    rm -rf "$APP_DIR.tmp" "$TGZ"
    
    # Fetch Alpine musl standard libraries (since .NET references them) and the loader
    set_state "fetching-deps"
    cd "$APP_DIR" 2>/dev/null
    wget -q 'https://dl-cdn.alpinelinux.org/alpine/v3.20/main/armv7/musl-1.2.5-r3.apk' -O musl.apk
    tar -xzf musl.apk && mv lib/ld-musl-armhf.so.1 ./ld-musl.so
    wget -q 'https://dl-cdn.alpinelinux.org/alpine/v3.20/main/armv7/libstdc++-13.2.1_git20240309-r1.apk' -O libstdc.apk
    tar -xzf libstdc.apk
    wget -q 'https://dl-cdn.alpinelinux.org/alpine/v3.20/main/armv7/libgcc-13.2.1_git20240309-r1.apk' -O libgcc.apk
    tar -xzf libgcc.apk
    wget -q 'https://dl-cdn.alpinelinux.org/alpine/v3.20/main/armv7/libssl3-3.3.7-r0.apk' -O libssl.apk
    tar -xzf libssl.apk
    wget -q 'https://dl-cdn.alpinelinux.org/alpine/v3.20/main/armv7/libcrypto3-3.3.7-r0.apk' -O libcrypto.apk
    tar -xzf libcrypto.apk
    rm -f *.apk

    chmod +x "$BIN" "./ld-musl.so" 2>/dev/null
    [ -n "$ver" ] && echo "$ver" >"$VERFILE"
    echo "$arch" >"$ARCHFILE"
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
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    TMPDIR="$DATA_DIR/tmp" HOME="$DATA_DIR" XDG_CONFIG_HOME="$DATA_DIR" \
        nohup env LD_LIBRARY_PATH="$APP_DIR/usr/lib:$APP_DIR" "$APP_DIR/ld-musl.so" "$BIN" -nobrowser -data="$DATA_SUB" >>"$LOG" 2>&1 &
    
    # Wait for the program to bind (can take a few seconds on slow TVs)
    i=0
    while [ $i -lt 15 ]; do
        sleep 1
        if is_running; then
            set_state "running"
            return 0
        fi
        i=$((i + 1))
    done
    
    set_state "error:launch"
    return 1
}

do_stop() {
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
    set_state "stopped"
    return 0
}

do_status() {
    if is_running; then r=true; else r=false; fi
    if [ -x "$BIN" ]; then ins=true; else ins=false; fi
    st=$(cat "$STATEFILE" 2>/dev/null); [ -z "$st" ] && st="idle"
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
    printf '{"running":%s,"installed":%s,"state":"%s","version":"%s","arch":"%s","port":%s,"downloadedBytes":%s,"totalBytes":%s,"dataDir":"%s","autostart":%s}\n' \
        "$r" "$ins" "$st" "$ver" "$arch" "$PORT" "$dlb" "$tot" "$DATA_DIR" "$as"
}

case "${1:-}" in
    start)    spawn_bg _start ;;
    install)  spawn_bg _install ;;
    update)   spawn_bg _update ;;
    restart)  do_stop; spawn_bg _start ;;
    stop)     do_stop ;;
    status)   do_status ;;
    logs)     tail -n "${2:-200}" "$LOG" 2>/dev/null ;;
    datadir)  echo "$DATA_DIR" ;;
    latest)   do_latest ;;
    enable-autostart)  enable_autostart && echo "enabled" || echo "failed" ;;
    disable-autostart) disable_autostart && echo "disabled" || echo "failed" ;;
    _start)   do_start ;;
    _install) do_install ;;
    _update)  do_stop; do_install && do_start ;;
    *) echo "usage: $0 {install|start|stop|restart|update|status|logs|datadir|latest|enable-autostart|disable-autostart}"; exit 1 ;;
esac





