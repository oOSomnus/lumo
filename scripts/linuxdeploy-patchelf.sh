#!/bin/sh
# linuxdeploy's patchelf (0.19.1) moves .gnu.version_d in Bun's aarch64 executable but leaves DT_VERDEF
# pointing at the old address, so the sidecar segfaults at startup. It needs nothing but the system libc,
# so it is left exactly as built; every other file goes to the real patchelf.
for last; do :; done
case "$last" in
  */lumo-server) exit 0 ;;
esac
real=patchelf
if [ -x "${APPDIR:-}/usr/bin/patchelf" ]; then real="$APPDIR/usr/bin/patchelf"; fi
exec "$real" "$@"
